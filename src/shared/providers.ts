import { z } from 'zod'

const baseProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  model: z.string().min(1),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
  secretRefs: z.record(z.string(), z.string()),
  extraHeaders: z.record(z.string(), z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})

const remoteBaseSchema = baseProfileSchema.extend({
  baseUrl: z.string().url()
})

export const elevenLabsProfileSchema = remoteBaseSchema.extend({
  task: z.literal('transcription'),
  kind: z.literal('elevenlabs'),
  language: z.string().nullable(),
  diarize: z.boolean(),
  numSpeakers: z.number().int().min(1).max(32).nullable(),
  timestampGranularity: z.enum(['word', 'character'])
})

export const openAiTranscriptionProfileSchema = remoteBaseSchema.extend({
  task: z.literal('transcription'),
  kind: z.literal('openai-transcription'),
  language: z.string().nullable(),
  responseFormat: z.enum(['auto', 'json', 'text', 'verbose_json', 'diarized_json']),
  maxUploadBytes: z.number().int().positive()
})

export const localCliTranscriptionProfileSchema = baseProfileSchema.extend({
  task: z.literal('transcription'),
  kind: z.literal('local-cli'),
  executable: z.string().min(1),
  args: z.array(z.string()),
  outputMode: z.enum(['stdout', 'file']),
  outputFormat: z.enum(['canonical-v1', 'openai-verbose-json', 'elevenlabs-json', 'text']),
  inheritEnvironment: z.boolean()
})

export const managedWhisperProfileSchema = baseProfileSchema.extend({
  task: z.literal('transcription'),
  kind: z.literal('managed-whisper'),
  model: z.literal('large-v3'),
  language: z.string().nullable()
})

export const openAiSummaryProfileSchema = remoteBaseSchema.extend({
  task: z.literal('summary'),
  kind: z.literal('openai-compatible'),
  apiStyle: z.enum(['responses', 'chat-completions']),
  structuredOutput: z.enum(['json-schema', 'json-object', 'prompt-only']),
  contextWindowTokens: z.number().int().min(2_048),
  extraBody: z.record(z.string(), z.unknown()),
  meetingPromptOverride: z.string().nullable(),
  lecturePromptOverride: z.string().nullable()
})

export const ollamaSummaryProfileSchema = remoteBaseSchema.extend({
  task: z.literal('summary'),
  kind: z.literal('ollama'),
  contextWindowTokens: z.number().int().min(2_048),
  numPredict: z.number().int().positive().nullable(),
  meetingPromptOverride: z.string().nullable(),
  lecturePromptOverride: z.string().nullable()
})

/**
 * Drives a locally installed agent CLI (Claude Code's `claude -p`) for summaries.
 * The prompt is written to the child's stdin rather than argv so a long transcript
 * chunk cannot exceed the platform argument limit, which is why — unlike the
 * transcription CLI adapter — no `{input}` placeholder is required.
 */
export const claudeCliSummaryProfileSchema = baseProfileSchema.extend({
  task: z.literal('summary'),
  kind: z.literal('claude-cli'),
  executable: z.string().min(1),
  args: z.array(z.string()),
  /** `claude-json` unwraps the `--output-format json` envelope; `raw` reads stdout verbatim. */
  outputEnvelope: z.enum(['claude-json', 'raw']),
  inheritEnvironment: z.boolean(),
  contextWindowTokens: z.number().int().min(2_048),
  meetingPromptOverride: z.string().nullable(),
  lecturePromptOverride: z.string().nullable()
})

export const providerProfileSchema = z.discriminatedUnion('kind', [
  elevenLabsProfileSchema,
  openAiTranscriptionProfileSchema,
  localCliTranscriptionProfileSchema,
  managedWhisperProfileSchema,
  openAiSummaryProfileSchema,
  ollamaSummaryProfileSchema,
  claudeCliSummaryProfileSchema
])
export type ProviderProfileV1 = z.infer<typeof providerProfileSchema>
export type TranscriptionProfileV1 = Extract<ProviderProfileV1, { task: 'transcription' }>
export type SummaryProfileV1 = Extract<ProviderProfileV1, { task: 'summary' }>

export const providerCapabilitiesSchema = z.object({
  timestamps: z.union([z.boolean(), z.literal('unknown')]),
  diarization: z.union([z.boolean(), z.literal('unknown')]),
  structuredOutput: z.union([z.boolean(), z.literal('unknown')]),
  modelListing: z.boolean(),
  maxInputBytes: z.number().int().positive().nullable(),
  maxDurationMs: z.number().int().positive().nullable()
})
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>
