import { z } from 'zod'
import { evidenceRefSchema } from './transcript'

const groundedTextSchema = z.object({
  text: z.string(),
  evidence: z.array(evidenceRefSchema)
})

const definitionSchema = z.object({
  name: z.string(),
  definition: z.string(),
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

export const lectureSubtopicSchema = z.object({
  title: z.string(),
  keyPoints: z.array(groundedTextSchema)
})

export const lectureStudyQuestionSchema = z.object({
  question: z.string(),
  answer: z.string(),
  evidence: z.array(evidenceRefSchema)
})

export const lectureChapterSchema = z.object({
  title: z.string(),
  summary: z.string(),
  startMs: z.number().int().nonnegative(),
  subtopics: z.array(lectureSubtopicSchema),
  emphasis: z.array(groundedTextSchema),
  openQuestions: z.array(groundedTextSchema),
  glossary: z.array(definitionSchema),
  studyQuestions: z.array(lectureStudyQuestionSchema)
})

/**
 * Lecture notes are chapter-structured from revision 2 onwards. The flat
 * revision-1 shape summarized a whole lecture into one set of lists, which
 * compressed harder the longer the lecture ran; see upgradeSummaryDocument for
 * how stored revision-1 documents are carried forward.
 */
export const LECTURE_SUMMARY_SCHEMA_VERSION = 2

export const lectureSummarySchema = summaryBaseSchema.extend({
  schemaVersion: z.literal(LECTURE_SUMMARY_SCHEMA_VERSION),
  mode: z.literal('lecture'),
  /** BCP-47 tag the notes are written in; empty when the transcript reported none. */
  language: z.string(),
  chapters: z.array(lectureChapterSchema)
})

export const summaryDocumentSchema = z.discriminatedUnion('mode', [
  meetingSummarySchema,
  lectureSummarySchema
])
export type MeetingSummaryV1 = z.infer<typeof meetingSummarySchema>
export type LectureSummaryV2 = z.infer<typeof lectureSummarySchema>
export type LectureChapter = z.infer<typeof lectureChapterSchema>
export type LectureSubtopic = z.infer<typeof lectureSubtopicSchema>
export type LectureStudyQuestion = z.infer<typeof lectureStudyQuestionSchema>
export type SummaryDocumentV1 = z.infer<typeof summaryDocumentSchema>

/**
 * Brings a stored summary up to the current schema so that documents written by
 * an earlier build stay readable. Anything already current, or too malformed to
 * recognize, is returned untouched so that validation reports the real problem
 * instead of a failure inside this function.
 */
export function upgradeSummaryDocument(value: unknown): unknown {
  if (!isRecord(value) || value.mode !== 'lecture' || value.schemaVersion !== 1) return value
  const subtopics = [
    subtopic('Key lessons', value.keyLessons),
    subtopic('Outline', value.outline),
    subtopic('Examples', value.examples),
    subtopic('Recommended review', value.recommendedReview)
  ].filter((entry) => entry !== null)
  const glossary = Array.isArray(value.concepts) ? value.concepts : []
  const studyQuestions = (Array.isArray(value.reviewQuestions) ? value.reviewQuestions : [])
    .filter((question): question is string => typeof question === 'string')
    .map((question) => ({ question, answer: '', evidence: [] }))
  const chapter = {
    title: typeof value.title === 'string' && value.title ? value.title : 'Lecture',
    summary: '',
    startMs: earliestEvidenceStart(value),
    subtopics,
    emphasis: [],
    openQuestions: [],
    glossary,
    studyQuestions
  }
  const hasContent =
    subtopics.length > 0 || glossary.length > 0 || studyQuestions.length > 0 || chapter.summary
  return {
    ...value,
    schemaVersion: LECTURE_SUMMARY_SCHEMA_VERSION,
    language: '',
    chapters: hasContent ? [chapter] : []
  }
}

function subtopic(title: string, points: unknown): { title: string; keyPoints: unknown[] } | null {
  if (!Array.isArray(points) || points.length === 0) return null
  return { title, keyPoints: points }
}

function earliestEvidenceStart(value: unknown): number {
  let earliest = Number.POSITIVE_INFINITY
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    if (!isRecord(candidate)) return
    if (typeof candidate.startMs === 'number' && typeof candidate.utteranceId === 'string') {
      earliest = Math.min(earliest, candidate.startMs)
    }
    Object.values(candidate).forEach(visit)
  }
  visit(value)
  return Number.isFinite(earliest) ? Math.max(0, Math.trunc(earliest)) : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
