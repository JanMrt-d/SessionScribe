export type ManagedDiarizationPhase =
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

export type ManagedDiarizationInstallStep =
  'checking' | 'building-image' | 'downloading-models' | 'creating-container'

export interface ManagedDiarizationProgress {
  step: ManagedDiarizationInstallStep
  completedBytes: number | null
  totalBytes: number | null
}

export interface ManagedDiarizationStatus {
  phase: ManagedDiarizationPhase
  message: string
  installed: boolean
  progress: ManagedDiarizationProgress | null
  activeJobs: number
  idleStopAt: string | null
  canInstall: boolean
  canStart: boolean
  canStop: boolean
}

export interface DiarizationSegment {
  startMs: number
  endMs: number
  speaker: string
}
