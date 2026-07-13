import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessingController } from '@main/app/contracts'
import { ArtifactStore } from '@main/artifacts/ArtifactStore'
import { RecoveredRecordingHandler } from '@main/capture/RecoveredRecordingHandler'
import type { RecoveryResult, SessionManifest } from '@main/obs/types'
import { AppDatabase } from '@main/persistence/Database'
import { SessionService } from '@main/sessions/SessionService'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('recovered recording handoff', () => {
  it('attaches recovered media and enqueues processing only once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-recovery-'))
    directories.push(root)
    const database = new AppDatabase(join(root, 'app.db'))
    const artifacts = new ArtifactStore(join(root, 'videos'))
    await artifacts.initialize()
    const sessions = new SessionService(database, artifacts)
    const session = await sessions.create('Recovered meeting', 'meeting')
    const recordingPath = artifacts.pathFor(session.id, 'recording.mkv')
    await writeFile(recordingPath, 'recovered recording')
    database.setSetting(`capture-processing:${session.id}`, {
      transcriptionProfileId: randomUUID(),
      summaryProfileId: randomUUID(),
      mode: 'meeting'
    })
    const enqueue = vi.fn(async () => sessions.createJob(session.id, 'probe', { kind: 'full' }))
    const processing = { enqueue } as unknown as ProcessingController
    const handler = new RecoveredRecordingHandler(database, sessions, processing)
    const recovery = recoveryResult(session.id, recordingPath)

    const firstHandoff = await handler.handle(recovery)
    const repeatedHandoff = await handler.handle(recovery)

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(firstHandoff).toMatchObject({ acknowledgeManifest: true })
    expect(repeatedHandoff).toMatchObject({ acknowledgeManifest: true, job: null })
    expect(database.getRecordingPath(session.id)).toBe(recordingPath)
    expect(database.getSession(session.id)?.status).toBe('processing')
    database.close()
  })

  it('marks an unrecoverable interrupted recording for user attention', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-recovery-'))
    directories.push(root)
    const database = new AppDatabase(join(root, 'app.db'))
    const artifacts = new ArtifactStore(join(root, 'videos'))
    await artifacts.initialize()
    const sessions = new SessionService(database, artifacts)
    const session = await sessions.create('Interrupted meeting', 'meeting')
    const handler = new RecoveredRecordingHandler(database, sessions, {
      enqueue: vi.fn()
    } as unknown as ProcessingController)
    const result = recoveryResult(session.id, artifacts.pathFor(session.id, 'missing.mkv'))
    result.artifacts = []
    result.manifest.error = 'OBS stopped before a valid file was finalized'

    const handoff = await handler.handle(result)

    expect(handoff).toEqual({ job: null, acknowledgeManifest: false })
    expect(database.getSession(session.id)).toMatchObject({
      status: 'interrupted',
      lastError: 'OBS stopped before a valid file was finalized'
    })
    database.close()
  })

  it('does not regress a completed handoff or repeat its provider job', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-recovery-'))
    directories.push(root)
    const database = new AppDatabase(join(root, 'app.db'))
    const artifacts = new ArtifactStore(join(root, 'videos'))
    await artifacts.initialize()
    const sessions = new SessionService(database, artifacts)
    const session = await sessions.create('Completed meeting', 'meeting')
    const recordingPath = artifacts.pathFor(session.id, 'recording.mkv')
    await writeFile(recordingPath, 'completed recording')
    sessions.attachRecording(session.id, recordingPath, 1_000)
    const job = sessions.createJob(session.id, 'summarize')
    database.updateJob(job.id, { status: 'succeeded', progress: 1, attempt: 1 })
    database.updateSession(session.id, { status: 'ready' })
    const enqueue = vi.fn()
    const handler = new RecoveredRecordingHandler(database, sessions, {
      enqueue
    } as unknown as ProcessingController)

    const handoff = await handler.handle(recoveryResult(session.id, recordingPath))

    expect(handoff).toEqual({ job: null, acknowledgeManifest: true })
    expect(enqueue).not.toHaveBeenCalled()
    expect(database.getSession(session.id)?.status).toBe('ready')
    database.close()
  })

  it('acknowledges a definitively failed start after recording the terminal DB state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-recovery-'))
    directories.push(root)
    const database = new AppDatabase(join(root, 'app.db'))
    const artifacts = new ArtifactStore(join(root, 'videos'))
    await artifacts.initialize()
    const sessions = new SessionService(database, artifacts)
    const session = await sessions.create('Failed recording', 'lecture')
    const handler = new RecoveredRecordingHandler(database, sessions, {
      enqueue: vi.fn()
    } as unknown as ProcessingController)
    const result = recoveryResult(session.id, artifacts.pathFor(session.id, 'missing.mkv'))
    result.action = 'failed'
    result.artifacts = []
    result.manifest.state = 'failed'
    result.manifest.error = 'OBS rejected StartRecord'

    const handoff = await handler.handle(result)

    expect(handoff).toEqual({ job: null, acknowledgeManifest: true })
    expect(database.getSession(session.id)).toMatchObject({
      status: 'failed',
      lastError: 'OBS rejected StartRecord'
    })
    database.close()
  })
})

function recoveryResult(sessionId: string, path: string): RecoveryResult {
  return {
    action: 'interrupted',
    artifacts: [{ path, size: 19 }],
    manifest: manifest(sessionId, path)
  }
}

function manifest(sessionId: string, path: string): SessionManifest {
  const now = new Date().toISOString()
  return {
    version: 1,
    sessionId,
    state: 'interrupted',
    recordDirectory: join(path, '..'),
    outputPaths: [path],
    profileName: 'SessionScribe',
    sceneCollectionName: 'SessionScribe',
    previousProfileName: 'Default',
    previousSceneCollectionName: 'Default',
    platform: 'x11',
    configuration: {
      targetId: 'window',
      microphoneDeviceId: null,
      outputDeviceId: null,
      captureCursor: true
    },
    windowInputUuid: randomUUID(),
    microphoneInputUuid: null,
    systemAudioInputUuid: null,
    startedAt: now,
    stopRequestedAt: null,
    completedAt: now,
    lastDurationMs: 1_000,
    lastBytes: 19,
    error: null,
    updatedAt: now
  }
}
