import type { ProviderContext } from './contracts'
import {
  ProviderError,
  isAbortError,
  normalizeProviderError,
  providerErrorFromHttp,
  sanitizeProviderMessage,
  type ProviderOperation,
  type ProviderStage
} from './errors'

const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504])
export const DEFAULT_MAX_PROVIDER_RESPONSE_BYTES = 64 * 1_048_576
const MAX_PROVIDER_ERROR_RESPONSE_BYTES = 32 * 1_024

export interface FetchWithRetryOptions {
  providerKind: string
  operation: ProviderOperation
  stage?: ProviderStage
  timeoutMs: number
  context: ProviderContext
  makeRequest: (signal: AbortSignal, attempt: number) => Promise<string | URL> | string | URL
  makeInit: (signal: AbortSignal, attempt: number) => Promise<RequestInit> | RequestInit
  maxAttempts?: number
  maxResponseBytes?: number
}

export async function fetchWithRetry(options: FetchWithRetryOptions): Promise<Response> {
  const fetchImplementation = options.context.fetch ?? globalThis.fetch
  const maximumAttempts = Math.max(1, options.maxAttempts ?? 3)
  const maximumResponseBytes = responseByteLimit(options)
  const deadline = Date.now() + options.timeoutMs
  let lastError: ProviderError | undefined

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    throwIfCancelled(options)
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw timeoutError(options)
    const attemptSignal = createAttemptSignal(options.context.signal, remainingMs)

    try {
      const [input, init] = await Promise.all([
        options.makeRequest(attemptSignal.signal, attempt),
        options.makeInit(attemptSignal.signal, attempt)
      ])
      const response = await fetchImplementation(input, { ...init, signal: attemptSignal.signal })
      if (response.ok) {
        return await bufferSuccessfulResponse(
          response,
          maximumResponseBytes,
          attemptSignal.signal,
          options
        )
      }

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
      const requestId = getRequestId(response.headers)
      const message = await readProviderErrorMessage(response, attemptSignal.signal)
      const responseError = providerErrorFromHttp(
        options.providerKind,
        options.operation,
        response.status,
        message,
        {
          ...(requestId === undefined ? {} : { requestId }),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs })
        }
      )
      lastError = responseError
      if (!RETRYABLE_STATUSES.has(response.status) || attempt === maximumAttempts) {
        throw responseError
      }
      await delayForRetry(attempt, retryAfterMs, deadline, options.context.signal)
    } catch (error) {
      if (error instanceof ProviderError) {
        if (!error.retryable || attempt === maximumAttempts) throw error
        lastError = error
      } else if (attemptSignal.didTimeout()) {
        throw timeoutError(options, error)
      } else if (options.context.signal.aborted || isAbortError(error)) {
        throw cancelledError(options, error)
      } else {
        lastError = new ProviderError('NETWORK', 'The provider could not be reached', {
          providerKind: options.providerKind,
          operation: options.operation,
          stage: options.stage ?? 'request',
          retryable: true,
          cause: error
        })
        if (attempt === maximumAttempts) throw lastError
        await delayForRetry(attempt, undefined, deadline, options.context.signal)
      }
    } finally {
      attemptSignal.dispose()
    }
  }

  throw (
    lastError ??
    normalizeProviderError(new Error('Provider request failed'), {
      providerKind: options.providerKind,
      operation: options.operation,
      stage: options.stage ?? 'request'
    })
  )
}

export async function readJsonResponse(response: Response, providerKind: string): Promise<unknown> {
  try {
    return await response.json()
  } catch (cause) {
    throw new ProviderError('OUTPUT_INVALID', 'The provider returned invalid JSON', {
      providerKind,
      operation: inferOperation(providerKind),
      stage: 'parse',
      cause
    })
  }
}

export async function readTextResponse(response: Response, providerKind: string): Promise<string> {
  try {
    return await response.text()
  } catch (cause) {
    throw new ProviderError('OUTPUT_INVALID', 'The provider response could not be read', {
      providerKind,
      operation: inferOperation(providerKind),
      stage: 'parse',
      cause
    })
  }
}

async function readProviderErrorMessage(response: Response, signal: AbortSignal): Promise<string> {
  const fallback = `Provider request failed with HTTP ${response.status}`
  let body: string
  try {
    const limited = await readResponseBodyLimited(
      response,
      MAX_PROVIDER_ERROR_RESPONSE_BYTES,
      signal
    )
    body = new TextDecoder().decode(limited.bytes)
  } catch (error) {
    if (signal.aborted) throw error
    return fallback
  }
  if (!body) return fallback
  try {
    const parsed: unknown = JSON.parse(body)
    const nested = readStringPath(parsed, ['error', 'message'])
    const direct = readStringPath(parsed, ['message'])
    return sanitizeProviderMessage(nested ?? direct ?? fallback)
  } catch {
    return sanitizeProviderMessage(body.slice(0, 1_000))
  }
}

