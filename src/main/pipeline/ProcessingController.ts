import { extname } from 'node:path'
import type {
  Job,
  ProviderProfileV1,
  SessionMode,
  SummaryProfileV1,
  TranscriptionProfileV1
} from '@shared/index'
import { ProviderError, type ProviderContext, type ProviderRegistry } from '../providers/index'
import type { ProcessingController } from '../app/contracts'
import type { AppDatabase } from '../persistence/Database'
import type { ArtifactStore } from '../artifacts/ArtifactStore'
import type { SessionService } from '../sessions/SessionService'
import type { FfmpegService } from '../media/FfmpegService'
import { providerSecretReference } from '../settings/ProviderProfileService'
import { logger } from '../logging/logger'

type FullJobPayload = {
  kind: 'full'
  transcriptionProfileId: string
  summaryProfileId: string
  mode: SessionMode
}

type SummaryJobPayload = {
  kind: 'summary'
  summaryProfileId: string
  mode: SessionMode
}

type PipelinePayload = FullJobPayload | SummaryJobPayload

export class DurableProcessingController implements ProcessingController {
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly listeners = new Set<(job: Job) => void>()
  private queue: Promise<void> = Promise.resolve()
  private shuttingDown = false

  constructor(
    private readonly database: AppDatabase,
    private readonly artifacts: ArtifactStore,
    private readonly sessions: SessionService,
    private readonly secrets: { get(reference: string): Promise<string | undefined> },
    private readonly ffmpeg: FfmpegService,
    private readonly providers: ProviderRegistry
  ) {}

  async enqueue(input: {
    sessionId: string
    transcriptionProfileId: string
    summaryProfileId: string
    mode: SessionMode
  }): Promise<Job> {
    this.requireTranscriptionProfile(input.transcriptionProfileId)
    this.requireSummaryProfile(input.summaryProfileId)
    const job = this.sessions.createJob(input.sessionId, 'probe', {
      kind: 'full',
      transcriptionProfileId: input.transcriptionProfileId,
      summaryProfileId: input.summaryProfileId,
      mode: input.mode
    } satisfies FullJobPayload)
    this.schedule(job.id)
    return job
  }

  async generateSummary(input: {
    sessionId: string
    profileId: string
    mode: SessionMode
  }): Promise<Job> {
    this.requireSummaryProfile(input.profileId)
    if (!this.database.getTranscript(input.sessionId))
      throw new Error('Transcribe the session first')
    const job = this.sessions.createJob(input.sessionId, 'summarize', {
      kind: 'summary',
      summaryProfileId: input.profileId,
      mode: input.mode
    } satisfies SummaryJobPayload)
    this.schedule(job.id)
    return job
  }

  async retry(jobId: string): Promise<Job> {
    const job = this.database.getJob(jobId)
    if (!job) throw new Error('Job not found')
    if (!['failed', 'cancelled'].includes(job.status))
      throw new Error('Only failed or cancelled jobs can retry')
    const queued = this.updateJob(jobId, {
      status: 'queued',
      progress: 0,
      attempt: job.attempt + 1,
      errorCode: null,
      errorMessage: null
    })
    this.schedule(jobId)
    return queued
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.database.getJob(jobId)
    if (!job || ['succeeded', 'failed', 'cancelled'].includes(job.status)) return
    this.abortControllers.get(jobId)?.abort()
    this.interruptSessionForCancelledJob(job)
    this.updateJob(jobId, {
      status: 'cancelled',
      errorCode: 'CANCELLED',
      errorMessage: 'Cancelled'
    })
  }

