import type { TranscriptionProfileV1 } from '@shared/providers'

export type ElevenLabsProfileV1 = Extract<TranscriptionProfileV1, { kind: 'elevenlabs' }>
export type OpenAiTranscriptionProfileV1 = Extract<
  TranscriptionProfileV1,
  { kind: 'openai-transcription' }
>
export type LocalCliTranscriptionProfileV1 = Extract<TranscriptionProfileV1, { kind: 'local-cli' }>
export type ManagedWhisperProfileV1 = Extract<
  TranscriptionProfileV1,
  { kind: 'managed-whisper' }
>
