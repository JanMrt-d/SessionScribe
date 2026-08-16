import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import {
  LECTURE_SUMMARY_SCHEMA_VERSION,
  summaryDocumentSchema,
  type SummaryDocumentV1
} from '@shared/summary'
import type { TranscriptUtterance } from '@shared/transcript'
import type { ProviderContext, SummaryRequest } from '../contracts'
import { providerNow, reportProgress } from '../contracts'
import { ProviderError } from '../errors'
import {
  buildLectureOverviewPrompt,
  buildLectureSegmentPrompt,
  buildReducePrompt,
  buildRepairPrompt,
  buildSystemPrompt,
  buildTranscriptPrompt,
  emptyDraft,
  formatTranscript,
  lectureOverviewDraftSchema,
  lectureSegmentDraftSchema,
  meetingDraftSchema,
  promptVersionForMode,
  summaryJsonSchema,
  type LectureChapterDraft,
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

/**
 * Share of the context window spent on transcript input. Lecture notes are many
 * times longer than a meeting record, so the lecture pass keeps far more of the
 * window free for the response; otherwise long chapters are cut off mid-JSON.
 */
const MEETING_INPUT_SHARE = 0.58
const LECTURE_INPUT_SHARE = 0.35

/**
 * Upper bound on a lecture segment, roughly ten to fifteen minutes of speech.
 * Segment size decides how finely chapters are resolved: a whole lecture in one
 * window collapses into a handful of headings no matter how large the model.
 */
const LECTURE_SEGMENT_CHARS = 18_000

const CHARACTERS_PER_TOKEN = 3

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
  const language = request.transcript.languages[0] ?? ''
  const systemPrompt = buildSystemPrompt(request.mode, options.promptOverride, language)
  const draft =
    lines.length === 0
      ? emptyDraft(request.mode)
      : request.mode === 'lecture'
        ? await composeLectureNotes(lines, systemPrompt, context, options)
        : await reduceMeetingNotes(lines, systemPrompt, context, options)

  reportProgress(context, { stage: 'parse', progress: 0.95 })
  const result = materializeSummary(request, draft, context, options, language)
  reportProgress(context, { stage: 'parse', progress: 1 })
  return result
}

/**
 * Collects chapters segment by segment and never merges them through the model.
 * The meeting path below reduces partial summaries until one is left, which
 * compresses harder the longer the recording is — the opposite of what study
 * notes need, where a longer lecture must yield more material, not less.
 */
async function composeLectureNotes(
  lines: readonly string[],
  systemPrompt: string,
  context: ProviderContext,
  options: SummaryEngineOptions
): Promise<LectureDraft> {
  const segments = chunkLines(lines, chunkBudget('lecture', options.contextWindowTokens))
  const jsonSchema = summaryJsonSchema('lecture-segment')
  reportProgress(context, { stage: 'request', progress: 0.05 })
  const drafts = await mapWithConcurrency(segments, 2, async (segment, index) => {
    const result = await generateValidated({
      generate: options.generate,
      systemPrompt,
      userPrompt: buildLectureSegmentPrompt(segment, index + 1, segments.length),
      schema: lectureSegmentDraftSchema,
      jsonSchema,
      schemaName: 'lecture_segment_notes',
      signal: context.signal,
      allowedEvidence: evidenceIdsFromTranscriptChunk(segment),
      providerKind: options.providerKind
    })
    reportProgress(context, {
      stage: segments.length === 1 ? 'request' : 'reduce',
      progress: 0.05 + (0.75 * (index + 1)) / segments.length
    })
    return result
  })

  const chapters = mergeAdjacentChapters(drafts.flatMap((draft) => draft.chapters))
  if (chapters.length === 0) return { overview: '', chapters }
  reportProgress(context, { stage: 'reduce', progress: 0.85 })
  const { overview } = await generateValidated({
    generate: options.generate,
    systemPrompt,
    userPrompt: buildLectureOverviewPrompt(
      chapters.map((chapter) => ({ title: chapter.title, summary: chapter.summary }))
    ),
    schema: lectureOverviewDraftSchema,
    jsonSchema: summaryJsonSchema('lecture-overview'),
    schemaName: 'lecture_overview',
    signal: context.signal,
    allowedEvidence: new Set<string>(),
    providerKind: options.providerKind
  })
  return { overview, chapters }
}