  async testProvider(
    profile: ProviderProfileV1,
    secretValues: Record<string, string>
  ): Promise<{ ok: boolean; message: string; models?: string[] }> {
    const controller = new AbortController()
    const ephemeral = new Map<string, string>()
    const secretRefs = Object.fromEntries(
      Object.keys(profile.secretRefs).map((name) => [
        name,
        providerSecretReference(profile.id, name)
      ])
    )
    for (const [name, value] of Object.entries(secretValues)) {
      const reference = providerSecretReference(profile.id, name)
      secretRefs[name] = reference
      ephemeral.set(reference, value)
    }
    const result = this.providers.test(
      { ...profile, secretRefs },
      this.context(
        controller.signal,
        async (reference) => ephemeral.get(reference) ?? this.secrets.get(reference)
      )
    )
    const enabled = Object.entries(result.capabilities)
      .filter(([, value]) => value === true)
      .map(([name]) => name)
    return {
      ok: result.ok,
      message: `Profile schema accepted. Capabilities: ${enabled.join(', ') || 'provider-defined'}`
    }
  }

  resumePending(): void {
    for (const job of this.database.listQueuedJobs()) this.schedule(job.id)
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    for (const controller of this.abortControllers.values()) {
      controller.abort(new DOMException('Application is shutting down', 'AbortError'))
    }
    await this.queue.catch(() => undefined)
  }

