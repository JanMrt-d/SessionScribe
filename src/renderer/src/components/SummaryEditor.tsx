import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  BookOpenCheck,
  CalendarClock,
  CheckSquare2,
  CircleHelp,
  FileWarning,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Sparkles,
  Target,
  Trash2,
  Users
} from 'lucide-react'
import type { SessionMode } from '@shared/domain'
import type { ProviderProfileV1 } from '@shared/providers'
import type { LectureSummaryV1, MeetingSummaryV1, SummaryDocumentV1 } from '@shared/summary'
import type { EvidenceRef } from '@shared/transcript'
import { formatDuration, fromDateTimeLocal, toDateTimeLocal } from '../lib/format'
import { Button, EmptyState, InlineNotice, SelectField } from './ui'

type GroundedText = MeetingSummaryV1['topics'][number]
type ActionItem = MeetingSummaryV1['actionItems'][number]
type Concept = LectureSummaryV1['concepts'][number]

interface SummaryEditorProps {
  sessionMode: SessionMode
  document: SummaryDocumentV1 | null
  stale: boolean
  profiles: ProviderProfileV1[]
  onGenerate(profileId: string, mode: SessionMode): Promise<void>
  onSave(document: SummaryDocumentV1): Promise<SummaryDocumentV1>
  onSeek(milliseconds: number): void
}

