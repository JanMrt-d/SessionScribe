import { describe, expect, it } from 'vitest'
import { createGroundedSummary, type SummaryTextGenerator } from '@main/providers'
import { providerContext, transcriptFixture } from './helpers'

describe('hierarchical summary engine', () => {
  it('maps and reduces long transcripts with bounded generation concurrency', async () => {
    const transcript = transcriptFixture('Long lecture')
    transcript.text = 'Long lecture '.repeat(1_000)
    transcript.durationMs = 20_000
    transcript.utterances = Array.from({ length: 12 }, (_, index) => ({
      id: `utterance-${index + 1}`,
      text: `Section ${index + 1}: ${'important explanation '.repeat(55)}`,
      startMs: index * 1_000,
      endMs: index * 1_000 + 900,
      speakerId: 'speaker-1',
      wordIds: [],
      manuallyEdited: false
    }))
    let calls = 0
    let active = 0
    let maximumActive = 0
    const generate: SummaryTextGenerator = async ({ userPrompt }) => {
      calls += 1
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      const visibleEvidence =
        /<utterance id="([^"]+)"/.exec(userPrompt)?.[1] ??
        /&quot;evidence&quot;:\[&quot;([^&]+)&quot;/.exec(userPrompt)?.[1] ??
        'utterance-1'
      return JSON.stringify({
        overview: 'The lecture contains several sections.',
        outline: [{ text: 'Several sections were covered.', evidence: [visibleEvidence] }],
        keyLessons: [{ text: 'Retain the important explanations.', evidence: [visibleEvidence] }],
        concepts: [],
        examples: [],
        reviewQuestions: ['What should be retained?'],
        recommendedReview: []
      })
    }

    const result = await createGroundedSummary(
      {
        sessionId: transcript.sessionId,
        title: 'Long lecture',
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

    expect(calls).toBeGreaterThan(3)
    expect(maximumActive).toBeLessThanOrEqual(2)
    expect(result.mode).toBe('lecture')
    expect(result.provenance.model).toBe('arbitrary-long-context-model')
  })

  it('rejects a valid transcript ID that was not visible in the current map chunk', async () => {
    const transcript = transcriptFixture('Grounding boundary')
    transcript.durationMs = 4_000
    transcript.utterances = [
      {
        id: 'utterance-1',
        text: 'First section. '.repeat(500),
        startMs: 0,
        endMs: 1_900,
        speakerId: 'speaker-1',
        wordIds: [],
        manuallyEdited: false
      },
      {
        id: 'utterance-2',
        text: 'Second section. '.repeat(500),
        startMs: 2_000,
        endMs: 3_900,
        speakerId: 'speaker-1',
        wordIds: [],
        manuallyEdited: false
      }
    ]
    const generate: SummaryTextGenerator = async () =>
      JSON.stringify({
        overview: 'Invalid cross-chunk citation.',
        outline: [{ text: 'Claim', evidence: ['utterance-1'] }],
        keyLessons: [],
        concepts: [],
        examples: [],
        reviewQuestions: [],
        recommendedReview: []
      })

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
