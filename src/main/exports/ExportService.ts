import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExportRequest, SummaryDocumentV1, TranscriptDocumentV1 } from '@shared/index'
import type { AppDatabase } from '../persistence/Database'

export class ExportService {
  constructor(private readonly database: AppDatabase) {}

  async write(request: ExportRequest): Promise<string[]> {
    const session = this.database.getSession(request.sessionId)
    if (!session) throw new Error('Session not found')
    const transcript = this.database.getTranscript(request.sessionId)
    const summary = this.database.getSummary(request.sessionId)
    if (!transcript) throw new Error('A transcript is required before exporting')
    await mkdir(request.directory, { recursive: true })
    const stem = sanitizeFileName(session.title)
    const paths: string[] = []
    for (const format of [...new Set(request.formats)]) {
      const extension = format === 'markdown' ? 'md' : format
      const path = join(request.directory, `${stem}.${extension}`)
      const content = render(format, transcript, summary)
      await atomicWrite(path, content)
      paths.push(path)
    }
    return paths
  }
}

function render(
  format: ExportRequest['formats'][number],
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
  }
}

function markdown(transcript: TranscriptDocumentV1, summary: SummaryDocumentV1 | null): string {
  const lines: string[] = [`# ${summary?.title || 'Session notes'}`, '']
  if (summary) {
    lines.push(summary.overview, '')
    if (summary.mode === 'meeting') {
      addGrounded(lines, 'Decisions', summary.decisions)
      lines.push('## Action items', '')
      summary.actionItems.forEach((item) => {
        const owner = item.assignee ?? 'Unassigned'
        const due = item.dueText ?? item.dueAt ?? 'No due date'
        lines.push(`- [ ] ${item.task} - **${owner}** - ${due}`)
      })
      lines.push('')
      addGrounded(lines, 'Open questions', summary.openQuestions)
      addGrounded(lines, 'Risks', summary.risks)
    } else {
      addGrounded(lines, 'Key lessons', summary.keyLessons)
      addGrounded(lines, 'Outline', summary.outline)
      lines.push('## Concepts', '')
      summary.concepts.forEach((concept) =>
        lines.push(`- **${concept.name}:** ${concept.definition}`)
      )
      lines.push('', '## Review questions', '')
      summary.reviewQuestions.forEach((question) => lines.push(`- ${question}`))
      lines.push('')
    }
  }
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

function addGrounded(
  lines: string[],
  title: string,
  items: Array<{ text: string; evidence: Array<{ startMs: number }> }>
): void {
  lines.push(`## ${title}`, '')
  items.forEach((item) => {
    const timestamp = item.evidence[0] ? ` (${vttTime(item.evidence[0].startMs)})` : ''
    lines.push(`- ${item.text}${timestamp}`)
  })
  lines.push('')
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

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}
