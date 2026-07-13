export type ProviderErrorCode =
  | 'INVALID_CONFIG'
  | 'SECRET_MISSING'
  | 'AUTHENTICATION'
  | 'PERMISSION'
  | 'RATE_LIMIT'
  | 'QUOTA_EXCEEDED'
  | 'UNSUPPORTED_FEATURE'
  | 'INVALID_INPUT'
  | 'PAYLOAD_TOO_LARGE'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UNAVAILABLE'
  | 'PROVIDER_REJECTED'
  | 'OUTPUT_INVALID'
  | 'PROCESS_FAILED'
  | 'UNKNOWN'

export type ProviderOperation = 'transcribe' | 'summarize'
export type ProviderStage =
  'preflight' | 'upload' | 'request' | 'poll' | 'parse' | 'reduce' | 'process'

export interface ProviderErrorDetails {
  providerKind: string
  operation: ProviderOperation
  stage: ProviderStage
  retryable?: boolean
  httpStatus?: number
  providerRequestId?: string
  retryAfterMs?: number
  exitCode?: number
  cause?: unknown
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly providerKind: string
  readonly operation: ProviderOperation
  readonly stage: ProviderStage
  readonly retryable: boolean
  readonly httpStatus?: number
  readonly providerRequestId?: string
  readonly retryAfterMs?: number
  readonly exitCode?: number

  constructor(code: ProviderErrorCode, message: string, details: ProviderErrorDetails) {
    super(sanitizeProviderMessage(message), { cause: details.cause })
    this.name = 'ProviderError'
    this.code = code
    this.providerKind = details.providerKind
    this.operation = details.operation
    this.stage = details.stage
    this.retryable = details.retryable ?? false
    if (details.httpStatus !== undefined) this.httpStatus = details.httpStatus
    if (details.providerRequestId !== undefined) {
      this.providerRequestId = details.providerRequestId
    }
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs
    if (details.exitCode !== undefined) this.exitCode = details.exitCode
  }
}

const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b(?:sk|xi|sess)-[A-Za-z0-9_-]{12,}\b/g, replacement: '[redacted]' },
  { pattern: /\bBearer\s+[^\s,;]+/gi, replacement: '[redacted]' },
  {
    pattern: /([?&](?:key|token|api_key|access_token)=)[^&\s]+/gi,
    replacement: '$1[redacted]'
  },
  {
    pattern: /("?(?:authorization|api[-_]?key|token|password)"?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
    replacement: '$1[redacted]'
  }
]

export function sanitizeProviderMessage(message: string): string {
  let result = message.replace(/[\r\n\t]+/g, ' ').trim()
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result.slice(0, 1_000) || 'Provider operation failed'
}

export function providerErrorFromHttp(
  providerKind: string,
  operation: ProviderOperation,
  status: number,
  message: string,
  metadata: { requestId?: string; retryAfterMs?: number } = {}
): ProviderError {
  let code: ProviderErrorCode = 'PROVIDER_REJECTED'
  if (status === 401) code = 'AUTHENTICATION'
  else if (status === 403) code = 'PERMISSION'
  else if (status === 408) code = 'TIMEOUT'
  else if (status === 413) code = 'PAYLOAD_TOO_LARGE'
  else if (status === 429) {
    code = /\b(?:quota|billing|credit|spend limit)\b/i.test(message)
      ? 'QUOTA_EXCEEDED'
      : 'RATE_LIMIT'
  } else if (status >= 500) code = 'UNAVAILABLE'
  else if (status === 400 || status === 404 || status === 409 || status === 422) {
    code = 'INVALID_INPUT'
  }

  return new ProviderError(code, message, {
    providerKind,
    operation,
    stage: 'request',
    retryable: [408, 429, 502, 503, 504].includes(status) && code !== 'QUOTA_EXCEEDED',
    httpStatus: status,
    ...(metadata.requestId === undefined ? {} : { providerRequestId: metadata.requestId }),
    ...(metadata.retryAfterMs === undefined ? {} : { retryAfterMs: metadata.retryAfterMs })
  })
}

export function normalizeProviderError(
  error: unknown,
  details: Pick<ProviderErrorDetails, 'providerKind' | 'operation' | 'stage'>
): ProviderError {
  if (error instanceof ProviderError) return error
  if (isAbortError(error)) {
    return new ProviderError('CANCELLED', 'Provider operation was cancelled', {
      ...details,
      cause: error
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new ProviderError('UNKNOWN', message, { ...details, cause: error })
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
  )
}
