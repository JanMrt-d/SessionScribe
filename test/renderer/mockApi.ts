/// <reference lib="dom" />

import { vi } from 'vitest'
import type { CaptureStatus } from '../../src/shared/capture'
import type { AppBootstrap, Job, Session } from '../../src/shared/domain'
import type { SessionDetails, SessionScribeApi, SessionScribeEvent } from '../../src/shared/ipc'
import type { ProviderProfileV1 } from '../../src/shared/providers'
import type { SummaryDocumentV1 } from '../../src/shared/summary'
import type { TranscriptDocumentV1 } from '../../src/shared/transcript'

export const SESSION_ID = '11111111-1111-4111-8111-111111111111'
export const TRANSCRIPT_ID = '22222222-2222-4222-8222-222222222222'
export const SUMMARY_ID = '33333333-3333-4333-8333-333333333333'
export const JOB_ID = '44444444-4444-4444-8444-444444444444'
export const TRANSCRIPTION_PROFILE_ID = '55555555-5555-4555-8555-555555555555'
export const SUMMARY_PROFILE_ID = '66666666-6666-4666-8666-666666666666'

const now = '2026-07-13T10:00:00.000Z'

export const sessionFixture: Session = {
  id: SESSION_ID,
  title: 'Design sync',
  preferredMode: 'meeting',
  status: 'ready',
  recordingFileName: 'design-sync.mkv',
  durationMs: 3_600_000,
  createdAt: now,
  updatedAt: now,
  lastError: null,
  transcriptRevision: 1,
  summaryRevision: 1
}

export const transcriptFixture: TranscriptDocumentV1 = {
  schemaVersion: 1,
  id: TRANSCRIPT_ID,
  sessionId: SESSION_ID,
  revision: 1,
  sourceSha256: 'abc123',
  durationMs: 3_600_000,
  text: 'We will ship the proposal Friday. Morgan owns the final review.',
  languages: ['en'],
  speakers: [
    { id: 'speaker-0', label: 'Speaker 1', displayName: 'Alex' },
    { id: 'speaker-1', label: 'Speaker 2', displayName: 'Morgan' }
  ],
  words: [],
  utterances: [
    {
      id: 'utterance-1',
      text: 'We will ship the proposal Friday.',
      startMs: 12_000,
      endMs: 17_000,
      speakerId: 'speaker-0',
      wordIds: [],
      manuallyEdited: false
    },
    {
      id: 'utterance-2',
      text: 'Morgan owns the final review.',
      startMs: 18_000,
      endMs: 22_000,
      speakerId: 'speaker-1',
      wordIds: [],
      manuallyEdited: false
    }
  ],
  warnings: [],
  provenance: {
    providerKind: 'openai-transcription',
    model: 'gpt-4o-transcribe-diarize',
    generatedAt: now
  }
}

export const summaryFixture: SummaryDocumentV1 = {
  schemaVersion: 1,
  id: SUMMARY_ID,
  sessionId: SESSION_ID,
  revision: 1,
  transcriptRevision: 1,
  title: 'Design sync',
  overview: 'The team agreed on the proposal timeline and final review owner.',
  provenance: {
    providerKind: 'openai-compatible',
    model: 'gpt-5.6-terra',
    promptVersion: 'meeting-v1',
    generatedAt: now
  },
  manuallyEdited: false,
  mode: 'meeting',
  topics: [
    {
      text: 'Proposal timeline',
      evidence: [{ utteranceId: 'utterance-1', startMs: 12_000, endMs: 17_000 }]
    }
  ],
  decisions: [
    {
      text: 'Ship Friday',
      evidence: [{ utteranceId: 'utterance-1', startMs: 12_000, endMs: 17_000 }]
    }
  ],
  actionItems: [
    {
      task: 'Complete final review',
      assignee: 'Morgan',
      explicitAssignment: true,
      dueAt: null,
      dueText: null,
      confidence: 0.96,
      evidence: [{ utteranceId: 'utterance-2', startMs: 18_000, endMs: 22_000 }]
    }
  ],
  openQuestions: [],
  risks: []
}

export const failedJobFixture: Job = {
  id: JOB_ID,
  sessionId: SESSION_ID,
  stage: 'transcribe',
  status: 'failed',
  progress: 0.35,
  attempt: 0,
  errorCode: 'PROVIDER_RATE_LIMIT',
  errorMessage: 'The provider rate limit was reached.',
  createdAt: now,
  updatedAt: now
}

export const captureFixture: CaptureStatus = {
  connected: false,
  obsVersion: null,
  phase: 'disconnected',
  activeSessionId: null,
  elapsedMs: 0,
  bytesWritten: 0,
  microphoneLevel: 0,
  systemLevel: 0,
  warnings: []
}

