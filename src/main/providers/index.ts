import { ElevenLabsTranscriptionAdapter } from './transcription/elevenlabs'
import { LocalCliTranscriptionAdapter } from './transcription/local-cli'
import { OpenAiTranscriptionAdapter } from './transcription/openai'
import { OpenAiCompatibleSummaryAdapter } from './summary/openai-compatible'
import { OllamaSummaryAdapter } from './summary/ollama'
import { ProviderRegistry } from './registry'

export * from './contracts'
export * from './errors'
export * from './fakes'
export * from './http'
export * from './normalize'
export * from './registry'
export * from './security'
export * from './summary/engine'
export * from './summary/ollama'
export * from './summary/openai-compatible'
export * from './summary/prompts'
export * from './summary/types'
export * from './transcription/elevenlabs'
export * from './transcription/local-cli'
export * from './transcription/openai'
export * from './transcription/types'

export function createDefaultProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    new ElevenLabsTranscriptionAdapter(),
    new OpenAiTranscriptionAdapter(),
    new LocalCliTranscriptionAdapter(),
    new OpenAiCompatibleSummaryAdapter(),
    new OllamaSummaryAdapter()
  ])
}
