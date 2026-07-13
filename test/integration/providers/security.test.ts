import { describe, expect, it, vi } from 'vitest'
import {
  ProviderError,
  fetchWithRetry,
  providerErrorFromHttp,
  resolveHttpHeaders,
  resolveSecureEndpoint,
  sanitizeProviderMessage
} from '@main/providers'
import { providerContext, startFixtureServer } from './helpers'

describe('provider transport security', () => {
  it('requires HTTPS for non-loopback endpoints unless the runtime opts in', () => {
    expect(() =>
      resolveSecureEndpoint(
        'http://example.com/v1',
        'responses',
        providerContext(),
        'openai-compatible',
        'summarize'
      )
    ).toThrowError(ProviderError)

    const endpoint = resolveSecureEndpoint(
      'http://127.0.0.1:11434',
      'api/chat',
      providerContext(),
      'ollama',
      'summarize'
    )
    expect(endpoint.toString()).toBe('http://127.0.0.1:11434/api/chat')

    const exactEndpoint = resolveSecureEndpoint(
      'http://127.0.0.1:11434/api/chat',
      '',
      providerContext(),
      'ollama',
      'summarize'
    )
    expect(exactEndpoint.toString()).toBe('http://127.0.0.1:11434/api/chat')

    const versionedEndpoint = resolveSecureEndpoint(
      'https://example.com/openai?api-version=2026-06-01',
      'responses',
      providerContext(),
      'openai-compatible',
      'summarize'
    )
    expect(versionedEndpoint.searchParams.get('api-version')).toBe('2026-06-01')
  })

  it('redacts credentials and distinguishes exhausted quota from a transient limit', () => {
    expect(sanitizeProviderMessage('Authorization: Bearer sk-abcdefghijklmnop')).toBe(
      'Authorization: [redacted]'
    )
    expect(
      providerErrorFromHttp('openai-compatible', 'summarize', 429, 'Billing quota exhausted')
    ).toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: false })
  })

  it('rejects literal credentials and resolves secret-backed headers', async () => {
    await expect(
      resolveHttpHeaders({ Authorization: 'Bearer literal-secret' }, {}, providerContext(), {
        providerKind: 'openai-compatible',
        operation: 'summarize'
      })
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' })

    const headers = await resolveHttpHeaders(
      { 'X-Organization': 'example' },
      { apiKey: 'keychain:provider', 'header:X-Tenant-Token': 'keychain:tenant' },
      providerContext({ 'keychain:provider': 'secret-key', 'keychain:tenant': 'tenant-secret' }),
      {
        providerKind: 'openai-compatible',
        operation: 'summarize',
        apiKeyHeader: 'Authorization',
        apiKeyScheme: 'Bearer'
      }
    )
    expect(headers.get('Authorization')).toBe('Bearer secret-key')
    expect(headers.get('X-Tenant-Token')).toBe('tenant-secret')
  })

  it('retries transient HTTP failures with a fresh request', async () => {
    let attempts = 0
    const fixture = await startFixtureServer((_request, response) => {
      attempts += 1
      if (attempts === 1) {
        response.statusCode = 503
        response.end(JSON.stringify({ error: { message: 'try again' } }))
      } else {
        response.setHeader('content-type', 'application/json')
        response.end('{}')
      }
    })
    try {
      const response = await fetchWithRetry({
        providerKind: 'openai-compatible',
        operation: 'summarize',
        timeoutMs: 3_000,
        context: providerContext(),
        makeRequest: () => fixture.baseUrl,
        makeInit: () => ({ method: 'POST', body: '{}' })
      })
      expect(response.status).toBe(200)
      expect(attempts).toBe(2)
    } finally {
      await fixture.close()
    }
  })

  it('keeps cancellation active while consuming a successful response body', async () => {
    const fixture = await startFixtureServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"still":"streaming"')
    })
    const controller = new AbortController()
    try {
      const pending = fetchWithRetry({
        providerKind: 'openai-compatible',
        operation: 'summarize',
        timeoutMs: 3_000,
        context: { ...providerContext(), signal: controller.signal },
        makeRequest: () => fixture.baseUrl,
        makeInit: () => ({ method: 'POST', body: '{}' }),
        maxAttempts: 1
      })
      setTimeout(() => controller.abort(), 20)
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    } finally {
      await fixture.close()
    }
  })

  it('rejects and cancels successful response bodies over the configured limit', async () => {
    const onCancel = vi.fn()
    const response = streamingResponse(['1234', '5'], 200, onCancel)
    const fetchImplementation = (async () => response) as typeof globalThis.fetch

    await expect(
      fetchWithRetry({
        providerKind: 'openai-compatible',
        operation: 'summarize',
        timeoutMs: 3_000,
        context: { ...providerContext(), fetch: fetchImplementation },
        makeRequest: () => 'https://provider.example/v1/responses',
        makeInit: () => ({ method: 'POST', body: '{}' }),
        maxAttempts: 1,
        maxResponseBytes: 4
      })
    ).rejects.toMatchObject({ code: 'OUTPUT_INVALID', stage: 'parse', retryable: false })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('cancels the response reader when the parent signal aborts', async () => {
    const onCancel = vi.fn()
    const response = streamingResponse(['{"still":"streaming"'], 200, onCancel)
    const fetchImplementation = (async () => response) as typeof globalThis.fetch
    const controller = new AbortController()
    const pending = fetchWithRetry({
      providerKind: 'openai-compatible',
      operation: 'summarize',
      timeoutMs: 3_000,
      context: { ...providerContext(), fetch: fetchImplementation, signal: controller.signal },
      makeRequest: () => 'https://provider.example/v1/responses',
      makeInit: () => ({ method: 'POST', body: '{}' }),
      maxAttempts: 1
    })

    setTimeout(() => controller.abort(), 0)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('caps and cancels oversized HTTP error bodies while preserving HTTP classification', async () => {
    const onCancel = vi.fn()
    const response = streamingResponse([`unauthorized ${'x'.repeat(40_000)}`], 401, onCancel)
    const fetchImplementation = (async () => response) as typeof globalThis.fetch

    await expect(
      fetchWithRetry({
        providerKind: 'openai-compatible',
        operation: 'summarize',
        timeoutMs: 3_000,
        context: { ...providerContext(), fetch: fetchImplementation },
        makeRequest: () => 'https://provider.example/v1/responses',
        makeInit: () => ({ method: 'POST', body: '{}' }),
        maxAttempts: 1
      })
    ).rejects.toMatchObject({ code: 'AUTHENTICATION', httpStatus: 401, retryable: false })
    expect(onCancel).toHaveBeenCalledOnce()
  })
})

function streamingResponse(
  chunks: readonly string[],
  status: number,
  onCancel: () => void
): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      },
      cancel() {
        onCancel()
      }
    }),
    { status, headers: { 'content-type': 'application/json' } }
  )
}