async function reduceMeetingNotes(
  lines: readonly string[],
  systemPrompt: string,
  context: ProviderContext,
  options: SummaryEngineOptions
): Promise<MeetingDraft> {
  const budget = chunkBudget('meeting', options.contextWindowTokens)
  const jsonSchema = summaryJsonSchema('meeting')
  const chunks = chunkLines(lines, budget)
  reportProgress(context, { stage: 'request', progress: 0.05 })
  let partials = await mapWithConcurrency(chunks, 2, async (chunk, index) => {
    const result = await generateValidated({
      generate: options.generate,
      systemPrompt,
      userPrompt: buildTranscriptPrompt('meeting', chunk),
      schema: meetingDraftSchema,
      jsonSchema,
      schemaName: 'meeting_summary',
      signal: context.signal,
      allowedEvidence: evidenceIdsFromTranscriptChunk(chunk),
      providerKind: options.providerKind
    })
    reportProgress(context, {
      stage: chunks.length === 1 ? 'request' : 'reduce',
      progress: 0.1 + (0.55 * (index + 1)) / chunks.length
    })
    return result
  })

  while (partials.length > 1) {
    const groups = groupPartials(partials, budget)
    partials = await mapWithConcurrency(groups, 2, (group) =>
      generateValidated({
        generate: options.generate,
        systemPrompt,
        userPrompt: buildReducePrompt('meeting', group),
        schema: meetingDraftSchema,
        jsonSchema,
        schemaName: 'meeting_summary',
        signal: context.signal,
        allowedEvidence: evidenceIdsFromDrafts(group),
        providerKind: options.providerKind
      })
    )
    reportProgress(context, {
      stage: 'reduce',
      progress: Math.min(0.9, 0.7 + 0.2 / partials.length)
    })
  }
  return partials[0]!
}

function chunkBudget(mode: SummaryRequest['mode'], contextWindowTokens: number): number {
  const share = mode === 'lecture' ? LECTURE_INPUT_SHARE : MEETING_INPUT_SHARE
  const modelBudget = Math.max(
    2_000,
    Math.floor(contextWindowTokens * CHARACTERS_PER_TOKEN * share)
  )
  return mode === 'lecture' ? Math.min(modelBudget, LECTURE_SEGMENT_CHARS) : modelBudget
}

/**
 * Rejoins a chapter that the lecturer carried across a segment boundary, which
 * the model reports under the same title in both segments. Titles are compared
 * only against the immediately preceding chapter so that a genuine return to an
 * earlier subject stays a separate chapter in reading order.
 */
function mergeAdjacentChapters(chapters: readonly LectureChapterDraft[]): LectureChapterDraft[] {
  const merged: LectureChapterDraft[] = []
  for (const chapter of chapters) {
    const previous = merged.at(-1)
    if (!previous || comparableTitle(previous.title) !== comparableTitle(chapter.title)) {
      merged.push(chapter)
      continue
    }
    merged[merged.length - 1] = {
      title: previous.title,
      summary: joinSummaries(previous.summary, chapter.summary),
      subtopics: [...previous.subtopics, ...chapter.subtopics],
      emphasis: [...previous.emphasis, ...chapter.emphasis],
      openQuestions: [...previous.openQuestions, ...chapter.openQuestions],
      glossary: [...previous.glossary, ...chapter.glossary],
      studyQuestions: [...previous.studyQuestions, ...chapter.studyQuestions]
    }
  }
  return merged
}

function comparableTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function joinSummaries(first: string, second: string): string {
  const left = first.trim()
  const right = second.trim()
  if (!left) return right
  if (!right || left === right) return left
  return `${left} ${right}`
}

interface ValidatedGeneration<T> {
  generate: SummaryTextGenerator
  systemPrompt: string
  userPrompt: string
  schema: z.ZodType<T>
  jsonSchema: Readonly<Record<string, unknown>>
  schemaName: string
  signal: AbortSignal
  allowedEvidence: ReadonlySet<string>
  providerKind: string
}

