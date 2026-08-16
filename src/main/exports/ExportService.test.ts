import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LectureSummaryV2, TranscriptDocumentV1 } from '@shared/index'
import { ExportService, plainText, type PdfRenderer } from './ExportService'

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

function lectureSummaryFixture(language: string): LectureSummaryV2 {
  const evidence = [{ utteranceId: 'utterance-2', startMs: 1_500, endMs: 4_000 }]
  return {
    schemaVersion: 2,
    id: '5f7f5e0a-8f04-4e4b-9f0f-0a4c1a1c9b03',
    sessionId: '5f7f5e0a-8f04-4e4b-9f0f-0a4c1a1c9b02',
    revision: 1,
    transcriptRevision: 1,
    title: 'Verteilte Systeme',
    overview: 'Eine Einführung in Konsensverfahren.',
    mode: 'lecture',
    language,
    chapters: [
      {
        title: 'Konsens',
        summary: 'Warum Konsens nötig ist.',
        startMs: 1_500,
        subtopics: [
          { title: 'Quoren', keyPoints: [{ text: 'Mehrheiten entscheiden.', evidence }] }
        ],
        emphasis: [{ text: 'Split-Brain ist die Gefahr.', evidence }],
        openQuestions: [{ text: 'Wie verhält sich das bei Netzsplits?', evidence }],
        glossary: [{ name: 'Quorum', definition: 'Eine Mehrheit der Knoten.', evidence }],
        studyQuestions: [
          { question: 'Was ist ein Quorum?', answer: 'Eine Mehrheit der Knoten.', evidence }
        ]
      }
    ],
    provenance: {
      providerKind: 'ollama',
      model: 'qwen',
      promptVersion: 'grounded-lecture-chapters-v2',
      generatedAt: '2026-01-01T00:00:00.000Z'
    },
    manuallyEdited: false
  }
}

function serviceFor(summary: LectureSummaryV2 | null, pdfRenderer: PdfRenderer | null = null) {
  return new ExportService(
    {
      getSession: () => ({ title: 'Design Sync' }),
      getTranscript: () => transcriptFixture(),
      getSummary: () => summary
    } as never,
    pdfRenderer
  )
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

  it('writes study notes with German headings and without the transcript', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sessionscribe-export-'))
    tempDirectories.push(directory)

    const paths = await serviceFor(lectureSummaryFixture('de')).write({
      sessionId: '5f7f5e0a-8f04-4e4b-9f0f-0a4c1a1c9b02',
      directory,
      formats: ['notes']
    })

    const expectedPath = join(directory, 'Design Sync.notes.md')
    expect(paths).toEqual([expectedPath])
    const notes = await readFile(expectedPath, 'utf8')
    expect(notes).toContain('## Gesamtzusammenfassung')
    expect(notes).toContain('## 1. Konsens')
    expect(notes).toContain('### 1.1 Quoren')
    expect(notes).toContain('### Besonders hervorgehoben')
    expect(notes).toContain('### Offene Fragen')
    expect(notes).toContain('### Lernfragen')
    expect(notes).toContain('<details><summary>Antwort</summary>')
    expect(notes).toContain('Mehrheiten entscheiden. (00:00:01)')
    // Study notes exist precisely so the transcript does not bury them.
    expect(notes).not.toContain('Hello there.')
  })

  it('falls back to English headings when the transcript language is unknown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sessionscribe-export-'))
    tempDirectories.push(directory)

    await serviceFor(lectureSummaryFixture('')).write({
      sessionId: '5f7f5e0a-8f04-4e4b-9f0f-0a4c1a1c9b02',
      directory,
      formats: ['notes']
    })

    const notes = await readFile(join(directory, 'Design Sync.notes.md'), 'utf8')
    expect(notes).toContain('## Overview')
    expect(notes).toContain('### Study questions')
  })

  it('keeps the markdown export distinct from the study notes it shares', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sessionscribe-export-'))
    tempDirectories.push(directory)

    const paths = await serviceFor(lectureSummaryFixture('de')).write({
      sessionId: '5f7f5e0a-8f04-4e4b-9f0f-0a4c1a1c9b02',
      directory,
      formats: ['markdown', 'notes']
    })

    expect(paths).toEqual([
      join(directory, 'Design Sync.md'),
      join(directory, 'Design Sync.notes.md')
    ])
    const markdown = await readFile(join(directory, 'Design Sync.md'), 'utf8')
    expect(markdown).toContain('## 1. Konsens')
    expect(markdown).toContain('## Transcript')
    expect(markdown).toContain('Hello there.')
  })

  it('writes the bytes the PDF renderer produced from the notes HTML', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sessionscribe-export-'))
    tempDirectories.push(directory)
    let renderedHtml = ''
    const renderer: PdfRenderer = {
      render: async (html) => {
        renderedHtml = html
        return new Uint8Array([0x25, 0x50, 0x44, 0x46])
      }
    }

    const paths = await serviceFor(lectureSummaryFixture('de'), renderer).write({
      sessionId: '5f7f5e0a-8f04-4e4b-9f0f-0a4c1a1c9b02',
      directory,
      formats: ['pdf']
    })

    const expectedPath = join(directory, 'Design Sync.pdf')
    expect(paths).toEqual([expectedPath])
    await expect(readFile(expectedPath)).resolves.toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46]))
    expect(renderedHtml).toContain('<html lang="de">')
    expect(renderedHtml).toContain('<meta charset="utf-8">')
    expect(renderedHtml).toContain('Gesamtzusammenfassung')
    // Printed answers cannot be unfolded by the reader, so they stay visible.
    expect(renderedHtml).not.toContain('<details')
    expect(renderedHtml).toContain('Eine Mehrheit der Knoten.')
  })

  it('refuses study-note formats before writing anything when no summary exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sessionscribe-export-'))
    tempDirectories.push(directory)

    await expect(
      serviceFor(null).write({
        sessionId: '5f7f5e0a-8f04-4e4b-9f0f-0a4c1a1c9b02',
        directory,
        formats: ['text', 'notes']
      })
    ).rejects.toThrow('A summary is required')
    await expect(readFile(join(directory, 'Design Sync.txt'), 'utf8')).rejects.toThrow()
  })

  it('reports a missing PDF renderer instead of writing an empty file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sessionscribe-export-'))
    tempDirectories.push(directory)

    await expect(
      serviceFor(lectureSummaryFixture('de')).write({
        sessionId: '5f7f5e0a-8f04-4e4b-9f0f-0a4c1a1c9b02',
        directory,
        formats: ['pdf']
      })
    ).rejects.toThrow('PDF export is not available')
  })
})
