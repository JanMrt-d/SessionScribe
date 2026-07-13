import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, LoaderCircle, Mic2, PlugZap, Plus, Upload, X } from 'lucide-react'
import type { AppBootstrap, Job, Session } from '@shared/domain'
import type { CaptureStatus } from '@shared/capture'
import type { ProviderInput, SessionDetails } from '@shared/ipc'
import type { ProviderProfileV1 } from '@shared/providers'
import { Button, EmptyState, IconButton, InlineNotice } from './components/ui'
import { ExportDialog } from './components/ExportDialog'
import { NewSessionDialog } from './components/NewSessionDialog'
import { ObsConnectionDialog } from './components/CaptureWorkspace'
import { ProviderSettingsDialog } from './components/ProviderSettingsDialog'
import { SessionSidebar } from './components/SessionSidebar'
import { SessionWorkspace } from './components/SessionWorkspace'

const DISCONNECTED_CAPTURE: CaptureStatus = {
  connected: false,
  obsVersion: null,
  phase: 'disconnected',
  activeSessionId: null,
  elapsedMs: 0,
  bytesWritten: 0,
  microphoneLevel: 0,
  systemLevel: 0,
  warnings: []
}

export function App(): React.JSX.Element {
  const api = window.sessionScribe
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [details, setDetails] = useState<SessionDetails | null>(null)
  const [profiles, setProfiles] = useState<ProviderProfileV1[]>([])
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>(DISCONNECTED_CAPTURE)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [newDialogOpen, setNewDialogOpen] = useState(false)
  const [newDialogSource, setNewDialogSource] = useState<'record' | 'import'>('record')
  const [obsDialogOpen, setObsDialogOpen] = useState(false)
  const [providerDialogOpen, setProviderDialogOpen] = useState(false)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions]
  )

  const loadApp = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      const appBootstrap = await api.app.bootstrap()
      setBootstrap(appBootstrap)
      setSessions(appBootstrap.sessions)
      const [providerProfiles, status] = await Promise.all([
        api.providers.list(),
        api.capture
          .status()
          .catch(() => ({ ...DISCONNECTED_CAPTURE, connected: appBootstrap.obsConnected }))
      ])
      setProfiles(providerProfiles)
      setCaptureStatus(status)
      setSelectedId(
        (current) => current ?? appBootstrap.activeSessionId ?? appBootstrap.sessions[0]?.id ?? null
      )
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'SessionScribe could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void loadApp()
  }, [loadApp])

  useEffect(() => {
    if (!selectedId) {
      setDetails(null)
      return
    }
    let cancelled = false
    setDetails(null)
    void api.sessions
      .get(selectedId)
      .then((next) => {
        if (!cancelled) setDetails(next)
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setNotice(cause instanceof Error ? cause.message : 'The session could not be opened.')
      })
    return () => {
      cancelled = true
    }
  }, [api.sessions, selectedId])

  useEffect(() => {
    return api.events.subscribe((event) => {
      if (event.type === 'capture-status') {
        setCaptureStatus(event.payload)
        return
      }
      if (event.type === 'session-updated') {
        setSessions((current) => upsertSession(current, event.payload))
        setDetails((current) =>
          current?.session.id === event.payload.id
            ? { ...current, session: event.payload }
            : current
        )
        return
      }
      setDetails((current) => {
        if (!current || current.session.id !== event.payload.sessionId) return current
        return { ...current, jobs: upsertJob(current.jobs, event.payload) }
      })
      if (
        event.payload.status === 'succeeded' ||
        event.payload.status === 'failed' ||
        event.payload.status === 'cancelled'
      ) {
        void api.sessions
          .get(event.payload.sessionId)
          .then((next) => {
            setDetails((current) =>
              current?.session.id === event.payload.sessionId ? next : current
            )
            setSessions((current) => upsertSession(current, next.session))
          })
          .catch(() => undefined)
      }
    })
  }, [api.events, api.sessions])

  async function createSession(input: Parameters<typeof api.sessions.create>[0]): Promise<Session> {
    const session = await api.sessions.create(input)
    setSessions((current) => upsertSession(current, session))
    setSelectedId(session.id)
    return session
  }

  async function importSession(
    input: Parameters<typeof api.sessions.importMedia>[0]
  ): Promise<Session> {
    const session = await api.sessions.importMedia(input)
    setSessions((current) => upsertSession(current, session))
    setSelectedId(session.id)
    return session
  }

  async function deleteSession(id: string): Promise<void> {
    const session = sessions.find((candidate) => candidate.id === id)
    if (!session || !window.confirm(`Delete “${session.title}” and its derived files?`)) return
    try {
      await api.sessions.delete(id)
      const remaining = sessions.filter((candidate) => candidate.id !== id)
      setSessions(remaining)
      if (selectedId === id) setSelectedId(remaining[0]?.id ?? null)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'The session could not be deleted.')
    }
  }

  async function retryJob(id: string): Promise<void> {
    const job = await api.jobs.retry(id)
    setDetails((current) =>
      current ? { ...current, jobs: upsertJob(current.jobs, job) } : current
    )
  }

  async function saveProvider(input: ProviderInput): Promise<ProviderProfileV1> {
    const saved = await api.providers.save(input)
    setProfiles((current) => {
      const others = current.filter((profile) => profile.id !== saved.id)
      return [...others, saved]
    })
    return saved
  }

  if (loading) {
    return (
      <div className="app-loading">
        <span className="brand-mark">
          <Mic2 size={20} />
        </span>
        <LoaderCircle className="spin" size={24} />
        <strong>Opening SessionScribe</strong>
      </div>
    )
  }

  if (loadError || !bootstrap) {
    return (
      <div className="app-fatal">
        <AlertCircle size={28} />
        <h1>SessionScribe could not start</h1>
        <p>{loadError ?? 'The desktop bridge did not return application data.'}</p>
        <Button variant="primary" onClick={() => void loadApp()}>
          Try again
        </Button>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <SessionSidebar
        sessions={sortedSessions}
        selectedId={selectedId}
        activeSessionId={captureStatus.activeSessionId}
        version={bootstrap.version}
        onSelect={setSelectedId}
        onCreate={() => {
          setNewDialogSource('record')
          setNewDialogOpen(true)
        }}
        onImport={() => {
          setNewDialogSource('import')
          setNewDialogOpen(true)
        }}
        onDelete={(id) => void deleteSession(id)}
        onOpenSettings={() => setProviderDialogOpen(true)}
      />

      {selectedId && !details ? (
        <main className="workspace workspace--loading">
          <LoaderCircle className="spin" size={24} />
          <span>Loading session</span>
        </main>
      ) : details ? (
        <SessionWorkspace
          details={details}
          captureStatus={captureStatus}
          profiles={profiles}
          onOpenConnection={() => setObsDialogOpen(true)}
          onOpenExport={() => setExportDialogOpen(true)}
          onDelete={(id) => void deleteSession(id)}
          onDiscover={() => api.capture.discover()}
          onConfigure={async (configuration) => {
            setCaptureStatus(await api.capture.configure(configuration))
          }}
          onSelectPortalTarget={() => api.capture.selectPortalTarget()}
          onPreflight={() => api.capture.preflight()}
          onStart={async (input) => {
            setCaptureStatus(await api.capture.start(input))
          }}
          onStop={async () => {
            setCaptureStatus(await api.capture.stop())
          }}
          onRetry={retryJob}
          onCancel={(id) => api.jobs.cancel(id)}
          onSaveTranscript={async (document) => {
            const saved = await api.transcript.save({ sessionId: details.session.id, document })
            setDetails((current) =>
              current ? { ...current, transcript: saved, summaryStale: true } : current
            )
            return saved
          }}
          onRenameSpeaker={async (speakerId, displayName) => {
            const saved = await api.transcript.renameSpeaker({
              sessionId: details.session.id,
              speakerId,
              displayName
            })
            setDetails((current) =>
              current ? { ...current, transcript: saved, summaryStale: true } : current
            )
            return saved
          }}
          onMergeSpeakers={async (sourceId, targetId) => {
            const saved = await api.transcript.mergeSpeakers({
              sessionId: details.session.id,
              sourceId,
              targetId
            })
            setDetails((current) =>
              current ? { ...current, transcript: saved, summaryStale: true } : current
            )
            return saved
          }}
          onGenerateSummary={async (profileId, mode) => {
            const job = await api.summary.generate({
              sessionId: details.session.id,
              mode,
              profileId
            })
            setDetails((current) =>
              current ? { ...current, jobs: upsertJob(current.jobs, job) } : current
            )
          }}
          onSaveSummary={async (document) => {
            const saved = await api.summary.save({ sessionId: details.session.id, document })
            setDetails((current) =>
              current ? { ...current, summary: saved, summaryStale: false } : current
            )
            return saved
          }}
        />
      ) : (
        <main className="workspace workspace--empty">
          <EmptyState
            icon={<Mic2 size={29} />}
            title="Start your first session"
            description="Record a configured OBS window or import an existing meeting or lecture recording."
            actions={
              <>
                <Button
                  variant="primary"
                  onClick={() => {
                    setNewDialogSource('record')
                    setNewDialogOpen(true)
                  }}
                >
                  <Plus size={17} /> New recording
                </Button>
                <Button
                  onClick={() => {
                    setNewDialogSource('import')
                    setNewDialogOpen(true)
                  }}
                >
                  <Upload size={17} /> Import media
                </Button>
              </>
            }
          />
          {!captureStatus.connected ? (
            <InlineNotice
              icon={<PlugZap size={18} />}
              actions={
                <Button size="small" onClick={() => setObsDialogOpen(true)}>
                  Connect OBS
                </Button>
              }
            >
              <strong>OBS is not connected</strong>
              <span>You can connect now or when setting up a recording.</span>
            </InlineNotice>
          ) : null}
        </main>
      )}

      {notice ? (
        <div className="toast" role="alert">
          <AlertCircle size={17} />
          <span>{notice}</span>
          <IconButton label="Dismiss" variant="ghost" onClick={() => setNotice(null)}>
            <X size={16} />
          </IconButton>
        </div>
      ) : null}

      <NewSessionDialog
        open={newDialogOpen}
        initialSource={newDialogSource}
        profiles={profiles}
        onOpenChange={setNewDialogOpen}
        onCreate={createSession}
        onImport={importSession}
      />
      <ObsConnectionDialog
        open={obsDialogOpen}
        connected={captureStatus.connected}
        obsVersion={captureStatus.obsVersion}
        onOpenChange={setObsDialogOpen}
        onConnect={async (input) => {
          setCaptureStatus(await api.capture.connect(input))
        }}
        onCancelConnect={() => api.capture.cancelConnect()}
        onDisconnect={async () => {
          await api.capture.disconnect()
          setCaptureStatus(DISCONNECTED_CAPTURE)
        }}
      />
      <ProviderSettingsDialog
        open={providerDialogOpen}
        profiles={profiles}
        encryptionAvailable={bootstrap.encryptionAvailable}
        onOpenChange={setProviderDialogOpen}
        onChooseExecutable={() => api.providers.chooseExecutable()}
        onSave={saveProvider}
        onDelete={async (id) => {
          await api.providers.delete(id)
          setProfiles((current) => current.filter((profile) => profile.id !== id))
        }}
        onTest={(input) => api.providers.test(input)}
      />
      {details ? (
        <ExportDialog
          open={exportDialogOpen}
          sessionId={details.session.id}
          transcriptAvailable={Boolean(details.transcript)}
          summaryAvailable={Boolean(details.summary)}
          onOpenChange={setExportDialogOpen}
          onChooseDirectory={() => api.exports.chooseDirectory()}
          onWrite={(request) => api.exports.write(request)}
        />
      ) : null}
    </div>
  )
}

function upsertSession(sessions: Session[], session: Session): Session[] {
  const remaining = sessions.filter((candidate) => candidate.id !== session.id)
  return [session, ...remaining]
}

function upsertJob(jobs: Job[], job: Job): Job[] {
  const remaining = jobs.filter((candidate) => candidate.id !== job.id)
  return [...remaining, job]
}
