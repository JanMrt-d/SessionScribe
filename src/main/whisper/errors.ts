export type ManagedWhisperErrorCode =
  | 'UNSUPPORTED'
  | 'DOCKER_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'NOT_INSTALLED'
  | 'CONTAINER_CONFLICT'
  | 'INSUFFICIENT_DISK_SPACE'
  | 'INSTALL_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'INTEGRITY_FAILED'
  | 'START_FAILED'
  | 'STOP_FAILED'
  | 'BUSY'
  | 'CANCELLED'

export class ManagedWhisperError extends Error {
  constructor(
    readonly code: ManagedWhisperErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ManagedWhisperError'
  }
}

export function managedWhisperCancelled(reason?: unknown): ManagedWhisperError {
  return new ManagedWhisperError('CANCELLED', 'The Whisper operation was cancelled.', {
    cause: reason
  })
}

export function throwIfWhisperCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw managedWhisperCancelled(signal.reason)
}
