import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  type Job,
  type Session,
  type SessionDetails,
  type SessionMode,
  type SummaryDocumentV1,
  type TranscriptDocumentV1
} from '@shared/index'
import type { AppDatabase } from '../persistence/Database'
import type { ArtifactStore } from '../artifacts/ArtifactStore'

export class SessionService {
  constructor(
    private readonly database: AppDatabase,
    private readonly artifacts: ArtifactStore
  ) {}

  list(): Session[] {
    return this.database.listSessions()
  }

  async create(title: string, mode: SessionMode): Promise<Session> {
    const now = new Date().toISOString()
    const session: Session = {
      id: randomUUID(),
      title: title.trim() || defaultTitle(mode),
      preferredMode: mode,
      status: 'draft',
      recordingFileName: null,
      durationMs: null,
      createdAt: now,
      updatedAt: now,
      lastError: null,
      transcriptRevision: 0,
      summaryRevision: 0
    }
    await this.artifacts.ensureSession(session.id)
    return this.database.insertSession(session)
  }

  async importMedia(
    sourcePath: string,
    mode: SessionMode,
    title = basename(sourcePath).replace(/\.[^.]+$/, '')
  ): Promise<Session> {
    const session = await this.create(title, mode)
    try {
      const recordingPath = await this.artifacts.importMedia(session.id, sourcePath)
      this.database.setRecording(session.id, recordingPath, null)
      return this.database.updateSession(session.id, { status: 'processing' })
    } catch (error) {
      this.database.deleteSession(session.id)
      await this.artifacts.removeSession(session.id)
      throw error
    }
  }

  get(id: string): SessionDetails {
    const session = this.database.getSession(id)
    if (!session) throw new Error(`Session ${id} not found`)
    const transcript = this.database.getTranscript(id)
    const summary = this.database.getSummary(id)
    const recordingPath = this.database.getMediaPath(id)
    return {
      session,
      transcript,
      summary,
      jobs: this.database.listJobs(id),
      mediaUrl: recordingPath ? `sessionscribe-media://session/${id}` : null,
      summaryStale: Boolean(
        summary && transcript && summary.transcriptRevision !== transcript.revision
      )
    }
  }

  attachRecording(id: string, path: string, durationMs: number | null): Session {
    this.artifacts.assertSessionPath(id, path)
    this.database.setRecording(id, path, durationMs)
    return this.database.updateSession(id, { status: 'processing', durationMs })
  }

  saveTranscript(input: TranscriptDocumentV1): TranscriptDocumentV1 {
    const session = this.database.getSession(input.sessionId)
    if (!session) throw new Error('Session not found')
    const next: TranscriptDocumentV1 = {
      ...input,
      id: randomUUID(),
      revision: session.transcriptRevision + 1,
      text: input.utterances
        .map((utterance) => utterance.text)
        .join(' ')
        .trim()
    }
    return this.database.saveTranscript(next)
  }

  renameSpeaker(sessionId: string, speakerId: string, displayName: string): TranscriptDocumentV1 {
    const transcript = this.requireTranscript(sessionId)
    const speakers = transcript.speakers.map((speaker) =>
      speaker.id === speakerId ? { ...speaker, displayName: displayName.trim() || null } : speaker
    )
    if (!speakers.some((speaker) => speaker.id === speakerId)) throw new Error('Speaker not found')
    return this.saveTranscript({ ...transcript, speakers })
  }

  mergeSpeakers(sessionId: string, sourceId: string, targetId: string): TranscriptDocumentV1 {
    if (sourceId === targetId) throw new Error('Choose two different speakers')
    const transcript = this.requireTranscript(sessionId)
    if (!transcript.speakers.some((speaker) => speaker.id === sourceId))
      throw new Error('Speaker not found')
    if (!transcript.speakers.some((speaker) => speaker.id === targetId))
      throw new Error('Speaker not found')
    return this.saveTranscript({
      ...transcript,
      speakers: transcript.speakers.filter((speaker) => speaker.id !== sourceId),
      words: transcript.words.map((word) =>
        word.speakerId === sourceId ? { ...word, speakerId: targetId } : word
      ),
      utterances: transcript.utterances.map((utterance) =>
        utterance.speakerId === sourceId ? { ...utterance, speakerId: targetId } : utterance
      )
    })
  }

  saveSummary(input: SummaryDocumentV1): SummaryDocumentV1 {
    const session = this.database.getSession(input.sessionId)
    if (!session) throw new Error('Session not found')
    return this.database.saveSummary({
      ...input,
      id: randomUUID(),
      revision: session.summaryRevision + 1
    })
  }

  async delete(id: string): Promise<void> {
    if (!this.database.getSession(id)) return
    await this.artifacts.removeSession(id)
    this.database.deleteSession(id)
  }

  createJob(sessionId: string, stage: Job['stage'], payload: unknown = {}): Job {
    const now = new Date().toISOString()
    return this.database.insertJob(
      {
        id: randomUUID(),
        sessionId,
        stage,
        status: 'queued',
        progress: 0,
        attempt: 0,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now
      },
      payload
    )
  }

  private requireTranscript(sessionId: string): TranscriptDocumentV1 {
    const transcript = this.database.getTranscript(sessionId)
    if (!transcript) throw new Error('Transcript not found')
    return transcript
  }
}

function defaultTitle(mode: SessionMode): string {
  const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date()
  )
  return `${mode === 'meeting' ? 'Meeting' : 'Lecture'} - ${date}`
}
