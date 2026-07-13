import type { ProviderCapabilities } from '@shared/providers'
import type { ProviderContext, SummaryAdapter, SummaryRequest } from '../contracts'
import { ProviderError, normalizeProviderError } from '../errors'
import { fetchWithRetry, readJsonResponse } from '../http'
import { httpCredentialOptionsFor, resolveHttpHeaders, resolveSecureEndpoint } from '../security'
import {
  createGroundedSummary,
  type SummaryGenerationRequest,
  type SummaryTextGenerator
} from './engine'
import type { OpenAiSummaryProfileV1 } from './types'

const RESERVED_EXTRA_BODY_KEYS = new Set([
  'model',
  'messages',
  'instructions',
  'input',
  'text',
  'response_format',
  'stream'
])

export class OpenAiCompatibleSummaryAdapter implements SummaryAdapter<OpenAiSummaryProfileV1> {
  readonly kind = 'openai-compatible' as const

  capabilities(profile: OpenAiSummaryProfileV1): ProviderCapabilities {
    return {
      timestamps: false,
      diarization: false,
      structuredOutput: profile.structuredOutput !== 'prompt-only',
      modelListing: false,
      maxInputBytes: null,
      maxDurationMs: null
    }
  }

  async summarize(
    request: SummaryRequest,
    profile: OpenAiSummaryProfileV1,
    context: ProviderContext
  ) {
    try {
      assertExtraBody(profile)
      const endpoint = resolveSecureEndpoint(
        profile.baseUrl,
        openAiSummaryPath(profile.baseUrl, profile.apiStyle),
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
        const body = makeRequestBody(profile, generation)
        const response = await fetchWithRetry({
          providerKind: this.kind,
          operation: 'summarize',
          timeoutMs: profile.timeoutMs,
          context,
          makeRequest: () => endpoint,
          makeInit: () => ({ method: 'POST', headers, body: JSON.stringify(body) })
        })
        return extractGeneratedText(await readJsonResponse(response, this.kind), profile.apiStyle)
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

function makeRequestBody(
  profile: OpenAiSummaryProfileV1,
  generation: SummaryGenerationRequest
): Record<string, unknown> {
  const base = { ...profile.extraBody, model: profile.model, stream: false }
  if (profile.apiStyle === 'responses') {
    return {
      ...base,
      instructions: generation.systemPrompt,
      input: generation.userPrompt,
      ...(profile.structuredOutput === 'prompt-only'
        ? {}
        : {
            text: {
              format:
                profile.structuredOutput === 'json-schema'
                  ? {
                      type: 'json_schema',
                      name: generation.schemaName,
                      strict: true,
                      schema: generation.jsonSchema
                    }
                  : { type: 'json_object' }
            }
          })
    }
  }
  return {
    ...base,
    messages: [
      { role: 'system', content: generation.systemPrompt },
      { role: 'user', content: generation.userPrompt }
    ],
    ...(profile.structuredOutput === 'prompt-only'
      ? {}
      : {
          response_format:
            profile.structuredOutput === 'json-schema'
              ? {
                  type: 'json_schema',
                  json_schema: {
                    name: generation.schemaName,
                    strict: true,
                    schema: generation.jsonSchema
                  }
                }
              : { type: 'json_object' }
        })
  }
}

export function extractGeneratedText(
  value: unknown,
  apiStyle: OpenAiSummaryProfileV1['apiStyle']
): string {
  const object = record(value)
  if (apiStyle === 'responses') {
    const direct = string(object.output_text)
    if (direct) return direct
    for (const output of array(object.output)) {
      for (const content of array(record(output).content)) {
        const text = string(record(content).text)
        if (text) return text
      }
    }
  } else {
    const choice = record(array(object.choices)[0])
    const content = record(choice.message).content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const joined = content
        .map((part) => string(record(part).text) ?? '')
        .filter(Boolean)
        .join('')
      if (joined) return joined
    }
  }
  throw new ProviderError('OUTPUT_INVALID', 'The summary response did not contain generated text', {
    providerKind: 'openai-compatible',
    operation: 'summarize',
    stage: 'parse'
  })
}

function assertExtraBody(profile: OpenAiSummaryProfileV1): void {
  const reserved = Object.keys(profile.extraBody).find((key) => RESERVED_EXTRA_BODY_KEYS.has(key))
  if (reserved) {
    throw new ProviderError(
      'INVALID_CONFIG',
      `extraBody cannot override the managed field ${reserved}`,
      {
        providerKind: 'openai-compatible',
        operation: 'summarize',
        stage: 'preflight'
      }
    )
  }
}

function openAiSummaryPath(baseUrl: string, apiStyle: OpenAiSummaryProfileV1['apiStyle']): string {
  const suffix = apiStyle === 'responses' ? 'responses' : 'chat/completions'
  const path = new URL(baseUrl).pathname.replace(/\/+$/, '')
  return path.endsWith(`/${suffix}`) ? '' : suffix
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
