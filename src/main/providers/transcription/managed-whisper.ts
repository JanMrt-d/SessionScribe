import type { ProviderCapabilities } from '@shared/providers'
import type { ProviderContext, TranscriptionAdapter, TranscriptionRequest } from '../contracts'
import { normalizeProviderError } from '../errors'
import { transcribeOpenAiCompatible } from './openai'
import type { ManagedWhisperProfileV1 } from './types'

const MAX_LOCAL_UPLOAD_BYTES = 2 * 1_024 * 1_024 * 1_024

/**
 * whisper.cpp primes each decoding window with the previous window's tokens,
 * unbounded by default. A phrase the model repeats once therefore becomes its
 * own prompt and reinforces itself, which strands long recordings in a loop of
 * one sentence that the entropy and log-probability guards cannot break: text
 * generated from a matching prompt is high-confidence by construction. Decoding
 * each window without carried text costs some cross-window consistency and
 * makes that failure mode structurally impossible.
 */
const WHISPER_DECODER_OPTIONS = { max_context: '0' } as const

export interface ManagedWhisperLease {
  endpoint: string
  release(): Promise<void>
}

export interface ManagedWhisperRuntime {
  acquire(signal?: AbortSignal): Promise<ManagedWhisperLease>
}

export class ManagedWhisperTranscriptionAdapter implements TranscriptionAdapter<ManagedWhisperProfileV1> {
  readonly kind = 'managed-whisper' as const

  constructor(private readonly runtime: ManagedWhisperRuntime) {}

  capabilities(): ProviderCapabilities {
    return {
      timestamps: true,
      diarization: false,
      structuredOutput: true,
      modelListing: false,
      maxInputBytes: MAX_LOCAL_UPLOAD_BYTES,
      maxDurationMs: null
    }
  }

  async transcribe(
    request: TranscriptionRequest,
    profile: ManagedWhisperProfileV1,
    context: ProviderContext
  ) {
    let lease: ManagedWhisperLease | null = null
    try {
      lease = await this.runtime.acquire(context.signal)
      return await transcribeOpenAiCompatible(request, context, {
        providerKind: this.kind,
        baseUrl: lease.endpoint,
        model: profile.model,
        language: profile.language,
        responseFormat: 'verbose_json',
        maxUploadBytes: MAX_LOCAL_UPLOAD_BYTES,
        timeoutMs: profile.timeoutMs,
        headers: new Headers(),
        extraFormFields: WHISPER_DECODER_OPTIONS
      })
    } catch (error) {
      throw normalizeProviderError(error, {
        providerKind: this.kind,
        operation: 'transcribe',
        stage: lease ? 'request' : 'preflight'
      })
    } finally {
      await lease?.release()
    }
  }
}
