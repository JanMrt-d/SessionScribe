import { useRef, useState } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import {
  AlertCircle,
  BookOpenText,
  Download,
  FileAudio,
  FileText,
  Film,
  LoaderCircle,
  Mic2,
  MoreHorizontal,
  Trash2
} from 'lucide-react'
import type { Session } from '@shared/domain'
import type { SessionDetails } from '@shared/ipc'
import type { ProviderProfileV1 } from '@shared/providers'
import type { SummaryDocumentV1 } from '@shared/summary'
import type { TranscriptDocumentV1 } from '@shared/transcript'
import type { CaptureConfiguration, CaptureStatus, PreflightResult } from '@shared/capture'
import { formatDateOnly, formatDuration, statusLabel } from '../lib/format'
import { Button, EmptyState, InlineNotice } from './ui'
import { CaptureWorkspace } from './CaptureWorkspace'
import { PipelinePanel } from './PipelinePanel'
import { SummaryEditor } from './SummaryEditor'
import { TranscriptEditor } from './TranscriptEditor'

interface SessionWorkspaceProps {
  details: SessionDetails
  captureStatus: CaptureStatus
  profiles: ProviderProfileV1[]
  onOpenConnection(): void
  onOpenExport(): void
  onDelete(sessionId: string): void
  onDiscover: () => ReturnType<typeof window.sessionScribe.capture.discover>
  onConfigure(configuration: CaptureConfiguration): Promise<void>
  onSelectPortalTarget(): Promise<void>
  onPreflight(): Promise<PreflightResult>
  onStart(input: {
    sessionId: string
    transcriptionProfileId: string
    summaryProfileId: string | null
  }): Promise<void>
  onStop(): Promise<void>
  onRetry(jobId: string): Promise<void>
  onCancel(jobId: string): Promise<void>
  onSaveTranscript(document: TranscriptDocumentV1): Promise<TranscriptDocumentV1>
  onRenameSpeaker(speakerId: string, displayName: string): Promise<TranscriptDocumentV1>
  onMergeSpeakers(sourceId: string, targetId: string): Promise<TranscriptDocumentV1>
  onGenerateSummary(profileId: string, mode: Session['preferredMode']): Promise<void>
  onSaveSummary(document: SummaryDocumentV1): Promise<SummaryDocumentV1>
}

