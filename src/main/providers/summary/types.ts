import type { SummaryProfileV1 } from '@shared/providers'

export type OpenAiSummaryProfileV1 = Extract<SummaryProfileV1, { kind: 'openai-compatible' }>
export type OllamaSummaryProfileV1 = Extract<SummaryProfileV1, { kind: 'ollama' }>
