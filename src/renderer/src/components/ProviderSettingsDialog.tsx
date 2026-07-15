import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  Cloud,
  Cpu,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  Plus,
  Save,
  Server,
  TestTube2,
  Trash2,
  XCircle
} from 'lucide-react'
import type { ProviderInput } from '@shared/ipc'
import type { ProviderProfileV1 } from '@shared/providers'
import type { ManagedDiarizationStatus } from '@shared/diarization'
import type { ManagedWhisperStatus } from '@shared/whisper'
import { Button, IconButton, InlineNotice, Modal, SelectField } from './ui'
import { DiarizationStatusCard, type DiarizationAction } from './DiarizationStatusCard'
import { WhisperStatusCard, type WhisperAction } from './WhisperStatusCard'

type ProviderKind = ProviderProfileV1['kind']
type Pair = { key: string; value: string }

interface ProviderFormState {
  id: string
  createdAt: string
  name: string
  kind: ProviderKind
  model: string
  baseUrl: string
  timeoutMs: string
  language: string
  diarize: boolean
  numSpeakers: string
  timestampGranularity: 'word' | 'character'
  responseFormat: 'auto' | 'json' | 'text' | 'verbose_json' | 'diarized_json'
  maxUploadBytes: string
  executable: string
  args: string
  outputMode: 'stdout' | 'file'
  outputFormat: 'canonical-v1' | 'openai-verbose-json' | 'elevenlabs-json' | 'text'
  inheritEnvironment: boolean
  apiStyle: 'responses' | 'chat-completions'
  structuredOutput: 'json-schema' | 'json-object' | 'prompt-only'
  contextWindowTokens: string
  extraBody: string
  meetingPromptOverride: string
  lecturePromptOverride: string
  numPredict: string
  headers: Pair[]
  secrets: Pair[]
  secretRefs: Record<string, string>
}

interface ProviderSettingsDialogProps {
  open: boolean
  profiles: ProviderProfileV1[]
  encryptionAvailable: boolean
  whisperStatus: ManagedWhisperStatus | null
  whisperAction: WhisperAction
  diarizationStatus: ManagedDiarizationStatus | null
  diarizationAction: DiarizationAction
  onOpenChange(open: boolean): void
  onChooseExecutable(): Promise<string | null>
  onSave(input: ProviderInput): Promise<ProviderProfileV1>
  onDelete(id: string): Promise<void>
  onTest(input: ProviderInput): Promise<{ ok: boolean; message: string; models?: string[] }>
  onInstallWhisper(): Promise<void>
  onCancelWhisperInstall(): Promise<void>
  onStartWhisper(): Promise<void>
  onStopWhisper(): Promise<void>
  onInstallDiarization(): Promise<void>
  onCancelDiarizationInstall(): Promise<void>
  onStartDiarization(): Promise<void>
  onStopDiarization(): Promise<void>
}