export const profilesFixture: ProviderProfileV1[] = [
  {
    id: TRANSCRIPTION_PROFILE_ID,
    name: 'OpenAI transcription',
    task: 'transcription',
    kind: 'openai-transcription',
    model: 'gpt-4o-transcribe-diarize',
    baseUrl: 'https://api.openai.com/v1',
    timeoutMs: 3_600_000,
    secretRefs: { apiKey: 'secret:transcription' },
    extraHeaders: {},
    createdAt: now,
    updatedAt: now,
    language: null,
    responseFormat: 'diarized_json',
    maxUploadBytes: 25_000_000
  },
  {
    id: SUMMARY_PROFILE_ID,
    name: 'OpenAI summary',
    task: 'summary',
    kind: 'openai-compatible',
    model: 'gpt-5.6-terra',
    baseUrl: 'https://api.openai.com/v1',
    timeoutMs: 180_000,
    secretRefs: { apiKey: 'secret:summary' },
    extraHeaders: {},
    createdAt: now,
    updatedAt: now,
    apiStyle: 'responses',
    structuredOutput: 'json-schema',
    contextWindowTokens: 128_000,
    extraBody: {},
    meetingPromptOverride: null,
    lecturePromptOverride: null
  }
]

export interface MockApi extends SessionScribeApi {
  emit(event: SessionScribeEvent): void
}

export function createMockApi(detailsOverrides: Partial<SessionDetails> = {}): MockApi {
  let listener: ((event: SessionScribeEvent) => void) | null = null
  const details: SessionDetails = {
    session: sessionFixture,
    transcript: transcriptFixture,
    summary: summaryFixture,
    jobs: [failedJobFixture],
    mediaUrl: null,
    summaryStale: false,
    ...detailsOverrides
  }

  const api: MockApi = {
    app: {
      bootstrap: vi.fn(async (): Promise<AppBootstrap> => ({
        version: '0.1.0',
        platform: 'linux',
        sessions: [sessionFixture],
        obsConnected: false,
        activeSessionId: null,
        encryptionAvailable: true
      })),
      openExternal: vi.fn(async () => undefined)
    },
    sessions: {
      list: vi.fn(async () => [sessionFixture]),
      get: vi.fn(async () => details),
      create: vi.fn(
        async (input: Parameters<SessionScribeApi['sessions']['create']>[0]): Promise<Session> => ({
          ...sessionFixture,
          title: input.title,
          preferredMode: input.mode,
          status: 'draft'
        })
      ),
      importMedia: vi.fn(
        async (
          input: Parameters<SessionScribeApi['sessions']['importMedia']>[0]
        ): Promise<Session> => ({
          ...sessionFixture,
          preferredMode: input.mode,
          status: 'processing'
        })
      ),
      delete: vi.fn(async () => undefined)
    },
    capture: {
      connect: vi.fn(async (): Promise<CaptureStatus> => ({
        ...captureFixture,
        connected: true,
        obsVersion: '32.0.0',
        phase: 'ready'
      })),
      cancelConnect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      discover: vi.fn(async () => ({ targets: [], audioDevices: [] })),
      configure: vi.fn(async (): Promise<CaptureStatus> => ({
        ...captureFixture,
        connected: true,
        phase: 'ready'
      })),
      selectPortalTarget: vi.fn(async () => undefined),
      preflight: vi.fn(async () => ({
        ok: true,
        blockers: [],
        warnings: [],
        screenshotDataUrl: null
      })),
      start: vi.fn(
        async (
          input: Parameters<SessionScribeApi['capture']['start']>[0]
        ): Promise<CaptureStatus> => ({
          ...captureFixture,
          connected: true,
          phase: 'recording',
          activeSessionId: input.sessionId
        })
      ),
      stop: vi.fn(async (): Promise<CaptureStatus> => ({
        ...captureFixture,
        connected: true,
        phase: 'finalizing'
      })),
      status: vi.fn(async () => captureFixture)
    },
    providers: {
      list: vi.fn(async () => profilesFixture),
      chooseExecutable: vi.fn(async () => '/usr/bin/transcriber'),
      save: vi.fn(async (input) => input.profile),
      delete: vi.fn(async () => undefined),
      test: vi.fn(async () => ({ ok: true, message: 'Connection succeeded.' }))
    },
    jobs: {
      retry: vi.fn(async (): Promise<Job> => ({
        ...failedJobFixture,
        status: 'queued',
        progress: 0,
        updatedAt: '2026-07-13T10:01:00.000Z'
      })),
      cancel: vi.fn(async () => undefined)
    },
    transcript: {
      save: vi.fn(async (input) => input.document),
      renameSpeaker: vi.fn(async (input) => ({
        ...transcriptFixture,
        speakers: transcriptFixture.speakers.map((speaker) =>
          speaker.id === input.speakerId ? { ...speaker, displayName: input.displayName } : speaker
        )
      })),
      mergeSpeakers: vi.fn(async () => transcriptFixture)
    },
    summary: {
      generate: vi.fn(async (): Promise<Job> => ({
        ...failedJobFixture,
        stage: 'summarize',
        status: 'queued',
        progress: 0
      })),
      save: vi.fn(async (input) => input.document)
    },
    exports: {
      chooseDirectory: vi.fn(async () => '/tmp/export'),
      write: vi.fn(async () => ['/tmp/export/design-sync.md'])
    },
    events: {
      subscribe: vi.fn((nextListener) => {
        listener = nextListener
        return () => {
          listener = null
        }
      })
    },
    emit(event) {
      listener?.(event)
    }
  }

  return api
}
