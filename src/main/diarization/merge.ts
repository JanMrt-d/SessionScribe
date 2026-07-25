import type { DiarizationSegment } from '@shared/diarization'
import type { TranscriptDocumentV1 } from '@shared/index'

type TranscriptWord = TranscriptDocumentV1['words'][number]
type TranscriptUtterance = TranscriptDocumentV1['utterances'][number]

/**
 * Assigns diarization speakers to a transcript using maximum temporal overlap
 * (the approach popularized by WhisperX):
 *
 * 1. Each word gets the speaker whose segment overlaps it the most; words in
 *    diarization gaps inherit the nearest segment's speaker.
 * 2. Utterances take the duration-weighted majority speaker of their words and
 *    are split where the speaker changes mid-utterance, so a turn boundary is
 *    always an utterance boundary.
 * 3. The speaker table lists every diarized speaker with a friendly label;
 *    display names stay null until the user renames them.
 *
 * A transcript without words falls back to utterance-level assignment. An
 * empty segment list returns the document unchanged.
 */
export function mergeDiarization(
  transcript: TranscriptDocumentV1,
  segments: readonly DiarizationSegment[]
): TranscriptDocumentV1 {
  if (segments.length === 0) return transcript
  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)

  const words = transcript.words.map((word) => ({
    ...word,
    speakerId: speakerForSpan(ordered, word.startMs, word.endMs) ?? word.speakerId
  }))
  const wordsById = new Map(words.map((word) => [word.id, word]))

  const utterances: TranscriptUtterance[] = []
  for (const utterance of transcript.utterances) {
    const utteranceWords = utterance.wordIds
      .map((id) => wordsById.get(id))
      .filter((word): word is TranscriptWord => word !== undefined)
    if (utteranceWords.length === 0) {
      utterances.push({
        ...utterance,
        speakerId:
          speakerForSpan(ordered, utterance.startMs, utterance.endMs) ?? utterance.speakerId
      })
      continue
    }
    utterances.push(...splitBySpeaker(utterance, utteranceWords))
  }

  const labels = new Set<string>()
  for (const segment of ordered) labels.add(segment.speaker)
  const speakers = [...labels].sort().map((label, index) => ({
    id: label,
    label: `Speaker ${index + 1}`,
    displayName: null
  }))

  return { ...transcript, words, utterances, speakers }
}

function splitBySpeaker(
  utterance: TranscriptUtterance,
  words: readonly TranscriptWord[]
): TranscriptUtterance[] {
  const runs: Array<{ speakerId: string | null; words: TranscriptWord[] }> = []
  for (const word of words) {
    const current = runs.at(-1)
    if (current && current.speakerId === word.speakerId) {
      current.words.push(word)
    } else {
      runs.push({ speakerId: word.speakerId, words: [word] })
    }
  }
  if (runs.length === 1) {
    return [{ ...utterance, speakerId: majoritySpeaker(words) }]
  }
  return runs.map((run, index) => {
    const first = run.words[0] as TranscriptWord
    const last = run.words.at(-1) as TranscriptWord
    return {
      id: `${utterance.id}-s${index + 1}`,
      text: run.words
        .map((word) => word.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      startMs: first.startMs,
      endMs: last.endMs,
      speakerId: run.speakerId,
      wordIds: run.words.map((word) => word.id),
      manuallyEdited: false
    }
  })
}

function majoritySpeaker(words: readonly TranscriptWord[]): string | null {
  const durations = new Map<string, number>()
  for (const word of words) {
    if (word.speakerId === null) continue
    const duration = Math.max(1, word.endMs - word.startMs)
    durations.set(word.speakerId, (durations.get(word.speakerId) ?? 0) + duration)
  }
  let best: string | null = null
  let bestDuration = 0
  for (const [speaker, duration] of durations) {
    if (duration > bestDuration) {
      best = speaker
      bestDuration = duration
    }
  }
  return best
}

function speakerForSpan(
  segments: readonly DiarizationSegment[],
  startMs: number,
  endMs: number
): string | null {
  let best: string | null = null
  let bestOverlap = 0
  let nearest: string | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const segment of segments) {
    const overlap = Math.min(endMs, segment.endMs) - Math.max(startMs, segment.startMs)
    if (overlap > bestOverlap) {
      best = segment.speaker
      bestOverlap = overlap
    }
    const distance =
      segment.endMs < startMs
        ? startMs - segment.endMs
        : segment.startMs > endMs
          ? segment.startMs - endMs
          : 0
    if (distance < nearestDistance) {
      nearest = segment.speaker
      nearestDistance = distance
    }
  }
  return best ?? nearest
}
