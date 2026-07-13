export class ObsSubsystemError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cause?: unknown
  ) {
    super(message, { cause })
    this.name = 'ObsSubsystemError'
  }
}

export class ObsTimeoutError extends ObsSubsystemError {
  constructor(operation: string, timeoutMs: number) {
    super('OBS_TIMEOUT', `${operation} did not complete within ${timeoutMs} ms`)
    this.name = 'ObsTimeoutError'
  }
}

export function isObsConnectionUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return error.code === -1 || error.code === 'ECONNREFUSED' || error.code === 'OBS_TIMEOUT'
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
