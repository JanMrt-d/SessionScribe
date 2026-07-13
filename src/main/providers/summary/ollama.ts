import type { ProviderCapabilities } from '@shared/providers'
import type { ProviderContext, SummaryAdapter, SummaryRequest } from '../contracts'
import { ProviderError, normalizeProviderError } from '../errors'
import { fetchWithRetry, readJsonResponse } from '../http'
import { httpCredentialOptionsFor, resolveHttpHeaders, resolveSecureEndpoint } from '../security'
import { createGroundedSummary, type SummaryTextGenerator } from './engine'
import type { OllamaSummaryProfileV1 } from './types'

export class OllamaSummaryAdapter implements SummaryAdapter<OllamaSummaryProfileV1> {
  readonly kind = 'ollama' as const

  capabilities(): ProviderCapabilities {
    return {
      timestamps: false,
      diarization: false,
      structuredOutput: true,
      modelListing: false,
      maxInputBytes: null,
      maxDurationMs: null
    }
  }

  async summarize(
    request: SummaryRequest,
    profile: OllamaSummaryProfileV1,
    context: ProviderContext
  ) {
    try {
      const endpoint = resolveSecureEndpoint(
        profile.baseUrl,
        ollamaPath(profile.baseUrl),
        context,
        this.kind,
        'summarize'
      )
      const headers = await resolveHttpHeaders(
        profile.extraHeaders,
        profile.secretRefs,
        context,
        httpCredentialOptionsFor(profile)
      )
      headers.set('Content-Type', 'application/json')
      const generate: SummaryTextGenerator = async (generation) => {
        const response = await fetchWithRetry({
          providerKind: this.kind,
          operation: 'summarize',
          timeoutMs: profile.timeoutMs,
          context,
          makeRequest: () => endpoint,
          makeInit: () => ({
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: profile.model,
              stream: false,
              messages: [
                { role: 'system', content: generation.systemPrompt },
                { role: 'user', content: generation.userPrompt }
              ],
              format: generation.jsonSchema,
              options: {
                num_ctx: profile.contextWindowTokens,
                temperature: 0,
                ...(profile.numPredict === null ? {} : { num_predict: profile.numPredict })
              }
            })
          })
        })
        const payload = record(await readJsonResponse(response, this.kind))
        const content = string(record(payload.message).content) ?? string(payload.response)
        if (!content) {
          throw new ProviderError('OUTPUT_INVALID', 'The Ollama response contained no text', {
            providerKind: this.kind,
            operation: 'summarize',
            stage: 'parse'
          })
        }
        return content
      }
      return await createGroundedSummary(request, context, {
        providerKind: this.kind,
        model: profile.model,
        contextWindowTokens: profile.contextWindowTokens,
        promptOverride:
          request.mode === 'meeting'
            ? profile.meetingPromptOverride
            : profile.lecturePromptOverride,
        generate
      })
    } catch (error) {
      throw normalizeProviderError(error, {
        providerKind: this.kind,
        operation: 'summarize',
        stage: 'parse'
      })
    }
  }
}

function ollamaPath(baseUrl: string): string {
  const path = new URL(baseUrl).pathname.replace(/\/+$/, '')
  return path.endsWith('/api/chat') ? '' : 'api/chat'
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
