import type { Job } from '@shared/domain'
import type { RecoveryResult } from '../obs/types'
import type { ProcessingController } from '../app/contracts'
import type { AppDatabase } from '../persistence/Database'
import type { SessionService } from '../sessions/SessionService'

type CaptureProcessingSettings = {
  transcriptionProfileId: string
  summaryProfileId: string
  mode: 'meeting' | 'lecture'
}

export interface RecoveredRecordingHandoff {
  job: Job | null
  acknowledgeManifest: boolean
}

export class RecoveredRecordingHandler {
  constructor(
    private readonly database: AppDatabase,
    private readonly sessions: SessionService,
    private readonly processing: ProcessingController
  ) {}

  async handle(result: RecoveryResult): Promise<RecoveredRecordingHandoff> {
    const sessionId = result.manifest.sessionId
    const session = this.database.getSession(sessionId)
    if (!session) return { job: null, acknowledgeManifest: false }

    if (result.action === 'reattached') {
      this.database.updateSession(sessionId, { status: 'recording', lastError: null })
      return { job: null, acknowledgeManifest: false }
    }
    if (result.artifacts.length === 0) {
      if (result.action === 'failed') {
        this.database.updateSession(sessionId, {
          status: 'failed',
          lastError: result.manifest.error ?? 'OBS could not start the recording.'
        })
        return { job: null, acknowledgeManifest: true }
      }
      if (result.action === 'interrupted') {
        this.database.updateSession(sessionId, {
          status: 'interrupted',
          lastError:
            result.manifest.error ?? 'The interrupted OBS recording did not produce usable media.'
        })
      }
      return { job: null, acknowledgeManifest: false }
    }

    const artifact = [...result.artifacts].sort((left, right) => right.size - left.size)[0]!
    if (this.database.getRecordingPath(sessionId) !== artifact.path) {
      this.sessions.attachRecording(sessionId, artifact.path, result.manifest.lastDurationMs)
    }
    const existingJobs = this.database.listJobs(sessionId)
    if (existingJobs.length > 0) {
      this.reconcileExistingJob(sessionId, existingJobs)
      return { job: null, acknowledgeManifest: true }
    }

    const settings = this.database.getSetting<CaptureProcessingSettings | null>(
      `capture-processing:${sessionId}`,
      null
    )
    if (!settings) {
      this.database.updateSession(sessionId, {
        status: 'interrupted',
        lastError: 'The recording was recovered, but its provider selections were unavailable.'
      })
      return { job: null, acknowledgeManifest: true }
    }
    try {
      const job = await this.processing.enqueue({ sessionId, ...settings })
      return { job, acknowledgeManifest: true }
    } catch (error) {
      this.database.updateSession(sessionId, {
        status: 'failed',
        lastError: error instanceof Error ? error.message : 'Recovered media could not be queued.'
      })
      return { job: null, acknowledgeManifest: true }
    }
  }

  private reconcileExistingJob(sessionId: string, jobs: Job[]): void {
    const active = jobs.find((job) => job.status === 'running' || job.status === 'queued')
    if (active) {
      this.database.updateSession(sessionId, { status: 'processing', lastError: null })
      return
    }
    const latest = [...jobs].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    )[0]!
    if (latest.status === 'succeeded') {
      this.database.updateSession(sessionId, { status: 'ready', lastError: null })
    } else if (latest.status === 'failed') {
      this.database.updateSession(sessionId, {
        status: 'failed',
        lastError: latest.errorMessage ?? 'Processing failed.'
      })
    } else {
      this.database.updateSession(sessionId, {
        status: 'interrupted',
        lastError: 'Processing was cancelled.'
      })
    }
  }
}
