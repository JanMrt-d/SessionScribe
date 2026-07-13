import type { AudioDevice, CaptureConfiguration, CaptureTarget } from '@shared/capture'

export type CapturePlatform = 'windows' | 'x11' | 'wayland'

export interface ObsConnectionOptions {
  url: string
  password: string
  timeoutMs?: number
  signal?: AbortSignal
  deadlineMs?: number
}

export interface ObsVersionInfo {
  obsVersion: string
  obsWebSocketVersion: string
  rpcVersion: number
  platform: string
  platformDescription: string
  availableRequests: ReadonlySet<string>
  supportedImageFormats: readonly string[]
}

export interface ManagedInput {
  name: string
  uuid: string
  kind: string
  sceneItemId: number | null
}

export interface ManagedResources {
  profileName: string
  sceneCollectionName: string
  sceneName: string
  previousProfileName: string | null
  previousSceneCollectionName: string | null
  windowInput: ManagedInput | null
  microphoneInput: ManagedInput | null
  systemAudioInput: ManagedInput | null
}

export interface ObsResourceRestorationLease {
  version: 1
  managedProfileName: string
  managedSceneCollectionName: string
  previousProfileName: string | null
  previousSceneCollectionName: string | null
  createdAt: string
  updatedAt: string
}

export interface CaptureDiscovery {
  targets: CaptureTarget[]
  audioDevices: AudioDevice[]
}

export interface ConfiguredCapture {
  configuration: CaptureConfiguration
  platform: CapturePlatform
  resources: ManagedResources
  selectedTarget: CaptureTarget | null
}

export interface RecordingTelemetry {
  active: boolean
  paused: boolean
  durationMs: number
  bytes: number
  availableDiskSpaceMb: number
  renderSkippedFrames: number
  renderTotalFrames: number
  outputSkippedFrames: number
  outputTotalFrames: number
}

export interface RecordingArtifact {
  path: string
  size: number
}

export type SessionManifestState =
  | 'configuring'
  | 'ready'
  | 'start-intent'
  | 'recording'
  | 'stop-intent'
  | 'finalizing'
  | 'complete'
  | 'interrupted'
  | 'failed'

export interface SessionManifest {
  version: 1
  sessionId: string
  state: SessionManifestState
  recordDirectory: string
  outputPaths: string[]
  profileName: string
  sceneCollectionName: string
  previousProfileName: string | null
  previousSceneCollectionName: string | null
  platform: CapturePlatform
  configuration: CaptureConfiguration
  windowInputUuid: string
  microphoneInputUuid: string | null
  systemAudioInputUuid: string | null
  startedAt: string | null
  stopRequestedAt: string | null
  completedAt: string | null
  lastDurationMs: number
  lastBytes: number
  error: string | null
  updatedAt: string
}

export interface RecoveryResult {
  manifest: SessionManifest
  action: 'reattached' | 'finalized' | 'interrupted' | 'failed' | 'ownership-conflict' | 'none'
  artifacts: RecordingArtifact[]
}

export interface ObsExecutable {
  command: string
  args: string[]
  cwd?: string
  kind: 'native' | 'flatpak'
}

export interface LoggerLike {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void
  info(message: string, context?: Readonly<Record<string, unknown>>): void
  warn(message: string, context?: Readonly<Record<string, unknown>>): void
  error(message: string, context?: Readonly<Record<string, unknown>>): void
}

export const silentLogger: LoggerLike = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}
