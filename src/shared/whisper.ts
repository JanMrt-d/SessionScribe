export type ManagedWhisperPhase =
  | 'unsupported'
  | 'docker-unavailable'
  | 'permission-denied'
  | 'not-installed'
  | 'installing'
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'stopping'
  | 'error'

export type ManagedWhisperInstallStep =
  | 'checking'
  | 'pulling-image'
  | 'downloading-model'
  | 'downloading-vad'
  | 'creating-container'

export interface ManagedWhisperProgress {
  step: ManagedWhisperInstallStep
  completedBytes: number | null
  totalBytes: number | null
}

export interface ManagedWhisperStatus {
  phase: ManagedWhisperPhase
  message: string
  installed: boolean
  progress: ManagedWhisperProgress | null
  activeTranscriptions: number
  idleStopAt: string | null
  canInstall: boolean
  canStart: boolean
  canStop: boolean
}
