import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExportRequest, SummaryDocumentV1, TranscriptDocumentV1 } from '@shared/index'
import type { AppDatabase } from '../persistence/Database'
import { studyNotesHtml, studyNotesMarkdown } from './StudyNotesDocument'

export interface PdfRenderer {
  render(html: string): Promise<Uint8Array>
}

type ExportFormat = ExportRequest['formats'][number]
type TextExportFormat = Exclude<ExportFormat, 'notes' | 'pdf'>

const SUMMARY_REQUIRED = 'A summary is required before exporting study notes'

export class ExportService {
  constructor(
    private readonly database: AppDatabase,
    private readonly pdfRenderer: PdfRenderer | null = null
  ) {}

  async write(request: ExportRequest): Promise<string[]> {
    const session = this.database.getSession(request.sessionId)
    if (!session) throw new Error('Session not found')
    const transcript = this.database.getTranscript(request.sessionId)
    const summary = this.database.getSummary(request.sessionId)
    if (!transcript) throw new Error('A transcript is required before exporting')
    const formats = [...new Set(request.formats)]
    // Checked before the first write so that a missing summary cannot leave a
    // half-finished set of files behind.
    if (!summary && formats.some(needsSummary)) throw new Error(SUMMARY_REQUIRED)
    await mkdir(request.directory, { recursive: true })
    const stem = sanitizeFileName(session.title)
    const paths: string[] = []
    for (const format of formats) {
      const path = join(request.directory, `${stem}.${extensionFor(format)}`)
      await atomicWrite(path, await this.content(format, transcript, summary))
      paths.push(path)
    }
    return paths
  }

  private async content(
    format: ExportFormat,
    transcript: TranscriptDocumentV1,
    summary: SummaryDocumentV1 | null
  ): Promise<string | Uint8Array> {
    if (!needsSummary(format)) return render(format, transcript, summary)
    if (!summary) throw new Error(SUMMARY_REQUIRED)
    if (format === 'notes') return studyNotesMarkdown(summary)
    if (!this.pdfRenderer) throw new Error('PDF export is not available in this build')
    return this.pdfRenderer.render(studyNotesHtml(summary))
  }
}

function needsSummary(format: ExportFormat): format is 'notes' | 'pdf' {
  return format === 'notes' || format === 'pdf'
}

function extensionFor(format: ExportFormat): string {
  switch (format) {
    case 'markdown':
      return 'md'
    // Distinct from the markdown export, which also carries the transcript and
    // would otherwise claim the same filename.
    case 'notes':
      return 'notes.md'
    case 'text':
      return 'txt'
    default:
      return format
  }
}

function render(
  format: TextExportFormat,
  transcript: TranscriptDocumentV1,
  summary: SummaryDocumentV1 | null
): string {
  switch (format) {
    case 'json':
      return `${JSON.stringify({ schemaVersion: 1, transcript, summary }, null, 2)}\n`
    case 'srt':
      return transcript.utterances
        .map(
          (utterance, index) =>
            `${index + 1}\n${srtTime(utterance.startMs)} --> ${srtTime(utterance.endMs)}\n${utterance.text.trim()}\n`
        )
        .join('\n')
    case 'vtt':
      return `WEBVTT\n\n${transcript.utterances
        .map(
          (utterance) =>
            `${vttTime(utterance.startMs)} --> ${vttTime(utterance.endMs)}\n${utterance.text.trim()}\n`
        )
        .join('\n')}`
    case 'markdown':
      return markdown(transcript, summary)
    case 'text':
      return plainText(transcript)
  }
}

export function plainText(transcript: TranscriptDocumentV1): string {
  const speakers = new Map(
    transcript.speakers.map((speaker) => [speaker.id, speaker.displayName ?? speaker.label])
  )
  return `${transcript.utterances
    .map((utterance) => {
      const speaker = utterance.speakerId ? speakers.get(utterance.speakerId) : null
      return `${speaker ? `${speaker}: ` : ''}${utterance.text.trim()}`
    })
    .join('\n\n')
    .trim()}\n`
}

function markdown(transcript: TranscriptDocumentV1, summary: SummaryDocumentV1 | null): string {
  // The notes half is shared with the study-notes export so the two cannot
  // describe the same session differently; this format then appends the
  // transcript that the study notes deliberately leave out.
  const lines: string[] = summary
    ? [studyNotesMarkdown(summary).trimEnd(), '']
    : ['# Session notes', '']
  lines.push('## Transcript', '')
  const speakers = new Map(
    transcript.speakers.map((speaker) => [speaker.id, speaker.displayName ?? speaker.label])
  )
  transcript.utterances.forEach((utterance) => {
    const speaker = utterance.speakerId ? speakers.get(utterance.speakerId) : null
    lines.push(
      `**${vttTime(utterance.startMs)}${speaker ? ` - ${speaker}` : ''}**  `,
      utterance.text,
      ''
    )
  })
  return `${lines.join('\n').trim()}\n`
}

function sanitizeFileName(value: string): string {
  const result = [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || '<>:"/\\|?*'.includes(character) ? '-' : character
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return (result || 'session').slice(0, 120)
}

function srtTime(ms: number): string {
  return clock(ms).replace('.', ',')
}

function vttTime(ms: number): string {
  return clock(ms)
}

function clock(ms: number): string {
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1_000)
  const milliseconds = ms % 1_000
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${String(milliseconds).padStart(3, '0')}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(
    temporary,
    content,
    typeof content === 'string' ? { encoding: 'utf8', mode: 0o600 } : { mode: 0o600 }
  )
  await rename(temporary, path)
}
