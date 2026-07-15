import type { Job, SessionStatus } from '@shared/domain'

export function formatDuration(milliseconds: number | null | undefined): string {
  const totalSeconds = Math.max(0, Math.floor((milliseconds ?? 0) / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(iso))
}

export function formatDateOnly(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(new Date(iso))
}

export function statusLabel(status: SessionStatus): string {
  const labels: Record<SessionStatus, string> = {
    draft: 'Draft',
    configuring: 'Configuring',
    'ready-to-record': 'Ready to record',
    recording: 'Recording',
    finalizing: 'Finalizing',
    processing: 'Processing',
    ready: 'Ready',
    interrupted: 'Interrupted',
    failed: 'Needs attention'
  }
  return labels[status]
}

export function jobStageLabel(stage: Job['stage']): string {
  const labels: Record<Job['stage'], string> = {
    probe: 'Inspect media',
    'playback-proxy': 'Prepare playback',
    'extract-audio': 'Extract audio',
    transcribe: 'Transcribe',
    diarize: 'Identify speakers',
    summarize: 'Create summary',
    export: 'Export'
  }
  return labels[stage]
}

export function initials(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean)
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')
}

export function toDateTimeLocal(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export function fromDateTimeLocal(value: string): string | null {
  if (!value) return null
  return new Date(value).toISOString()
}
