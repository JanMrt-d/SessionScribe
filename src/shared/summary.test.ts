import { describe, expect, it } from 'vitest'
import { summaryDocumentSchema, upgradeSummaryDocument } from './summary'

const EVIDENCE = [{ utteranceId: 'utterance-2', startMs: 4_000, endMs: 5_000 }]

const LEGACY_LECTURE = {
  schemaVersion: 1,
  id: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  revision: 3,
  transcriptRevision: 2,
  title: 'Verteilte Systeme',
  overview: 'Eine Einführung.',
  mode: 'lecture',
  outline: [{ text: 'Konsens', evidence: EVIDENCE }],
  keyLessons: [{ text: 'Quoren verhindern Split-Brain.', evidence: EVIDENCE }],
  concepts: [{ name: 'Quorum', definition: 'Eine Mehrheit der Knoten.', evidence: EVIDENCE }],
  examples: [{ text: 'Raft.', evidence: EVIDENCE }],
  reviewQuestions: ['Was ist ein Quorum?'],
  recommendedReview: [{ text: 'Kapitel 4.', evidence: EVIDENCE }],
  provenance: {
    providerKind: 'ollama',
    model: 'qwen',
    promptVersion: 'grounded-summary-v1',
    generatedAt: '2026-01-01T00:00:00.000Z'
  },
  manuallyEdited: false
}

describe('upgradeSummaryDocument', () => {
  it('makes a stored revision-1 lecture readable under the current schema', () => {
    const upgraded = summaryDocumentSchema.parse(upgradeSummaryDocument(LEGACY_LECTURE))
    expect(upgraded.mode).toBe('lecture')
    if (upgraded.mode !== 'lecture') return
    expect(upgraded.schemaVersion).toBe(2)
    expect(upgraded.revision).toBe(3)
    expect(upgraded.overview).toBe('Eine Einführung.')
  })

  it('carries every list of the old shape into the single migrated chapter', () => {
    const upgraded = summaryDocumentSchema.parse(upgradeSummaryDocument(LEGACY_LECTURE))
    if (upgraded.mode !== 'lecture') throw new Error('expected a lecture summary')
    const chapter = upgraded.chapters[0]!
    expect(upgraded.chapters).toHaveLength(1)
    expect(chapter.title).toBe('Verteilte Systeme')
    expect(chapter.subtopics.map((subtopic) => subtopic.title)).toEqual([
      'Key lessons',
      'Outline',
      'Examples',
      'Recommended review'
    ])
    expect(chapter.glossary[0]?.name).toBe('Quorum')
    expect(chapter.studyQuestions[0]?.question).toBe('Was ist ein Quorum?')
    // The old shape had no answers, so the field stays empty rather than invented.
    expect(chapter.studyQuestions[0]?.answer).toBe('')
    // Taken from the evidence that was already stored.
    expect(chapter.startMs).toBe(4_000)
  })

  it('drops the empty chapter when the old summary carried no content', () => {
    const empty = {
      ...LEGACY_LECTURE,
      outline: [],
      keyLessons: [],
      concepts: [],
      examples: [],
      reviewQuestions: [],
      recommendedReview: []
    }
    const upgraded = summaryDocumentSchema.parse(upgradeSummaryDocument(empty))
    if (upgraded.mode !== 'lecture') throw new Error('expected a lecture summary')
    expect(upgraded.chapters).toEqual([])
  })

  it('leaves meeting summaries and current lecture summaries untouched', () => {
    const meeting = {
      ...LEGACY_LECTURE,
      mode: 'meeting',
      topics: [],
      decisions: [],
      actionItems: [],
      openQuestions: [],
      risks: []
    }
    expect(upgradeSummaryDocument(meeting)).toBe(meeting)
    const current = { schemaVersion: 2, mode: 'lecture', chapters: [] }
    expect(upgradeSummaryDocument(current)).toBe(current)
  })

  it('passes unrecognizable input through so validation reports the real problem', () => {
    expect(upgradeSummaryDocument(null)).toBeNull()
    expect(upgradeSummaryDocument('not a document')).toBe('not a document')
    expect(() => summaryDocumentSchema.parse(upgradeSummaryDocument({ mode: 'lecture' }))).toThrow()
  })
})
