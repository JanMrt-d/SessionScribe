import { z } from 'zod'

export const evidenceRefSchema = z.object({
  utteranceId: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative()
})
export type EvidenceRef = z.infer<typeof evidenceRefSchema>

export const transcriptWordSchema = z.object({
  id: z.string(),
  text: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  speakerId: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable()
})

export const transcriptUtteranceSchema = z.object({
  id: z.string(),
  text: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  speakerId: z.string().nullable(),
  wordIds: z.array(z.string()),
  manuallyEdited: z.boolean()
})
export type TranscriptUtterance = z.infer<typeof transcriptUtteranceSchema>

export const transcriptSpeakerSchema = z.object({
  id: z.string(),
  label: z.string(),
  displayName: z.string().nullable()
})

export const transcriptDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  revision: z.number().int().positive(),
  sourceSha256: z.string(),
  durationMs: z.number().int().nonnegative(),
  text: z.string(),
  languages: z.array(z.string()),
  speakers: z.array(transcriptSpeakerSchema),
  words: z.array(transcriptWordSchema),
  utterances: z.array(transcriptUtteranceSchema),
  warnings: z.array(z.string()),
  provenance: z.object({
    providerKind: z.string(),
    model: z.string(),
    generatedAt: z.string().datetime()
  })
})
export type TranscriptDocumentV1 = z.infer<typeof transcriptDocumentSchema>
