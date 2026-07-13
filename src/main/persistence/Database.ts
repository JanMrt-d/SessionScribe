import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import {
  jobSchema,
  providerProfileSchema,
  sessionSchema,
  summaryDocumentSchema,
  transcriptDocumentSchema,
  type Job,
  type ProviderProfileV1,
  type Session,
  type SummaryDocumentV1,
  type TranscriptDocumentV1
} from '@shared/index'

type Row = Record<string, unknown>

const migrations = [
  `
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      preferred_mode TEXT NOT NULL CHECK (preferred_mode IN ('meeting', 'lecture')),
      status TEXT NOT NULL,
      recording_path TEXT,
      playback_path TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT,
      transcript_revision INTEGER NOT NULL DEFAULT 0,
      summary_revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_session_idx ON jobs(session_id, created_at);
    CREATE TABLE IF NOT EXISTS provider_profiles (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      kind TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transcript_revisions (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, revision)
    );
    CREATE TABLE IF NOT EXISTS summary_revisions (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      mode TEXT NOT NULL,
      transcript_revision INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, revision)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    PRAGMA user_version = 1;
  `
]

export class AppDatabase {
  private readonly db: DatabaseSync

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as Row
    const current = Number(row.user_version ?? 0)
    if (current > migrations.length) {
      throw new Error(`Database schema ${current} is newer than this application supports`)
    }
    for (let index = current; index < migrations.length; index += 1) {
      const migration = migrations[index]
      if (!migration) throw new Error(`Missing database migration ${index + 1}`)
      this.db.exec(`BEGIN IMMEDIATE; ${migration} COMMIT;`)
    }
  }

  close(): void {
    this.db.close()
  }

  listSessions(): Session[] {
    return (this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as Row[]).map(
      mapSession
    )
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined
    return row ? mapSession(row) : null
  }

  insertSession(session: Session, recordingPath: string | null = null): Session {
    const parsed = sessionSchema.parse(session)
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, title, preferred_mode, status, recording_path, duration_ms, created_at, updated_at,
          last_error, transcript_revision, summary_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        parsed.id,
        parsed.title,
        parsed.preferredMode,
        parsed.status,
        recordingPath,
        parsed.durationMs,
        parsed.createdAt,
        parsed.updatedAt,
        parsed.lastError,
        parsed.transcriptRevision,
        parsed.summaryRevision
      )
    return parsed
  }

  updateSession(id: string, patch: Partial<Omit<Session, 'id' | 'createdAt'>>): Session {
    const current = this.requireSession(id)
    const next = sessionSchema.parse({
      ...current,
      ...patch,
      id,
      updatedAt: new Date().toISOString()
    })
    this.db
      .prepare(
        `UPDATE sessions SET title = ?, preferred_mode = ?, status = ?, duration_ms = ?, updated_at = ?,
          last_error = ?, transcript_revision = ?, summary_revision = ? WHERE id = ?`
      )
      .run(
        next.title,
        next.preferredMode,
        next.status,
        next.durationMs,
        next.updatedAt,
        next.lastError,
        next.transcriptRevision,
        next.summaryRevision,
        id
      )
    return next
  }

  setRecording(id: string, recordingPath: string, durationMs: number | null): Session {
    this.db
      .prepare(
        'UPDATE sessions SET recording_path = ?, duration_ms = ?, updated_at = ? WHERE id = ?'
      )
      .run(recordingPath, durationMs, new Date().toISOString(), id)
    return this.requireSession(id)
  }

  setPlaybackPath(id: string, playbackPath: string | null): void {
    this.db
      .prepare('UPDATE sessions SET playback_path = ?, updated_at = ? WHERE id = ?')
      .run(playbackPath, new Date().toISOString(), id)
  }

  getPlaybackPath(id: string): string | null {
    const row = this.db.prepare('SELECT playback_path FROM sessions WHERE id = ?').get(id) as
      Row | undefined
    return row ? (row.playback_path as string | null) : null
  }

  getMediaPath(id: string): string | null {
    return this.getPlaybackPath(id) ?? this.getRecordingPath(id)
  }

  getRecordingPath(id: string): string | null {
    const row = this.db.prepare('SELECT recording_path FROM sessions WHERE id = ?').get(id) as
      Row | undefined
    return row ? (row.recording_path as string | null) : null
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  insertJob(job: Job, payload: unknown = {}): Job {
    const parsed = jobSchema.parse(job)
    this.db
      .prepare(
        `INSERT INTO jobs (id, session_id, stage, status, progress, attempt, error_code, error_message,
          payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        parsed.id,
        parsed.sessionId,
        parsed.stage,
        parsed.status,
        parsed.progress,
        parsed.attempt,
        parsed.errorCode,
        parsed.errorMessage,
        JSON.stringify(payload),
        parsed.createdAt,
        parsed.updatedAt
      )
    return parsed
  }

  getJob(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined
    return row ? mapJob(row) : null
  }

  listJobs(sessionId: string): Job[] {
    return (
      this.db
        .prepare('SELECT * FROM jobs WHERE session_id = ? ORDER BY created_at')
        .all(sessionId) as Row[]
    ).map(mapJob)
  }

  listQueuedJobs(): Job[] {
    return (
      this.db
        .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at")
        .all() as Row[]
    ).map(mapJob)
  }

  hasActiveJobReferencingProvider(profileId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS found FROM jobs
         WHERE status IN ('queued', 'running')
           AND (
             json_extract(payload_json, '$.transcriptionProfileId') = ? OR
             json_extract(payload_json, '$.summaryProfileId') = ?
           )
         LIMIT 1`
      )
      .get(profileId, profileId) as Row | undefined
    return row !== undefined
  }

  getJobPayload<T>(id: string): T {
    const row = this.db.prepare('SELECT payload_json FROM jobs WHERE id = ?').get(id) as
      Row | undefined
    if (!row) throw new Error(`Job ${id} not found`)
    return JSON.parse(String(row.payload_json)) as T
  }

  updateJob(id: string, patch: Partial<Omit<Job, 'id' | 'sessionId' | 'createdAt'>>): Job {
    const current = this.getJob(id)
    if (!current) throw new Error(`Job ${id} not found`)
    const next = jobSchema.parse({ ...current, ...patch, updatedAt: new Date().toISOString() })
    this.db
      .prepare(
        `UPDATE jobs SET stage = ?, status = ?, progress = ?, attempt = ?, error_code = ?,
          error_message = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        next.stage,
        next.status,
        next.progress,
        next.attempt,
        next.errorCode,
        next.errorMessage,
        next.updatedAt,
        id
      )
    return next
  }

  recoverRunningJobs(): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', error_code = NULL,
          error_message = 'Recovered after application restart', updated_at = ? WHERE status = 'running'`
      )
      .run(now)
  }

  saveTranscript(document: TranscriptDocumentV1): TranscriptDocumentV1 {
    const parsed = transcriptDocumentSchema.parse(document)
    const now = new Date().toISOString()
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO transcript_revisions (session_id, revision, document_json, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(parsed.sessionId, parsed.revision, JSON.stringify(parsed), now)
      this.db
        .prepare(
          `UPDATE sessions SET transcript_revision = ?, status = 'processing', updated_at = ? WHERE id = ?`
        )
        .run(parsed.revision, now, parsed.sessionId)
    })
    return parsed
  }

  getTranscript(sessionId: string, revision?: number): TranscriptDocumentV1 | null {
    const row = revision
      ? (this.db
          .prepare(
            'SELECT document_json FROM transcript_revisions WHERE session_id = ? AND revision = ?'
          )
          .get(sessionId, revision) as Row | undefined)
      : (this.db
          .prepare(
            'SELECT document_json FROM transcript_revisions WHERE session_id = ? ORDER BY revision DESC LIMIT 1'
          )
          .get(sessionId) as Row | undefined)
    return row ? transcriptDocumentSchema.parse(JSON.parse(String(row.document_json))) : null
  }

  saveSummary(document: SummaryDocumentV1): SummaryDocumentV1 {
    const parsed = summaryDocumentSchema.parse(document)
    const now = new Date().toISOString()
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO summary_revisions
            (session_id, revision, mode, transcript_revision, document_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          parsed.sessionId,
          parsed.revision,
          parsed.mode,
          parsed.transcriptRevision,
          JSON.stringify(parsed),
          now
        )
      this.db
        .prepare(
          `UPDATE sessions SET summary_revision = ?, status = 'ready', updated_at = ?, last_error = NULL
           WHERE id = ?`
        )
        .run(parsed.revision, now, parsed.sessionId)
    })
    return parsed
  }

  getSummary(sessionId: string, revision?: number): SummaryDocumentV1 | null {
    const row = revision
      ? (this.db
          .prepare(
            'SELECT document_json FROM summary_revisions WHERE session_id = ? AND revision = ?'
          )
          .get(sessionId, revision) as Row | undefined)
      : (this.db
          .prepare(
            'SELECT document_json FROM summary_revisions WHERE session_id = ? ORDER BY revision DESC LIMIT 1'
          )
          .get(sessionId) as Row | undefined)
    return row ? summaryDocumentSchema.parse(JSON.parse(String(row.document_json))) : null
  }

  listProviderProfiles(): ProviderProfileV1[] {
    return (
      this.db
        .prepare('SELECT data_json FROM provider_profiles ORDER BY task, created_at')
        .all() as Row[]
    ).map((row) => providerProfileSchema.parse(JSON.parse(String(row.data_json))))
  }

  getProviderProfile(id: string): ProviderProfileV1 | null {
    const row = this.db.prepare('SELECT data_json FROM provider_profiles WHERE id = ?').get(id) as
      Row | undefined
    return row ? providerProfileSchema.parse(JSON.parse(String(row.data_json))) : null
  }

  saveProviderProfile(profile: ProviderProfileV1): ProviderProfileV1 {
    const parsed = providerProfileSchema.parse(profile)
    this.db
      .prepare(
        `INSERT INTO provider_profiles (id, task, kind, data_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET task = excluded.task, kind = excluded.kind,
           data_json = excluded.data_json, updated_at = excluded.updated_at`
      )
      .run(
        parsed.id,
        parsed.task,
        parsed.kind,
        JSON.stringify(parsed),
        parsed.createdAt,
        parsed.updatedAt
      )
    return parsed
  }

  deleteProviderProfile(id: string): void {
    this.db.prepare('DELETE FROM provider_profiles WHERE id = ?').run(id)
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      Row | undefined
    return row ? (JSON.parse(String(row.value_json)) as T) : fallback
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), new Date().toISOString())
  }

  private requireSession(id: string): Session {
    const session = this.getSession(id)
    if (!session) throw new Error(`Session ${id} not found`)
    return session
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

function mapSession(row: Row): Session {
  return sessionSchema.parse({
    id: row.id,
    title: row.title,
    preferredMode: row.preferred_mode,
    status: row.status,
    recordingFileName:
      typeof row.recording_path === 'string' ? row.recording_path.split(/[\\/]/).at(-1) : null,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
    transcriptRevision: row.transcript_revision,
    summaryRevision: row.summary_revision
  })
}

function mapJob(row: Row): Job {
  return jobSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    stage: row.stage,
    status: row.status,
    progress: row.progress,
    attempt: row.attempt,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

export function sqliteValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value
  if (value instanceof Uint8Array) return value
  throw new Error('Unsupported SQLite value')
}
