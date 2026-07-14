import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  CircleStop,
  Eye,
  Gauge,
  HardDrive,
  LoaderCircle,
  Mic,
  MonitorUp,
  PlugZap,
  Radio,
  RefreshCw,
  Settings2,
  Volume2,
  WifiOff
} from 'lucide-react'
import type { Session } from '@shared/domain'
import type { ProviderProfileV1 } from '@shared/providers'
import type {
  AudioDevice,
  CaptureConfiguration,
  CaptureStatus,
  CaptureTarget,
  PreflightResult
} from '@shared/capture'
import { formatBytes, formatDuration } from '../lib/format'
import { Button, InlineNotice, Modal, SelectField } from './ui'

interface ObsConnectionDialogProps {
  open: boolean
  connected: boolean
  obsVersion: string | null
  onOpenChange(open: boolean): void
  onConnect(input: { url: string; password: string; rememberPassword: boolean }): Promise<void>
  onCancelConnect(): Promise<void>
  onDisconnect(): Promise<void>
}

export function ObsConnectionDialog({
  open,
  connected,
  obsVersion,
  onOpenChange,
  onConnect,
  onCancelConnect,
  onDisconnect
}: ObsConnectionDialogProps): React.JSX.Element {
  const [url, setUrl] = useState('ws://127.0.0.1:4455')
  const [password, setPassword] = useState('')
  const [rememberPassword, setRememberPassword] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const attemptRef = useRef(0)
  const cancellingRef = useRef(false)

  async function connect(): Promise<void> {
    const attempt = ++attemptRef.current
    setBusy(true)
    setError(null)
    try {
      await onConnect({ url, password, rememberPassword })
      if (attempt !== attemptRef.current) return
      setPassword('')
      onOpenChange(false)
    } catch (cause) {
      if (attempt !== attemptRef.current) return
      setError(connectionErrorMessage(cause, 'Could not connect to OBS Studio.'))
    } finally {
      if (attempt === attemptRef.current) setBusy(false)
    }
  }

  async function cancelConnect(): Promise<void> {
    if (cancellingRef.current) return
    cancellingRef.current = true
    attemptRef.current += 1
    setError(null)
    try {
      await onCancelConnect()
    } catch {
      // The main process abort is requested before cancellation cleanup, so the dialog can close.
    } finally {
      cancellingRef.current = false
      setBusy(false)
      onOpenChange(false)
    }
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen && busy) {
      void cancelConnect()
      return
    }
    onOpenChange(nextOpen)
  }

  async function disconnect(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await onDisconnect()
      onOpenChange(false)
    } catch (cause) {
      setError(connectionErrorMessage(cause, 'Could not disconnect from OBS Studio.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={handleOpenChange}
      title="OBS connection"
      description="SessionScribe connects only to the WebSocket address you provide."
    >
      {connected && !busy ? (
        <div className="dialog-form">
          <div className="connection-summary">
            <span className="connection-summary__icon">
              <CheckCircle2 size={22} />
            </span>
            <div>
              <strong>Connected to OBS Studio</strong>
              <span>{obsVersion ? `Version ${obsVersion}` : 'WebSocket connection active'}</span>
            </div>
          </div>
          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
          <div className="dialog-actions dialog-actions--flush">
            <Button variant="danger" disabled={busy} onClick={() => void disconnect()}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <WifiOff size={17} />}
              Disconnect
            </Button>
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault()
            void connect()
          }}
        >
          <label className="field">
            <span className="field__label">WebSocket address</span>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="ws://127.0.0.1:4455"
              inputMode="url"
              required
              disabled={busy}
            />
            <span className="field__hint">
              Find this in OBS under Tools → WebSocket Server Settings.
            </span>
          </label>
          <label className="field">
            <span className="field__label">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="off"
              placeholder="OBS WebSocket password"
              disabled={busy}
            />
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={rememberPassword}
              onChange={(event) => setRememberPassword(event.target.checked)}
              disabled={busy}
            />
            <span>Store password in the operating system credential store</span>
          </label>
          {busy ? (
            <span className="field__hint" role="status">
              Waiting for OBS Studio and its WebSocket server...
            </span>
          ) : null}
          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
          <div className="dialog-actions dialog-actions--flush">
            <Button
              variant="ghost"
              onClick={() => (busy ? void cancelConnect() : onOpenChange(false))}
            >
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={busy || !url.trim()}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <PlugZap size={17} />}
              {busy ? 'Connecting...' : 'Connect'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}

function connectionErrorMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback
  return cause.message
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^ObsSubsystemError:\s*/, '')
}

