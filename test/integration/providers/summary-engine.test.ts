import { describe, expect, it } from 'vitest'
import { createGroundedSummary, type SummaryTextGenerator } from '@main/providers'
import { providerContext, transcriptFixture } from './helpers'
import type { TranscriptDocumentV1 } from '@shared/transcript'

function lectureTranscript(
  title: string,
  utteranceCount: number,
  charactersEach: number
): TranscriptDocumentV1 {
  const transcript = transcriptFixture(title)
  transcript.durationMs = utteranceCount * 1_000
  transcript.languages = ['de']
  transcript.utterances = Array.from({ length: utteranceCount }, (_, index) => ({
    id: `utterance-${index + 1}`,
    text: `Abschnitt ${index + 1}: ${'ausführliche Erklärung '.repeat(charactersEach)}`,
    startMs: index * 1_000,
    endMs: index * 1_000 + 900,
    speakerId: 'speaker-1',
    wordIds: [],
    manuallyEdited: false
  }))
  transcript.text = transcript.utterances.map((utterance) => utterance.text).join(' ')
  return transcript
}

function chapterFor(title: string, evidenceId: string): Record<string, unknown> {
  return {
    title,
    summary: `Zusammenfassung zu ${title}.`,
    subtopics: [
      {
        title: `Unterthema ${title}`,
        keyPoints: [{ text: `Kernaussage zu ${title}.`, evidence: [evidenceId] }]
      }
    ],
    emphasis: [{ text: 'Besonders betont.', evidence: [evidenceId] }],
    openQuestions: [],
    glossary: [],
    studyQuestions: [
      { question: `Frage zu ${title}?`, answer: 'Die Antwort.', evidence: [evidenceId] }
    ]
  }
}

function visibleUtterance(userPrompt: string): string {
  return /<utterance id="([^"]+)"/.exec(userPrompt)?.[1] ?? 'utterance-1'
}

describe('lecture note engine', () => {
  it('keeps a chapter for every segment instead of reducing them into one', async () => {
    const transcript = lectureTranscript('Lange Vorlesung', 12, 55)
    let segmentCalls = 0
    let overviewCalls = 0
    let active = 0
    let maximumActive = 0
    const generate: SummaryTextGenerator = async ({ schemaName, userPrompt }) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      if (schemaName === 'lecture_overview') {
        overviewCalls += 1
        return JSON.stringify({ overview: 'Die Vorlesung behandelt mehrere Abschnitte.' })
      }
      segmentCalls += 1
      const evidenceId = visibleUtterance(userPrompt)
      return JSON.stringify({ chapters: [chapterFor(`Kapitel ${evidenceId}`, evidenceId)] })
    }

    const result = await createGroundedSummary(
      {
        sessionId: transcript.sessionId,
        title: 'Lange Vorlesung',
        mode: 'lecture',
        revision: 1,
        transcript
      },
      providerContext(),
      {
        providerKind: 'fixture-summary',
        model: 'arbitrary-long-context-model',
        contextWindowTokens: 2_048,
        promptOverride: null,
        generate
      }
    )

    expect(segmentCalls).toBeGreaterThan(3)
    expect(maximumActive).toBeLessThanOrEqual(2)
    // The regression this schema exists for: the notes must grow with the
    // recording rather than being merged down to a single set of lists.
    expect(overviewCalls).toBe(1)
    expect(result.mode).toBe('lecture')
    if (result.mode !== 'lecture') return
    expect(result.chapters).toHaveLength(segmentCalls)
    expect(result.overview).toBe('Die Vorlesung behandelt mehrere Abschnitte.')
    expect(result.language).toBe('de')
    expect(result.provenance.model).toBe('arbitrary-long-context-model')
    expect(result.provenance.promptVersion).toBe('grounded-lecture-chapters-v2')
    // Chapters stay in the order they were spoken.
    expect(result.chapters.map((chapter) => chapter.startMs)).toEqual(
      [...result.chapters.map((chapter) => chapter.startMs)].sort((a, b) => a - b)
    )
    expect(result.chapters[0]?.subtopics[0]?.keyPoints[0]?.evidence[0]?.utteranceId).toBe(
      'utterance-1'
    )
  })

  it('rejoins a chapter the lecturer carried across a segment boundary', async () => {
    const transcript = lectureTranscript('Durchgehendes Thema', 2, 80)
    const generate: SummaryTextGenerator = async ({ schemaName, userPrompt }) => {
      if (schemaName === 'lecture_overview') return JSON.stringify({ overview: 'Ein Thema.' })
      return JSON.stringify({
        chapters: [chapterFor('Geteiltes Thema', visibleUtterance(userPrompt))]
      })
    }

    const result = await createGroundedSummary(
      {
        sessionId: transcript.sessionId,
        title: 'Durchgehendes Thema',
        mode: 'lecture',
        revision: 1,
        transcript
      },
      providerContext(),
      {
        providerKind: 'fixture-summary',
        model: 'fixture',
        contextWindowTokens: 2_048,
        promptOverride: null,
        generate
      }
    )

    expect(result.mode).toBe('lecture')
    if (result.mode !== 'lecture') return
    expect(result.chapters).toHaveLength(1)
    // Both halves survive the merge; nothing is dropped in favour of the first.
    expect(result.chapters[0]?.subtopics).toHaveLength(2)
    expect(result.chapters[0]?.studyQuestions).toHaveLength(2)
    expect(result.chapters[0]?.emphasis).toHaveLength(2)
  })

  it('rejects a valid transcript ID that was not visible in the current segment', async () => {
    const transcript = lectureTranscript('Grounding boundary', 2, 80)
    const generate: SummaryTextGenerator = async ({ schemaName }) => {
      if (schemaName === 'lecture_overview') return JSON.stringify({ overview: 'Overview.' })
      return JSON.stringify({ chapters: [chapterFor('Kapitel', 'utterance-1')] })
    }

    await expect(
      createGroundedSummary(
        {
          sessionId: transcript.sessionId,
          title: 'Grounding boundary',
          mode: 'lecture',
          revision: 1,
          transcript
        },
        providerContext(),
        {
          providerKind: 'fixture-summary',
          model: 'fixture',
          contextWindowTokens: 2_048,
          promptOverride: null,
          generate
        }
      )
    ).rejects.toMatchObject({ code: 'OUTPUT_INVALID' })
  })
})
