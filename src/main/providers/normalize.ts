import { randomUUID } from 'node:crypto'
import { transcriptDocumentSchema, type TranscriptDocumentV1 } from '@shared/transcript'

export interface RawTranscriptWord {
  text: string
  startMs: number
  endMs: number
  speakerLabel?: string | null
  confidence?: number | null
}

export interface RawTranscriptUtterance {
  text: string
  startMs: number
  endMs: number
  speakerLabel?: string | null
}

export interface RawTranscript {
  text?: string
  languages?: readonly string[]
  words?: readonly RawTranscriptWord[]
  utterances?: readonly RawTranscriptUtterance[]
  warnings?: readonly string[]
  speakerDisplayNames?: Readonly<Record<string, string>>
}

export interface TranscriptMetadata {
  sessionId: string
  sourceSha256: string
  durationMs: number
  providerKind: string
  model: string
  generatedAt: string
}

interface CanonicalWord {
  id: string
  text: string
  startMs: number
  endMs: number
  speakerId: string | null
  confidence: number | null
}

export function normalizeTranscript(
  raw: RawTranscript,
  metadata: TranscriptMetadata
): TranscriptDocumentV1 {
  const warnings = [...(raw.warnings ?? [])]
  const labels = collectSpeakerLabels(raw)
  const speakerIds = new Map(labels.map((label, index) => [label, `speaker-${index + 1}`]))
  const words = normalizeWords(raw.words ?? [], speakerIds, metadata.durationMs, warnings)
  const utterances = raw.utterances?.length
    ? normalizeUtterances(raw.utterances, words, speakerIds, metadata.durationMs, warnings)
    : groupWordsIntoUtterances(words)

  if (words.length === 0 && utterances.length === 0 && (raw.text ?? '').trim()) {
    utterances.push({
      id: 'utterance-1',
      text: raw.text!.trim(),
      startMs: 0,
      endMs: metadata.durationMs,
      speakerId: null,
      wordIds: [],
      manuallyEdited: false
    })
    warnings.push('The provider did not return word-level timestamps.')
  }

  const computedText = utterances.length
    ? utterances.map((utterance) => utterance.text).join('\n')
    : tokensToText(words.map((word) => word.text))
  const document = {
    schemaVersion: 1 as const,
    id: randomUUID(),
    sessionId: metadata.sessionId,
    revision: 1,
    sourceSha256: metadata.sourceSha256,
    durationMs: metadata.durationMs,
    text: raw.text?.trim() || computedText,
    languages: uniqueStrings(raw.languages ?? []),
    speakers: labels.map((label) => ({
      id: speakerIds.get(label)!,
      label,
      displayName: raw.speakerDisplayNames?.[label] ?? null
    })),
    words,
    utterances,
    warnings: uniqueStrings(warnings),
    provenance: {
      providerKind: metadata.providerKind,
      model: metadata.model,
      generatedAt: metadata.generatedAt
    }
  }
  return transcriptDocumentSchema.parse(document)
}

export function parseCanonicalTranscript(
  value: unknown,
  metadata: TranscriptMetadata
): TranscriptDocumentV1 {
  const parsed = transcriptDocumentSchema.parse(value)
  return transcriptDocumentSchema.parse({
    ...parsed,
    id: randomUUID(),
    sessionId: metadata.sessionId,
    revision: 1,
    sourceSha256: metadata.sourceSha256,
    durationMs: metadata.durationMs,
    provenance: {
      providerKind: metadata.providerKind,
      model: metadata.model,
      generatedAt: metadata.generatedAt
    }
  })
}

function collectSpeakerLabels(raw: RawTranscript): string[] {
  const labels: string[] = []
  for (const item of [...(raw.words ?? []), ...(raw.utterances ?? [])]) {
    const label = item.speakerLabel?.trim()
    if (label && !labels.includes(label)) labels.push(label)
  }
  return labels
}

