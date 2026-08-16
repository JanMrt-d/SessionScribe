import { createHash } from 'node:crypto'
import type {
  ProviderCapabilities,
  SummaryProfileV1,
  TranscriptionProfileV1
} from '@shared/providers'
import {
  LECTURE_SUMMARY_SCHEMA_VERSION,
  summaryDocumentSchema,
  type SummaryDocumentV1
} from '@shared/summary'
import { transcriptDocumentSchema, type TranscriptDocumentV1 } from '@shared/transcript'
import type {
  ProviderContext,
  SummaryAdapter,
  SummaryRequest,
  TranscriptionAdapter,
  TranscriptionRequest
} from './contracts'
import { reportProgress } from './contracts'
import { normalizeTranscript, type RawTranscript } from './normalize'

export interface FakeTranscriptionOptions {
  transcript?: RawTranscript
  generatedAt?: string
}

export class DeterministicFakeTranscriptionAdapter<
  TProfile extends TranscriptionProfileV1 = TranscriptionProfileV1
> implements TranscriptionAdapter<TProfile> {
  readonly kind: TProfile['kind']
  private readonly options: FakeTranscriptionOptions

  constructor(kind: TProfile['kind'], options: FakeTranscriptionOptions = {}) {
    this.kind = kind
    this.options = options
  }

  capabilities(): ProviderCapabilities {
    return {
      timestamps: true,
      diarization: true,
      structuredOutput: true,
      modelListing: false,
      maxInputBytes: null,
      maxDurationMs: null
    }
  }

  async transcribe(
    request: TranscriptionRequest,
    profile: TProfile,
    context: ProviderContext
  ): Promise<TranscriptDocumentV1> {
    await Promise.resolve()
    context.signal.throwIfAborted()
    reportProgress(context, { stage: 'process', progress: 0.5 })
    const raw = this.options.transcript ?? {
      text: 'Deterministic transcript.',
      words: [
        {
          text: 'Deterministic transcript.',
          startMs: 0,
          endMs: Math.min(1_000, request.durationMs),
          speakerLabel: 'Speaker 1',
          confidence: 1
        }
      ]
    }
    const normalized = normalizeTranscript(raw, {
      sessionId: request.sessionId,
      sourceSha256: request.sourceSha256,
      durationMs: request.durationMs,
      providerKind: this.kind,
      model: profile.model,
      generatedAt: this.options.generatedAt ?? '2000-01-01T00:00:00.000Z'
    })
    reportProgress(context, { stage: 'parse', progress: 1 })
    return transcriptDocumentSchema.parse({
      ...normalized,
      id: stableUuid(`transcript:${this.kind}:${request.sessionId}:${request.sourceSha256}`)
    })
  }
}

export interface FakeSummaryOptions {
  generatedAt?: string
}

export class DeterministicFakeSummaryAdapter<
  TProfile extends SummaryProfileV1 = SummaryProfileV1
> implements SummaryAdapter<TProfile> {
  readonly kind: TProfile['kind']
  private readonly options: FakeSummaryOptions

  constructor(kind: TProfile['kind'], options: FakeSummaryOptions = {}) {
    this.kind = kind
    this.options = options
  }

  capabilities(): ProviderCapabilities {
    return {
      timestamps: false,
      diarization: false,
      structuredOutput: true,
      modelListing: false,
      maxInputBytes: null,
      maxDurationMs: null
    }
  }

  async summarize(
    request: SummaryRequest,
    profile: TProfile,
    context: ProviderContext
  ): Promise<SummaryDocumentV1> {
    await Promise.resolve()
    context.signal.throwIfAborted()
    const utterance = request.transcript.utterances[0]
    const evidence = utterance
      ? [{ utteranceId: utterance.id, startMs: utterance.startMs, endMs: utterance.endMs }]
      : []
    const base = {
      schemaVersion: 1 as const,
      id: stableUuid(`summary:${this.kind}:${request.sessionId}:${request.revision}`),
      sessionId: request.sessionId,
      revision: request.revision,
      transcriptRevision: request.transcript.revision,
      title: request.title,
      overview: request.transcript.text,
      provenance: {
        providerKind: this.kind,
        model: profile.model,
        promptVersion: 'deterministic-fake-v1',
        generatedAt: this.options.generatedAt ?? '2000-01-01T00:00:00.000Z'
      },
      manuallyEdited: false
    }
    const result =
      request.mode === 'meeting'
        ? {
            ...base,
            mode: 'meeting' as const,
            topics: utterance ? [{ text: utterance.text, evidence }] : [],
            decisions: [],
            actionItems: [],
            openQuestions: [],
            risks: []
          }
        : {
            ...base,
            schemaVersion: LECTURE_SUMMARY_SCHEMA_VERSION,
            mode: 'lecture' as const,
            language: request.transcript.languages[0] ?? '',
            chapters: utterance
              ? [
                  {
                    title: request.title,
                    summary: utterance.text,
                    startMs: utterance.startMs,
                    subtopics: [
                      { title: request.title, keyPoints: [{ text: utterance.text, evidence }] }
                    ],
                    emphasis: [],
                    openQuestions: [],
                    glossary: [],
                    studyQuestions: []
                  }
                ]
              : []
          }
    reportProgress(context, { stage: 'parse', progress: 1 })
    return summaryDocumentSchema.parse(result)
  }
}

function stableUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}
