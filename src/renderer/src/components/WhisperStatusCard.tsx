import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  Cpu,
  Download,
  LoaderCircle,
  Play,
  X
} from 'lucide-react'
import type { ManagedWhisperStatus } from '@shared/whisper'
import { formatBytes } from '../lib/format'
import { Button } from './ui'

export type WhisperAction = 'install' | 'cancel' | 'start' | 'stop' | null

interface WhisperStatusCardProps {
  status: ManagedWhisperStatus | null
  action: WhisperAction
  compact?: boolean
  onInstall(): Promise<void>
  onCancelInstall(): Promise<void>
  onStart(): Promise<void>
  onStop(): Promise<void>
}

export function WhisperStatusCard({
  status,
  action,
  compact = false,
  onInstall,
  onCancelInstall,
  onStart,
  onStop
}: WhisperStatusCardProps): React.JSX.Element {
  const idleCountdown = useIdleCountdown(status?.idleStopAt ?? null)
  const phase = status?.phase ?? 'starting'
  const installing = phase === 'installing' || action === 'install'
  const presentation = whisperPresentation(status, idleCountdown)
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
      aria-label="Local Whisper"
    >
      <div className="whisper-card__heading">
        <span className="whisper-card__icon" aria-hidden="true">
          {presentation.icon}
        </span>
        <div>
          <strong>Local Whisper</strong>
          <span aria-live="polite">{presentation.label}</span>
        </div>
      </div>

      {!compact ? (
        <>
          <p>{status?.message ?? 'Checking the managed Whisper service…'}</p>
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
            aria-label="Whisper installation progress"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(progressPercent === null ? {} : { 'aria-valuenow': progressPercent })}
          >
            <i style={progressPercent === null ? undefined : { width: `${progressPercent}%` }} />
          </div>
          {!compact && progress.completedBytes !== null && progress.totalBytes !== null ? (
            <small>
              {formatBytes(progress.completedBytes)} of {formatBytes(progress.totalBytes)}
            </small>
          ) : null}
        </div>
      ) : null}

      <WhisperActionButton
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

function WhisperActionButton({
  status,
  action,
  installing,
  onInstall,
  onCancelInstall,
  onStart,
  onStop
}: Omit<WhisperStatusCardProps, 'compact'> & { installing: boolean }): React.JSX.Element | null {
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
        {status.installed ? 'Repair setup' : 'Set up Whisper'}
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
        Stop Whisper
      </Button>
    )
  }

  if (status?.canStart) {
    return (
      <Button size="small" disabled={action !== null} onClick={() => void onStart()}>
        {action === 'start' ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
        Start Whisper
      </Button>
    )
  }

  return null
}

function whisperPresentation(
  status: ManagedWhisperStatus | null,
  idleCountdown: string | null
): { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger'; icon: React.ReactNode } {
  if (!status) {
    return {
      label: 'Checking service…',
      tone: 'neutral',
      icon: <LoaderCircle className="spin" size={16} />
    }
  }

  switch (status.phase) {
    case 'ready':
      return {
        label: idleCountdown ? `Ready · stops in ${idleCountdown}` : 'Ready · using VRAM',
        tone: 'success',
        icon: <CheckCircle2 size={16} />
      }
    case 'busy':
      return {
        label:
          status.activeTranscriptions === 1
            ? 'Transcribing audio'
            : `Transcribing ${status.activeTranscriptions} jobs`,
        tone: 'success',
        icon: <Cpu size={16} />
      }
    case 'stopped':
      return {
        label: 'Stopped · VRAM released',
        tone: 'neutral',
        icon: <Cpu size={16} />
      }
    case 'starting':
      return {
        label: 'Loading model into VRAM…',
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
        label: 'Installing local model…',
        tone: 'neutral',
        icon: <LoaderCircle className="spin" size={16} />
      }
    case 'not-installed':
      return {
        label: 'Not set up',
        tone: 'warning',
        icon: <Download size={16} />
      }
    case 'docker-unavailable':
      return {
        label: 'Docker unavailable',
        tone: 'warning',
        icon: <AlertTriangle size={16} />
      }
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
      return {
        label: 'Service needs attention',
        tone: 'danger',
        icon: <AlertTriangle size={16} />
      }
  }
}

function diagnosticGuidance(status: ManagedWhisperStatus | null): React.JSX.Element | null {
  switch (status?.phase) {
    case 'permission-denied':
      return (
        <small>
          Configure rootless Docker, or add your account to the Docker group and sign in again.
          Docker group access is equivalent to administrator access.
        </small>
      )
    case 'docker-unavailable':
      return <small>Install and start Docker, then reopen SessionScribe.</small>
    case 'unsupported':
      return (
        <small>Managed Vulkan Whisper currently requires a Linux x64 system with /dev/dri.</small>
      )
    case 'not-installed':
      return (
        <small>
          Setup downloads the pinned Large-v3 and VAD models once. Stopping the service keeps the
          files but releases GPU memory.
        </small>
      )
    default:
      return null
  }
}

function installStepLabel(step: NonNullable<ManagedWhisperStatus['progress']>['step']): string {
  const labels = {
    checking: 'Checking system',
    'pulling-image': 'Downloading container',
    'downloading-model': 'Downloading Large-v3',
    'downloading-vad': 'Downloading voice detection',
    'creating-container': 'Creating service'
  } satisfies Record<NonNullable<ManagedWhisperStatus['progress']>['step'], string>
  return labels[step]
}

function useIdleCountdown(idleStopAt: string | null): string | null {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!idleStopAt) return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [idleStopAt])

  if (!idleStopAt) return null
  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(idleStopAt) - now) / 1_000))
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