  subscribe(listener: (job: Job) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private schedule(jobId: string): void {
    this.queue = this.queue
      .then(async () => {
        if (this.shuttingDown) return
        const job = this.database.getJob(jobId)
        if (!job || job.status !== 'queued') return
        await this.run(job)
      })
      .catch((error: unknown) => {
        logger.error('Processing queue task failed unexpectedly', {
          jobId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }

  private async run(job: Job): Promise<void> {
    const controller = new AbortController()
    this.abortControllers.set(job.id, controller)
    this.database.updateSession(job.sessionId, { status: 'processing', lastError: null })
    this.updateJob(job.id, {
      status: 'running',
      attempt: Math.max(1, job.attempt),
      errorCode: null,
      errorMessage: null
    })
    try {
      const payload = this.database.getJobPayload<PipelinePayload>(job.id)
      if (payload.kind === 'full') {
        await this.runFull(job, payload, controller.signal)
      } else {
        await this.runSummary(job, payload, controller.signal)
      }
      throwIfCancelled(controller.signal)
      const current = this.database.getJob(job.id)
      if (!current || current.status === 'cancelled') return
      await this.artifacts.removeWorkFiles(job.sessionId).catch((error: unknown) => {
        logger.warn('Temporary processing files could not be removed', {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error)
        })
      })
      throwIfCancelled(controller.signal)
      const completed = this.database.getJob(job.id)
      if (!completed || completed.status === 'cancelled') return
      this.database.updateSession(job.sessionId, { status: 'ready', lastError: null })
      this.updateJob(job.id, { status: 'succeeded', progress: 1 })
    } catch (error) {
      const current = this.database.getJob(job.id)
      if (!current) return
      if (controller.signal.aborted) {
        if (this.shuttingDown) {
          this.updateJob(job.id, {
            status: 'queued',
            errorCode: null,
            errorMessage: 'Paused for application shutdown'
          })
        } else if (current.status !== 'cancelled') {
          this.interruptSessionForCancelledJob(current)
          this.updateJob(job.id, {
            status: 'cancelled',
            errorCode: 'CANCELLED',
            errorMessage: 'Cancelled'
          })
        }
      } else {
        const normalized = normalizePipelineError(error)
        this.database.updateSession(job.sessionId, {
          status: 'failed',
          lastError: normalized.message
        })
        this.updateJob(job.id, {
          status: 'failed',
          errorCode: normalized.code,
          errorMessage: normalized.message
        })
        logger.error('Processing job failed', { jobId: job.id, code: normalized.code })
      }
    } finally {
      this.abortControllers.delete(job.id)
    }
  }

  private async runFull(job: Job, payload: FullJobPayload, signal: AbortSignal): Promise<void> {
    const jobId = job.id
    const sessionId = job.sessionId
    const recordingPath = this.database.getRecordingPath(sessionId)
    if (!recordingPath) throw new Error('Session has no recording')
    this.artifacts.assertSessionPath(sessionId, recordingPath)

    this.stage(jobId, 'probe', 0.03)
    const probe = await this.ffmpeg.probe(recordingPath, signal)
    if (!probe.hasAudio) throw new Error('The recording does not contain an audio stream')
    this.database.setRecording(sessionId, recordingPath, probe.durationMs)

    if (probe.hasVideo) {
      this.stage(jobId, 'playback-proxy', 0.1)
      const proxyPath = this.artifacts.pathFor(sessionId, 'playback.mp4')
      await this.ffmpeg.makePlaybackProxy(recordingPath, proxyPath, signal)
      this.database.setPlaybackPath(sessionId, proxyPath)
    } else {
      this.database.setPlaybackPath(sessionId, null)
    }

    this.stage(jobId, 'extract-audio', 0.2)
    const audioPath = this.artifacts.pathFor(sessionId, 'work', 'audio.flac')
    await this.ffmpeg.extractSpeechAudio(recordingPath, audioPath, signal)
    const sourceSha256 = await this.ffmpeg.sha256(recordingPath, signal)

    const transcriptionProfile = this.requireTranscriptionProfile(payload.transcriptionProfileId)
    const reusableTranscript =
      job.stage === 'summarize' ? this.database.getTranscript(sessionId) : null
    const savedTranscript =
      reusableTranscript?.sourceSha256 === sourceSha256 &&
      reusableTranscript.provenance.providerKind === transcriptionProfile.kind &&
      reusableTranscript.provenance.model === transcriptionProfile.model
        ? reusableTranscript
        : await this.transcribeAndPersist(
            jobId,
            sessionId,
            sourceSha256,
            audioPath,
            probe.durationMs,
            transcriptionProfile,
            signal
          )

    this.stage(jobId, 'summarize', 0.75)
    const summaryProfile = this.requireSummaryProfile(payload.summaryProfileId)
    const session = this.database.getSession(sessionId)
    if (!session) throw new Error('Session not found')
    if (this.hasPersistedSummaryForJob(job, savedTranscript.revision, summaryProfile)) return
    const summary = await this.providers.summarize(
      {
        sessionId,
        title: session.title,
        mode: payload.mode,
        revision: session.summaryRevision + 1,
        transcript: savedTranscript
      },
      summaryProfile,
      this.context(signal, undefined, (progress) => {
        this.stage(jobId, 'summarize', 0.75 + progress * 0.24)
      })
    )
    throwIfCancelled(signal)
    this.sessions.saveSummary(summary)
  }

  private async runSummary(
    job: Job,
    payload: SummaryJobPayload,
    signal: AbortSignal
  ): Promise<void> {
    const jobId = job.id
    const sessionId = job.sessionId
    this.stage(jobId, 'summarize', 0.05)
    const transcript = this.database.getTranscript(sessionId)
    const session = this.database.getSession(sessionId)
    if (!transcript || !session) throw new Error('Session transcript not found')
    const profile = this.requireSummaryProfile(payload.summaryProfileId)
    if (this.hasPersistedSummaryForJob(job, transcript.revision, profile)) return
    const summary = await this.providers.summarize(
      {
        sessionId,
        title: session.title,
        mode: payload.mode,
        revision: session.summaryRevision + 1,
        transcript
      },
      profile,
      this.context(signal, undefined, (progress) =>
        this.stage(jobId, 'summarize', 0.05 + progress * 0.94)
      )
    )
    throwIfCancelled(signal)
    this.sessions.saveSummary(summary)
  }

  private async transcribeAndPersist(
    jobId: string,
    sessionId: string,
    sourceSha256: string,
    audioPath: string,
    durationMs: number,
    profile: TranscriptionProfileV1,
    signal: AbortSignal
  ) {
    this.stage(jobId, 'transcribe', 0.3)
    const transcript = await this.providers.transcribe(
      {
        sessionId,
        sourceSha256,
        filePath: audioPath,
        mimeType: 'audio/flac',
        durationMs
      },
      profile,
      this.context(signal, undefined, (progress) => {
        this.stage(jobId, 'transcribe', 0.3 + progress * 0.42)
      })
    )
    throwIfCancelled(signal)
    this.stage(jobId, 'summarize', 0.74)
    return this.sessions.saveTranscript(transcript)
  }

  private hasPersistedSummaryForJob(
    job: Job,
    transcriptRevision: number,
    profile: SummaryProfileV1
  ): boolean {
    const summary = this.database.getSummary(job.sessionId)
    return Boolean(
      job.stage === 'summarize' &&
      summary &&
      !summary.manuallyEdited &&
      summary.transcriptRevision === transcriptRevision &&
      summary.provenance.providerKind === profile.kind &&
      summary.provenance.model === profile.model &&
      Date.parse(summary.provenance.generatedAt) >= Date.parse(job.createdAt)
    )
  }

  private context(
    signal: AbortSignal,
    secretGetter?: (reference: string) => Promise<string | undefined>,
    progress?: (value: number) => void
  ): ProviderContext {
    return {
      signal,
      secrets: { get: secretGetter ?? ((reference) => this.secrets.get(reference)) },
      logger: {
        debug: (message, fields) => logger.debug(message, fields ?? {}),
        warn: (message, fields) => logger.warn(message, fields ?? {})
      },
      ...(progress
        ? {
            onProgress: (event: { progress: number }) =>
              progress(Math.max(0, Math.min(1, event.progress)))
          }
        : {})
    }
  }

  private requireTranscriptionProfile(id: string): TranscriptionProfileV1 {
    const profile = this.database.getProviderProfile(id)
    if (!profile || profile.task !== 'transcription')
      throw new Error('Transcription profile not found')
    return profile
  }

  private requireSummaryProfile(id: string): SummaryProfileV1 {
    const profile = this.database.getProviderProfile(id)
    if (!profile || profile.task !== 'summary') throw new Error('Summary profile not found')
    return profile
  }

  private interruptSessionForCancelledJob(job: Job): void {
    const session = this.database.getSession(job.sessionId)
    if (!session || session.status !== 'processing') return
    const hasOtherActiveJob = this.database
      .listJobs(job.sessionId)
      .some(
        (candidate) => candidate.id !== job.id && ['queued', 'running'].includes(candidate.status)
      )
    if (!hasOtherActiveJob) {
      this.database.updateSession(job.sessionId, {
        status: 'interrupted',
        lastError: 'Processing was cancelled.'
      })
    }
  }

  private stage(jobId: string, stage: Job['stage'], progress: number): void {
    if (!this.database.getJob(jobId)) return
    this.updateJob(jobId, { stage, progress: Math.max(0, Math.min(0.99, progress)) })
  }

  private updateJob(
    jobId: string,
    patch: Partial<Omit<Job, 'id' | 'sessionId' | 'createdAt'>>
  ): Job {
    const job = this.database.updateJob(jobId, patch)
    this.listeners.forEach((listener) => listener(job))
    return job
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Operation cancelled', 'AbortError')
  }
}

function normalizePipelineError(error: unknown): { code: string; message: string } {
  if (error instanceof ProviderError) return { code: error.code, message: error.message }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { code: 'CANCELLED', message: 'Cancelled' }
  }
  const message = error instanceof Error ? error.message : 'Processing failed'
  return { code: 'PROCESS_FAILED', message: message.replace(/[\r\n\t]+/g, ' ').slice(0, 1_000) }
}

export function mediaMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.flac':
      return 'audio/flac'
    case '.wav':
      return 'audio/wav'
    case '.mp3':
      return 'audio/mpeg'
    case '.m4a':
      return 'audio/mp4'
    default:
      return 'application/octet-stream'
  }
}
