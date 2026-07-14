import type { ProviderContext } from './contracts'
import { ProviderError, type ProviderOperation } from './errors'
import type { ProviderProfileV1 } from '@shared/providers'

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const FORBIDDEN_LITERAL_HEADER =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|xi-api-key|x-goog-api-key|.*(?:token|secret|password).*)$/i
const FORBIDDEN_MANAGED_HEADER =
  /^(?:host|content-type|content-length|connection|transfer-encoding|upgrade|te|trailer)$/i

export interface HttpCredentialOptions {
  providerKind: string
  operation: ProviderOperation
  apiKeyHeader?: string
  apiKeyScheme?: string
  requireApiKey?: boolean
}

type HttpProviderProfile = Exclude<
  ProviderProfileV1,
  { kind: 'local-cli' | 'managed-whisper' }
>

export function httpCredentialOptionsFor(profile: HttpProviderProfile): HttpCredentialOptions {
  switch (profile.kind) {
    case 'elevenlabs':
      return {
        providerKind: profile.kind,
        operation: 'transcribe',
        apiKeyHeader: 'xi-api-key',
        requireApiKey: true
      }
    case 'openai-transcription':
      return {
        providerKind: profile.kind,
        operation: 'transcribe',
        apiKeyHeader: 'Authorization',
        apiKeyScheme: 'Bearer'
      }
    case 'openai-compatible':
    case 'ollama':
      return {
        providerKind: profile.kind,
        operation: 'summarize',
        apiKeyHeader: 'Authorization',
        apiKeyScheme: 'Bearer'
      }
  }
}

export function validateHttpHeaderConfiguration(
  extraHeaders: Readonly<Record<string, string>>,
  secretNames: readonly string[],
  options: HttpCredentialOptions,
  secretValues: Readonly<Record<string, string>> = {}
): void {
  const headers = new Headers()
  for (const [name, value] of Object.entries(extraHeaders)) {
    assertHeader(name, value, options, false)
    headers.set(name, value)
  }

  const names = new Set(secretNames)
  if (names.has('apiKey')) {
    if (!options.apiKeyHeader) {
      throw invalidConfig(
        options.providerKind,
        options.operation,
        'This provider does not accept an apiKey secret reference'
      )
    }
    assertHeader(options.apiKeyHeader, secretValues.apiKey ?? 'configured-secret', options, true)
    headers.set(options.apiKeyHeader, 'configured-secret')
  } else if (options.apiKeyHeader && options.requireApiKey === true) {
    throw new ProviderError('SECRET_MISSING', 'An API key is required for this provider', {
      providerKind: options.providerKind,
      operation: options.operation,
      stage: 'preflight'
    })
  }

  for (const key of names) {
    if (key === 'apiKey') continue
    if (!key.startsWith('header:')) {
      throw invalidConfig(
        options.providerKind,
        options.operation,
        `Unsupported HTTP secret reference key: ${key}`
      )
    }
    const name = key.slice('header:'.length)
    assertHeader(name, secretValues[key] ?? 'configured-secret', options, true)
    if (headers.has(name)) {
      throw invalidConfig(
        options.providerKind,
        options.operation,
        `Header ${name} is configured more than once`
      )
    }
    headers.set(name, 'configured-secret')
  }
}

export function resolveSecureEndpoint(
  baseUrl: string,
  relativePath: string,
  context: ProviderContext,
  providerKind: string,
  operation: ProviderOperation
): URL {
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch (cause) {
    throw invalidConfig(providerKind, operation, 'The provider base URL is invalid', cause)
  }

  if (base.username || base.password) {
    throw invalidConfig(providerKind, operation, 'Credentials are not allowed in provider URLs')
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw invalidConfig(providerKind, operation, 'Provider URLs must use HTTP or HTTPS')
  }
  if (
    base.protocol === 'http:' &&
    !isLoopbackHostname(base.hostname) &&
    context.allowInsecureRemoteHttp !== true
  ) {
    throw invalidConfig(
      providerKind,
      operation,
      'Remote provider URLs must use HTTPS; plaintext HTTP requires an explicit runtime opt-in'
    )
  }

  const suffix = relativePath.replace(/^\/+/, '')
  const prefix = base.pathname.replace(/\/+$/, '')
  base.pathname = suffix ? `${prefix}/${suffix}` : prefix || '/'
  base.hash = ''
  return base
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (normalized === 'localhost' || normalized === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized)
  if (!match) return false
  const octets = match.slice(1).map(Number)
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127
}

