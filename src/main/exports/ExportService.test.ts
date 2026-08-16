import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TranscriptDocumentV1 } from '@shared/index'
import { ExportService, plainText } from './ExportService'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

function transcriptFixture(overrides: Partial<TranscriptDocumentV1> = {}): TranscriptDocumentV1 {
  return {
    schemaVersion: 1,
    id: '5f7f5e0a-8f04-4e4b-9f0f-0a4c1a1c9b01',
    sessionId: '5f7f5e0a-8f04-4e4b-9f0f-0a4c1a1c9b02',
    revision: 1,
    sourceSha256: 'a'.repeat(64),
    durationMs: 4_000,
    text: 'Hello there. General reply.',
    languages: ['en'],
    speakers: [
      { id: 'speaker-1', label: 'Speaker 1', displayName: 'Alice' },
      { id: 'speaker-2', label: 'Speaker 2', displayName: null }
    ],
    words: [],
    utterances: [
      {
        id: 'utterance-1',
        text: 'Hello there.',
        startMs: 0,
        endMs: 1_500,
        speakerId: 'speaker-1',
        wordIds: [],
        manuallyEdited: false
      },
      {
        id: 'utterance-2',
        text: 'General reply.',
        startMs: 1_500,
        endMs: 4_000,
        speakerId: 'speaker-2',
        wordIds: [],
        manuallyEdited: false
      }
    ],
    warnings: [],
    provenance: {
      providerKind: 'managed-whisper',
      model: 'large-v3',
      generatedAt: '2026-01-01T00:00:00.000Z'
    },
    ...overrides
  }
}

describe('plainText', () => {
  it('renders speaker-labeled paragraphs preferring display names over labels', () => {
    expect(plainText(transcriptFixture())).toBe(
      'Alice: Hello there.\n\nSpeaker 2: General reply.\n'
    )
  })

  it('omits the speaker prefix when an utterance has no resolvable speaker', () => {
    const transcript = transcriptFixture({
      speakers: [],
      utterances: [
        {
          id: 'utterance-1',
          text: '  Unattributed words.  ',
          startMs: 0,
          endMs: 1_000,
          speakerId: null,
          wordIds: [],
          manuallyEdited: false
        }
      ]
    })
    expect(plainText(transcript)).toBe('Unattributed words.\n')
  })

  it('uses the edited utterance text rather than the original words', () => {
    const transcript = transcriptFixture()
    transcript.utterances = transcript.utterances.map((utterance) =>
      utterance.id === 'utterance-1'
        ? { ...utterance, text: 'Hello there, corrected.', manuallyEdited: true }
        : utterance
    )
    expect(plainText(transcript)).toContain('Alice: Hello there, corrected.')
  })
})

describe('ExportService.write', () => {
  it('writes a plain text file named after the session title', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sessionscribe-export-'))
    tempDirectories.push(directory)
    const transcript = transcriptFixture()
    const service = new ExportService({
      getSession: () => ({ title: 'Design Sync' }),
      getTranscript: () => transcript,
      getSummary: () => null
    } as never)

    const paths = await service.write({
      sessionId: transcript.sessionId,
      directory,
      formats: ['text']
    })

    const expectedPath = join(directory, 'Design Sync.txt')
    expect(paths).toEqual([expectedPath])
    await expect(readFile(expectedPath, 'utf8')).resolves.toBe(
      'Alice: Hello there.\n\nSpeaker 2: General reply.\n'
    )
  })
})
