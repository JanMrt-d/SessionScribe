import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  Edit3,
  Languages,
  LoaderCircle,
  Merge,
  Play,
  RotateCcw,
  Save,
  Search,
  Users
} from 'lucide-react'
import type { TranscriptDocumentV1, TranscriptUtterance } from '@shared/transcript'
import { formatDuration, initials } from '../lib/format'
import { Button, InlineNotice, SelectField } from './ui'

interface TranscriptEditorProps {
  document: TranscriptDocumentV1
  onSeek(milliseconds: number): void
  onSave(document: TranscriptDocumentV1): Promise<TranscriptDocumentV1>
  onRenameSpeaker(speakerId: string, displayName: string): Promise<TranscriptDocumentV1>
  onMergeSpeakers(sourceId: string, targetId: string): Promise<TranscriptDocumentV1>
}

export function TranscriptEditor({
  document,
  onSeek,
  onSave,
  onRenameSpeaker,
  onMergeSpeakers
}: TranscriptEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState<TranscriptDocumentV1>(() => structuredClone(document))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({})
  const [mergeSource, setMergeSource] = useState('')
  const [mergeTarget, setMergeTarget] = useState('')

  useEffect(() => {
    setDraft(structuredClone(document))
    setDirty(false)
    setSpeakerNames(
      Object.fromEntries(
        document.speakers.map((speaker) => [speaker.id, speaker.displayName ?? speaker.label])
      )
    )
    setMergeSource(document.speakers[1]?.id ?? '')
    setMergeTarget(document.speakers[0]?.id ?? '')
  }, [document])

  const visibleUtterances = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return draft.utterances
    return draft.utterances.filter((utterance) => {
      const speaker = draft.speakers.find((candidate) => candidate.id === utterance.speakerId)
      return (
        utterance.text.toLocaleLowerCase().includes(normalized) ||
        speaker?.displayName?.toLocaleLowerCase().includes(normalized) ||
        speaker?.label.toLocaleLowerCase().includes(normalized)
      )
    })
  }, [draft.speakers, draft.utterances, query])

  function updateUtterance(id: string, change: Partial<TranscriptUtterance>): void {
    setDraft((current) => {
      const utterances = current.utterances.map((utterance) =>
        utterance.id === id ? { ...utterance, ...change, manuallyEdited: true } : utterance
      )
      return {
        ...current,
        utterances,
        text: utterances.map((utterance) => utterance.text).join(' ')
      }
    })
    setDirty(true)
  }

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const saved = await onSave(draft)
      setDraft(structuredClone(saved))
      setDirty(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Transcript changes could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  async function persistDraftIfDirty(): Promise<void> {
    if (!dirty) return
    const saved = await onSave(draft)
    setDraft(structuredClone(saved))
    setDirty(false)
  }

  async function renameSpeaker(speakerId: string): Promise<void> {
    const displayName = speakerNames[speakerId]?.trim()
    if (!displayName) return
    setSaving(true)
    setError(null)
    try {
      await persistDraftIfDirty()
      const saved = await onRenameSpeaker(speakerId, displayName)
      setDraft(structuredClone(saved))
      setDirty(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The speaker could not be renamed.')
    } finally {
      setSaving(false)
    }
  }

  async function mergeSpeakers(): Promise<void> {
    if (!mergeSource || !mergeTarget || mergeSource === mergeTarget) return
    setSaving(true)
    setError(null)
    try {
      await persistDraftIfDirty()
      const saved = await onMergeSpeakers(mergeSource, mergeTarget)
      setDraft(structuredClone(saved))
      setDirty(false)
      setMergeSource(saved.speakers[1]?.id ?? '')
      setMergeTarget(saved.speakers[0]?.id ?? '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The speakers could not be merged.')
    } finally {
      setSaving(false)
    }
  }

  const speakerOptions = draft.speakers.map((speaker) => ({
    value: speaker.id,
    label: speaker.displayName ?? speaker.label
  }))

  return (
    <section className="transcript-editor" aria-labelledby="transcript-heading">
      <header className="editor-heading">
        <div>
          <span className="eyebrow">Transcript · revision {draft.revision}</span>
          <h2 id="transcript-heading">Conversation</h2>
          <p>
            {draft.utterances.length} utterances · {draft.text.split(/\s+/).filter(Boolean).length}{' '}
            words
          </p>
        </div>
        <div className="editor-heading__actions">
          {dirty ? (
            <span className="unsaved-indicator">
              <Edit3 size={14} /> Unsaved edits
            </span>
          ) : null}
          <Button
            size="small"
            variant="ghost"
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(structuredClone(document))
              setDirty(false)
            }}
          >
            <RotateCcw size={15} /> Reset
          </Button>
          <Button
            size="small"
            variant="primary"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
            Save transcript
          </Button>
        </div>
      </header>

      <div className="transcript-toolbar">
        <label className="search-field search-field--transcript">
          <Search size={16} />
          <span className="sr-only">Search transcript</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find in transcript"
          />
        </label>
        <span>
          <Languages size={15} />
          {draft.languages.join(', ') || 'Language not reported'}
        </span>
        <span>
          <Users size={15} />
          {draft.speakers.length} speakers
        </span>
      </div>

      {draft.warnings.map((warning) => (
        <InlineNotice tone="warning" key={warning}>
          {warning}
        </InlineNotice>
      ))}
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      {draft.speakers.length > 0 ? (
        <details className="speaker-manager">
          <summary>
            <Users size={17} />
            Rename or merge speakers
          </summary>
          <div className="speaker-manager__body">
            <div className="speaker-name-list">
              {draft.speakers.map((speaker, index) => (
                <div className="speaker-name-row" key={speaker.id}>
                  <span className="speaker-avatar" data-color={index % 6}>
                    {initials(speakerNames[speaker.id] ?? speaker.label)}
                  </span>
                  <label>
                    <span>{speaker.label}</span>
                    <input
                      value={speakerNames[speaker.id] ?? ''}
                      onChange={(event) =>
                        setSpeakerNames((current) => ({
                          ...current,
                          [speaker.id]: event.target.value
                        }))
                      }
                    />
                  </label>
                  <Button
                    size="small"
                    disabled={saving}
                    onClick={() => void renameSpeaker(speaker.id)}
                  >
                    <Check size={15} /> Apply
                  </Button>
                </div>
              ))}
            </div>
            {draft.speakers.length > 1 ? (
              <div className="merge-speakers">
                <SelectField
                  label="Merge speaker"
                  value={mergeSource}
                  onValueChange={setMergeSource}
                  options={speakerOptions}
                />
                <span>into</span>
                <SelectField
                  label="Destination speaker"
                  value={mergeTarget}
                  onValueChange={setMergeTarget}
                  options={speakerOptions.filter((option) => option.value !== mergeSource)}
                />
                <Button
                  disabled={!mergeSource || !mergeTarget || mergeSource === mergeTarget || saving}
                  onClick={() => void mergeSpeakers()}
                >
                  <Merge size={16} /> Merge
                </Button>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}

      <div className="utterance-list">
        {visibleUtterances.map((utterance) => {
          const speakerIndex = Math.max(
            0,
            draft.speakers.findIndex((speaker) => speaker.id === utterance.speakerId)
          )
          return (
            <article className="utterance" key={utterance.id} id={`utterance-${utterance.id}`}>
              <div className="utterance__rail">
                <span className="speaker-avatar" data-color={speakerIndex % 6}>
                  {initials(speakerName(draft, utterance.speakerId)) || '–'}
                </span>
                <button
                  className="timestamp-button"
                  onClick={() => onSeek(utterance.startMs)}
                  aria-label={`Play from ${formatDuration(utterance.startMs)}`}
                >
                  <Play size={12} fill="currentColor" />
                  {formatDuration(utterance.startMs)}
                </button>
              </div>
              <div className="utterance__content">
                <div className="utterance__header">
                  {draft.speakers.length > 0 ? (
                    <SelectField
                      label="Speaker"
                      value={utterance.speakerId ?? 'unknown'}
                      onValueChange={(speakerId) =>
                        updateUtterance(utterance.id, {
                          speakerId: speakerId === 'unknown' ? null : speakerId
                        })
                      }
                      options={[{ value: 'unknown', label: 'Unknown speaker' }, ...speakerOptions]}
                    />
                  ) : (
                    <strong>Unknown speaker</strong>
                  )}
                  {utterance.manuallyEdited ? <span className="edited-badge">Edited</span> : null}
                  <span>{formatDuration(utterance.endMs - utterance.startMs)}</span>
                </div>
                <textarea
                  value={utterance.text}
                  rows={Math.max(2, Math.ceil(utterance.text.length / 92))}
                  aria-label={`Transcript at ${formatDuration(utterance.startMs)}`}
                  onChange={(event) => updateUtterance(utterance.id, { text: event.target.value })}
                />
              </div>
            </article>
          )
        })}
        {visibleUtterances.length === 0 ? (
          <div className="transcript-no-results">No utterances match “{query}”.</div>
        ) : null}
      </div>
    </section>
  )
}

function speakerName(document: TranscriptDocumentV1, speakerId: string | null): string {
  const speaker = document.speakers.find((candidate) => candidate.id === speakerId)
  return speaker?.displayName ?? speaker?.label ?? 'Unknown'
}
