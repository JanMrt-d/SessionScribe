export type ManagedDiarizationErrorCode =
  | 'UNSUPPORTED'
  | 'DOCKER_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'NOT_INSTALLED'
  | 'CONTAINER_CONFLICT'
  | 'INSUFFICIENT_DISK_SPACE'
  | 'INSTALL_FAILED'
  | 'BUILD_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'INTEGRITY_FAILED'
  | 'START_FAILED'
  | 'STOP_FAILED'
  | 'REQUEST_FAILED'
  | 'BUSY'
  | 'CANCELLED'

export class ManagedDiarizationError extends Error {
  constructor(
    readonly code: ManagedDiarizationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ManagedDiarizationError'
  }
}

export function managedDiarizationCancelled(reason?: unknown): ManagedDiarizationError {
  return new ManagedDiarizationError('CANCELLED', 'The diarization operation was cancelled.', {
    cause: reason
  })
}

export function throwIfDiarizationCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw managedDiarizationCancelled(signal.reason)
}