export function SummaryEditor({
  sessionMode,
  document,
  stale,
  profiles,
  onGenerate,
  onSave,
  onSeek
}: SummaryEditorProps): React.JSX.Element {
  const summaryProfiles = useMemo(
    () => profiles.filter((profile) => profile.task === 'summary'),
    [profiles]
  )
  const [profileId, setProfileId] = useState('')
  const [draft, setDraft] = useState<SummaryDocumentV1 | null>(
    document ? structuredClone(document) : null
  )
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(document ? structuredClone(document) : null)
    setDirty(false)
  }, [document])

  useEffect(() => {
    setProfileId((current) =>
      summaryProfiles.some((profile) => profile.id === current)
        ? current
        : (summaryProfiles[0]?.id ?? '')
    )
  }, [summaryProfiles])

  async function generate(): Promise<void> {
    if (!summaryProfiles.some((profile) => profile.id === profileId)) return
    setBusy(true)
    setError(null)
    try {
      await onGenerate(profileId, sessionMode)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The summary job could not be started.')
    } finally {
      setBusy(false)
    }
  }

  async function save(): Promise<void> {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const saved = await onSave({ ...draft, manuallyEdited: true })
      setDraft(structuredClone(saved))
      setDirty(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Summary changes could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  function change(transform: (current: SummaryDocumentV1) => SummaryDocumentV1): void {
    setDraft((current) => (current ? transform(current) : current))
    setDirty(true)
  }

  const providerPicker = (
    <div className="generate-controls">
      <SelectField
        label="Summary provider"
        value={profileId}
        onValueChange={setProfileId}
        options={summaryProfiles.map((profile) => ({
          value: profile.id,
          label: `${profile.name} · ${profile.model}`
        }))}
        placeholder="Choose a summary provider"
      />
      <Button
        variant="primary"
        disabled={busy || !summaryProfiles.some((profile) => profile.id === profileId)}
        onClick={() => void generate()}
      >
        {busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
        {draft ? 'Regenerate' : 'Generate summary'}
      </Button>
    </div>
  )

  if (!draft) {
    return (
      <section className="summary-editor summary-editor--empty" aria-label="Summary">
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
        <EmptyState
          icon={sessionMode === 'meeting' ? <ListChecks size={27} /> : <BookOpenCheck size={27} />}
          title={sessionMode === 'meeting' ? 'Create meeting notes' : 'Create lecture notes'}
          description={
            sessionMode === 'meeting'
              ? 'Extract grounded decisions, responsibilities, due dates, risks, and open questions.'
              : 'Turn the spoken lecture into an outline, key lessons, concepts, examples, and review questions.'
          }
          actions={summaryProfiles.length > 0 ? providerPicker : undefined}
        />
        {summaryProfiles.length === 0 ? (
          <InlineNotice tone="warning" icon={<FileWarning size={18} />}>
            Add a summary provider in Settings before generating notes.
          </InlineNotice>
        ) : null}
      </section>
    )
  }

  return (
    <section className="summary-editor" aria-labelledby="summary-heading">
      {stale ? (
        <InlineNotice tone="warning" icon={<AlertTriangle size={18} />} actions={providerPicker}>
          <strong>Summary is out of date</strong>
          <span>The transcript changed after this summary was generated.</span>
        </InlineNotice>
      ) : null}
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      <header className="editor-heading">
        <div>
          <span className="eyebrow">
            {draft.mode === 'meeting' ? 'Meeting summary' : 'Lecture summary'} · revision{' '}
            {draft.revision}
          </span>
          <h2 id="summary-heading">Structured notes</h2>
          <p>Generated from transcript revision {draft.transcriptRevision}</p>
        </div>
        <div className="editor-heading__actions">
          {!stale ? providerPicker : null}
          <Button
            variant="primary"
            size="small"
            disabled={!dirty || busy}
            onClick={() => void save()}
          >
            {busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
            Save summary
          </Button>
        </div>
      </header>

      <div className="summary-title-fields">
        <label className="field">
          <span className="field__label">Title</span>
          <input
            value={draft.title}
            onChange={(event) =>
              change((current) => ({ ...current, title: event.target.value, manuallyEdited: true }))
            }
          />
        </label>
        <label className="field">
          <span className="field__label">Overview</span>
          <textarea
            rows={4}
            value={draft.overview}
            onChange={(event) =>
              change((current) => ({
                ...current,
                overview: event.target.value,
                manuallyEdited: true
              }))
            }
          />
        </label>
      </div>

      {draft.mode === 'meeting' ? (
        <MeetingFields document={draft} onChange={(next) => change(() => next)} onSeek={onSeek} />
      ) : (
        <LectureFields document={draft} onChange={(next) => change(() => next)} onSeek={onSeek} />
      )}

      <footer className="summary-provenance">
        <span>Model {draft.provenance.model}</span>
        <span>Prompt {draft.provenance.promptVersion}</span>
        {draft.manuallyEdited || dirty ? <span>Edited by you</span> : null}
      </footer>
    </section>
  )
}

function MeetingFields({
  document,
  onChange,
  onSeek
}: {
  document: MeetingSummaryV1
  onChange(document: MeetingSummaryV1): void
  onSeek(milliseconds: number): void
}): React.JSX.Element {
  function update<K extends keyof MeetingSummaryV1>(key: K, value: MeetingSummaryV1[K]): void {
    onChange({ ...document, [key]: value, manuallyEdited: true })
  }

  return (
    <div className="summary-sections">
      <GroundedListEditor
        title="Topics"
        icon={<Target size={18} />}
        items={document.topics}
        placeholder="Topic discussed"
        onChange={(items) => update('topics', items)}
        onSeek={onSeek}
      />
      <GroundedListEditor
        title="Decisions"
        icon={<CheckSquare2 size={18} />}
        items={document.decisions}
        placeholder="Decision made"
        onChange={(items) => update('decisions', items)}
        onSeek={onSeek}
      />
      <section className="summary-section" aria-labelledby="action-items-heading">
        <SummarySectionHeading
          id="action-items-heading"
          icon={<ListChecks size={18} />}
          title="Action items"
          count={document.actionItems.length}
          onAdd={() =>
            update('actionItems', [
              ...document.actionItems,
              {
                task: '',
                assignee: null,
                explicitAssignment: false,
                dueAt: null,
                dueText: null,
                confidence: 0.5,
                evidence: []
              }
            ])
          }
        />
        <div className="structured-list">
          {document.actionItems.map((item, index) => (
            <ActionItemEditor
              item={item}
              onSeek={onSeek}
              onChange={(next) =>
                update(
                  'actionItems',
                  document.actionItems.map((candidate, candidateIndex) =>
                    candidateIndex === index ? next : candidate
                  )
                )
              }
              onRemove={() =>
                update(
                  'actionItems',
                  document.actionItems.filter((_, candidateIndex) => candidateIndex !== index)
                )
              }
              key={index}
            />
          ))}
          {document.actionItems.length === 0 ? (
            <p className="structured-list__empty">No action items identified.</p>
          ) : null}
        </div>
      </section>
      <GroundedListEditor
        title="Open questions"
        icon={<CircleHelp size={18} />}
        items={document.openQuestions}
        placeholder="Question left unresolved"
        onChange={(items) => update('openQuestions', items)}
        onSeek={onSeek}
      />
      <GroundedListEditor
        title="Risks"
        icon={<ShieldAlert size={18} />}
        items={document.risks}
        placeholder="Risk or dependency"
        onChange={(items) => update('risks', items)}
        onSeek={onSeek}
      />
    </div>
  )
}

function LectureFields({
  document,
  onChange,
  onSeek
}: {
  document: LectureSummaryV1
  onChange(document: LectureSummaryV1): void
  onSeek(milliseconds: number): void
}): React.JSX.Element {
  function update<K extends keyof LectureSummaryV1>(key: K, value: LectureSummaryV1[K]): void {
    onChange({ ...document, [key]: value, manuallyEdited: true })
  }

  return (
    <div className="summary-sections">
      <GroundedListEditor
        title="Outline"
        icon={<ListChecks size={18} />}
        items={document.outline}
        placeholder="Lecture section"
        onChange={(items) => update('outline', items)}
        onSeek={onSeek}
      />
      <GroundedListEditor
        title="Key lessons"
        icon={<Lightbulb size={18} />}
        items={document.keyLessons}
        placeholder="Important lesson"
        onChange={(items) => update('keyLessons', items)}
        onSeek={onSeek}
      />
      <section className="summary-section" aria-labelledby="concepts-heading">
        <SummarySectionHeading
          id="concepts-heading"
          icon={<BookOpenCheck size={18} />}
          title="Concepts"
          count={document.concepts.length}
          onAdd={() =>
            update('concepts', [...document.concepts, { name: '', definition: '', evidence: [] }])
          }
        />
        <div className="structured-list">
          {document.concepts.map((concept, index) => (
            <ConceptEditor
              concept={concept}
              onSeek={onSeek}
              onChange={(next) =>
                update(
                  'concepts',
                  document.concepts.map((candidate, candidateIndex) =>
                    candidateIndex === index ? next : candidate
                  )
                )
              }
              onRemove={() =>
                update(
                  'concepts',
                  document.concepts.filter((_, candidateIndex) => candidateIndex !== index)
                )
              }
              key={index}
            />
          ))}
        </div>
      </section>
      <GroundedListEditor
        title="Examples"
        icon={<Sparkles size={18} />}
        items={document.examples}
        placeholder="Example from the lecture"
        onChange={(items) => update('examples', items)}
        onSeek={onSeek}
      />
      <StringListEditor
        title="Review questions"
        icon={<CircleHelp size={18} />}
        items={document.reviewQuestions}
        placeholder="Question to test understanding"
        onChange={(items) => update('reviewQuestions', items)}
      />
      <GroundedListEditor
        title="Recommended review"
        icon={<RefreshCw size={18} />}
        items={document.recommendedReview}
        placeholder="Material worth revisiting"
        onChange={(items) => update('recommendedReview', items)}
        onSeek={onSeek}
      />
    </div>
  )
}

function SummarySectionHeading({
  id,
  icon,
  title,
  count,
  onAdd
}: {
  id: string
  icon: React.ReactNode
  title: string
  count: number
  onAdd(): void
}): React.JSX.Element {
  return (
    <header className="summary-section__heading">
      <div>
        {icon}
        <h3 id={id}>{title}</h3>
        <span>{count}</span>
      </div>
      <Button size="small" variant="ghost" onClick={onAdd}>
        <Plus size={15} /> Add
      </Button>
    </header>
  )
}

function GroundedListEditor({
  title,
  icon,
  items,
  placeholder,
  onChange,
  onSeek
}: {
  title: string
  icon: React.ReactNode
  items: GroundedText[]
  placeholder: string
  onChange(items: GroundedText[]): void
  onSeek(milliseconds: number): void
}): React.JSX.Element {
  const id = `summary-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <section className="summary-section" aria-labelledby={id}>
      <SummarySectionHeading
        id={id}
        icon={icon}
        title={title}
        count={items.length}
        onAdd={() => onChange([...items, { text: '', evidence: [] }])}
      />
      <div className="structured-list">
        {items.map((item, index) => (
          <div className="grounded-row" key={index}>
            <textarea
              rows={2}
              value={item.text}
              placeholder={placeholder}
              aria-label={`${title} item ${index + 1}`}
              onChange={(event) =>
                onChange(
                  items.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, text: event.target.value }
                      : candidate
                  )
                )
              }
            />
            <EvidenceList evidence={item.evidence} onSeek={onSeek} />
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Remove ${title.toLowerCase()} item ${index + 1}`}
              onClick={() =>
                onChange(items.filter((_, candidateIndex) => candidateIndex !== index))
              }
            >
              <Trash2 size={15} />
            </Button>
          </div>
        ))}
        {items.length === 0 ? <p className="structured-list__empty">None identified.</p> : null}
      </div>
    </section>
  )
}

