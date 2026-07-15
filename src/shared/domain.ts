import { z } from 'zod'

export const sessionModeSchema = z.enum(['meeting', 'lecture'])
export type SessionMode = z.infer<typeof sessionModeSchema>

export const sessionStatusSchema = z.enum([
  'draft',
  'configuring',
  'ready-to-record',
  'recording',
  'finalizing',
  'processing',
  'ready',
  'interrupted',
  'failed'
])
export type SessionStatus = z.infer<typeof sessionStatusSchema>

export const jobStageSchema = z.enum([
  'probe',
  'playback-proxy',
  'extract-audio',
  'transcribe',
  'diarize',
  'summarize',
  'export'
])

export const jobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled'])

export const jobSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  stage: jobStageSchema,
  status: jobStatusSchema,
  progress: z.number().min(0).max(1),
  attempt: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})
export type Job = z.infer<typeof jobSchema>

export const sessionSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(240),
  preferredMode: sessionModeSchema,
  status: sessionStatusSchema,
  recordingFileName: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastError: z.string().nullable(),
  transcriptRevision: z.number().int().nonnegative(),
  summaryRevision: z.number().int().nonnegative()
})
export type Session = z.infer<typeof sessionSchema>

export const appBootstrapSchema = z.object({
  version: z.string(),
  platform: z.enum(['win32', 'linux']),
  sessions: z.array(sessionSchema),
  obsConnected: z.boolean(),
  activeSessionId: z.string().uuid().nullable(),
  encryptionAvailable: z.boolean()
})
export type AppBootstrap = z.infer<typeof appBootstrapSchema>
