import type { AppBootstrap, Job, Session, SessionMode } from './domain'
import type { ProviderProfileV1 } from './providers'
import type { SummaryDocumentV1 } from './summary'
import type { TranscriptDocumentV1 } from './transcript'
import type { ManagedDiarizationStatus } from './diarization'
import type { ManagedWhisperStatus } from './whisper'
import type {
  AudioDevice,
  CaptureConfiguration,
  CaptureStatus,
  CaptureTarget,
  PreflightResult
} from './capture'

export interface SessionDetails {
  session: Session
  transcript: TranscriptDocumentV1 | null
  summary: SummaryDocumentV1 | null
  jobs: Job[]
  mediaUrl: string | null
  summaryStale: boolean
}

export interface ProviderInput {
  profile: ProviderProfileV1
  secrets: Record<string, string>
}

export interface ExportRequest {
  sessionId: string
  directory: string
  formats: Array<'markdown' | 'json' | 'srt' | 'vtt'>
}

export interface SessionScribeApi {
  app: {
    bootstrap(): Promise<AppBootstrap>
    openExternal(url: string): Promise<void>
  }
  sessions: {
    list(): Promise<Session[]>
    get(id: string): Promise<SessionDetails>
    create(input: { title: string; mode: SessionMode }): Promise<Session>
    importMedia(input: {
      mode: SessionMode
      transcriptionProfileId: string
      summaryProfileId: string | null
    }): Promise<Session>
    delete(id: string): Promise<void>
  }
  capture: {
    connect(input: {
      url: string
      password: string
      rememberPassword: boolean
    }): Promise<CaptureStatus>
    cancelConnect(): Promise<void>
    disconnect(): Promise<void>
    discover(): Promise<{ targets: CaptureTarget[]; audioDevices: AudioDevice[] }>
    configure(input: CaptureConfiguration): Promise<CaptureStatus>
    selectPortalTarget(): Promise<void>
    preflight(): Promise<PreflightResult>
    start(input: {
      sessionId: string
      transcriptionProfileId: string
      summaryProfileId: string | null
    }): Promise<CaptureStatus>
    stop(): Promise<CaptureStatus>
    status(): Promise<CaptureStatus>
  }
  providers: {
    list(): Promise<ProviderProfileV1[]>
    chooseExecutable(): Promise<string | null>
    save(input: ProviderInput): Promise<ProviderProfileV1>
    delete(id: string): Promise<void>
    test(input: ProviderInput): Promise<{ ok: boolean; message: string; models?: string[] }>
  }
  whisper: {
    status(): Promise<ManagedWhisperStatus>
    install(): Promise<{ status: ManagedWhisperStatus; profile: ProviderProfileV1 }>
    cancelInstall(): Promise<void>
    start(): Promise<ManagedWhisperStatus>
    stop(): Promise<ManagedWhisperStatus>
  }
  diarization: {
    status(): Promise<ManagedDiarizationStatus>
    install(): Promise<ManagedDiarizationStatus>
    cancelInstall(): Promise<void>
    start(): Promise<ManagedDiarizationStatus>
    stop(): Promise<ManagedDiarizationStatus>
  }
  jobs: {
    retry(id: string): Promise<Job>
    cancel(id: string): Promise<void>
  }
  transcript: {
    save(input: {
      sessionId: string
      document: TranscriptDocumentV1
    }): Promise<TranscriptDocumentV1>
    renameSpeaker(input: {
      sessionId: string
      speakerId: string
      displayName: string
    }): Promise<TranscriptDocumentV1>
    mergeSpeakers(input: {
      sessionId: string
      sourceId: string
      targetId: string
    }): Promise<TranscriptDocumentV1>
  }
  summary: {
    generate(input: { sessionId: string; mode: SessionMode; profileId: string }): Promise<Job>
    save(input: { sessionId: string; document: SummaryDocumentV1 }): Promise<SummaryDocumentV1>
  }
  exports: {
    chooseDirectory(): Promise<string | null>
    write(input: ExportRequest): Promise<string[]>
  }
  events: {
    subscribe(listener: (event: SessionScribeEvent) => void): () => void
  }
}

export type SessionScribeEvent =
  | { type: 'capture-status'; payload: CaptureStatus }
  | { type: 'job-updated'; payload: Job }
  | { type: 'session-updated'; payload: Session }
  | { type: 'whisper-status'; payload: ManagedWhisperStatus }
  | { type: 'diarization-status'; payload: ManagedDiarizationStatus }

export const IPC = {
  invoke: 'sessionscribe:invoke',
  event: 'sessionscribe:event'
} as const