export async function resolveHttpHeaders(
  extraHeaders: Readonly<Record<string, string>>,
  secretRefs: Readonly<Record<string, string>>,
  context: ProviderContext,
  options: HttpCredentialOptions
): Promise<Headers> {
  validateHttpHeaderConfiguration(extraHeaders, Object.keys(secretRefs), options)
  const headers = new Headers()
  for (const [name, value] of Object.entries(extraHeaders)) {
    assertHeader(name, value, options, false)
    headers.set(name, value)
  }

  const apiKeyRef = secretRefs.apiKey
  if (apiKeyRef !== undefined) {
    if (!options.apiKeyHeader) {
      throw invalidConfig(
        options.providerKind,
        options.operation,
        'This provider does not accept an apiKey secret reference'
      )
    }
    const value = await resolveRequiredSecret(apiKeyRef, context, options)
    assertHeader(options.apiKeyHeader, value, options, true)
    const prefix = options.apiKeyScheme ? `${options.apiKeyScheme} ` : ''
    headers.set(options.apiKeyHeader, `${prefix}${value}`)
  } else if (options.apiKeyHeader && options.requireApiKey === true) {
    throw new ProviderError('SECRET_MISSING', 'An API key is required for this provider', {
      providerKind: options.providerKind,
      operation: options.operation,
      stage: 'preflight'
    })
  }

  for (const [key, reference] of Object.entries(secretRefs)) {
    if (key === 'apiKey') continue
    if (!key.startsWith('header:')) {
      throw invalidConfig(
        options.providerKind,
        options.operation,
        `Unsupported HTTP secret reference key: ${key}`
      )
    }
    const name = key.slice('header:'.length)
    const value = await resolveRequiredSecret(reference, context, options)
    assertHeader(name, value, options, true)
    if (headers.has(name)) {
      throw invalidConfig(
        options.providerKind,
        options.operation,
        `Header ${name} is configured more than once`
      )
    }
    headers.set(name, value)
  }
  return headers
}

async function resolveRequiredSecret(
  reference: string,
  context: ProviderContext,
  options: HttpCredentialOptions
): Promise<string> {
  if (!reference) {
    throw invalidConfig(
      options.providerKind,
      options.operation,
      'Secret references cannot be empty'
    )
  }
  const value = await context.secrets.get(reference, context.signal)
  if (!value) {
    throw new ProviderError('SECRET_MISSING', 'A configured provider secret is unavailable', {
      providerKind: options.providerKind,
      operation: options.operation,
      stage: 'preflight'
    })
  }
  return value
}

function assertHeader(
  name: string,
  value: string,
  options: HttpCredentialOptions,
  fromSecret: boolean
): void {
  if (!HEADER_NAME.test(name) || FORBIDDEN_MANAGED_HEADER.test(name)) {
    throw invalidConfig(options.providerKind, options.operation, `Header ${name} is not allowed`)
  }
  if (!fromSecret && FORBIDDEN_LITERAL_HEADER.test(name)) {
    throw invalidConfig(
      options.providerKind,
      options.operation,
      `Sensitive header ${name} must be backed by a secret reference`
    )
  }
  if (/[\r\n\0]/.test(value)) {
    throw invalidConfig(options.providerKind, options.operation, `Header ${name} is invalid`)
  }
}

function invalidConfig(
  providerKind: string,
  operation: ProviderOperation,
  message: string,
  cause?: unknown
): ProviderError {
  return new ProviderError('INVALID_CONFIG', message, {
    providerKind,
    operation,
    stage: 'preflight',
    ...(cause === undefined ? {} : { cause })
  })
}
