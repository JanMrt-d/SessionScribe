import { openAsBlob } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ProviderCapabilities } from '@shared/providers'
import type { ProviderContext, TranscriptionAdapter, TranscriptionRequest } from '../contracts'
import { providerNow, reportProgress } from '../contracts'
import { ProviderError, normalizeProviderError } from '../errors'
import { fetchWithRetry, readJsonResponse, readTextResponse } from '../http'
import {
  normalizeTranscript,
  type RawTranscript,
  type RawTranscriptUtterance,
  type RawTranscriptWord
} from '../normalize'
import { httpCredentialOptionsFor, resolveHttpHeaders, resolveSecureEndpoint } from '../security'
import type { OpenAiTranscriptionProfileV1 } from './types'

type OpenAiResponseFormat = Exclude<OpenAiTranscriptionProfileV1['responseFormat'], 'auto'>

export interface OpenAiCompatibleTranscriptionOptions {
  providerKind: string
  baseUrl: string
  model: string
  language: string | null
  responseFormat: OpenAiResponseFormat
  maxUploadBytes: number
  timeoutMs: number
  headers: Headers
}

export class OpenAiTranscriptionAdapter implements TranscriptionAdapter<OpenAiTranscriptionProfileV1> {
  readonly kind = 'openai-transcription' as const

  capabilities(profile: OpenAiTranscriptionProfileV1): ProviderCapabilities {
    const responseFormat = chooseResponseFormat(profile)
    return {
      timestamps: responseFormat === 'verbose_json' || responseFormat === 'diarized_json',
      diarization: responseFormat === 'diarized_json',
      structuredOutput: true,
      modelListing: false,
      maxInputBytes: profile.maxUploadBytes,
      maxDurationMs: null
    }
  }

  async transcribe(
    request: TranscriptionRequest,
    profile: OpenAiTranscriptionProfileV1,
    context: ProviderContext
  ) {
    try {
      const responseFormat = chooseResponseFormat(profile)
      const headers = await resolveHttpHeaders(
        profile.extraHeaders,
        profile.secretRefs,
        context,
        httpCredentialOptionsFor(profile)
      )
      return await transcribeOpenAiCompatible(request, context, {
        providerKind: this.kind,
        baseUrl: profile.baseUrl,
        model: profile.model,
        language: profile.language,
        responseFormat,
        maxUploadBytes: profile.maxUploadBytes,
        timeoutMs: profile.timeoutMs,
        headers
      })
    } catch (error) {
      throw normalizeProviderError(error, {
        providerKind: this.kind,
        operation: 'transcribe',
        stage: 'preflight'
      })
    }
  }
}

export async function transcribeOpenAiCompatible(
  request: TranscriptionRequest,
  context: ProviderContext,
  options: OpenAiCompatibleTranscriptionOptions
) {
  try {
    reportProgress(context, { stage: 'preflight', progress: 0 })
    const input = await stat(request.filePath)
    if (!input.isFile()) throw new Error('The transcription input is not a file')
    if (input.size > options.maxUploadBytes) {
      throw new ProviderError('PAYLOAD_TOO_LARGE', 'The file exceeds the configured upload limit', {
        providerKind: options.providerKind,
        operation: 'transcribe',
        stage: 'preflight'
      })
    }
    validateKnownSpeakers(request, options.responseFormat, options.providerKind)
    const endpoint = resolveSecureEndpoint(
      options.baseUrl,
      openAiTranscriptionPath(options.baseUrl),
      context,
      options.providerKind,
      'transcribe'
    )
    reportProgress(context, { stage: 'upload', progress: 0.1 })
    const response = await fetchWithRetry({
      providerKind: options.providerKind,
      operation: 'transcribe',
      timeoutMs: options.timeoutMs,
      context,
      makeRequest: () => endpoint,
      makeInit: async () => ({
        method: 'POST',
        headers: options.headers,
        body: await makeOpenAiForm(request, options, options.responseFormat)
      })
    })
    reportProgress(context, { stage: 'parse', progress: 0.9 })
    const raw: RawTranscript =
      options.responseFormat === 'text'
        ? { text: await readTextResponse(response, options.providerKind) }
        : parseOpenAiTranscript(await readJsonResponse(response, options.providerKind))
    if (request.knownSpeakers?.length) {
      raw.speakerDisplayNames = Object.fromEntries(
        request.knownSpeakers.map((speaker) => [speaker.speakerId, speaker.displayName])
      )
    }
    const language = options.language ?? request.languageHint
    if (!raw.languages?.length && language) raw.languages = [language]
    const result = normalizeTranscript(raw, {
      sessionId: request.sessionId,
      sourceSha256: request.sourceSha256,
      durationMs: request.durationMs,
      providerKind: options.providerKind,
      model: options.model,
      generatedAt: providerNow(context).toISOString()
    })
    reportProgress(context, { stage: 'parse', progress: 1 })
    return result
  } catch (error) {
    throw normalizeProviderError(error, {
      providerKind: options.providerKind,
      operation: 'transcribe',
      stage: 'parse'
    })
  }
}

function chooseResponseFormat(profile: OpenAiTranscriptionProfileV1): OpenAiResponseFormat {
  if (profile.responseFormat !== 'auto') return profile.responseFormat
  const model = profile.model.toLowerCase()
  if (model.includes('diarize')) return 'diarized_json'
  if (model.includes('whisper')) return 'verbose_json'
  return 'json'
}