function StringListEditor({
  title,
  icon,
  items,
  placeholder,
  onChange
}: {
  title: string
  icon: React.ReactNode
  items: string[]
  placeholder: string
  onChange(items: string[]): void
}): React.JSX.Element {
  const id = `summary-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <section className="summary-section" aria-labelledby={id}>
      <SummarySectionHeading
        id={id}
        icon={icon}
        title={title}
        count={items.length}
        onAdd={() => onChange([...items, ''])}
      />
      <div className="structured-list">
        {items.map((item, index) => (
          <div className="grounded-row" key={index}>
            <textarea
              rows={2}
              value={item}
              placeholder={placeholder}
              aria-label={`${title} item ${index + 1}`}
              onChange={(event) =>
                onChange(
                  items.map((candidate, candidateIndex) =>
                    candidateIndex === index ? event.target.value : candidate
                  )
                )
              }
            />
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Remove ${title.toLowerCase()} item ${index + 1}`}
              onClick={() =>
                onChange(items.filter((_, candidateIndex) => candidateIndex !== index))
              }
            >
              <Trash2 size={15} />
            </Button>
          </div>
        ))}
      </div>
    </section>
  )
}

function ActionItemEditor({
  item,
  onChange,
  onRemove,
  onSeek
}: {
  item: ActionItem
  onChange(item: ActionItem): void
  onRemove(): void
  onSeek(milliseconds: number): void
}): React.JSX.Element {
  return (
    <article className="action-editor">
      <div className="action-editor__main">
        <label className="field field--wide">
          <span className="field__label">Task</span>
          <textarea
            rows={2}
            value={item.task}
            onChange={(event) => onChange({ ...item, task: event.target.value })}
          />
        </label>
        <Button size="icon" variant="ghost" aria-label="Remove action item" onClick={onRemove}>
          <Trash2 size={15} />
        </Button>
      </div>
      <div className="action-editor__fields">
        <label className="field">
          <span className="field__label">Assignee</span>
          <div className="input-with-icon">
            <Users size={15} />
            <input
              value={item.assignee ?? ''}
              placeholder="Unassigned"
              onChange={(event) => onChange({ ...item, assignee: event.target.value || null })}
            />
          </div>
        </label>
        <label className="field">
          <span className="field__label">Due date</span>
          <div className="input-with-icon">
            <CalendarClock size={15} />
            <input
              type="datetime-local"
              value={toDateTimeLocal(item.dueAt)}
              onChange={(event) =>
                onChange({ ...item, dueAt: fromDateTimeLocal(event.target.value) })
              }
            />
          </div>
        </label>
        <label className="field">
          <span className="field__label">Due date as stated</span>
          <input
            value={item.dueText ?? ''}
            placeholder="e.g. next Friday"
            onChange={(event) => onChange({ ...item, dueText: event.target.value || null })}
          />
        </label>
      </div>
      <div className="action-editor__footer">
        <label className="check-field">
          <input
            type="checkbox"
            checked={item.explicitAssignment}
            onChange={(event) => onChange({ ...item, explicitAssignment: event.target.checked })}
          />
          <span>Explicitly assigned</span>
        </label>
        <label className="confidence-field">
          <span>Confidence {Math.round(item.confidence * 100)}%</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={item.confidence}
            onChange={(event) => onChange({ ...item, confidence: Number(event.target.value) })}
          />
        </label>
        <EvidenceList evidence={item.evidence} onSeek={onSeek} />
      </div>
    </article>
  )
}

