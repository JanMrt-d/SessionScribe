import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { summaryDocumentSchema, type SummaryDocumentV1 } from '@shared/summary'
import type { TranscriptUtterance } from '@shared/transcript'
import type { ProviderContext, SummaryRequest } from '../contracts'
import { providerNow, reportProgress } from '../contracts'
import { ProviderError } from '../errors'
import {
  SUMMARY_PROMPT_VERSION,
  buildReducePrompt,
  buildRepairPrompt,
  buildSystemPrompt,
  buildTranscriptPrompt,
  draftSchemaForMode,
  emptyDraft,
  formatTranscript,
  summaryJsonSchema,
  type LectureDraft,
  type MeetingDraft,
  type SummaryDraft
} from './prompts'

export interface SummaryGenerationRequest {
  systemPrompt: string
  userPrompt: string
  schemaName: string
  jsonSchema: Readonly<Record<string, unknown>>
  signal: AbortSignal
}

export type SummaryTextGenerator = (request: SummaryGenerationRequest) => Promise<string>

export interface SummaryEngineOptions {
  providerKind: string
  model: string
  contextWindowTokens: number
  promptOverride: string | null
  generate: SummaryTextGenerator
}

export async function createGroundedSummary(
  request: SummaryRequest,
  context: ProviderContext,
  options: SummaryEngineOptions
): Promise<SummaryDocumentV1> {
  if (context.signal.aborted) {
    throw new ProviderError('CANCELLED', 'Summary generation was cancelled', {
      providerKind: options.providerKind,
      operation: 'summarize',
      stage: 'preflight'
    })
  }
  if (request.sessionId !== request.transcript.sessionId) {
    throw new ProviderError('INVALID_INPUT', 'The transcript belongs to a different session', {
      providerKind: options.providerKind,
      operation: 'summarize',
      stage: 'preflight'
    })
  }
  if (!Number.isInteger(request.revision) || request.revision < 1) {
    throw new ProviderError('INVALID_INPUT', 'The summary revision must be a positive integer', {
      providerKind: options.providerKind,
      operation: 'summarize',
      stage: 'preflight'
    })
  }
  if (request.transcript.text.trim() && request.transcript.utterances.length === 0) {
    throw new ProviderError(
      'INVALID_INPUT',
      'The transcript must contain utterances before it can be summarized with evidence',
      {
        providerKind: options.providerKind,
        operation: 'summarize',
        stage: 'preflight'
      }
    )
  }
  const lines = formatTranscript(request.transcript)
  const schema = draftSchemaForMode(request.mode)
  const systemPrompt = buildSystemPrompt(request.mode, options.promptOverride)
  const jsonSchema = summaryJsonSchema(request.mode)
  const budget = Math.max(2_000, Math.floor(options.contextWindowTokens * 3 * 0.58))
  let draft: SummaryDraft

  if (lines.length === 0) {
    draft = emptyDraft(request.mode)
  } else {
    const chunks = chunkLines(lines, budget)
    reportProgress(context, { stage: 'request', progress: 0.05 })
    let partials = await mapWithConcurrency(chunks, 2, async (chunk, index) => {
      const chunkEvidence = evidenceIdsFromTranscriptChunk(chunk)
      const result = await generateValidated(
        options.generate,
        systemPrompt,
        buildTranscriptPrompt(request.mode, chunk),
        schema,
        jsonSchema,
        request.mode,
        context.signal,
        chunkEvidence,
        options.providerKind
      )
      reportProgress(context, {
        stage: chunks.length === 1 ? 'request' : 'reduce',
        progress: 0.1 + (0.55 * (index + 1)) / chunks.length
      })
      return result
    })

    while (partials.length > 1) {
      const groups = groupPartials(partials, budget)
      partials = await mapWithConcurrency(groups, 2, (group) => {
        const groupEvidence = evidenceIdsFromDrafts(group)
        return generateValidated(
          options.generate,
          systemPrompt,
          buildReducePrompt(request.mode, group),
          schema,
          jsonSchema,
          request.mode,
          context.signal,
          groupEvidence,
          options.providerKind
        )
      })
      reportProgress(context, {
        stage: 'reduce',
        progress: Math.min(0.9, 0.7 + 0.2 / partials.length)
      })
    }
    draft = partials[0]!
  }

  reportProgress(context, { stage: 'parse', progress: 0.95 })
  const result = materializeSummary(request, draft, context, options)
  reportProgress(context, { stage: 'parse', progress: 1 })
  return result
}

