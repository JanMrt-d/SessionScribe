import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ElevenLabsTranscriptionAdapter,
  LocalCliTranscriptionAdapter,
  OpenAiTranscriptionAdapter
} from '@main/providers'
import type { TranscriptionRequest } from '@main/providers'
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
    expect(transcript.utterances.map((utterance) => utterance.speakerId)).toEqual([
      'speaker-1',
      'speaker-2'
    ])
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
