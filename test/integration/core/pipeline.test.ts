import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderProfileV1 } from '@shared/index'
import type {
  ProviderCapabilities,
  TranscriptDocumentV1,
  TranscriptionProfileV1
} from '@shared/index'
import { AppDatabase } from '@main/persistence/Database'
import { ArtifactStore } from '@main/artifacts/ArtifactStore'
import { SessionService } from '@main/sessions/SessionService'
import { FfmpegService, runProcess } from '@main/media/FfmpegService'
import { DurableProcessingController } from '@main/pipeline/ProcessingController'
import {
  DeterministicFakeSummaryAdapter,
  DeterministicFakeTranscriptionAdapter,
  ProviderRegistry,
  type ProviderContext,
  type TranscriptionAdapter,
  type TranscriptionRequest
} from '@main/providers'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('durable processing pipeline', () => {
  it('runs imported media through canonical transcription and meeting summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-pipeline-'))
    directories.push(root)
    const ffmpeg = await FfmpegService.create({ resourcesPath: resolve('resources') })
    const source = join(root, 'meeting.wav')
    await runProcess(
      ffmpeg.ffmpegPath,
      ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', source],
      { timeoutMs: 30_000 }
    )

    const database = new AppDatabase(join(root, 'app.db'))
    const artifacts = new ArtifactStore(join(root, 'videos'))
    await artifacts.initialize()
    const sessions = new SessionService(database, artifacts)
    const session = await sessions.importMedia(source, 'meeting', 'Pipeline meeting')

    const [transcriptionProfile, summaryProfile] = profiles()
    database.saveProviderProfile(transcriptionProfile)
    database.saveProviderProfile(summaryProfile)
    const registry = new ProviderRegistry([
      new DeterministicFakeTranscriptionAdapter('local-cli'),
      new DeterministicFakeSummaryAdapter('ollama')
    ])
    const processing = new DurableProcessingController(
      database,
      artifacts,
      sessions,
      { get: async () => undefined },
      ffmpeg,
      registry
    )

    const job = await processing.enqueue({
      sessionId: session.id,
      transcriptionProfileId: transcriptionProfile.id,
      summaryProfileId: summaryProfile.id,
      mode: 'meeting'
    })
    const succeededSessionStatuses: string[] = []
    const unsubscribe = processing.subscribe((updated) => {
      if (updated.id === job.id && updated.status === 'succeeded') {
        succeededSessionStatuses.push(database.getSession(updated.sessionId)?.status ?? 'missing')
      }
    })
    await waitFor(() => database.getJob(job.id)?.status === 'succeeded')

    const details = sessions.get(session.id)
    expect(succeededSessionStatuses).toEqual(['ready'])
    expect(details.session.status).toBe('ready')
    expect(details.transcript?.utterances[0]?.text).toBe('Deterministic transcript.')
    expect(details.summary?.mode).toBe('meeting')
    expect(details.summaryStale).toBe(false)
    unsubscribe()
    database.close()
  })

  it('pauses a running provider call on shutdown and resumes the durable job', async () => {
    const fixture = await pipelineFixture('Shutdown recovery')
    const blocking = new BlockingTranscriptionAdapter()
    const processing = fixture.processing(blocking)
    const job = await processing.enqueue({
      sessionId: fixture.session.id,
      transcriptionProfileId: fixture.transcriptionProfile.id,
      summaryProfileId: fixture.summaryProfile.id,
      mode: 'meeting'
    })
    await waitFor(
      () =>
        fixture.database.getJob(job.id)?.status === 'running' &&
        fixture.database.getJob(job.id)?.stage === 'transcribe'
    )

    await processing.shutdown()

    expect(fixture.database.getJob(job.id)).toMatchObject({
      status: 'queued',
      stage: 'transcribe',
      errorMessage: 'Paused for application shutdown'
    })
    const resumed = fixture.processing(new DeterministicFakeTranscriptionAdapter('local-cli'))
    resumed.resumePending()
    await waitFor(() => fixture.database.getJob(job.id)?.status === 'succeeded')
    expect(fixture.sessions.get(fixture.session.id).session.status).toBe('ready')
    await resumed.shutdown()
    fixture.database.close()
  })

  it('persists an interrupted session before notifying cancellation observers', async () => {
    const fixture = await pipelineFixture('Cancelled session event ordering')
    const processing = fixture.processing(new BlockingTranscriptionAdapter())
    const observedSessionStatuses: string[] = []
    const job = await processing.enqueue({
      sessionId: fixture.session.id,
      transcriptionProfileId: fixture.transcriptionProfile.id,
      summaryProfileId: fixture.summaryProfile.id,
      mode: 'meeting'
    })
    const unsubscribe = processing.subscribe((updated) => {
      if (updated.id === job.id && updated.status === 'cancelled') {
        observedSessionStatuses.push(
          fixture.database.getSession(updated.sessionId)?.status ?? 'missing'
        )
      }
    })
    await waitFor(
      () =>
        fixture.database.getJob(job.id)?.status === 'running' &&
        fixture.database.getJob(job.id)?.stage === 'transcribe'
    )

    await processing.cancel(job.id)

    expect(observedSessionStatuses).toEqual(['interrupted'])
    expect(fixture.database.getSession(fixture.session.id)?.status).toBe('interrupted')
    unsubscribe()
    await processing.shutdown()
    fixture.database.close()
  })

  it('continues the global queue after a running session is cancelled and deleted', async () => {
    const fixture = await pipelineFixture('Deleted running session')
    const secondSession = await fixture.sessions.importMedia(
      fixture.source,
      'meeting',
      'Queued session'
    )
    const blocking = new BlockingTranscriptionAdapter(fixture.session.id)
    const processing = fixture.processing(blocking)
    const firstJob = await processing.enqueue({
      sessionId: fixture.session.id,
      transcriptionProfileId: fixture.transcriptionProfile.id,
      summaryProfileId: fixture.summaryProfile.id,
      mode: 'meeting'
    })
    const secondJob = await processing.enqueue({
      sessionId: secondSession.id,
      transcriptionProfileId: fixture.transcriptionProfile.id,
      summaryProfileId: fixture.summaryProfile.id,
      mode: 'meeting'
    })
    await waitFor(() => fixture.database.getJob(firstJob.id)?.stage === 'transcribe')

    await processing.cancel(firstJob.id)
    await fixture.sessions.delete(fixture.session.id)

    await waitFor(() => fixture.database.getJob(secondJob.id)?.status === 'succeeded')
    expect(fixture.database.getJob(firstJob.id)).toBeNull()
    expect(fixture.sessions.get(secondSession.id).session.status).toBe('ready')
    await processing.shutdown()
    fixture.database.close()
  })
})