async function generateValidated<TSchema extends z.ZodType<SummaryDraft>>(
  generate: SummaryTextGenerator,
  systemPrompt: string,
  userPrompt: string,
  schema: TSchema,
  jsonSchema: Readonly<Record<string, unknown>>,
  mode: SummaryRequest['mode'],
  signal: AbortSignal,
  allowedEvidence: ReadonlySet<string>,
  providerKind: string
): Promise<SummaryDraft> {
  const schemaName = `${mode}_summary`
  const first = await generate({ systemPrompt, userPrompt, schemaName, jsonSchema, signal })
  const firstResult = parseDraft(first, schema)
  const firstIssue = firstResult.success
    ? validateEvidence(firstResult.data, allowedEvidence)
    : firstResult.issue
  if (firstResult.success && !firstIssue) return firstResult.data

  const repaired = await generate({
    systemPrompt,
    userPrompt: buildRepairPrompt(userPrompt, first, firstIssue ?? 'Invalid structured output'),
    schemaName,
    jsonSchema,
    signal
  })
  const repairedResult = parseDraft(repaired, schema)
  if (repairedResult.success) {
    const evidenceIssue = validateEvidence(repairedResult.data, allowedEvidence)
    if (!evidenceIssue) return repairedResult.data
  }
  throw new ProviderError(
    'OUTPUT_INVALID',
    'The summary provider returned invalid structured output',
    {
      providerKind,
      operation: 'summarize',
      stage: 'parse'
    }
  )
}

function parseDraft<TSchema extends z.ZodType<SummaryDraft>>(
  output: string,
  schema: TSchema
): { success: true; data: SummaryDraft } | { success: false; issue: string } {
  try {
    const parsed: unknown = JSON.parse(stripCodeFence(output))
    const result = schema.safeParse(parsed)
    if (result.success) return { success: true, data: result.data }
    return { success: false, issue: result.error.issues.map((issue) => issue.message).join('; ') }
  } catch (error) {
    return { success: false, issue: error instanceof Error ? error.message : 'Invalid JSON' }
  }
}

function validateEvidence(
  draft: SummaryDraft,
  allowedEvidence: ReadonlySet<string>
): string | undefined {
  const visit = (value: unknown): string | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const issue = visit(item)
        if (issue) return issue
      }
      return undefined
    }
    if (!value || typeof value !== 'object') return undefined
    const object = value as Record<string, unknown>
    if (isUnknownArray(object.evidence)) {
      const unknownId = object.evidence.find(
        (id) => typeof id !== 'string' || !allowedEvidence.has(id)
      )
      if (unknownId !== undefined) return 'An evidence array contains an unknown utterance ID.'
    }
    for (const child of Object.values(object)) {
      const issue = visit(child)
      if (issue) return issue
    }
    return undefined
  }
  return visit(draft)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function evidenceIdsFromTranscriptChunk(chunk: string): Set<string> {
  return new Set([...chunk.matchAll(/<utterance id="([^"]+)"/g)].map((match) => match[1]!))
}

function evidenceIdsFromDrafts(drafts: readonly SummaryDraft[]): Set<string> {
  const ids = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== 'object') return
    const object = value as Record<string, unknown>
    if (Array.isArray(object.evidence)) {
      for (const id of object.evidence) if (typeof id === 'string') ids.add(id)
    }
    Object.values(object).forEach(visit)
  }
  drafts.forEach(visit)
  return ids
}

function materializeSummary(
  request: SummaryRequest,
  draft: SummaryDraft,
  context: ProviderContext,
  options: SummaryEngineOptions
): SummaryDocumentV1 {
  const utterances = new Map(
    request.transcript.utterances.map((utterance) => [utterance.id, utterance])
  )
  const evidence = (ids: readonly string[]) =>
    ids.map((id) => evidenceFor(id, utterances, options.providerKind))
  const base = {
    schemaVersion: 1 as const,
    id: randomUUID(),
    sessionId: request.sessionId,
    revision: request.revision,
    transcriptRevision: request.transcript.revision,
    title: request.title,
    overview: draft.overview,
    provenance: {
      providerKind: options.providerKind,
      model: options.model,
      promptVersion: SUMMARY_PROMPT_VERSION,
      generatedAt: providerNow(context).toISOString()
    },
    manuallyEdited: false
  }
  const document =
    request.mode === 'meeting'
      ? materializeMeeting(base, draft as MeetingDraft, evidence)
      : materializeLecture(base, draft as LectureDraft, evidence)
  try {
    return summaryDocumentSchema.parse(document)
  } catch (cause) {
    throw new ProviderError('OUTPUT_INVALID', 'The canonical summary is invalid', {
      providerKind: options.providerKind,
      operation: 'summarize',
      stage: 'parse',
      cause
    })
  }
}

