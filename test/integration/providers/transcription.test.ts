import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ElevenLabsTranscriptionAdapter,
  LocalCliTranscriptionAdapter,
  ManagedWhisperTranscriptionAdapter,
  OpenAiTranscriptionAdapter
} from '@main/providers'
import type { ManagedWhisperRuntime, TranscriptionRequest } from '@main/providers'
import type { TranscriptionProfileV1 } from '@shared/providers'
import {
  profileBase,
  providerContext,
  readRequestBody,
  startFixtureServer,
  type FixtureServer
} from './helpers'

const cleanupDirectories: string[] = []
const cleanupServers: FixtureServer[] = []

afterEach(async () => {
  await Promise.all(cleanupServers.splice(0).map((server) => server.close()))
  await Promise.all(
    cleanupDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('transcription providers', () => {
  it('maps ElevenLabs Scribe words and speakers to the canonical transcript', async () => {
    let receivedBody = ''
    let receivedKey: string | undefined
    const fixture = await startFixtureServer(async (httpRequest, response) => {
      receivedKey = httpRequest.headers['xi-api-key'] as string | undefined
      receivedBody = (await readRequestBody(httpRequest)).toString('utf8')
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          language_code: 'en',
          text: 'Hello world.',
          words: [
            {
              text: 'Hello',
              start: 0.1,
              end: 0.5,
              type: 'word',
              speaker_id: 'speaker_0',
              logprob: -0.1
            },
            { text: ' ', start: 0.5, end: 0.5, type: 'spacing', speaker_id: 'speaker_0' },
            {
              text: 'world.',
              start: 0.5,
              end: 1.1,
              type: 'word',
              speaker_id: 'speaker_0',
              logprob: -0.2
            }
          ]
        })
      )
    })
    cleanupServers.push(fixture)
    const input = await makeInputFile()
    const profile: Extract<TranscriptionProfileV1, { kind: 'elevenlabs' }> = {
      ...profileBase('scribe_v2-custom'),
      task: 'transcription',
      kind: 'elevenlabs',
      baseUrl: fixture.baseUrl,
      secretRefs: { apiKey: 'eleven-key' },
      language: null,
      diarize: true,
      numSpeakers: 2,
      timestampGranularity: 'word'
    }
    const transcript = await new ElevenLabsTranscriptionAdapter().transcribe(
      transcriptionRequest(input),
      profile,
      providerContext({ 'eleven-key': 'fixture-secret' })
    )

    expect(receivedKey).toBe('fixture-secret')
    expect(receivedBody).toContain('scribe_v2-custom')
    expect(receivedBody).toContain('architecture')
    expect(transcript.text).toBe('Hello world.')
    expect(transcript.words).toHaveLength(2)
    expect(transcript.speakers[0]?.label).toBe('speaker_0')
    expect(transcript.utterances[0]?.wordIds).toEqual(['word-1', 'word-2'])
  })

  it('supports arbitrary OpenAI-compatible transcription model IDs and diarized output', async () => {
    let receivedBody = ''
    let receivedPath = ''
    const fixture = await startFixtureServer(async (httpRequest, response) => {
      receivedPath = httpRequest.url ?? ''
      receivedBody = (await readRequestBody(httpRequest)).toString('utf8')
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          text: 'One. Two.',
          language: 'en',
          segments: [
            { text: 'One.', start: 0, end: 0.7, speaker: 'Alice' },
            { text: 'Two.', start: 0.8, end: 1.5, speaker: 'Bob' }
          ]
        })
      )
    })
    cleanupServers.push(fixture)
    const input = await makeInputFile()
    const profile: Extract<TranscriptionProfileV1, { kind: 'openai-transcription' }> = {
      ...profileBase('vendor/future-diarize-2030'),
      task: 'transcription',
      kind: 'openai-transcription',
      baseUrl: `${fixture.baseUrl}/custom/v9`,
      language: null,
      responseFormat: 'auto',
      maxUploadBytes: 1_000_000
    }
    const transcript = await new OpenAiTranscriptionAdapter().transcribe(
      transcriptionRequest(input),
      profile,
      providerContext()
    )

    expect(receivedPath).toBe('/custom/v9/audio/transcriptions')
    expect(receivedBody).toContain('vendor/future-diarize-2030')
    expect(receivedBody).toContain('diarized_json')
    // max_context is a whisper.cpp extension, so it must stay off the OpenAI path.
    expect(receivedBody).not.toContain('max_context')
    expect(transcript.utterances.map((utterance) => utterance.speakerId)).toEqual([
      'speaker-1',
      'speaker-2'
    ])
  })

  it('uses a managed Whisper lease and maps verbose JSON to a canonical transcript', async () => {
    let receivedBody = ''
    let receivedPath = ''
    let acquiredSignal: AbortSignal | undefined
    let releaseCount = 0
    const fixture = await startFixtureServer(async (httpRequest, response) => {
      receivedPath = httpRequest.url ?? ''
      receivedBody = (await readRequestBody(httpRequest)).toString('utf8')
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          text: 'Hallo Welt.',
          language: 'de',
          segments: [{ text: 'Hallo Welt.', start: 0.15, end: 1.4 }],
          words: [
            { word: 'Hallo', start: 0.15, end: 0.7, probability: 0.98 },
            { word: ' Welt.', start: 0.75, end: 1.4, probability: 0.97 }
          ]
        })
      )
    })
    cleanupServers.push(fixture)
    const input = await makeInputFile()
    const context = providerContext()
    const runtime: ManagedWhisperRuntime = {
      acquire: async (signal) => {
        acquiredSignal = signal
        return {
          endpoint: `${fixture.baseUrl}/v1`,
          release: async () => {
            releaseCount += 1
          }
        }
      }
    }

    const transcript = await new ManagedWhisperTranscriptionAdapter(runtime).transcribe(
      { ...transcriptionRequest(input), languageHint: 'en' },
      managedWhisperProfile('de'),
      context
    )

    expect(acquiredSignal).toBe(context.signal)
    expect(releaseCount).toBe(1)
    expect(receivedPath).toBe('/v1/audio/transcriptions')
    expect(receivedBody).toContain('name="model"')
    expect(receivedBody).toContain('large-v3')
    expect(receivedBody).toContain('name="response_format"')
    expect(receivedBody).toContain('verbose_json')
    expect(receivedBody).toContain('name="language"')
    expect(receivedBody).toContain('de')
    expect(receivedBody).toContain('name="timestamp_granularities[]"')
    expect(receivedBody).toContain('name="file"; filename="audio.wav"')
    // Carried decoder context lets a repeated phrase prime its own next window,
    // which strands long recordings in a loop of one sentence.
    expect(receivedBody).toMatch(/name="max_context"\r\n\r\n0\r\n/)
    expect(transcript.text).toBe('Hallo Welt.')
    expect(transcript.languages).toEqual(['de'])
    expect(transcript.utterances[0]).toMatchObject({ startMs: 150, endMs: 1_400 })
    expect(transcript.words.map((word) => [word.text, word.startMs, word.endMs])).toEqual([
      ['Hallo', 150, 700],
      [' Welt.', 750, 1_400]
    ])
    expect(transcript.provenance).toEqual({
      providerKind: 'managed-whisper',
      model: 'large-v3',
      generatedAt: '2026-01-01T00:00:00.000Z'
    })
  })

  it('releases the managed Whisper lease when the server rejects transcription', async () => {
    let releaseCount = 0
    const fixture = await startFixtureServer(async (httpRequest, response) => {
      await readRequestBody(httpRequest)
      response.statusCode = 400
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: { message: 'Invalid audio fixture' } }))
    })
    cleanupServers.push(fixture)
    const input = await makeInputFile()
    const runtime: ManagedWhisperRuntime = {
      acquire: async () => ({
        endpoint: `${fixture.baseUrl}/v1`,
        release: async () => {
          releaseCount += 1
        }
      })
    }

    await expect(
      new ManagedWhisperTranscriptionAdapter(runtime).transcribe(
        transcriptionRequest(input),
        managedWhisperProfile(null),
        providerContext()
      )
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      providerKind: 'managed-whisper',
      operation: 'transcribe',
      stage: 'request'
    })
    expect(releaseCount).toBe(1)
  })

  it('cancels a managed Whisper request and releases its lease', async () => {
    let notifyRequestStarted: (() => void) | undefined
    const requestStarted = new Promise<void>((resolve) => {
      notifyRequestStarted = resolve
    })
    const fixture = await startFixtureServer(async (httpRequest, response) => {
      await readRequestBody(httpRequest)
      notifyRequestStarted?.()
      await new Promise<void>((resolve) => response.once('close', resolve))
    })
    cleanupServers.push(fixture)
    const input = await makeInputFile()
    let releaseCount = 0
    const runtime: ManagedWhisperRuntime = {
      acquire: async () => ({
        endpoint: `${fixture.baseUrl}/v1`,
        release: async () => {
          releaseCount += 1
        }
      })
    }
    const controller = new AbortController()
    const operation = new ManagedWhisperTranscriptionAdapter(runtime).transcribe(
      transcriptionRequest(input),
      managedWhisperProfile(null),
      { ...providerContext(), signal: controller.signal }
    )

    await requestStarted
    controller.abort()

    await expect(operation).rejects.toMatchObject({
      code: 'CANCELLED',
      providerKind: 'managed-whisper',
      operation: 'transcribe'
    })
    expect(releaseCount).toBe(1)
  })

  it('runs a local CLI without a shell and parses stdout', async () => {
    const input = await makeInputFile()
    const output = JSON.stringify({
      text: 'Offline output.',
      language: 'en',
      words: [
        { word: 'Offline', start: 0, end: 0.5 },
        { word: 'output.', start: 0.5, end: 1 }
      ]
    })
    const profile: Extract<TranscriptionProfileV1, { kind: 'local-cli' }> = {
      ...profileBase('offline/model with spaces'),
      task: 'transcription',
      kind: 'local-cli',
      executable: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(output)})`, '{input}', '{model}'],
      outputMode: 'stdout',
      outputFormat: 'openai-verbose-json',
      inheritEnvironment: false
    }
    const transcript = await new LocalCliTranscriptionAdapter().transcribe(
      transcriptionRequest(input),
      profile,
      providerContext()
    )
    expect(transcript.text).toBe('Offline output.')
    expect(transcript.words).toHaveLength(2)
    expect(transcript.provenance.model).toBe('offline/model with spaces')
  })

  it('terminates a local CLI when the operation is cancelled', async () => {
    const input = await makeInputFile()
    const profile: Extract<TranscriptionProfileV1, { kind: 'local-cli' }> = {
      ...profileBase('offline-cancellation-model'),
      task: 'transcription',
      kind: 'local-cli',
      executable: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)', '{input}'],
      outputMode: 'stdout',
      outputFormat: 'text',
      inheritEnvironment: false
    }
    const controller = new AbortController()
    const operation = new LocalCliTranscriptionAdapter().transcribe(
      transcriptionRequest(input),
      profile,
      { ...providerContext(), signal: controller.signal }
    )
    setTimeout(() => controller.abort(), 25)
    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})

async function makeInputFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'provider-test-'))
  cleanupDirectories.push(directory)
  const path = join(directory, 'audio.wav')
  await writeFile(path, Buffer.from('fixture-audio'))
  return path
}

function transcriptionRequest(filePath: string): TranscriptionRequest {
  return {
    sessionId: randomUUID(),
    sourceSha256: 'fixture-sha',
    filePath,
    mimeType: 'audio/wav',
    durationMs: 2_000,
    glossary: ['architecture']
  }
}

function managedWhisperProfile(
  language: string | null
): Extract<TranscriptionProfileV1, { kind: 'managed-whisper' }> {
  return {
    ...profileBase('large-v3'),
    task: 'transcription',
    kind: 'managed-whisper',
    model: 'large-v3',
    language
  }
}
