import { useEffect, useState } from 'react'
import { CheckCircle2, FileJson, FileText, FolderOpen, LoaderCircle, Subtitles } from 'lucide-react'
import type { ExportRequest } from '@shared/ipc'
import { Button, InlineNotice, Modal } from './ui'

type ExportFormat = ExportRequest['formats'][number]

interface ExportDialogProps {
  open: boolean
  sessionId: string
  transcriptAvailable: boolean
  summaryAvailable: boolean
  onOpenChange(open: boolean): void
  onChooseDirectory(): Promise<string | null>
  onWrite(request: ExportRequest): Promise<string[]>
}

const FORMAT_OPTIONS: Array<{
  value: ExportFormat
  label: string
  description: string
  requires: 'summary' | 'transcript' | 'either'
  icon: React.ReactNode
}> = [
  {
    value: 'markdown',
    label: 'Markdown',
    description: 'Readable summary and transcript notes',
    requires: 'either',
    icon: <FileText size={18} />
  },
  {
    value: 'text',
    label: 'Plain text',
    description: 'Speaker-labeled transcript only, smallest file',
    requires: 'transcript',
    icon: <FileText size={18} />
  },
  {
    value: 'json',
    label: 'Structured JSON',
    description: 'Complete machine-readable session data',
    requires: 'either',
    icon: <FileJson size={18} />
  },
  {
    value: 'srt',
    label: 'SRT subtitles',
    description: 'Timestamped transcript for video players',
    requires: 'transcript',
    icon: <Subtitles size={18} />
  },
  {
    value: 'vtt',
    label: 'WebVTT subtitles',
    description: 'Web-compatible timestamped transcript',
    requires: 'transcript',
    icon: <Subtitles size={18} />
  }
]

export function ExportDialog({
  open,
  sessionId,
  transcriptAvailable,
  summaryAvailable,
  onOpenChange,
  onChooseDirectory,
  onWrite
}: ExportDialogProps): React.JSX.Element {
  const [directory, setDirectory] = useState('')
  const [formats, setFormats] = useState<ExportFormat[]>(['markdown', 'json'])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [written, setWritten] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    setError(null)
    setWritten([])
  }, [open])

  async function chooseDirectory(): Promise<void> {
    const selected = await onChooseDirectory()
    if (selected) setDirectory(selected)
  }

  async function write(): Promise<void> {
    if (!directory || formats.length === 0) return
    setBusy(true)
    setError(null)
    setWritten([])
    try {
      setWritten(await onWrite({ sessionId, directory, formats }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The session could not be exported.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Export session"
      description="Choose one or more portable formats."
    >
      <div className="dialog-form">
        <div className="export-formats">
          {FORMAT_OPTIONS.map((option) => {
            const disabled =
              (option.requires === 'transcript' && !transcriptAvailable) ||
              (option.requires === 'summary' && !summaryAvailable) ||
              (option.requires === 'either' && !transcriptAvailable && !summaryAvailable)
            return (
              <label className={disabled ? 'is-disabled' : ''} key={option.value}>
                <input
                  type="checkbox"
                  checked={formats.includes(option.value)}
                  disabled={disabled}
                  onChange={(event) =>
                    setFormats((current) =>
                      event.target.checked
                        ? [...current, option.value]
                        : current.filter((format) => format !== option.value)
                    )
                  }
                />
                <span className="export-formats__icon">{option.icon}</span>
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            )
          })}
        </div>

        <label className="field">
          <span className="field__label">Destination folder</span>
          <div className="directory-picker">
            <input value={directory} readOnly placeholder="Choose a folder" />
            <Button onClick={() => void chooseDirectory()}>
              <FolderOpen size={16} /> Browse
            </Button>
          </div>
        </label>

        {written.length > 0 ? (
          <InlineNotice tone="success" icon={<CheckCircle2 size={18} />}>
            <strong>Export complete</strong>
            <span>
              {written.length} {written.length === 1 ? 'file' : 'files'} written to {directory}
            </span>
          </InlineNotice>
        ) : null}
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      </div>
      <div className="dialog-actions">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Close
        </Button>
        <Button
          variant="primary"
          disabled={busy || !directory || formats.length === 0}
          onClick={() => void write()}
        >
          {busy ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />}
          Export selected
        </Button>
      </div>
    </Modal>
  )
}