function materializeMeeting(
  base: Record<string, unknown>,
  draft: MeetingDraft,
  evidence: (
    ids: readonly string[]
  ) => Array<{ utteranceId: string; startMs: number; endMs: number }>
): Record<string, unknown> {
  const grounded = (item: { text: string; evidence: string[] }) => ({
    text: item.text,
    evidence: evidence(item.evidence)
  })
  return {
    ...base,
    mode: 'meeting',
    topics: draft.topics.map(grounded),
    decisions: draft.decisions.map(grounded),
    actionItems: draft.actionItems.map((item) => ({ ...item, evidence: evidence(item.evidence) })),
    openQuestions: draft.openQuestions.map(grounded),
    risks: draft.risks.map(grounded)
  }
}

function materializeLecture(
  base: Record<string, unknown>,
  draft: LectureDraft,
  evidence: (
    ids: readonly string[]
  ) => Array<{ utteranceId: string; startMs: number; endMs: number }>
): Record<string, unknown> {
  const grounded = (item: { text: string; evidence: string[] }) => ({
    text: item.text,
    evidence: evidence(item.evidence)
  })
  return {
    ...base,
    mode: 'lecture',
    outline: draft.outline.map(grounded),
    keyLessons: draft.keyLessons.map(grounded),
    concepts: draft.concepts.map((item) => ({ ...item, evidence: evidence(item.evidence) })),
    examples: draft.examples.map(grounded),
    reviewQuestions: draft.reviewQuestions,
    recommendedReview: draft.recommendedReview.map(grounded)
  }
}

function evidenceFor(
  id: string,
  utterances: ReadonlyMap<string, TranscriptUtterance>,
  providerKind: string
): { utteranceId: string; startMs: number; endMs: number } {
  const utterance = utterances.get(id)
  if (!utterance) {
    throw new ProviderError('OUTPUT_INVALID', 'The summary cited an unknown transcript utterance', {
      providerKind,
      operation: 'summarize',
      stage: 'parse'
    })
  }
  return { utteranceId: utterance.id, startMs: utterance.startMs, endMs: utterance.endMs }
}

function chunkLines(lines: readonly string[], budget: number): string[] {
  const chunks: string[] = []
  let current = ''
  for (const line of lines.flatMap((value) => splitLongLine(value, budget))) {
    if (current && current.length + line.length + 1 > budget) {
      chunks.push(current)
      current = ''
    }
    current += `${current ? '\n' : ''}${line}`
  }
  if (current) chunks.push(current)
  return chunks
}

function splitLongLine(line: string, budget: number): string[] {
  if (line.length <= budget) return [line]
  const openingEnd = line.indexOf('>') + 1
  const closingStart = line.lastIndexOf('</utterance>')
  if (openingEnd <= 0 || closingStart <= openingEnd) {
    return Array.from({ length: Math.ceil(line.length / budget) }, (_, index) =>
      line.slice(index * budget, (index + 1) * budget)
    )
  }
  const opening = line.slice(0, openingEnd)
  const body = line.slice(openingEnd, closingStart)
  const closing = line.slice(closingStart)
  const bodyBudget = Math.max(200, budget - opening.length - closing.length)
  return Array.from(
    { length: Math.ceil(body.length / bodyBudget) },
    (_, index) => `${opening}${body.slice(index * bodyBudget, (index + 1) * bodyBudget)}${closing}`
  )
}

function groupPartials(partials: readonly SummaryDraft[], budget: number): SummaryDraft[][] {
  const groups: SummaryDraft[][] = []
  let index = 0
  while (index < partials.length) {
    const group: SummaryDraft[] = [partials[index]!]
    index += 1
    if (index < partials.length) {
      group.push(partials[index]!)
      index += 1
    }
    while (
      index < partials.length &&
      JSON.stringify([...group, partials[index]]).length <= budget
    ) {
      group.push(partials[index]!)
      index += 1
    }
    groups.push(group)
  }
  return groups
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim()
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return match?.[1] ?? trimmed
}

async function mapWithConcurrency<T, TResult>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
  const results = new Array<TResult>(values.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(values[index]!, index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), values.length) }, () => worker())
  )
  return results
}