function ConceptEditor({
  concept,
  onChange,
  onRemove,
  onSeek
}: {
  concept: Concept
  onChange(concept: Concept): void
  onRemove(): void
  onSeek(milliseconds: number): void
}): React.JSX.Element {
  return (
    <article className="concept-editor">
      <div>
        <label className="field">
          <span className="field__label">Concept</span>
          <input
            value={concept.name}
            onChange={(event) => onChange({ ...concept, name: event.target.value })}
          />
        </label>
        <Button size="icon" variant="ghost" aria-label="Remove concept" onClick={onRemove}>
          <Trash2 size={15} />
        </Button>
      </div>
      <label className="field">
        <span className="field__label">Definition</span>
        <textarea
          rows={3}
          value={concept.definition}
          onChange={(event) => onChange({ ...concept, definition: event.target.value })}
        />
      </label>
      <EvidenceList evidence={concept.evidence} onSeek={onSeek} />
    </article>
  )
}

function EvidenceList({
  evidence,
  onSeek
}: {
  evidence: EvidenceRef[]
  onSeek(milliseconds: number): void
}): React.JSX.Element {
  if (evidence.length === 0) return <span className="no-evidence">No source linked</span>
  return (
    <div className="evidence-list" aria-label="Source timestamps">
      {evidence.map((reference) => (
        <button
          type="button"
          onClick={() => onSeek(reference.startMs)}
          title={`Open transcript utterance ${reference.utteranceId}`}
          key={`${reference.utteranceId}-${reference.startMs}`}
        >
          {formatDuration(reference.startMs)}
        </button>
      ))}
    </div>
  )
}
