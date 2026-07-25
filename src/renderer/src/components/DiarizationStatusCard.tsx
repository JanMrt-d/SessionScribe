import {
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  Download,
  LoaderCircle,
  Play,
  Users,
  X
} from 'lucide-react'
import type { ManagedDiarizationStatus } from '@shared/diarization'
import { formatBytes } from '../lib/format'
import { Button } from './ui'

export type DiarizationAction = 'install' | 'cancel' | 'start' | 'stop' | null

interface DiarizationStatusCardProps {
  status: ManagedDiarizationStatus | null
  action: DiarizationAction
  compact?: boolean
  onInstall(): Promise<void>
  onCancelInstall(): Promise<void>
  onStart(): Promise<void>
  onStop(): Promise<void>
}

export function DiarizationStatusCard({
  status,
  action,
  compact = false,
  onInstall,
  onCancelInstall,
  onStart,
  onStop
}: DiarizationStatusCardProps): React.JSX.Element {
  const phase = status?.phase ?? 'starting'
  const installing = phase === 'installing' || action === 'install'
  const presentation = diarizationPresentation(status)
  const progress = status?.progress
  const progressPercent =
    progress?.completedBytes !== null &&
    progress?.completedBytes !== undefined &&
    progress.totalBytes !== null &&
    progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.completedBytes / progress.totalBytes) * 100))
      : null

  return (
    <section
      className={`whisper-card whisper-card--${compact ? 'compact' : 'full'} whisper-card--${presentation.tone}`}
      aria-label="Speaker identification"
    >
      <div className="whisper-card__heading">
        <span className="whisper-card__icon" aria-hidden="true">
          {presentation.icon}
        </span>
        <div>
          <strong>Speaker identification</strong>
          <span aria-live="polite">{presentation.label}</span>
        </div>
      </div>

      {!compact ? (
        <>
          <p>{status?.message ?? 'Checking the managed diarization service…'}</p>
          {diagnosticGuidance(status)}
        </>
      ) : null}

      {installing && progress ? (
        <div className="whisper-progress">
          <div>
            <span>{installStepLabel(progress.step)}</span>
            <span>
              {progressPercent !== null
                ? `${progressPercent}%`
                : progress.completedBytes !== null
                  ? formatBytes(progress.completedBytes)
                  : 'Working…'}
            </span>
          </div>
          <div
            className={`whisper-progress__track ${progressPercent === null ? 'is-indeterminate' : ''}`}
            role="progressbar"
            aria-label="Diarization installation progress"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(progressPercent === null ? {} : { 'aria-valuenow': progressPercent })}
          >
            <i style={progressPercent === null ? undefined : { width: `${progressPercent}%` }} />
          </div>
        </div>
      ) : null}

      <DiarizationActionButton
        status={status}
        action={action}
        installing={installing}
        onInstall={onInstall}
        onCancelInstall={onCancelInstall}
        onStart={onStart}
        onStop={onStop}
      />
    </section>
  )
}

function DiarizationActionButton({
  status,
  action,
  installing,
  onInstall,
  onCancelInstall,
  onStart,
  onStop
}: Omit<DiarizationStatusCardProps, 'compact'> & {
  installing: boolean
}): React.JSX.Element | null {
  if (installing) {
    return (
      <Button
        size="small"
        variant="ghost"
        disabled={action === 'cancel'}
        onClick={() => void onCancelInstall()}
      >
        {action === 'cancel' ? <LoaderCircle className="spin" size={14} /> : <X size={14} />}
        Cancel setup
      </Button>
    )
  }

  if (status?.canInstall) {
    return (
      <Button
        size="small"
        variant="primary"
        disabled={action !== null}
        onClick={() => void onInstall()}
      >
        {action === 'install' ? (
          <LoaderCircle className="spin" size={14} />
        ) : (
          <Download size={14} />
        )}
        {status.installed ? 'Repair setup' : 'Set up speakers'}
      </Button>
    )
  }

  if (status?.canStop) {
    return (
      <Button
        size="small"
        variant="danger"
        disabled={action !== null}
        onClick={() => void onStop()}
      >
        {action === 'stop' ? <LoaderCircle className="spin" size={14} /> : <CircleStop size={14} />}
        Stop service
      </Button>
    )
  }

  if (status?.canStart) {
    return (
      <Button size="small" disabled={action !== null} onClick={() => void onStart()}>
        {action === 'start' ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
        Start service
      </Button>
    )
  }

  return null
}

function diarizationPresentation(status: ManagedDiarizationStatus | null): {
  label: string
  tone: 'neutral' | 'success' | 'warning' | 'danger'
  icon: React.ReactNode
} {
  if (!status) {
    return {
      label: 'Checking service…',
      tone: 'neutral',
      icon: <LoaderCircle className="spin" size={16} />
    }
  }

  switch (status.phase) {
    case 'ready':
      return { label: 'Ready · using VRAM', tone: 'success', icon: <CheckCircle2 size={16} /> }
    case 'busy':
      return { label: 'Identifying speakers', tone: 'success', icon: <Users size={16} /> }
    case 'stopped':
      return { label: 'Stopped · VRAM released', tone: 'neutral', icon: <Users size={16} /> }
    case 'starting':
      return {
        label: 'Loading models into VRAM…',
        tone: 'neutral',
        icon: <LoaderCircle className="spin" size={16} />
      }
    case 'stopping':
      return {
        label: 'Releasing VRAM…',
        tone: 'neutral',
        icon: <LoaderCircle className="spin" size={16} />
      }
    case 'installing':
      return {
        label: 'Installing runtime…',
        tone: 'neutral',
        icon: <LoaderCircle className="spin" size={16} />
      }
    case 'not-installed':
      return { label: 'Not set up', tone: 'warning', icon: <Download size={16} /> }
    case 'docker-unavailable':
      return { label: 'Docker unavailable', tone: 'warning', icon: <AlertTriangle size={16} /> }
    case 'permission-denied':
      return {
        label: 'Docker permission required',
        tone: 'warning',
        icon: <AlertTriangle size={16} />
      }
    case 'unsupported':
      return {
        label: 'Unsupported on this system',
        tone: 'warning',
        icon: <AlertTriangle size={16} />
      }
    case 'error':
      return { label: 'Service needs attention', tone: 'danger', icon: <AlertTriangle size={16} /> }
  }
}

function diagnosticGuidance(status: ManagedDiarizationStatus | null): React.JSX.Element | null {
  switch (status?.phase) {
    case 'permission-denied':
      return (
        <small>
          Configure rootless Docker, or add your account to the Docker group and sign in again.
        </small>
      )
    case 'docker-unavailable':
      return <small>Install and start Docker, then reopen SessionScribe.</small>
    case 'unsupported':
      return (
        <small>
          Speaker identification currently requires a Linux x64 system with an AMD GPU (ROCm via
          /dev/kfd).
        </small>
      )
    case 'not-installed':
      return (
        <small>
          Setup builds the diarization runtime once (a large download) and fetches the pinned
          pyannote community-1 models. Meeting sessions then label who spoke when.
        </small>
      )
    default:
      return null
  }
}

function installStepLabel(step: NonNullable<ManagedDiarizationStatus['progress']>['step']): string {
  const labels = {
    checking: 'Checking system',
    'building-image': 'Building runtime (large download)',
    'downloading-models': 'Downloading speaker models',
    'creating-container': 'Creating service'
  } satisfies Record<NonNullable<ManagedDiarizationStatus['progress']>['step'], string>
  return labels[step]
}
