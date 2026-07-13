import { openAsBlob } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ElevenLabsProfileV1 } from './types'
import type { ProviderCapabilities } from '@shared/providers'
import type { TranscriptionAdapter, TranscriptionRequest, ProviderContext } from '../contracts'
import { providerNow, reportProgress } from '../contracts'
import { ProviderError, normalizeProviderError } from '../errors'
import { fetchWithRetry, readJsonResponse } from '../http'
import { normalizeTranscript, type RawTranscript, type RawTranscriptWord } from '../normalize'
import { httpCredentialOptionsFor, resolveHttpHeaders, resolveSecureEndpoint } from '../security'

const MAX_ELEVENLABS_BYTES = 3_000_000_000

export class ElevenLabsTranscriptionAdapter implements TranscriptionAdapter<ElevenLabsProfileV1> {
  readonly kind = 'elevenlabs' as const

  capabilities(): ProviderCapabilities {
    return {
      timestamps: true,
      diarization: true,
      structuredOutput: true,
      modelListing: false,
      maxInputBytes: MAX_ELEVENLABS_BYTES,
      maxDurationMs: null
    }
  }

  async transcribe(
    request: TranscriptionRequest,
    profile: ElevenLabsProfileV1,
    context: ProviderContext
  ) {
    try {
      reportProgress(context, { stage: 'preflight', progress: 0 })
      const file = await stat(request.filePath)
      if (!file.isFile()) throw new Error('The transcription input is not a file')
      if (file.size > MAX_ELEVENLABS_BYTES) {
        throw new ProviderError('PAYLOAD_TOO_LARGE', 'The file exceeds the provider upload limit', {
          providerKind: this.kind,
          operation: 'transcribe',
          stage: 'preflight'
        })
      }
      const endpoint = resolveSecureEndpoint(
        profile.baseUrl,
        elevenLabsPath(profile.baseUrl),
        context,
        this.kind,
        'transcribe'
      )
      const headers = await resolveHttpHeaders(
        profile.extraHeaders,
        profile.secretRefs,
        context,
        httpCredentialOptionsFor(profile)
      )

      reportProgress(context, { stage: 'upload', progress: 0.1 })
      const response = await fetchWithRetry({
        providerKind: this.kind,
        operation: 'transcribe',
        timeoutMs: profile.timeoutMs,
        context,
        makeRequest: () => endpoint,
        makeInit: async () => ({
          method: 'POST',
          headers,
          body: await makeElevenLabsForm(request, profile)
        })
      })
      reportProgress(context, { stage: 'parse', progress: 0.9 })
      const raw = parseElevenLabsTranscript(await readJsonResponse(response, this.kind))
      const language = profile.language ?? request.languageHint
      if (!raw.languages?.length && language) raw.languages = [language]
      const result = normalizeTranscript(raw, {
        sessionId: request.sessionId,
        sourceSha256: request.sourceSha256,
        durationMs: request.durationMs,
        providerKind: this.kind,
        model: profile.model,
        generatedAt: providerNow(context).toISOString()
      })
      reportProgress(context, { stage: 'parse', progress: 1 })
      return result
    } catch (error) {
      throw normalizeProviderError(error, {
        providerKind: this.kind,
        operation: 'transcribe',
        stage: 'parse'
      })
    }
  }
}

async function makeElevenLabsForm(
  request: TranscriptionRequest,
  profile: ElevenLabsProfileV1
): Promise<FormData> {
  const form = new FormData()
  form.append(
    'file',
    await openAsBlob(request.filePath, { type: request.mimeType }),
    basename(request.filePath)
  )
  form.append('model_id', profile.model)
  form.append('tag_audio_events', 'false')
  form.append('diarize', String(profile.diarize))
  form.append('timestamps_granularity', profile.timestampGranularity)
  const language = profile.language ?? request.languageHint
  if (language) form.append('language_code', language)
  if (profile.diarize && profile.numSpeakers !== null) {
    form.append('num_speakers', String(profile.numSpeakers))
  }
  for (const keyterm of validateKeyterms(request.glossary ?? [])) {
    form.append('keyterms', keyterm)
  }
  return form
}

function validateKeyterms(input: readonly string[]): string[] {
  return input
    .map((term) => term.trim())
    .filter(
      (term) =>
        term.length > 0 &&
        term.length < 50 &&
        term.split(/\s+/).length <= 5 &&
        ![...term].some((character) => '<>{}[]\\'.includes(character))
    )
    .slice(0, 1_000)
}

export function parseElevenLabsTranscript(value: unknown): RawTranscript {
  const object = record(value)
  const inputWords = array(object.words)
  const words: RawTranscriptWord[] = []
  let audioEventCount = 0
  for (const item of inputWords) {
    const word = record(item)
    const type = string(word.type)
    if (type === 'audio_event') {
      audioEventCount += 1
      continue
    }
    if (type === 'spacing') continue
    const text = string(word.text)
    const start = number(word.start)
    const end = number(word.end)
    if (text === undefined || start === undefined || end === undefined) continue
    const logprob = number(word.logprob)
    const speakerLabel = string(word.speaker_id)
    words.push({
      text,
      startMs: start * 1_000,
      endMs: end * 1_000,
      ...(speakerLabel === undefined ? {} : { speakerLabel }),
      ...(logprob === undefined ? {} : { confidence: Math.exp(logprob) })
    })
  }
  const language = string(object.language_code)
  const transcriptText = string(object.text)
  return {
    ...(transcriptText === undefined ? {} : { text: transcriptText }),
    ...(language === undefined ? {} : { languages: [language] }),
    words,
    warnings: audioEventCount
      ? [`${audioEventCount} non-speech audio event(s) were omitted from the canonical transcript.`]
      : []
  }
}

function elevenLabsPath(baseUrl: string): string {
  const path = new URL(baseUrl).pathname.replace(/\/+$/, '')
  if (path.endsWith('/v1/speech-to-text')) return ''
  return path.endsWith('/v1') ? 'speech-to-text' : 'v1/speech-to-text'
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
