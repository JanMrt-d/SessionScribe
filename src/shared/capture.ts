import { z } from 'zod'

export const captureTargetSchema = z.object({
  id: z.string(),
  label: z.string(),
  platform: z.enum(['windows', 'x11', 'wayland']),
  requiresPortal: z.boolean()
})
export type CaptureTarget = z.infer<typeof captureTargetSchema>

export const audioDeviceSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['microphone', 'output', 'window'])
})
export type AudioDevice = z.infer<typeof audioDeviceSchema>

export const captureConfigurationSchema = z.object({
  targetId: z.string().nullable(),
  microphoneDeviceId: z.string().nullable(),
  outputDeviceId: z.string().nullable(),
  captureCursor: z.boolean()
})
export type CaptureConfiguration = z.infer<typeof captureConfigurationSchema>

export const captureStatusSchema = z.object({
  connected: z.boolean(),
  obsVersion: z.string().nullable(),
  phase: z.enum(['disconnected', 'configuring', 'ready', 'recording', 'finalizing', 'recovering']),
  activeSessionId: z.string().uuid().nullable(),
  elapsedMs: z.number().int().nonnegative(),
  bytesWritten: z.number().int().nonnegative(),
  microphoneLevel: z.number().min(0).max(1),
  systemLevel: z.number().min(0).max(1),
  warnings: z.array(z.string())
})
export type CaptureStatus = z.infer<typeof captureStatusSchema>

export const preflightResultSchema = z.object({
  ok: z.boolean(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  screenshotDataUrl: z.string().nullable()
})
export type PreflightResult = z.infer<typeof preflightResultSchema>