interface CaptureWorkspaceProps {
  session: Session
  status: CaptureStatus
  profiles: ProviderProfileV1[]
  onOpenConnection(): void
  onDiscover(): Promise<{ targets: CaptureTarget[]; audioDevices: AudioDevice[] }>
  onConfigure(configuration: CaptureConfiguration): Promise<void>
  onSelectPortalTarget(): Promise<void>
  onPreflight(): Promise<PreflightResult>
  onStart(input: {
    sessionId: string
    transcriptionProfileId: string
    summaryProfileId: string | null
  }): Promise<void>
  onStop(): Promise<void>
}

const NO_SUMMARY_PROFILE_ID = 'transcript-only'

export function CaptureWorkspace({
  session,
  status,
  profiles,
  onOpenConnection,
  onDiscover,
  onConfigure,
  onSelectPortalTarget,
  onPreflight,
  onStart,
  onStop
}: CaptureWorkspaceProps): React.JSX.Element {
  const [targets, setTargets] = useState<CaptureTarget[]>([])
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([])
  const [targetId, setTargetId] = useState('')
  const [microphoneId, setMicrophoneId] = useState('none')
  const [outputId, setOutputId] = useState('none')
  const [captureCursor, setCaptureCursor] = useState(true)
  const transcriptionProfiles = useMemo(
    () => profiles.filter((profile) => profile.task === 'transcription'),
    [profiles]
  )
  const summaryProfiles = useMemo(
    () => profiles.filter((profile) => profile.task === 'summary'),
    [profiles]
  )
  const [transcriptionProfileId, setTranscriptionProfileId] = useState(
    () => transcriptionProfiles[0]?.id ?? ''
  )
  const [summaryProfileId, setSummaryProfileId] = useState(
    () => summaryProfiles[0]?.id ?? NO_SUMMARY_PROFILE_ID
  )
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const microphones = useMemo(
    () => audioDevices.filter((device) => device.kind === 'microphone'),
    [audioDevices]
  )
  const outputs = useMemo(
    () => audioDevices.filter((device) => device.kind !== 'microphone'),
    [audioDevices]
  )
  const isActive = status.activeSessionId === session.id && status.phase === 'recording'
  const isFinalizing = status.activeSessionId === session.id && status.phase === 'finalizing'
  const isReady = status.connected && status.phase === 'ready'
  const isPreparingConnection = status.phase === 'configuring'
  const selectedTarget = targets.find((target) => target.id === targetId)

  useEffect(() => {
    if (!status.connected || status.phase !== 'ready' || isActive || isFinalizing) return
    let cancelled = false
    void onDiscover()
      .then((result) => {
        if (cancelled) return
        setTargets(result.targets)
        setAudioDevices(result.audioDevices)
        setTargetId((current) => current || result.targets[0]?.id || '')
        const defaultMic = result.audioDevices.find((device) => device.kind === 'microphone')
        const defaultOutput = result.audioDevices.find((device) => device.kind !== 'microphone')
        setMicrophoneId((current) => (current === 'none' ? (defaultMic?.id ?? 'none') : current))
        setOutputId((current) => (current === 'none' ? (defaultOutput?.id ?? 'none') : current))
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : 'Capture sources could not be loaded.')
      })
    return () => {
      cancelled = true
    }
  }, [isActive, isFinalizing, onDiscover, status.connected, status.phase])

  useEffect(() => {
    setTranscriptionProfileId((current) =>
      transcriptionProfiles.some((profile) => profile.id === current)
        ? current
        : (transcriptionProfiles[0]?.id ?? '')
    )
    setSummaryProfileId((current) =>
      current === NO_SUMMARY_PROFILE_ID || summaryProfiles.some((profile) => profile.id === current)
        ? current
        : (summaryProfiles[0]?.id ?? NO_SUMMARY_PROFILE_ID)
    )
  }, [summaryProfiles, transcriptionProfiles])

  async function runPreflight(): Promise<void> {
    setBusy(true)
    setError(null)
    setPreflight(null)
    try {
      await onConfigure({
        targetId: targetId || null,
        microphoneDeviceId: microphoneId === 'none' ? null : microphoneId,
        outputDeviceId: outputId === 'none' ? null : outputId,
        captureCursor
      })
      setPreflight(await onPreflight())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Preflight could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  async function selectPortalTarget(): Promise<void> {
    setBusy(true)
    setError(null)
    setPreflight(null)
    try {
      await onSelectPortalTarget()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Another window could not be selected.')
    } finally {
      setBusy(false)
    }
  }

  async function start(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const transcriptionProfileAvailable = transcriptionProfiles.some(
        (profile) => profile.id === transcriptionProfileId
      )
      if (!transcriptionProfileAvailable) {
        throw new Error('Choose a transcription provider before recording.')
      }
      await onStart({
        sessionId: session.id,
        transcriptionProfileId,
        summaryProfileId: summaryProfileId === NO_SUMMARY_PROFILE_ID ? null : summaryProfileId
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Recording could not be started.')
    } finally {
      setBusy(false)
    }
  }

  async function stop(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await onStop()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Recording could not be stopped.')
    } finally {
      setBusy(false)
    }
  }

  if (isActive || isFinalizing) {
    return (
      <section className="recording-workspace" aria-labelledby="recording-title">
        <div className="recording-workspace__pulse" aria-hidden="true">
          <i />
        </div>
        <span className="eyebrow eyebrow--recording">
          {isFinalizing ? 'Finalizing recording' : 'Recording in OBS'}
        </span>
        <h1 id="recording-title">{session.title}</h1>
        <div
          className="recording-time"
          aria-label={`Elapsed time ${formatDuration(status.elapsedMs)}`}
        >
          {formatDuration(status.elapsedMs)}
        </div>
        <div className="meter-grid">
          <AudioMeter label="Microphone" value={status.microphoneLevel} icon={<Mic size={17} />} />
          <AudioMeter
            label="System audio"
            value={status.systemLevel}
            icon={<Volume2 size={17} />}
          />
        </div>
        <div className="recording-stats">
          <span>
            <HardDrive size={16} />
            {formatBytes(status.bytesWritten)} written
          </span>
          <span>
            <Gauge size={16} />
            OBS {status.obsVersion ?? 'connected'}
          </span>
        </div>
        {status.warnings.map((warning) => (
          <InlineNotice tone="warning" icon={<AlertCircle size={18} />} key={warning}>
            {warning}
          </InlineNotice>
        ))}
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
        <Button
          variant="danger"
          className="stop-recording"
          disabled={busy || isFinalizing}
          onClick={() => void stop()}
        >
          {busy || isFinalizing ? (
            <LoaderCircle className="spin" size={18} />
          ) : (
            <CircleStop size={18} />
          )}
          {isFinalizing ? 'Saving recording…' : 'Stop recording'}
        </Button>
      </section>
    )
  }

  return (
    <section className="capture-setup" aria-labelledby="capture-setup-title">
      <header className="workspace-heading">
        <div>
          <span className="eyebrow">Recording setup</span>
          <h1 id="capture-setup-title">{session.title}</h1>
          <p>Choose the OBS source and audio inputs, then verify them before recording.</p>
        </div>
        <Button disabled={isPreparingConnection} onClick={onOpenConnection}>
          <Settings2 size={17} />
          OBS connection
        </Button>
      </header>

      {!isReady ? (
        <div className="onboarding-panel">
          <span className="onboarding-panel__icon">
            <MonitorUp size={28} />
          </span>
          <div>
            <h2>
              {status.phase === 'recovering'
                ? 'Reconnecting to OBS Studio'
                : status.connected
                  ? 'Preparing OBS Studio'
                  : 'Connect OBS Studio'}
            </h2>
            <p>
              {isPreparingConnection
                ? 'Waiting for the OBS connection and recording resources to become ready.'
                : status.phase === 'recovering'
                  ? 'SessionScribe is reconnecting automatically, or you can connect manually.'
                  : 'Enable the OBS WebSocket server and connect before selecting a capture target.'}
            </p>
          </div>
          {isPreparingConnection ? (
            <LoaderCircle className="spin" size={20} />
          ) : (
            <Button variant="primary" onClick={onOpenConnection}>
              <PlugZap size={17} />
              Connect OBS
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="capture-status-strip">
            <span>
              <CheckCircle2 size={17} /> Connected to OBS {status.obsVersion ?? ''}
            </span>
            <Button
              size="small"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setError(null)
                void onDiscover()
                  .then((result) => {
                    setTargets(result.targets)
                    setAudioDevices(result.audioDevices)
                  })
                  .catch((cause: unknown) =>
                    setError(
                      cause instanceof Error ? cause.message : 'Sources could not be refreshed.'
                    )
                  )
              }}
            >
              <RefreshCw size={15} /> Refresh sources
            </Button>
          </div>

          <div className="capture-form">
            <div className="capture-target-picker">
              <SelectField
                label="Capture target"
                value={targetId}
                onValueChange={(value) => {
                  setTargetId(value)
                  setPreflight(null)
                }}
                options={targets.map((target) => ({
                  value: target.id,
                  label: `${target.label}${target.requiresPortal ? ' · portal' : ''}`
                }))}
                placeholder="Choose an OBS window source"
              />
              {selectedTarget?.requiresPortal ? (
                <Button size="small" disabled={busy} onClick={() => void selectPortalTarget()}>
                  {busy ? <LoaderCircle className="spin" size={15} /> : <MonitorUp size={15} />}
                  Choose another window
                </Button>
              ) : null}
            </div>
            <SelectField
              label="Microphone"
              value={microphoneId}
              onValueChange={(value) => {
                setMicrophoneId(value)
                setPreflight(null)
              }}
              options={[
                { value: 'none', label: 'No microphone' },
                ...microphones.map((device) => ({ value: device.id, label: device.label }))
              ]}
            />
            <SelectField
              label="System or window audio"
              value={outputId}
              onValueChange={(value) => {
                setOutputId(value)
                setPreflight(null)
              }}
              options={[
                { value: 'none', label: 'No system audio' },
                ...outputs.map((device) => ({ value: device.id, label: device.label }))
              ]}
            />
            <label className="check-field capture-cursor">
              <input
                type="checkbox"
                checked={captureCursor}
                onChange={(event) => {
                  setCaptureCursor(event.target.checked)
                  setPreflight(null)
                }}
              />
              <span>Include pointer in recording</span>
            </label>
          </div>

          <div className="processing-provider-row">
            <SelectField
              label="Transcription provider"
              value={transcriptionProfileId}
              onValueChange={setTranscriptionProfileId}
              options={transcriptionProfiles.map((profile) => ({
                value: profile.id,
                label: `${profile.name} · ${profile.model}`
              }))}
              placeholder="Choose transcription provider"
            />
            <SelectField
              label="Summary provider"
              value={summaryProfileId}
              onValueChange={setSummaryProfileId}
              options={[
                { value: NO_SUMMARY_PROFILE_ID, label: 'No summary — transcript only' },
                ...summaryProfiles.map((profile) => ({
                  value: profile.id,
                  label: `${profile.name} · ${profile.model}`
                }))
              ]}
              placeholder="Choose summary provider"
            />
          </div>

          {transcriptionProfiles.length === 0 ? (
            <InlineNotice tone="warning">
              Add a transcription provider in Settings before recording.
            </InlineNotice>
          ) : null}

          {preflight ? <PreflightReport result={preflight} /> : null}
          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
          <div className="capture-actions">
            <Button disabled={busy || !targetId} onClick={() => void runPreflight()}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <Eye size={17} />}
              Run preflight
            </Button>
            <Button
              variant="primary"
              disabled={
                busy ||
                !preflight?.ok ||
                !transcriptionProfiles.some((profile) => profile.id === transcriptionProfileId)
              }
              onClick={() => void start()}
            >
              <Radio size={17} />
              Start recording
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

function AudioMeter({
  label,
  value,
  icon
}: {
  label: string
  value: number
  icon: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="audio-meter">
      <div className="audio-meter__label">
        <span>{icon}</span>
        {label}
        <strong>{Math.round(value * 100)}%</strong>
      </div>
      <div
        className="audio-meter__track"
        aria-label={`${label} level`}
        role="meter"
        aria-valuenow={Math.round(value * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <i style={{ width: `${Math.max(2, value * 100)}%` }} />
      </div>
    </div>
  )
}

function PreflightReport({ result }: { result: PreflightResult }): React.JSX.Element {
  return (
    <div className={`preflight-report ${result.ok ? 'is-ready' : 'has-blockers'}`}>
      <div className="preflight-report__result">
        {result.ok ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
        <div>
          <strong>{result.ok ? 'Ready to record' : 'Preflight needs attention'}</strong>
          <span>
            {result.ok
              ? 'OBS can see the target and selected audio sources.'
              : 'Resolve the blockers below and run preflight again.'}
          </span>
        </div>
      </div>
      {result.screenshotDataUrl ? (
        <img
          className="preflight-preview"
          src={result.screenshotDataUrl}
          alt="OBS capture preview"
        />
      ) : null}
      {[...result.blockers, ...result.warnings].length > 0 ? (
        <ul>
          {result.blockers.map((blocker) => (
            <li className="is-blocker" key={blocker}>
              {blocker}
            </li>
          ))}
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