export function ProviderSettingsDialog({
  open,
  profiles,
  encryptionAvailable,
  whisperStatus,
  whisperAction,
  diarizationStatus,
  diarizationAction,
  onOpenChange,
  onChooseExecutable,
  onSave,
  onDelete,
  onTest,
  onInstallWhisper,
  onCancelWhisperInstall,
  onStartWhisper,
  onStopWhisper,
  onInstallDiarization,
  onCancelDiarizationInstall,
  onStartDiarization,
  onStopDiarization
}: ProviderSettingsDialogProps): React.JSX.Element {
  // `undefined` means the asynchronously loaded profile list has not been
  // initialized yet; `null` deliberately represents the new-profile editor.
  const [selectedId, setSelectedId] = useState<string | null | undefined>(profiles[0]?.id)
  const selectedProfile =
    typeof selectedId === 'string'
      ? (profiles.find((profile) => profile.id === selectedId) ?? null)
      : null
  const [form, setForm] = useState<ProviderFormState>(() =>
    selectedProfile ? profileToForm(selectedProfile) : newProviderForm('openai-transcription')
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    message: string
    models?: string[]
  } | null>(null)

  useEffect(() => {
    if (!open) return
    if (selectedId === undefined) {
      const firstProfile = profiles[0]
      if (firstProfile) {
        setSelectedId(firstProfile.id)
        setForm(profileToForm(firstProfile))
      }
      return
    }
    if (selectedProfile) setForm(profileToForm(selectedProfile))
  }, [open, profiles, selectedId, selectedProfile])

  const grouped = useMemo(
    () => ({
      transcription: profiles.filter((profile) => profile.task === 'transcription'),
      summary: profiles.filter((profile) => profile.task === 'summary')
    }),
    [profiles]
  )

  function selectProfile(profile: ProviderProfileV1): void {
    setSelectedId(profile.id)
    setForm(profileToForm(profile))
    setError(null)
    setTestResult(null)
  }

  function addProfile(): void {
    setSelectedId(null)
    setForm(newProviderForm('openai-transcription'))
    setError(null)
    setTestResult(null)
  }

  function buildInput(): ProviderInput {
    const profile = formToProfile(form)
    const secrets = Object.fromEntries(
      form.secrets
        .map((pair) => [pair.key.trim(), pair.value] as const)
        .filter(([key, value]) => key.length > 0 && value.length > 0)
    )
    return { profile, secrets }
  }

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const saved = await onSave(buildInput())
      setSelectedId(saved.id)
      setForm(profileToForm(saved))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The provider profile could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  async function test(): Promise<void> {
    setBusy(true)
    setError(null)
    setTestResult(null)
    try {
      setTestResult(await onTest(buildInput()))
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The provider test failed before completing.'
      )
    } finally {
      setBusy(false)
    }
  }

  async function chooseExecutable(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const executable = await onChooseExecutable()
      if (executable) setForm((current) => ({ ...current, executable }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The executable could not be selected.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    if (!selectedProfile || !window.confirm(`Delete “${selectedProfile.name}”?`)) return
    setBusy(true)
    setError(null)
    try {
      await onDelete(selectedProfile.id)
      setSelectedId(null)
      setForm(newProviderForm('openai-transcription'))
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The provider profile could not be deleted.'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Provider settings"
      description="Configure transcription and summary endpoints. Credentials stay in the desktop process."
      size="wide"
    >
      <div className="settings-layout">
        <aside className="settings-nav" aria-label="Provider profiles">
          <Button variant="primary" size="small" onClick={addProfile}>
            <Plus size={15} /> Add provider
          </Button>
          <ProviderGroup
            title="Transcription"
            profiles={grouped.transcription}
            selectedId={selectedId ?? null}
            onSelect={selectProfile}
          />
          <ProviderGroup
            title="Summary"
            profiles={grouped.summary}
            selectedId={selectedId ?? null}
            onSelect={selectProfile}
          />
        </aside>

        <div className="settings-editor">
          <WhisperStatusCard
            status={whisperStatus}
            action={whisperAction}
            onInstall={onInstallWhisper}
            onCancelInstall={onCancelWhisperInstall}
            onStart={onStartWhisper}
            onStop={onStopWhisper}
          />

          <DiarizationStatusCard
            status={diarizationStatus}
            action={diarizationAction}
            onInstall={onInstallDiarization}
            onCancelInstall={onCancelDiarizationInstall}
            onStart={onStartDiarization}
            onStop={onStopDiarization}
          />

          {!encryptionAvailable ? (
            <InlineNotice tone="warning" icon={<KeyRound size={18} />}>
              <strong>Secure credential storage is unavailable</strong>
              <span>Secrets may remain session-only on this Linux desktop.</span>
            </InlineNotice>
          ) : null}

          <div className="settings-editor__heading">
            <div>
              <span className="eyebrow">{selectedProfile ? 'Edit provider' : 'New provider'}</span>
              <h2>{form.name || providerKindLabel(form.kind)}</h2>
            </div>
            {selectedProfile ? (
              <Button size="small" variant="danger" disabled={busy} onClick={() => void remove()}>
                <Trash2 size={15} /> Delete
              </Button>
            ) : null}
          </div>

          <form
            className="provider-form"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <div className="form-grid form-grid--two">
              <label className="field">
                <span className="field__label">Profile name</span>
                <input
                  value={form.name}
                  required
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="My provider"
                />
              </label>
              <SelectField
                label="Provider kind"
                value={form.kind}
                onValueChange={(kind) => {
                  const reset = newProviderForm(kind as ProviderKind)
                  setForm({
                    ...reset,
                    id: form.id,
                    createdAt: form.createdAt,
                    name: form.name
                  })
                  setTestResult(null)
                }}
                options={PROVIDER_KINDS.map((kind) => ({
                  value: kind,
                  label: providerKindLabel(kind)
                }))}
              />
              <label className="field">
                <span className="field__label">Model</span>
                <input
                  value={form.model}
                  required
                  readOnly={form.kind === 'managed-whisper'}
                  list="provider-model-suggestions"
                  onChange={(event) => setForm({ ...form, model: event.target.value })}
                  placeholder="Enter any model identifier"
                />
                {testResult?.models ? (
                  <datalist id="provider-model-suggestions">
                    {testResult.models.map((model) => (
                      <option value={model} key={model} />
                    ))}
                  </datalist>
                ) : null}
              </label>
              {form.kind !== 'local-cli' && form.kind !== 'managed-whisper' ? (
                <label className="field">
                  <span className="field__label">Base URL</span>
                  <input
                    value={form.baseUrl}
                    required
                    type="url"
                    onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                    placeholder="https://api.example.com/v1"
                  />
                </label>
              ) : null}
              <label className="field">
                <span className="field__label">Timeout</span>
                <div className="input-with-suffix">
                  <input
                    type="number"
                    min="1"
                    max="3600"
                    value={Math.round(Number(form.timeoutMs || 0) / 1_000)}
                    onChange={(event) =>
                      setForm({ ...form, timeoutMs: String(Number(event.target.value) * 1_000) })
                    }
                  />
                  <span>seconds</span>
                </div>
              </label>
            </div>

            <ProviderSpecificFields
              form={form}
              busy={busy}
              onChange={setForm}
              onChooseExecutable={chooseExecutable}
            />

            {form.kind !== 'managed-whisper' ? (
              <>
                <KeyValueEditor
                  title="Secrets"
                  description="Use any field names required by the adapter, such as apiKey. Existing values stay stored when left blank."
                  pairs={form.secrets}
                  secret
                  onChange={(secrets) => setForm({ ...form, secrets })}
                />
                <KeyValueEditor
                  title="Extra headers"
                  description="Headers are sent only to this profile’s configured endpoint."
                  pairs={form.headers}
                  onChange={(headers) => setForm({ ...form, headers })}
                />
              </>
            ) : null}

            {testResult ? (
              <InlineNotice
                tone={testResult.ok ? 'success' : 'danger'}
                icon={testResult.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
              >
                <strong>
                  {testResult.ok ? 'Configuration accepted' : 'Configuration rejected'}
                </strong>
                <span>{testResult.message}</span>
              </InlineNotice>
            ) : null}
            {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

            <div className="dialog-actions dialog-actions--flush">
              <Button disabled={busy} onClick={() => void test()}>
                {busy ? <LoaderCircle className="spin" size={16} /> : <TestTube2 size={16} />}
                Validate profile
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !form.name.trim() || !form.model.trim()}
              >
                {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
                Save profile
              </Button>
            </div>
          </form>
        </div>
      </div>
    </Modal>
  )
}

function ProviderSpecificFields({
  form,
  busy,
  onChange,
  onChooseExecutable
}: {
  form: ProviderFormState
  busy: boolean
  onChange(form: ProviderFormState): void
  onChooseExecutable(): Promise<void>
}): React.JSX.Element {
  if (form.kind === 'managed-whisper') {
    return (
      <section className="provider-section">
        <h3>Managed Whisper options</h3>
        <div className="form-grid form-grid--two">
          <label className="field">
            <span className="field__label">Language code</span>
            <input
              aria-label="Language code"
              value={form.language}
              onChange={(event) => onChange({ ...form, language: event.target.value })}
              placeholder="Auto detect"
            />
            <span className="field__hint">
              Leave blank for automatic detection, or use a code such as en or de.
            </span>
          </label>
          <div className="managed-whisper-facts">
            <span>Model</span>
            <strong>Whisper Large-v3</strong>
            <small>Runs locally through the managed Vulkan container.</small>
          </div>
        </div>
      </section>
    )
  }

  if (form.kind === 'elevenlabs') {
    return (
      <section className="provider-section">
        <h3>Transcription options</h3>
        <div className="form-grid form-grid--two">
          <label className="field">
            <span className="field__label">Language code</span>
            <input
              value={form.language}
              onChange={(event) => onChange({ ...form, language: event.target.value })}
              placeholder="Auto detect"
            />
          </label>
          <label className="field">
            <span className="field__label">Expected speakers</span>
            <input
              type="number"
              min="1"
              max="32"
              value={form.numSpeakers}
              onChange={(event) => onChange({ ...form, numSpeakers: event.target.value })}
              placeholder="Automatic"
            />
          </label>
          <SelectField
            label="Timestamp granularity"
            value={form.timestampGranularity}
            onValueChange={(value) =>
              onChange({ ...form, timestampGranularity: value as 'word' | 'character' })
            }
            options={[
              { value: 'word', label: 'Word' },
              { value: 'character', label: 'Character' }
            ]}
          />
          <label className="check-field check-field--boxed">
            <input
              type="checkbox"
              checked={form.diarize}
              onChange={(event) => onChange({ ...form, diarize: event.target.checked })}
            />
            <span>Identify speakers</span>
          </label>
        </div>
      </section>
    )
  }

  if (form.kind === 'openai-transcription') {
    return (
      <section className="provider-section">
        <h3>Transcription options</h3>
        <div className="form-grid form-grid--two">
          <label className="field">
            <span className="field__label">Language code</span>
            <input
              value={form.language}
              onChange={(event) => onChange({ ...form, language: event.target.value })}
              placeholder="Auto detect"
            />
          </label>
          <SelectField
            label="Response format"
            value={form.responseFormat}
            onValueChange={(value) =>
              onChange({ ...form, responseFormat: value as ProviderFormState['responseFormat'] })
            }
            options={['auto', 'json', 'text', 'verbose_json', 'diarized_json'].map((value) => ({
              value,
              label: value.replace('_', ' ')
            }))}
          />
          <label className="field">
            <span className="field__label">Maximum upload size</span>
            <div className="input-with-suffix">
              <input
                type="number"
                min="1"
                value={Math.round(Number(form.maxUploadBytes) / 1_048_576)}
                onChange={(event) =>
                  onChange({
                    ...form,
                    maxUploadBytes: String(Number(event.target.value) * 1_048_576)
                  })
                }
              />
              <span>MB</span>
            </div>
          </label>
        </div>
      </section>
    )
  }

  if (form.kind === 'local-cli') {
    return (
      <section className="provider-section">
        <h3>Local command</h3>
        <div className="form-grid form-grid--two">
          <label className="field field--wide">
            <span className="field__label">Executable</span>
            <div className="directory-picker">
              <input
                value={form.executable}
                placeholder="Choose a local executable"
                readOnly
                required
              />
              <IconButton
                label="Choose executable"
                disabled={busy}
                onClick={() => void onChooseExecutable()}
              >
                <FolderOpen size={16} />
              </IconButton>
            </div>
          </label>
          <label className="field field--wide">
            <span className="field__label">Arguments, one per line</span>
            <textarea
              rows={4}
              value={form.args}
              onChange={(event) => onChange({ ...form, args: event.target.value })}
              placeholder={'--input\n{input}'}
            />
          </label>
          <SelectField
            label="Output mode"
            value={form.outputMode}
            onValueChange={(value) => onChange({ ...form, outputMode: value as 'stdout' | 'file' })}
            options={[
              { value: 'stdout', label: 'Standard output' },
              { value: 'file', label: 'Output file' }
            ]}
          />
          <SelectField
            label="Output format"
            value={form.outputFormat}
            onValueChange={(value) =>
              onChange({ ...form, outputFormat: value as ProviderFormState['outputFormat'] })
            }
            options={[
              { value: 'canonical-v1', label: 'SessionScribe canonical v1' },
              { value: 'openai-verbose-json', label: 'OpenAI verbose JSON' },
              { value: 'elevenlabs-json', label: 'ElevenLabs JSON' },
              { value: 'text', label: 'Plain text' }
            ]}
          />
          <label className="check-field check-field--boxed">
            <input
              type="checkbox"
              checked={form.inheritEnvironment}
              onChange={(event) => onChange({ ...form, inheritEnvironment: event.target.checked })}
            />
            <span>Inherit process environment</span>
          </label>
        </div>
      </section>
    )
  }

  return (
    <section className="provider-section">
      <h3>Summary options</h3>
      <div className="form-grid form-grid--two">
        {form.kind === 'openai-compatible' ? (
          <>
            <SelectField
              label="API style"
              value={form.apiStyle}
              onValueChange={(value) =>
                onChange({ ...form, apiStyle: value as 'responses' | 'chat-completions' })
              }
              options={[
                { value: 'responses', label: 'Responses API' },
                { value: 'chat-completions', label: 'Chat Completions' }
              ]}
            />
            <SelectField
              label="Structured output"
              value={form.structuredOutput}
              onValueChange={(value) =>
                onChange({
                  ...form,
                  structuredOutput: value as ProviderFormState['structuredOutput']
                })
              }
              options={[
                { value: 'json-schema', label: 'JSON Schema' },
                { value: 'json-object', label: 'JSON object' },
                { value: 'prompt-only', label: 'Prompt only' }
              ]}
            />
          </>
        ) : (
          <label className="field">
            <span className="field__label">Maximum generated tokens</span>
            <input
              type="number"
              min="1"
              value={form.numPredict}
              onChange={(event) => onChange({ ...form, numPredict: event.target.value })}
              placeholder="Provider default"
            />
          </label>
        )}
        <label className="field">
          <span className="field__label">Context window</span>
          <div className="input-with-suffix">
            <input
              type="number"
              min="2048"
              value={form.contextWindowTokens}
              onChange={(event) => onChange({ ...form, contextWindowTokens: event.target.value })}
            />
            <span>tokens</span>
          </div>
        </label>
        {form.kind === 'openai-compatible' ? (
          <label className="field field--wide">
            <span className="field__label">Extra request body (JSON)</span>
            <textarea
              rows={4}
              value={form.extraBody}
              onChange={(event) => onChange({ ...form, extraBody: event.target.value })}
              spellCheck={false}
            />
          </label>
        ) : null}
        <label className="field field--wide">
          <span className="field__label">Meeting prompt override</span>
          <textarea
            rows={3}
            value={form.meetingPromptOverride}
            onChange={(event) => onChange({ ...form, meetingPromptOverride: event.target.value })}
            placeholder="Use the built-in grounded meeting prompt"
          />
        </label>
        <label className="field field--wide">
          <span className="field__label">Lecture prompt override</span>
          <textarea
            rows={3}
            value={form.lecturePromptOverride}
            onChange={(event) => onChange({ ...form, lecturePromptOverride: event.target.value })}
            placeholder="Use the built-in spoken-lecture prompt"
          />
        </label>
      </div>
    </section>
  )
}

function ProviderGroup({
  title,
  profiles,
  selectedId,
  onSelect
}: {
  title: string
  profiles: ProviderProfileV1[]
  selectedId: string | null
  onSelect(profile: ProviderProfileV1): void
}): React.JSX.Element {
  return (
    <section className="provider-group">
      <h3>{title}</h3>
      {profiles.map((profile) => (
        <button
          type="button"
          className={profile.id === selectedId ? 'is-selected' : ''}
          aria-label={`${profile.name} · ${profile.model}`}
          aria-pressed={profile.id === selectedId}
          onClick={() => onSelect(profile)}
          key={profile.id}
        >
          <span>{providerIcon(profile.kind)}</span>
          <span>
            <strong>{profile.name}</strong>
            <small>{profile.model}</small>
          </span>
        </button>
      ))}
      {profiles.length === 0 ? <p>No profiles</p> : null}
    </section>
  )
}

function KeyValueEditor({
  title,
  description,
  pairs,
  secret = false,
  onChange
}: {
  title: string
  description: string
  pairs: Pair[]
  secret?: boolean
  onChange(pairs: Pair[]): void
}): React.JSX.Element {
  return (
    <section className="provider-section key-value-editor">
      <div className="key-value-editor__heading">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <Button
          size="small"
          variant="ghost"
          onClick={() => onChange([...pairs, { key: '', value: '' }])}
        >
          <Plus size={15} /> Add field
        </Button>
      </div>
      {pairs.map((pair, index) => (
        <div className="key-value-row" key={index}>
          <input
            aria-label={`${title} field name ${index + 1}`}
            value={pair.key}
            placeholder={secret ? 'apiKey' : 'Header-Name'}
            onChange={(event) =>
              onChange(
                pairs.map((candidate, candidateIndex) =>
                  candidateIndex === index ? { ...candidate, key: event.target.value } : candidate
                )
              )
            }
          />
          <input
            aria-label={`${title} value ${index + 1}`}
            type={secret ? 'password' : 'text'}
            value={pair.value}
            autoComplete="off"
            placeholder={
              secret ? (pair.key ? 'Leave blank to keep stored value' : 'Secret value') : 'Value'
            }
            onChange={(event) =>
              onChange(
                pairs.map((candidate, candidateIndex) =>
                  candidateIndex === index ? { ...candidate, value: event.target.value } : candidate
                )
              )
            }
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Remove ${title.toLowerCase()} field ${index + 1}`}
            onClick={() => onChange(pairs.filter((_, candidateIndex) => candidateIndex !== index))}
          >
            <Trash2 size={15} />
          </Button>
        </div>
      ))}
    </section>
  )
}

const PROVIDER_KINDS: ProviderKind[] = [
  'managed-whisper',
  'openai-transcription',
  'elevenlabs',
  'local-cli',
  'openai-compatible',
  'ollama'
]

function providerKindLabel(kind: ProviderKind): string {
  const labels: Record<ProviderKind, string> = {
    'managed-whisper': 'Managed local Whisper',
    'openai-transcription': 'OpenAI transcription',
    elevenlabs: 'ElevenLabs transcription',
    'local-cli': 'Local CLI transcription',
    'openai-compatible': 'OpenAI-compatible summary',
    ollama: 'Ollama summary'
  }
  return labels[kind]
}

function providerIcon(kind: ProviderKind): React.JSX.Element {
  if (kind === 'local-cli' || kind === 'managed-whisper') return <Cpu size={16} />
  if (kind === 'ollama') return <Server size={16} />
  return <Cloud size={16} />
}

function newProviderForm(kind: ProviderKind): ProviderFormState {
  const now = new Date().toISOString()
  const summary = kind === 'openai-compatible' || kind === 'ollama'
  return {
    id: crypto.randomUUID(),
    createdAt: now,
    name: '',
    kind,
    model:
      kind === 'managed-whisper'
        ? 'large-v3'
        : kind === 'openai-transcription'
          ? 'gpt-4o-transcribe-diarize'
          : kind === 'elevenlabs'
            ? 'scribe_v2'
            : kind === 'openai-compatible'
              ? 'gpt-5.6-terra'
              : kind === 'ollama'
                ? 'qwen3.5:9b'
                : '',
    baseUrl:
      kind === 'ollama'
        ? 'http://127.0.0.1:11434'
        : kind === 'elevenlabs'
          ? 'https://api.elevenlabs.io/v1'
          : 'https://api.openai.com/v1',
    timeoutMs: summary ? '180000' : '3600000',
    language: '',
    diarize: true,
    numSpeakers: '',
    timestampGranularity: 'word',
    responseFormat: 'diarized_json',
    maxUploadBytes: String(25 * 1_048_576),
    executable: '',
    args: '',
    outputMode: 'stdout',
    outputFormat: 'canonical-v1',
    inheritEnvironment: false,
    apiStyle: 'responses',
    structuredOutput: 'json-schema',
    contextWindowTokens: kind === 'openai-compatible' ? '1000000' : '128000',
    extraBody: '{}',
    meetingPromptOverride: '',
    lecturePromptOverride: '',
    numPredict: '',
    headers: [],
    secrets:
      kind === 'ollama' || kind === 'local-cli' || kind === 'managed-whisper'
        ? []
        : [{ key: 'apiKey', value: '' }],
    secretRefs: {}
  }
}

function profileToForm(profile: ProviderProfileV1): ProviderFormState {
  const base = newProviderForm(profile.kind)
  const common: ProviderFormState = {
    ...base,
    id: profile.id,
    createdAt: profile.createdAt,
    name: profile.name,
    model: profile.model,
    timeoutMs: String(profile.timeoutMs),
    headers: Object.entries(profile.extraHeaders).map(([key, value]) => ({ key, value })),
    secrets:
      Object.keys(profile.secretRefs).length > 0
        ? Object.keys(profile.secretRefs).map((key) => ({ key, value: '' }))
        : base.secrets,
    secretRefs: profile.secretRefs
  }
  if ('baseUrl' in profile) common.baseUrl = profile.baseUrl

  switch (profile.kind) {
    case 'managed-whisper':
      return {
        ...common,
        language: profile.language ?? ''
      }
    case 'elevenlabs':
      return {
        ...common,
        language: profile.language ?? '',
        diarize: profile.diarize,
        numSpeakers: profile.numSpeakers ? String(profile.numSpeakers) : '',
        timestampGranularity: profile.timestampGranularity
      }
    case 'openai-transcription':
      return {
        ...common,
        language: profile.language ?? '',
        responseFormat: profile.responseFormat,
        maxUploadBytes: String(profile.maxUploadBytes)
      }
    case 'local-cli':
      return {
        ...common,
        executable: profile.executable,
        args: profile.args.join('\n'),
        outputMode: profile.outputMode,
        outputFormat: profile.outputFormat,
        inheritEnvironment: profile.inheritEnvironment
      }
    case 'openai-compatible':
      return {
        ...common,
        apiStyle: profile.apiStyle,
        structuredOutput: profile.structuredOutput,
        contextWindowTokens: String(profile.contextWindowTokens),
        extraBody: JSON.stringify(profile.extraBody, null, 2),
        meetingPromptOverride: profile.meetingPromptOverride ?? '',
        lecturePromptOverride: profile.lecturePromptOverride ?? ''
      }
    case 'ollama':
      return {
        ...common,
        contextWindowTokens: String(profile.contextWindowTokens),
        numPredict: profile.numPredict ? String(profile.numPredict) : '',
        meetingPromptOverride: profile.meetingPromptOverride ?? '',
        lecturePromptOverride: profile.lecturePromptOverride ?? ''
      }
  }
}

function formToProfile(form: ProviderFormState): ProviderProfileV1 {
  const now = new Date().toISOString()
  const secretRefs = Object.fromEntries(
    form.secrets
      .map((pair) => pair.key.trim())
      .filter(Boolean)
      .map((key) => [key, form.secretRefs[key] ?? key])
  )
  const common = {
    id: form.id,
    name: form.name.trim(),
    model: form.model.trim(),
    timeoutMs: Number(form.timeoutMs),
    secretRefs,
    extraHeaders: Object.fromEntries(
      form.headers.filter((pair) => pair.key.trim()).map((pair) => [pair.key.trim(), pair.value])
    ),
    createdAt: form.createdAt,
    updatedAt: now
  }

  switch (form.kind) {
    case 'managed-whisper':
      return {
        ...common,
        task: 'transcription',
        kind: 'managed-whisper',
        model: 'large-v3',
        secretRefs: {},
        extraHeaders: {},
        language: form.language.trim() || null
      }
    case 'elevenlabs':
      return {
        ...common,
        task: 'transcription',
        kind: 'elevenlabs',
        baseUrl: form.baseUrl,
        language: form.language.trim() || null,
        diarize: form.diarize,
        numSpeakers: form.numSpeakers ? Number(form.numSpeakers) : null,
        timestampGranularity: form.timestampGranularity
      }
    case 'openai-transcription':
      return {
        ...common,
        task: 'transcription',
        kind: 'openai-transcription',
        baseUrl: form.baseUrl,
        language: form.language.trim() || null,
        responseFormat: form.responseFormat,
        maxUploadBytes: Number(form.maxUploadBytes)
      }
    case 'local-cli':
      return {
        ...common,
        task: 'transcription',
        kind: 'local-cli',
        executable: form.executable.trim(),
        args: form.args
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        outputMode: form.outputMode,
        outputFormat: form.outputFormat,
        inheritEnvironment: form.inheritEnvironment
      }
    case 'openai-compatible': {
      const parsedBody: unknown = JSON.parse(form.extraBody || '{}')
      if (!parsedBody || Array.isArray(parsedBody) || typeof parsedBody !== 'object')
        throw new Error('Extra request body must be a JSON object.')
      return {
        ...common,
        task: 'summary',
        kind: 'openai-compatible',
        baseUrl: form.baseUrl,
        apiStyle: form.apiStyle,
        structuredOutput: form.structuredOutput,
        contextWindowTokens: Number(form.contextWindowTokens),
        extraBody: parsedBody as Record<string, unknown>,
        meetingPromptOverride: form.meetingPromptOverride.trim() || null,
        lecturePromptOverride: form.lecturePromptOverride.trim() || null
      }
    }
    case 'ollama':
      return {
        ...common,
        task: 'summary',
        kind: 'ollama',
        baseUrl: form.baseUrl,
        contextWindowTokens: Number(form.contextWindowTokens),
        numPredict: form.numPredict ? Number(form.numPredict) : null,
        meetingPromptOverride: form.meetingPromptOverride.trim() || null,
        lecturePromptOverride: form.lecturePromptOverride.trim() || null
      }
  }
}
