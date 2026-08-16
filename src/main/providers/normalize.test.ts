import { describe, expect, it } from 'vitest'
import { normalizeTranscript, type RawTranscriptUtterance } from './normalize'

const LOOP_WARNING =
  'Most of this transcript repeats a single phrase, which usually means the transcription looped.'

const METADATA = {
  sessionId: '5f7f5e0a-8f04-4e4b-9f0f-0a4c1a1c9b02',
  sourceSha256: 'a'.repeat(64),
  durationMs: 600_000,
  providerKind: 'managed-whisper',
  model: 'large-v3',
  generatedAt: '2026-01-01T00:00:00.000Z'
}

function utterances(texts: readonly string[]): RawTranscriptUtterance[] {
  return texts.map((text, index) => ({
    text,
    startMs: index * 1_000,
    endMs: index * 1_000 + 900
  }))
}

function warningsFor(texts: readonly string[]): string[] {
  return normalizeTranscript({ utterances: utterances(texts) }, METADATA).warnings
}

describe('decoder loop detection', () => {
  it('warns when one phrase fills most of a long transcript', () => {
    const looped = [
      ...['Welcome to the lecture.', 'Today we begin with a question.'],
      ...Array.from({ length: 40 }, () => 'Was ist das, was wir hier machen?')
    ]
    expect(warningsFor(looped)).toContain(LOOP_WARNING)
  })

  it('ignores casing and surrounding whitespace when counting repeats', () => {
    const looped = Array.from({ length: 30 }, (_, index) =>
      index % 2 === 0 ? 'Yes indeed.' : '  yes indeed.  '
    )
    expect(warningsFor(looped)).toContain(LOOP_WARNING)
  })

  it('leaves a varied transcript unflagged', () => {
    const varied = Array.from({ length: 40 }, (_, index) => `Distinct sentence number ${index}.`)
    expect(warningsFor(varied)).not.toContain(LOOP_WARNING)
  })

  it('does not flag repeated filler in a short exchange', () => {
    expect(warningsFor(['Yes.', 'Yes.', 'Yes.', 'No.'])).not.toContain(LOOP_WARNING)
  })
})