function normalizeWords(
  input: readonly RawTranscriptWord[],
  speakerIds: ReadonlyMap<string, string>,
  durationMs: number,
  warnings: string[]
): CanonicalWord[] {
  return input
    .map((word, originalIndex) => ({ word, originalIndex }))
    .filter(({ word }) => word.text.length > 0)
    .sort((left, right) =>
      left.word.startMs === right.word.startMs
        ? left.originalIndex - right.originalIndex
        : left.word.startMs - right.word.startMs
    )
    .map(({ word }, index) => {
      const startMs = clampMilliseconds(word.startMs, durationMs)
      const endMs = Math.max(startMs, clampMilliseconds(word.endMs, durationMs))
      if (startMs !== Math.round(word.startMs) || endMs !== Math.round(word.endMs)) {
        warnings.push('Some provider timestamps were clamped to the recording duration.')
      }
      const label = word.speakerLabel?.trim()
      return {
        id: `word-${index + 1}`,
        text: word.text,
        startMs,
        endMs,
        speakerId: label ? (speakerIds.get(label) ?? null) : null,
        confidence:
          word.confidence === null ||
          word.confidence === undefined ||
          !Number.isFinite(word.confidence)
            ? null
            : Math.max(0, Math.min(1, word.confidence))
      }
    })
}

function normalizeUtterances(
  input: readonly RawTranscriptUtterance[],
  words: readonly CanonicalWord[],
  speakerIds: ReadonlyMap<string, string>,
  durationMs: number,
  warnings: string[]
): TranscriptDocumentV1['utterances'] {
  return input
    .map((utterance, originalIndex) => ({ utterance, originalIndex }))
    .filter(({ utterance }) => utterance.text.trim().length > 0)
    .sort((left, right) =>
      left.utterance.startMs === right.utterance.startMs
        ? left.originalIndex - right.originalIndex
        : left.utterance.startMs - right.utterance.startMs
    )
    .map(({ utterance }, index) => {
      const startMs = clampMilliseconds(utterance.startMs, durationMs)
      const endMs = Math.max(startMs, clampMilliseconds(utterance.endMs, durationMs))
      if (startMs !== Math.round(utterance.startMs) || endMs !== Math.round(utterance.endMs)) {
        warnings.push('Some provider timestamps were clamped to the recording duration.')
      }
      const label = utterance.speakerLabel?.trim()
      const speakerId = label ? (speakerIds.get(label) ?? null) : null
      return {
        id: `utterance-${index + 1}`,
        text: utterance.text.trim(),
        startMs,
        endMs,
        speakerId,
        wordIds: words
          .filter((word) => {
            const midpoint = word.startMs + (word.endMs - word.startMs) / 2
            return (
              midpoint >= startMs &&
              (midpoint < endMs || startMs === endMs) &&
              (speakerId === null || word.speakerId === speakerId)
            )
          })
          .map((word) => word.id),
        manuallyEdited: false
      }
    })
}

function groupWordsIntoUtterances(
  words: readonly CanonicalWord[]
): TranscriptDocumentV1['utterances'] {
  if (words.length === 0) return []
  const groups: CanonicalWord[][] = []
  let current: CanonicalWord[] = []
  for (const word of words) {
    const previous = current.at(-1)
    const shouldSplit =
      previous !== undefined &&
      (word.speakerId !== previous.speakerId ||
        word.startMs - previous.endMs > 1_200 ||
        word.endMs - current[0]!.startMs > 30_000 ||
        (/[.!?]\s*$/.test(previous.text) && word.startMs - previous.endMs > 250))
    if (shouldSplit) {
      groups.push(current)
      current = []
    }
    current.push(word)
  }
  if (current.length) groups.push(current)

  return groups.map((group, index) => ({
    id: `utterance-${index + 1}`,
    text: tokensToText(group.map((word) => word.text)),
    startMs: group[0]!.startMs,
    endMs: group.at(-1)!.endMs,
    speakerId: group[0]!.speakerId,
    wordIds: group.map((word) => word.id),
    manuallyEdited: false
  }))
}

export function tokensToText(tokens: readonly string[]): string {
  let result = ''
  for (const token of tokens) {
    if (!result || /^\s/.test(token) || /\s$/.test(result) || /^[,.;:!?%)\]}]/.test(token)) {
      result += token
    } else if (/^['\u2019]/.test(token) || /[([{]$/.test(result)) {
      result += token
    } else {
      result += ` ${token}`
    }
  }
  return result.trim()
}

function clampMilliseconds(value: number, durationMs: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(Math.round(value), durationMs))
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}
