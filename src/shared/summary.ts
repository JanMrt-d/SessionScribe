import { z } from 'zod'
import { evidenceRefSchema } from './transcript'

const groundedTextSchema = z.object({
  text: z.string(),
  evidence: z.array(evidenceRefSchema)
})

const summaryBaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  revision: z.number().int().positive(),
  transcriptRevision: z.number().int().positive(),
  title: z.string(),
  overview: z.string(),
  provenance: z.object({
    providerKind: z.string(),
    model: z.string(),
    promptVersion: z.string(),
    generatedAt: z.string().datetime()
  }),
  manuallyEdited: z.boolean()
})

export const meetingSummarySchema = summaryBaseSchema.extend({
  mode: z.literal('meeting'),
  topics: z.array(groundedTextSchema),
  decisions: z.array(groundedTextSchema),
  actionItems: z.array(
    z.object({
      task: z.string(),
      assignee: z.string().nullable(),
      explicitAssignment: z.boolean(),
      dueAt: z.string().datetime().nullable(),
      dueText: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      evidence: z.array(evidenceRefSchema)
    })
  ),
  openQuestions: z.array(groundedTextSchema),
  risks: z.array(groundedTextSchema)
})

export const lectureSummarySchema = summaryBaseSchema.extend({
  mode: z.literal('lecture'),
  outline: z.array(groundedTextSchema),
  keyLessons: z.array(groundedTextSchema),
  concepts: z.array(
    z.object({ name: z.string(), definition: z.string(), evidence: z.array(evidenceRefSchema) })
  ),
  examples: z.array(groundedTextSchema),
  reviewQuestions: z.array(z.string()),
  recommendedReview: z.array(groundedTextSchema)
})

export const summaryDocumentSchema = z.discriminatedUnion('mode', [
  meetingSummarySchema,
  lectureSummarySchema
])
export type MeetingSummaryV1 = z.infer<typeof meetingSummarySchema>
export type LectureSummaryV1 = z.infer<typeof lectureSummarySchema>
export type SummaryDocumentV1 = z.infer<typeof summaryDocumentSchema>