class BlockingTranscriptionAdapter implements TranscriptionAdapter<TranscriptionProfileV1> {
  readonly kind = 'local-cli' as const
  private readonly delegate = new DeterministicFakeTranscriptionAdapter('local-cli')

  constructor(private readonly blockedSessionId?: string) {}

  capabilities(): ProviderCapabilities {
    return this.delegate.capabilities()
  }

  async transcribe(
    request: TranscriptionRequest,
    profile: TranscriptionProfileV1,
    context: ProviderContext
  ): Promise<TranscriptDocumentV1> {
    if (this.blockedSessionId && request.sessionId !== this.blockedSessionId) {
      return await this.delegate.transcribe(request, profile, context)
    }
    return await new Promise<TranscriptDocumentV1>((_resolve, reject) => {
      const abort = (): void => {
        context.signal.removeEventListener('abort', abort)
        reject(
          context.signal.reason instanceof Error
            ? context.signal.reason
            : new DOMException('Cancelled', 'AbortError')
        )
      }
      if (context.signal.aborted) abort()
      else context.signal.addEventListener('abort', abort, { once: true })
    })
  }
}

async function pipelineFixture(title: string): Promise<{
  database: AppDatabase
  sessions: SessionService
  session: Awaited<ReturnType<SessionService['importMedia']>>
  source: string
  transcriptionProfile: ProviderProfileV1
  summaryProfile: ProviderProfileV1
  processing(adapter: TranscriptionAdapter): DurableProcessingController
}> {
  const root = await mkdtemp(join(tmpdir(), 'sessionscribe-pipeline-'))
  directories.push(root)
  const ffmpeg = await FfmpegService.create({ resourcesPath: resolve('resources') })
  const source = join(root, 'meeting.wav')
  await runProcess(
    ffmpeg.ffmpegPath,
    ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25', '-c:a', 'pcm_s16le', source],
    { timeoutMs: 30_000 }
  )
  const database = new AppDatabase(join(root, 'app.db'))
  const artifacts = new ArtifactStore(join(root, 'videos'))
  await artifacts.initialize()
  const sessions = new SessionService(database, artifacts)
  const session = await sessions.importMedia(source, 'meeting', title)
  const [transcriptionProfile, summaryProfile] = profiles()
  database.saveProviderProfile(transcriptionProfile)
  database.saveProviderProfile(summaryProfile)
  return {
    database,
    sessions,
    session,
    source,
    transcriptionProfile,
    summaryProfile,
    processing: (adapter) =>
      new DurableProcessingController(
        database,
        artifacts,
        sessions,
        { get: async () => undefined },
        ffmpeg,
        new ProviderRegistry([adapter, new DeterministicFakeSummaryAdapter('ollama')])
      )
  }
}

function profiles(): [ProviderProfileV1, ProviderProfileV1] {
  const now = new Date().toISOString()
  return [
    {
      id: randomUUID(),
      name: 'Fake local transcription',
      task: 'transcription',
      kind: 'local-cli',
      model: 'fake-transcriber',
      timeoutMs: 60_000,
      secretRefs: {},
      extraHeaders: {},
      executable:
        process.platform === 'win32' ? 'C:\\Windows\\System32\\where.exe' : '/usr/bin/false',
      args: [],
      outputMode: 'stdout',
      outputFormat: 'text',
      inheritEnvironment: false,
      createdAt: now,
      updatedAt: now
    },
    {
      id: randomUUID(),
      name: 'Fake local summary',
      task: 'summary',
      kind: 'ollama',
      model: 'fake-summary',
      timeoutMs: 60_000,
      secretRefs: {},
      extraHeaders: {},
      baseUrl: 'http://127.0.0.1:11434',
      contextWindowTokens: 8_192,
      numPredict: 1_024,
      meetingPromptOverride: null,
      lecturePromptOverride: null,
      createdAt: now,
      updatedAt: now
    }
  ]
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  throw new Error('Timed out waiting for pipeline completion')
}