async function bufferSuccessfulResponse(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  options: FetchWithRetryOptions
): Promise<Response> {
  const contentLength = responseContentLength(response)
  if (contentLength !== undefined && contentLength > maximumBytes) {
    const error = responseTooLargeError(options, maximumBytes)
    await cancelResponseBody(response, error)
    throw error
  }
  const limited = await readResponseBodyLimited(response, maximumBytes, signal)
  if (limited.truncated) throw responseTooLargeError(options, maximumBytes)
  const body = [204, 205, 304].includes(response.status) ? null : limited.bytes
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

interface LimitedResponseBody {
  bytes: Uint8Array
  truncated: boolean
}

async function readResponseBodyLimited(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal
): Promise<LimitedResponseBody> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false }
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let cancellation: Promise<void> | null = null
  const cancelReader = (reason: unknown): Promise<void> => {
    cancellation ??= reader.cancel(reason).catch(() => undefined)
    return cancellation
  }
  const onAbort = (): void => {
    void cancelReader(signal.reason)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()

  try {
    while (true) {
      throwIfSignalAborted(signal)
      const { done, value } = await reader.read()
      throwIfSignalAborted(signal)
      if (done) return { bytes: concatenateChunks(chunks, totalBytes), truncated: false }
      if (value.byteLength === 0) continue
      const remainingBytes = maximumBytes - totalBytes
      if (value.byteLength > remainingBytes) {
        if (remainingBytes > 0) {
          chunks.push(value.slice(0, remainingBytes))
          totalBytes += remainingBytes
        }
        await cancelReader(new Error('Provider response body limit exceeded'))
        return { bytes: concatenateChunks(chunks, totalBytes), truncated: true }
      }
      chunks.push(value)
      totalBytes += value.byteLength
    }
  } catch (error) {
    await cancelReader(error)
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

function concatenateChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]?.byteLength === totalBytes) return chunks[0]
  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

async function cancelResponseBody(response: Response, reason: unknown): Promise<void> {
  try {
    await response.body?.cancel(reason)
  } catch {
    // The body may already be closed; the request still fails with the size error.
  }
}

function throwIfSignalAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Provider operation was cancelled', 'AbortError')
}

function responseContentLength(response: Response): number | undefined {
  const contentEncoding = response.headers.get('content-encoding')
  if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') return undefined
  const value = response.headers.get('content-length')
  if (value === null || !/^\d+$/.test(value)) return undefined
  const bytes = Number(value)
  return Number.isSafeInteger(bytes) ? bytes : undefined
}

function responseByteLimit(options: FetchWithRetryOptions): number {
  const limit = options.maxResponseBytes ?? DEFAULT_MAX_PROVIDER_RESPONSE_BYTES
  if (Number.isSafeInteger(limit) && limit > 0) return limit
  throw new ProviderError('INVALID_CONFIG', 'The provider response byte limit is invalid', {
    providerKind: options.providerKind,
    operation: options.operation,
    stage: 'preflight'
  })
}

function responseTooLargeError(
  options: FetchWithRetryOptions,
  maximumBytes: number
): ProviderError {
  return new ProviderError(
    'OUTPUT_INVALID',
    `The provider response exceeded the configured ${maximumBytes}-byte limit`,
    {
      providerKind: options.providerKind,
      operation: options.operation,
      stage: 'parse'
    }
  )
}

function readStringPath(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' ? current : undefined
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000)
  const timestamp = Date.parse(value)
  if (!Number.isNaN(timestamp)) return Math.min(Math.max(0, timestamp - Date.now()), 60_000)
  return undefined
}

function getRequestId(headers: Headers): string | undefined {
  return (
    headers.get('request-id') ??
    headers.get('x-request-id') ??
    headers.get('openai-request-id') ??
    undefined
  )
}

async function delayForRetry(
  attempt: number,
  retryAfterMs: number | undefined,
  deadline: number,
  signal: AbortSignal
): Promise<void> {
  const jitter = Math.floor(Math.random() * 100)
  const requested = retryAfterMs ?? Math.min(250 * 2 ** (attempt - 1) + jitter, 2_000)
  const delayMs = Math.min(requested, Math.max(0, deadline - Date.now()))
  if (delayMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Provider operation was cancelled', 'AbortError')
      )
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function createAttemptSignal(
  parent: AbortSignal,
  timeoutMs: number
): {
  signal: AbortSignal
  didTimeout: () => boolean
  dispose: () => void
} {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = (): void => controller.abort(parent.reason)
  parent.addEventListener('abort', onAbort, { once: true })
  if (parent.aborted) onAbort()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('Provider request timed out', 'TimeoutError'))
  }, timeoutMs)
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      parent.removeEventListener('abort', onAbort)
    }
  }
}

function throwIfCancelled(options: FetchWithRetryOptions): void {
  if (options.context.signal.aborted) throw cancelledError(options, options.context.signal.reason)
}

function timeoutError(options: FetchWithRetryOptions, cause?: unknown): ProviderError {
  return new ProviderError('TIMEOUT', 'The provider request timed out', {
    providerKind: options.providerKind,
    operation: options.operation,
    stage: options.stage ?? 'request',
    retryable: true,
    ...(cause === undefined ? {} : { cause })
  })
}

function cancelledError(options: FetchWithRetryOptions, cause?: unknown): ProviderError {
  return new ProviderError('CANCELLED', 'Provider operation was cancelled', {
    providerKind: options.providerKind,
    operation: options.operation,
    stage: options.stage ?? 'request',
    ...(cause === undefined ? {} : { cause })
  })
}

function inferOperation(providerKind: string): ProviderOperation {
  return ['elevenlabs', 'openai-transcription', 'managed-whisper'].includes(providerKind)
    ? 'transcribe'
    : 'summarize'
}