async function generateValidated<T>(request: ValidatedGeneration<T>): Promise<T> {
  const { generate, systemPrompt, schemaName, jsonSchema, signal } = request
  const first = await generate({
    systemPrompt,
    userPrompt: request.userPrompt,
    schemaName,
    jsonSchema,
    signal
  })
  const firstResult = parseDraft(first, request.schema)
  const firstIssue = firstResult.success
    ? validateEvidence(firstResult.data, request.allowedEvidence)
    : firstResult.issue
  if (firstResult.success && !firstIssue) return firstResult.data

  const repaired = await generate({
    systemPrompt,
    userPrompt: buildRepairPrompt(
      request.userPrompt,
      first,
      firstIssue ?? 'Invalid structured output'
    ),
    schemaName,
    jsonSchema,
    signal
  })
  const repairedResult = parseDraft(repaired, request.schema)
  if (repairedResult.success) {
    const evidenceIssue = validateEvidence(repairedResult.data, request.allowedEvidence)
    if (!evidenceIssue) return repairedResult.data
  }
  throw new ProviderError(
    'OUTPUT_INVALID',
    'The summary provider returned invalid structured output',
    {
      providerKind: request.providerKind,
      operation: 'summarize',
      stage: 'parse'
    }
  )
}

function parseDraft<T>(
  output: string,
  schema: z.ZodType<T>
): { success: true; data: T } | { success: false; issue: string } {
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
  draft: unknown,
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

type EvidenceResolver = (
  ids: readonly string[]
) => Array<{ utteranceId: string; startMs: number; endMs: number }>

function materializeSummary(
  request: SummaryRequest,
  draft: SummaryDraft,
  context: ProviderContext,
  options: SummaryEngineOptions,
  language: string
): SummaryDocumentV1 {
  const utterances = new Map(
    request.transcript.utterances.map((utterance) => [utterance.id, utterance])
  )
  const evidence: EvidenceResolver = (ids) =>
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
      promptVersion: promptVersionForMode(request.mode),
      generatedAt: providerNow(context).toISOString()
    },
    manuallyEdited: false
  }
  const document =
    request.mode === 'meeting'
      ? materializeMeeting(base, draft as MeetingDraft, evidence)
      : materializeLecture(base, draft as LectureDraft, evidence, language)
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
  evidence: EvidenceResolver
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
  evidence: EvidenceResolver,
  language: string
): Record<string, unknown> {
  const grounded = (item: { text: string; evidence: string[] }) => ({
    text: item.text,
    evidence: evidence(item.evidence)
  })
  return {
    ...base,
    schemaVersion: LECTURE_SUMMARY_SCHEMA_VERSION,
    mode: 'lecture',
    language,
    chapters: draft.chapters.map((chapter) => {
      const resolved = {
        title: chapter.title,
        summary: chapter.summary,
        subtopics: chapter.subtopics.map((subtopic) => ({
          title: subtopic.title,
          keyPoints: subtopic.keyPoints.map(grounded)
        })),
        emphasis: chapter.emphasis.map(grounded),
        openQuestions: chapter.openQuestions.map(grounded),
        glossary: chapter.glossary.map((entry) => ({
          name: entry.name,
          definition: entry.definition,
          evidence: evidence(entry.evidence)
        })),
        studyQuestions: chapter.studyQuestions.map((entry) => ({
          question: entry.question,
          answer: entry.answer,
          evidence: evidence(entry.evidence)
        }))
      }
      // Taken from the cited utterances rather than from the model, so that the
      // chapter always opens where its evidence actually starts.
      return { ...resolved, startMs: earliestEvidenceStart(resolved) }
    })
  }
}

function earliestEvidenceStart(chapter: unknown): number {
  let earliest = Number.POSITIVE_INFINITY
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== 'object') return
    const object = value as Record<string, unknown>
    if (typeof object.utteranceId === 'string' && typeof object.startMs === 'number') {
      earliest = Math.min(earliest, object.startMs)
    }
    Object.values(object).forEach(visit)
  }
  visit(chapter)
  return Number.isFinite(earliest) ? Math.max(0, Math.trunc(earliest)) : 0
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

function groupPartials(partials: readonly MeetingDraft[], budget: number): MeetingDraft[][] {
  const groups: MeetingDraft[][] = []
  let index = 0
  while (index < partials.length) {
    const group: MeetingDraft[] = [partials[index]!]
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
