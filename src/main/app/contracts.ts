import type {
  AudioDevice,
  CaptureConfiguration,
  CaptureStatus,
  CaptureTarget,
  Job,
  PreflightResult,
  ProviderProfileV1,
  SessionMode
} from '@shared/index'

export interface CaptureController {
  connect(input: { url: string; password: string }): Promise<CaptureStatus>
  cancelConnect(): Promise<void>
  disconnect(): Promise<void>
  discover(): Promise<{ targets: CaptureTarget[]; audioDevices: AudioDevice[] }>
  selectPortalTarget(): Promise<void>
  configure(input: CaptureConfiguration): Promise<CaptureStatus>
  preflight(): Promise<PreflightResult>
  start(sessionId: string, sessionDirectory: string): Promise<CaptureStatus>
  stop(): Promise<{
    status: CaptureStatus
    sessionId: string | null
    outputPath: string | null
    durationMs: number | null
  }>
  acknowledgeRecording(sessionId: string): Promise<void>
  status(): Promise<CaptureStatus>
  subscribe(listener: (status: CaptureStatus) => void): () => void
}

export interface ProcessingController {
  enqueue(input: {
    sessionId: string
    transcriptionProfileId: string
    summaryProfileId: string | null
    mode: SessionMode
  }): Promise<Job>
  generateSummary(input: { sessionId: string; profileId: string; mode: SessionMode }): Promise<Job>
  retry(jobId: string): Promise<Job>
  cancel(jobId: string): Promise<void>
  testProvider(
    profile: ProviderProfileV1,
    secrets: Record<string, string>
  ): Promise<{
    ok: boolean
    message: string
    models?: string[]
  }>
  shutdown(): Promise<void>
  resumePending(): void
  subscribe(listener: (job: Job) => void): () => void
}

export const disconnectedCaptureStatus: CaptureStatus = {
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
