import { describe, expect, it } from 'vitest'

import type { DiarizationSegment } from '@shared/diarization'
import type { TranscriptDocumentV1 } from '@shared/index'

import { mergeDiarization } from './merge'

describe('mergeDiarization', () => {
  it('returns the transcript unchanged for an empty segment list', () => {
    const transcript = fixture()
    expect(mergeDiarization(transcript, [])).toBe(transcript)
  })

  it('assigns words by maximum overlap and utterances by majority', () => {
    const transcript = fixture()
    const segments: DiarizationSegment[] = [
      { startMs: 0, endMs: 1_000, speaker: 'SPEAKER_00' },
      { startMs: 1_000, endMs: 2_000, speaker: 'SPEAKER_01' }
    ]

    const merged = mergeDiarization(transcript, segments)

    expect(merged.words.map((word) => word.speakerId)).toEqual([
      'SPEAKER_00',
      'SPEAKER_00',
      'SPEAKER_01',
      'SPEAKER_01'
    ])
    expect(merged.speakers).toEqual([
      { id: 'SPEAKER_00', label: 'Speaker 1', displayName: null },
      { id: 'SPEAKER_01', label: 'Speaker 2', displayName: null }
    ])
  })

  it('splits an utterance where the speaker changes mid-way', () => {
    const transcript = fixture()
    const segments: DiarizationSegment[] = [
      { startMs: 0, endMs: 1_000, speaker: 'SPEAKER_00' },
      { startMs: 1_000, endMs: 2_000, speaker: 'SPEAKER_01' }
    ]

    const merged = mergeDiarization(transcript, segments)

    expect(merged.utterances).toHaveLength(2)
    expect(merged.utterances[0]).toMatchObject({
      id: 'u1-s1',
      text: 'hello there',
      speakerId: 'SPEAKER_00',
      wordIds: ['w1', 'w2'],
      startMs: 0,
      endMs: 900
    })
    expect(merged.utterances[1]).toMatchObject({
      id: 'u1-s2',
      text: 'general kenobi',
      speakerId: 'SPEAKER_01',
      wordIds: ['w3', 'w4'],
      startMs: 1_100,
      endMs: 1_900
    })
  })

  it('keeps single-speaker utterances intact with the majority speaker', () => {
    const transcript = fixture()
    const segments: DiarizationSegment[] = [
      { startMs: 0, endMs: 2_000, speaker: 'SPEAKER_00' }
    ]

    const merged = mergeDiarization(transcript, segments)

    expect(merged.utterances).toHaveLength(1)
    expect(merged.utterances[0]).toMatchObject({
      id: 'u1',
      speakerId: 'SPEAKER_00',
      wordIds: ['w1', 'w2', 'w3', 'w4']
    })
  })

  it('assigns words in diarization gaps to the nearest segment', () => {
    const transcript = fixture()
    const segments: DiarizationSegment[] = [
      { startMs: 0, endMs: 350, speaker: 'SPEAKER_00' },
      { startMs: 1_600, endMs: 2_000, speaker: 'SPEAKER_01' }
    ]

    const merged = mergeDiarization(transcript, segments)

    // w2 (500-900) has no overlap; nearest is SPEAKER_00 (distance 150 vs 700).
    expect(merged.words[1]?.speakerId).toBe('SPEAKER_00')
  })

  it('falls back to utterance-level assignment without word timestamps', () => {
    const transcript: TranscriptDocumentV1 = {
      ...fixture(),
      words: [],
      utterances: [
        {
          id: 'u1',
          text: 'hello there general kenobi',
          startMs: 0,
          endMs: 1_900,
          speakerId: null,
          wordIds: [],
          manuallyEdited: false
        }
      ]
    }
    const segments: DiarizationSegment[] = [
      { startMs: 0, endMs: 1_000, speaker: 'SPEAKER_00' },
      { startMs: 1_000, endMs: 1_200, speaker: 'SPEAKER_01' }
    ]

    const merged = mergeDiarization(transcript, segments)

    expect(merged.utterances[0]?.speakerId).toBe('SPEAKER_00')
  })
})

function fixture(): TranscriptDocumentV1 {
  return {
    schemaVersion: 1,
    id: '7b6a4c0e-3b1f-4f43-9e59-52a4c53b3e21',
    sessionId: '0d9a7d33-6a83-4f14-8f0e-a2b8f6fdaa11',
    revision: 1,
    sourceSha256: 'abc',
    durationMs: 2_000,
    text: 'hello there general kenobi',
    languages: ['en'],
    speakers: [],
    words: [
      word('w1', 'hello', 0, 400),
      word('w2', 'there', 500, 900),
      word('w3', 'general', 1_100, 1_500),
      word('w4', 'kenobi', 1_600, 1_900)
    ],
    utterances: [
      {
        id: 'u1',
        text: 'hello there general kenobi',
        startMs: 0,
        endMs: 1_900,
        speakerId: null,
        wordIds: ['w1', 'w2', 'w3', 'w4'],
        manuallyEdited: false
      }
    ],
    warnings: [],
    provenance: {
      providerKind: 'managed-whisper',
      model: 'large-v3',
      generatedAt: '2026-07-14T12:00:00.000Z'
    }
  }
}

function word(
  id: string,
  text: string,
  startMs: number,
  endMs: number
): TranscriptDocumentV1['words'][number] {
  return { id, text, startMs, endMs, speakerId: null, confidence: null }
}
