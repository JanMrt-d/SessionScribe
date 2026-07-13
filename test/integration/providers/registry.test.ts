import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DeterministicFakeSummaryAdapter,
  DeterministicFakeTranscriptionAdapter,
  ProviderRegistry
} from '@main/providers'
import type { SummaryProfileV1, TranscriptionProfileV1 } from '@shared/providers'
import { profileBase, providerContext, transcriptFixture } from './helpers'

describe('provider registry and deterministic adapters', () => {
  it('dispatches fake adapters through the production contracts deterministically', async () => {
    const registry = new ProviderRegistry([
      new DeterministicFakeTranscriptionAdapter('openai-transcription'),
      new DeterministicFakeSummaryAdapter('openai-compatible')
    ])
    const transcriptionProfile: Extract<TranscriptionProfileV1, { kind: 'openai-transcription' }> =
      {
        ...profileBase('arbitrary-transcription-model'),
        task: 'transcription',
        kind: 'openai-transcription',
        baseUrl: 'https://example.test/v1',
        language: null,
        responseFormat: 'auto',
        maxUploadBytes: 1_000_000
      }
    const request = {
      sessionId: randomUUID(),
      sourceSha256: 'same-source',
      filePath: '/unused-by-fake.wav',
      mimeType: 'audio/wav',
      durationMs: 2_000
    }
    const first = await registry.transcribe(request, transcriptionProfile, providerContext())
    const second = await registry.transcribe(request, transcriptionProfile, providerContext())
    expect(first).toEqual(second)

    const summaryProfile: Extract<SummaryProfileV1, { kind: 'openai-compatible' }> = {
      ...profileBase('arbitrary-summary-model'),
      task: 'summary',
      kind: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      apiStyle: 'responses',
      structuredOutput: 'json-schema',
      contextWindowTokens: 8_192,
      extraBody: {},
      meetingPromptOverride: null,
      lecturePromptOverride: null
    }
    const transcript = transcriptFixture()
    const summary = await registry.summarize(
      {
        sessionId: transcript.sessionId,
        title: 'Fixture',
        mode: 'meeting',
        revision: 1,
        transcript
      },
      summaryProfile,
      providerContext()
    )
    expect(summary.provenance.promptVersion).toBe('deterministic-fake-v1')
    expect(registry.test(summaryProfile, providerContext())).toMatchObject({
      ok: true,
      kind: 'openai-compatible'
    })
  })
})
