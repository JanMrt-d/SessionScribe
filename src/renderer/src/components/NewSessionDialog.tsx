import { useEffect, useMemo, useState } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import { BookOpenText, LoaderCircle, Mic2, Radio, Upload } from 'lucide-react'
import type { Session, SessionMode } from '@shared/domain'
import type { ProviderProfileV1 } from '@shared/providers'
import { Button, InlineNotice, Modal, SegmentedControl, SelectField } from './ui'

interface NewSessionDialogProps {
  open: boolean
  initialSource: 'record' | 'import'
  profiles: ProviderProfileV1[]
  onOpenChange(open: boolean): void
  onCreate(input: { title: string; mode: SessionMode }): Promise<Session>
  onImport(input: {
    mode: SessionMode
    transcriptionProfileId: string
    summaryProfileId: string
  }): Promise<Session>
}

export function NewSessionDialog({
  open,
  initialSource,
  profiles,
  onOpenChange,
  onCreate,
  onImport
}: NewSessionDialogProps): React.JSX.Element {
  const [source, setSource] = useState<'record' | 'import'>(initialSource)
  const [mode, setMode] = useState<SessionMode>('meeting')
  const [title, setTitle] = useState('')
  const [transcriptionProfileId, setTranscriptionProfileId] = useState('')
  const [summaryProfileId, setSummaryProfileId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const transcriptionProfiles = useMemo(
    () => profiles.filter((profile) => profile.task === 'transcription'),
    [profiles]
  )
  const summaryProfiles = useMemo(
    () => profiles.filter((profile) => profile.task === 'summary'),
    [profiles]
  )

  useEffect(() => {
    if (!open) return
    setSource(initialSource)
    setError(null)
    setTranscriptionProfileId((current) =>
      transcriptionProfiles.some((profile) => profile.id === current)
        ? current
        : (transcriptionProfiles[0]?.id ?? '')
    )
    setSummaryProfileId((current) =>
      summaryProfiles.some((profile) => profile.id === current)
        ? current
        : (summaryProfiles[0]?.id ?? '')
    )
  }, [initialSource, open, summaryProfiles, transcriptionProfiles])

  async function submit(): Promise<void> {
    setSubmitting(true)
    setError(null)
    try {
      if (source === 'record') {
        const cleanTitle = title.trim() || defaultTitle(mode)
        await onCreate({ title: cleanTitle, mode })
      } else {
        const transcriptionProfileAvailable = transcriptionProfiles.some(
          (profile) => profile.id === transcriptionProfileId
        )
        const summaryProfileAvailable = summaryProfiles.some(
          (profile) => profile.id === summaryProfileId
        )
        if (!transcriptionProfileAvailable || !summaryProfileAvailable) {
          throw new Error('Choose both a transcription and summary provider before importing.')
        }
        await onImport({ mode, transcriptionProfileId, summaryProfileId })
      }
      setTitle('')
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The session could not be created.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New session"
      description="Record through OBS or process media you already have."
    >
      <Tabs.Root
        className="source-tabs"
        value={source}
        onValueChange={(value) => setSource(value as 'record' | 'import')}
      >
        <Tabs.List aria-label="Session source">
          <Tabs.Trigger value="record">
            <Radio size={16} />
            Record with OBS
          </Tabs.Trigger>
          <Tabs.Trigger value="import">
            <Upload size={16} />
            Import media
          </Tabs.Trigger>
        </Tabs.List>

        <div className="dialog-form">
          <SegmentedControl<SessionMode>
            label="Session mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'meeting', label: 'Meeting', icon: <Mic2 size={17} /> },
              { value: 'lecture', label: 'Lecture', icon: <BookOpenText size={17} /> }
            ]}
          />

          <Tabs.Content value="record">
            <label className="field">
              <span className="field__label">Session title</span>
              <input
                aria-label="Session title"
                value={title}
                maxLength={240}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={defaultTitle(mode)}
                autoFocus
              />
              <span className="field__hint">
                You can change the capture target before recording.
              </span>
            </label>
          </Tabs.Content>

          <Tabs.Content value="import" className="form-grid">
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
              options={summaryProfiles.map((profile) => ({
                value: profile.id,
                label: `${profile.name} · ${profile.model}`
              }))}
              placeholder="Choose summary provider"
            />
            {transcriptionProfiles.length === 0 || summaryProfiles.length === 0 ? (
              <InlineNotice tone="warning">
                Add one transcription and one summary provider in Settings before importing.
              </InlineNotice>
            ) : null}
          </Tabs.Content>

          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
        </div>
      </Tabs.Root>

      <div className="dialog-actions">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={
            submitting ||
            (source === 'import' &&
              (!transcriptionProfiles.some((profile) => profile.id === transcriptionProfileId) ||
                !summaryProfiles.some((profile) => profile.id === summaryProfileId)))
          }
        >
          {submitting ? <LoaderCircle className="spin" size={17} /> : null}
          {source === 'record' ? 'Set up recording' : 'Choose media'}
        </Button>
      </div>
    </Modal>
  )
}

function defaultTitle(mode: SessionMode): string {
  const date = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date())
  return `${mode === 'meeting' ? 'Meeting' : 'Lecture'} · ${date}`
}