export function SessionWorkspace({
  details,
  captureStatus,
  profiles,
  onOpenConnection,
  onOpenExport,
  onDelete,
  onDiscover,
  onConfigure,
  onSelectPortalTarget,
  onPreflight,
  onStart,
  onStop,
  onRetry,
  onCancel,
  onSaveTranscript,
  onRenameSpeaker,
  onMergeSpeakers,
  onGenerateSummary,
  onSaveSummary
}: SessionWorkspaceProps): React.JSX.Element {
  const { session } = details
  const [activeTab, setActiveTab] = useState<'transcript' | 'summary'>('transcript')
  const videoRef = useRef<HTMLVideoElement>(null)
  const isCaptureStage =
    ['draft', 'configuring', 'ready-to-record', 'recording', 'finalizing'].includes(
      session.status
    ) || captureStatus.activeSessionId === session.id

  function seek(milliseconds: number): void {
    if (videoRef.current) {
      videoRef.current.currentTime = milliseconds / 1_000
      void videoRef.current.play().catch(() => undefined)
    }
  }

  if (isCaptureStage) {
    return (
      <main className="workspace workspace--capture">
        <CaptureWorkspace
          session={session}
          status={captureStatus}
          profiles={profiles}
          onOpenConnection={onOpenConnection}
          onDiscover={onDiscover}
          onConfigure={onConfigure}
          onSelectPortalTarget={onSelectPortalTarget}
          onPreflight={onPreflight}
          onStart={onStart}
          onStop={onStop}
        />
      </main>
    )
  }

  return (
    <main className="workspace">
      <header className="session-header">
        <div className={`session-header__mode session-header__mode--${session.preferredMode}`}>
          {session.preferredMode === 'meeting' ? <Mic2 size={20} /> : <BookOpenText size={20} />}
        </div>
        <div className="session-header__title">
          <div>
            <span className={`status-badge status-badge--${session.status}`}>
              {statusLabel(session.status)}
            </span>
            <span>{formatDateOnly(session.createdAt)}</span>
            {session.durationMs ? <span>{formatDuration(session.durationMs)}</span> : null}
          </div>
          <h1>{session.title}</h1>
        </div>
        <div className="session-header__actions">
          <Button onClick={onOpenExport} disabled={!details.transcript && !details.summary}>
            <Download size={16} /> Export
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Delete session"
            onClick={() => onDelete(session.id)}
          >
            <Trash2 size={17} />
          </Button>
          <Button size="icon" variant="ghost" aria-label="More session actions" disabled>
            <MoreHorizontal size={17} />
          </Button>
        </div>
      </header>

      {session.lastError ? (
        <div className="workspace-band">
          <InlineNotice tone="danger" icon={<AlertCircle size={18} />}>
            <strong>Session needs attention</strong>
            <span>{session.lastError}</span>
          </InlineNotice>
        </div>
      ) : null}

      {details.mediaUrl ? (
        <section className="media-band" aria-labelledby="media-heading">
          <div className="media-player">
            <video ref={videoRef} src={details.mediaUrl} controls preload="metadata">
              <track kind="captions" />
            </video>
          </div>
          <div className="media-info">
            <span className="eyebrow">Source recording</span>
            <h2 id="media-heading">{session.recordingFileName ?? 'Session media'}</h2>
            <p>Use transcript timestamps or summary evidence to jump to the relevant moment.</p>
            <div>
              <span>
                <Film size={15} /> Video available
              </span>
              {details.transcript ? (
                <span>
                  <FileAudio size={15} />{' '}
                  {details.transcript.languages.join(', ') || 'Audio transcript'}
                </span>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      <div className="workspace-band">
        <PipelinePanel jobs={details.jobs} onRetry={onRetry} onCancel={onCancel} />
      </div>

      <Tabs.Root
        className="workspace-tabs"
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as 'transcript' | 'summary')}
      >
        <Tabs.List aria-label="Session content">
          <Tabs.Trigger value="transcript">
            <FileText size={16} /> Transcript
            {details.transcript ? <span>{details.transcript.utterances.length}</span> : null}
          </Tabs.Trigger>
          <Tabs.Trigger value="summary">
            <BookOpenText size={16} /> Summary
            {details.summaryStale ? <i title="Summary out of date" /> : null}
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="transcript" className="workspace-tab-content">
          {details.transcript ? (
            <TranscriptEditor
              document={details.transcript}
              onSeek={seek}
              onSave={onSaveTranscript}
              onRenameSpeaker={onRenameSpeaker}
              onMergeSpeakers={onMergeSpeakers}
            />
          ) : (
            <WaitingForTranscript session={session} jobs={details.jobs} />
          )}
        </Tabs.Content>
        <Tabs.Content value="summary" className="workspace-tab-content">
          {details.transcript ? (
            <SummaryEditor
              sessionMode={session.preferredMode}
              document={details.summary}
              stale={details.summaryStale}
              profiles={profiles}
              onGenerate={onGenerateSummary}
              onSave={onSaveSummary}
              onSeek={(milliseconds) => {
                seek(milliseconds)
                setActiveTab('transcript')
              }}
            />
          ) : (
            <EmptyState
              icon={<FileText size={26} />}
              title="Transcript required"
              description="The summary can be generated once transcription finishes."
            />
          )}
        </Tabs.Content>
      </Tabs.Root>
    </main>
  )
}

function WaitingForTranscript({
  session,
  jobs
}: {
  session: Session
  jobs: SessionDetails['jobs']
}): React.JSX.Element {
  const processing = jobs.some((job) => job.status === 'running' || job.status === 'queued')
  return (
    <EmptyState
      icon={processing ? <LoaderCircle className="spin" size={27} /> : <FileText size={27} />}
      title={processing ? 'Preparing transcript' : 'No transcript available'}
      description={
        processing
          ? 'Processing continues locally and through your selected provider. This view updates automatically.'
          : session.status === 'failed'
            ? 'Retry the failed pipeline stage above to continue.'
            : 'This recording has not produced a transcript yet.'
      }
    />
  )
}
