import type {
  ProviderCapabilities,
  SummaryProfileV1,
  TranscriptionProfileV1
} from '@shared/providers'
import type { SessionMode } from '@shared/domain'
import type { SummaryDocumentV1 } from '@shared/summary'
import type { TranscriptDocumentV1 } from '@shared/transcript'

export interface SecretStore {
  get(reference: string, signal?: AbortSignal): Promise<string | undefined>
}

export interface ProviderLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void
}

export type ProviderProgress = Readonly<{
  stage: 'preflight' | 'upload' | 'request' | 'poll' | 'parse' | 'reduce' | 'process'
  progress: number
  message?: string
}>

export interface ProviderContext {
  signal: AbortSignal
  secrets: SecretStore
  fetch?: typeof globalThis.fetch
  logger?: ProviderLogger
  onProgress?: (event: ProviderProgress) => void
  allowInsecureRemoteHttp?: boolean
  now?: () => Date
}

export interface KnownSpeakerReference {
  speakerId: string
  displayName: string
  filePath: string
  mimeType: string
  durationMs: number
}

export interface TranscriptionRequest {
  sessionId: string
  sourceSha256: string
  filePath: string
  mimeType: string
  durationMs: number
  languageHint?: string
  glossary?: readonly string[]
  knownSpeakers?: readonly KnownSpeakerReference[]
}

export interface SummaryRequest {
  sessionId: string
  title: string
  mode: SessionMode
  revision: number
  transcript: TranscriptDocumentV1
}

export interface TranscriptionAdapter<
  TProfile extends TranscriptionProfileV1 = TranscriptionProfileV1
> {
  readonly kind: TProfile['kind']
  capabilities(profile: TProfile): ProviderCapabilities
  transcribe(
    request: TranscriptionRequest,
    profile: TProfile,
    context: ProviderContext
  ): Promise<TranscriptDocumentV1>
}

export interface SummaryAdapter<TProfile extends SummaryProfileV1 = SummaryProfileV1> {
  readonly kind: TProfile['kind']
  capabilities(profile: TProfile): ProviderCapabilities
  summarize(
    request: SummaryRequest,
    profile: TProfile,
    context: ProviderContext
  ): Promise<SummaryDocumentV1>
}

export type ProviderAdapter = TranscriptionAdapter | SummaryAdapter

export const silentProviderLogger: ProviderLogger = {
  debug: () => undefined,
  warn: () => undefined
}

export function reportProgress(context: ProviderContext, event: ProviderProgress): void {
  context.onProgress?.({ ...event, progress: Math.max(0, Math.min(1, event.progress)) })
}

export function providerNow(context: ProviderContext): Date {
  return context.now?.() ?? new Date()
}