async function makeOpenAiForm(
  request: TranscriptionRequest,
  profile: Pick<OpenAiCompatibleTranscriptionOptions, 'model' | 'language'>,
  responseFormat: OpenAiResponseFormat
): Promise<FormData> {
  const form = new FormData()
  form.append(
    'file',
    await openAsBlob(request.filePath, { type: request.mimeType }),
    basename(request.filePath)
  )
  form.append('model', profile.model)
  form.append('response_format', responseFormat)
  const language = profile.language ?? request.languageHint
  if (language) form.append('language', language)

  if (responseFormat === 'verbose_json') {
    form.append('timestamp_granularities[]', 'word')
  }
  if (responseFormat === 'diarized_json') {
    form.append('chunking_strategy', 'auto')
    for (const speaker of request.knownSpeakers ?? []) {
      const reference = await readFile(speaker.filePath)
      form.append('known_speaker_names[]', speaker.speakerId)
      form.append(
        'known_speaker_references[]',
        `data:${speaker.mimeType};base64,${reference.toString('base64')}`
      )
    }
  } else if (request.glossary?.length) {
    form.append(
      'prompt',
      request.glossary
        .map((term) => term.trim())
        .filter(Boolean)
        .join(', ')
        .slice(0, 1_500)
    )
  }
  return form
}

function validateKnownSpeakers(
  request: TranscriptionRequest,
  responseFormat: OpenAiResponseFormat,
  providerKind = 'openai-transcription'
): void {
  const speakers = request.knownSpeakers ?? []
  if (speakers.length === 0) return
  if (responseFormat !== 'diarized_json') {
    throw new ProviderError(
      'UNSUPPORTED_FEATURE',
      'Known-speaker references require diarized JSON output',
      {
        providerKind,
        operation: 'transcribe',
        stage: 'preflight'
      }
    )
  }
  if (
    speakers.length > 4 ||
    speakers.some((speaker) => speaker.durationMs < 2_000 || speaker.durationMs > 10_000) ||
    new Set(speakers.map((speaker) => speaker.speakerId)).size !== speakers.length ||
    speakers.some(
      (speaker) =>
        !/^[A-Za-z0-9_-]{1,64}$/.test(speaker.speakerId) ||
        !/^[\w.+-]+\/[\w.+-]+$/i.test(speaker.mimeType)
    )
  ) {
    throw new ProviderError(
      'INVALID_INPUT',
      'Known-speaker samples must have unique short IDs, valid MIME types, and durations between 2 and 10 seconds',
      {
        providerKind,
        operation: 'transcribe',
        stage: 'preflight'
      }
    )
  }
}

export function parseOpenAiTranscript(value: unknown): RawTranscript {
  if (typeof value === 'string') return { text: value }
  const object = record(value)
  const segments = array(object.segments)
  const utterances: RawTranscriptUtterance[] = segments.flatMap((item) => {
    const segment = record(item)
    const text = string(segment.text)
    const start = number(segment.start)
    const end = number(segment.end)
    if (text === undefined || start === undefined || end === undefined) return []
    const speakerLabel = string(segment.speaker)
    return [
      {
        text,
        startMs: start * 1_000,
        endMs: end * 1_000,
        ...(speakerLabel === undefined ? {} : { speakerLabel })
      }
    ]
  })
  const topLevelWords = array(object.words)
  const wordItems =
    topLevelWords.length > 0
      ? topLevelWords
      : segments.flatMap((item) => {
          const segment = record(item)
          const speaker = string(segment.speaker)
          return array(segment.words).map((word) =>
            speaker === undefined ? word : { ...record(word), speaker }
          )
        })
  const words: RawTranscriptWord[] = wordItems.flatMap((item) => {
    const word = record(item)
    const text = string(word.word) ?? string(word.text)
    const start = number(word.start)
    const end = number(word.end)
    if (text === undefined || start === undefined || end === undefined) return []
    const speaker = string(word.speaker) ?? speakerForTime(utterances, start * 1_000, end * 1_000)
    const logprob = number(word.logprob) ?? number(word.avg_logprob)
    const confidence =
      number(word.confidence) ?? (logprob === undefined ? undefined : Math.exp(logprob))
    return [
      {
        text,
        startMs: start * 1_000,
        endMs: end * 1_000,
        ...(speaker === undefined ? {} : { speakerLabel: speaker }),
        ...(confidence === undefined ? {} : { confidence })
      }
    ]
  })
  const language = string(object.language)
  const transcriptText = string(object.text)
  return {
    ...(transcriptText === undefined ? {} : { text: transcriptText }),
    ...(language === undefined ? {} : { languages: [language] }),
    words,
    utterances
  }
}

function speakerForTime(
  utterances: readonly RawTranscriptUtterance[],
  startMs: number,
  endMs: number
): string | undefined {
  return (
    utterances.find(
      (utterance) =>
        utterance.speakerLabel && utterance.startMs <= startMs && utterance.endMs >= endMs
    )?.speakerLabel ?? undefined
  )
}

function openAiTranscriptionPath(baseUrl: string): string {
  const path = new URL(baseUrl).pathname.replace(/\/+$/, '')
  return path.endsWith('/audio/transcriptions') ? '' : 'audio/transcriptions'
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

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
