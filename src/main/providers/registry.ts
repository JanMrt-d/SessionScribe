import {
  providerProfileSchema,
  type ProviderCapabilities,
  type ProviderProfileV1,
  type SummaryProfileV1,
  type TranscriptionProfileV1
} from '@shared/providers'
import type { SummaryDocumentV1 } from '@shared/summary'
import type { TranscriptDocumentV1 } from '@shared/transcript'
import type {
  ProviderAdapter,
  ProviderContext,
  SummaryAdapter,
  SummaryRequest,
  TranscriptionAdapter,
  TranscriptionRequest
} from './contracts'
import { ProviderError } from './errors'

export interface ProviderTestResult {
  ok: true
  kind: ProviderProfileV1['kind']
  capabilities: ProviderCapabilities
}

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderProfileV1['kind'], ProviderAdapter>()

  constructor(adapters: readonly ProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: ProviderAdapter): this {
    if (this.adapters.has(adapter.kind)) {
      throw new ProviderError(
        'INVALID_CONFIG',
        `Provider adapter ${adapter.kind} is already registered`,
        {
          providerKind: adapter.kind,
          operation: isSummaryAdapter(adapter) ? 'summarize' : 'transcribe',
          stage: 'preflight'
        }
      )
    }
    this.adapters.set(adapter.kind, adapter)
    return this
  }

  async transcribe(
    request: TranscriptionRequest,
    profile: TranscriptionProfileV1,
    context: ProviderContext
  ): Promise<TranscriptDocumentV1> {
    const parsed = parseProfile(profile, 'transcribe')
    if (parsed.task !== 'transcription') throw taskMismatch(parsed.kind, 'transcribe')
    const adapter = this.adapters.get(parsed.kind)
    if (!adapter || !isTranscriptionAdapter(adapter))
      throw missingAdapter(parsed.kind, 'transcribe')
    return adapter.transcribe(request, parsed, context)
  }

  async summarize(
    request: SummaryRequest,
    profile: SummaryProfileV1,
    context: ProviderContext
  ): Promise<SummaryDocumentV1> {
    const parsed = parseProfile(profile, 'summarize')
    if (parsed.task !== 'summary') throw taskMismatch(parsed.kind, 'summarize')
    const adapter = this.adapters.get(parsed.kind)
    if (!adapter || !isSummaryAdapter(adapter)) throw missingAdapter(parsed.kind, 'summarize')
    return adapter.summarize(request, parsed, context)
  }

  test(profile: ProviderProfileV1, context: ProviderContext): ProviderTestResult {
    if (context.signal.aborted) {
      throw new ProviderError('CANCELLED', 'Provider validation was cancelled', {
        providerKind: profile.kind,
        operation: profile.task === 'summary' ? 'summarize' : 'transcribe',
        stage: 'preflight'
      })
    }
    const parsed = parseProfile(profile, profile.task === 'summary' ? 'summarize' : 'transcribe')
    const adapter = this.adapters.get(parsed.kind)
    if (!adapter)
      throw missingAdapter(parsed.kind, parsed.task === 'summary' ? 'summarize' : 'transcribe')
    const capabilities =
      parsed.task === 'summary'
        ? (adapter as SummaryAdapter).capabilities(parsed)
        : (adapter as TranscriptionAdapter).capabilities(parsed)
    return { ok: true, kind: parsed.kind, capabilities }
  }
}

function parseProfile(
  profile: ProviderProfileV1,
  operation: 'transcribe' | 'summarize'
): ProviderProfileV1 {
  const result = providerProfileSchema.safeParse(profile)
  if (result.success) return result.data
  throw new ProviderError('INVALID_CONFIG', 'The provider profile is invalid', {
    providerKind:
      profile && typeof profile === 'object' && 'kind' in profile
        ? String(profile.kind)
        : 'unknown',
    operation,
    stage: 'preflight',
    cause: result.error
  })
}

function isTranscriptionAdapter(adapter: ProviderAdapter): adapter is TranscriptionAdapter {
  return 'transcribe' in adapter
}

function isSummaryAdapter(adapter: ProviderAdapter): adapter is SummaryAdapter {
  return 'summarize' in adapter
}

function missingAdapter(
  providerKind: string,
  operation: 'transcribe' | 'summarize'
): ProviderError {
  return new ProviderError('INVALID_CONFIG', `No adapter is registered for ${providerKind}`, {
    providerKind,
    operation,
    stage: 'preflight'
  })
}

function taskMismatch(providerKind: string, operation: 'transcribe' | 'summarize'): ProviderError {
  return new ProviderError('INVALID_CONFIG', 'The provider profile has the wrong task type', {
    providerKind,
    operation,
    stage: 'preflight'
  })
}
