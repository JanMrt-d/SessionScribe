import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { MeetingSummaryV1, TranscriptDocumentV1 } from '@shared/index'
import { AppDatabase } from '@main/persistence/Database'
import { ArtifactStore } from '@main/artifacts/ArtifactStore'
import { SessionService } from '@main/sessions/SessionService'
import { ExportService } from '@main/exports/ExportService'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('durable sessions and revisions', () => {
  it('persists transcript and summary revisions and exports all formats', async () => {
    const root = await temporaryDirectory()
    const database = new AppDatabase(join(root, 'data', 'app.db'))
    const artifacts = new ArtifactStore(join(root, 'videos'))
    await artifacts.initialize()
    const sessions = new SessionService(database, artifacts)
    const exports = new ExportService(database)

    const session = await sessions.create('Architecture review', 'meeting')
    const transcript = sessions.saveTranscript(sampleTranscript(session.id))
    expect(transcript.revision).toBe(1)
    const edited = sessions.saveTranscript({
      ...transcript,
      utterances: [
        {
          ...transcript.utterances[0]!,
          text: 'Ship the implementation Friday.',
          manuallyEdited: true
        }
      ]
    })
    expect(edited.revision).toBe(2)
    expect(edited.text).toContain('Friday')

    const summary = sessions.saveSummary(sampleMeetingSummary(session.id, edited.revision))
    expect(summary.revision).toBe(1)
    expect(sessions.get(session.id).summaryStale).toBe(false)

    const exportDirectory = join(root, 'exports')
    const paths = await exports.write({
      sessionId: session.id,
      directory: exportDirectory,
      formats: ['markdown', 'json', 'srt', 'vtt']
    })
    expect(paths).toHaveLength(4)
    expect(await readFile(join(exportDirectory, 'Architecture review.md'), 'utf8')).toContain(
      '## Action items'
    )
    expect(await readFile(join(exportDirectory, 'Architecture review.srt'), 'utf8')).toContain(
      '00:00:00,000 --> 00:00:03,500'
    )

    database.close()
  })

  it('recovers running jobs as queued without losing their payload', async () => {
    const root = await temporaryDirectory()
    const database = new AppDatabase(join(root, 'app.db'))
    const artifacts = new ArtifactStore(join(root, 'videos'))
    await artifacts.initialize()
    const sessions = new SessionService(database, artifacts)
    const session = await sessions.create('Recovery', 'lecture')
    const job = sessions.createJob(session.id, 'probe', { mode: 'lecture' })
    database.updateJob(job.id, { status: 'running' })
    database.recoverRunningJobs()
    expect(database.getJob(job.id)?.status).toBe('queued')
    expect(database.getJobPayload(job.id)).toEqual({ mode: 'lecture' })
    database.close()
  })

  it('finds queued and running jobs that reference provider profiles', async () => {
    const root = await temporaryDirectory()
    const database = new AppDatabase(join(root, 'app.db'))
    const artifacts = new ArtifactStore(join(root, 'videos'))
    await artifacts.initialize()
    const sessions = new SessionService(database, artifacts)
    const session = await sessions.create('Provider references', 'meeting')
    const transcriptionProfileId = randomUUID()
    const summaryProfileId = randomUUID()
    const fullJob = sessions.createJob(session.id, 'probe', {
      kind: 'full',
      transcriptionProfileId,
      summaryProfileId,
      mode: 'meeting'
    })
    const summaryJob = sessions.createJob(session.id, 'summarize', {
      kind: 'summary',
      summaryProfileId,
      mode: 'meeting'
    })
    database.updateJob(summaryJob.id, { status: 'running' })

    expect(database.hasActiveJobReferencingProvider(transcriptionProfileId)).toBe(true)
    expect(database.hasActiveJobReferencingProvider(summaryProfileId)).toBe(true)
    expect(database.hasActiveJobReferencingProvider(randomUUID())).toBe(false)

    database.updateJob(fullJob.id, { status: 'succeeded' })
    expect(database.hasActiveJobReferencingProvider(transcriptionProfileId)).toBe(false)
    expect(database.hasActiveJobReferencingProvider(summaryProfileId)).toBe(true)
    database.updateJob(summaryJob.id, { status: 'failed' })
    expect(database.hasActiveJobReferencingProvider(summaryProfileId)).toBe(false)
    database.close()
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sessionscribe-test-'))
  directories.push(directory)
  return directory
}

function sampleTranscript(sessionId: string): TranscriptDocumentV1 {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    sessionId,
    revision: 1,
    sourceSha256: 'a'.repeat(64),
    durationMs: 3_500,
    text: 'Ship Friday.',
    languages: ['en'],
    speakers: [{ id: 'speaker-1', label: 'Speaker 1', displayName: 'Alex' }],
    words: [],
    utterances: [
      {
        id: 'utterance-1',
        text: 'Ship Friday.',
        startMs: 0,
        endMs: 3_500,
        speakerId: 'speaker-1',
        wordIds: [],
        manuallyEdited: false
      }
    ],
    warnings: [],
    provenance: {
      providerKind: 'fake',
      model: 'fixture',
      generatedAt: new Date().toISOString()
    }
  }
}

function sampleMeetingSummary(sessionId: string, transcriptRevision: number): MeetingSummaryV1 {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    sessionId,
    revision: 1,
    transcriptRevision,
    mode: 'meeting',
    title: 'Architecture review',
    overview: 'The implementation is ready to ship.',
    topics: [],
    decisions: [],
    actionItems: [
      {
        task: 'Ship the implementation',
        assignee: 'Alex',
        explicitAssignment: true,
        dueAt: null,
        dueText: 'Friday',
        confidence: 0.95,
        evidence: [{ utteranceId: 'utterance-1', startMs: 0, endMs: 3_500 }]
      }
    ],
    openQuestions: [],
    risks: [],
    provenance: {
      providerKind: 'fake',
      model: 'fixture',
      promptVersion: 'meeting-v1',
      generatedAt: new Date().toISOString()
    },
    manuallyEdited: false
  }
}
