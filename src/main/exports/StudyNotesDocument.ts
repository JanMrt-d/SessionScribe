import type { LectureSummaryV2, MeetingSummaryV1, SummaryDocumentV1 } from '@shared/summary'
import type { EvidenceRef } from '@shared/transcript'

/**
 * Study notes are built once as blocks and rendered to Markdown and to print
 * HTML from that shared shape, so the two exports cannot drift apart. Neither
 * carries the transcript: the markdown export already does that, and at lecture
 * length it buries the notes it is supposed to support.
 */
type NotesBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'bullets'; items: BulletItem[] }
  | { kind: 'definitions'; items: DefinitionItem[] }
  | { kind: 'questions'; items: QuestionItem[]; answerLabel: string }

interface BulletItem {
  text: string
  timestamp: string | null
}

interface DefinitionItem {
  term: string
  description: string
  timestamp: string | null
}

interface QuestionItem {
  question: string
  answer: string
  timestamp: string | null
}

interface NotesLabels {
  overview: string
  emphasis: string
  openQuestions: string
  glossary: string
  studyQuestions: string
  answer: string
  from: string
  topics: string
  decisions: string
  actionItems: string
  risks: string
  unassigned: string
  noDueDate: string
}

const ENGLISH: NotesLabels = {
  overview: 'Overview',
  emphasis: 'Emphasized',
  openQuestions: 'Open questions',
  glossary: 'Key terms',
  studyQuestions: 'Study questions',
  answer: 'Answer',
  from: 'from',
  topics: 'Topics',
  decisions: 'Decisions',
  actionItems: 'Action items',
  risks: 'Risks',
  unassigned: 'Unassigned',
  noDueDate: 'No due date'
}

const GERMAN: NotesLabels = {
  overview: 'Gesamtzusammenfassung',
  emphasis: 'Besonders hervorgehoben',
  openQuestions: 'Offene Fragen',
  glossary: 'Begriffe',
  studyQuestions: 'Lernfragen',
  answer: 'Antwort',
  from: 'ab',
  topics: 'Themen',
  decisions: 'Entscheidungen',
  actionItems: 'Aufgaben',
  risks: 'Risiken',
  unassigned: 'Nicht zugewiesen',
  noDueDate: 'Kein Datum'
}

function labelsFor(summary: SummaryDocumentV1): NotesLabels {
  const language = summary.mode === 'lecture' ? summary.language : ''
  return language.trim().toLowerCase().startsWith('de') ? GERMAN : ENGLISH
}

export function studyNotesMarkdown(summary: SummaryDocumentV1): string {
  return `${blocksFor(summary).map(markdownBlock).join('\n\n').trim()}\n`
}

export function studyNotesHtml(summary: SummaryDocumentV1): string {
  const language = summary.mode === 'lecture' && summary.language ? summary.language : 'en'
  return `<!doctype html>
<html lang="${escapeHtml(language)}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(summary.title || 'Study notes')}</title>
<style>${PRINT_STYLES}</style>
</head>
<body>
${blocksFor(summary).map(htmlBlock).join('\n')}
</body>
</html>
`
}

function blocksFor(summary: SummaryDocumentV1): NotesBlock[] {
  const labels = labelsFor(summary)
  const blocks: NotesBlock[] = [{ kind: 'heading', level: 1, text: summary.title || 'Study notes' }]
  if (summary.overview.trim()) {
    blocks.push({ kind: 'heading', level: 2, text: labels.overview })
    blocks.push({ kind: 'paragraph', text: summary.overview.trim() })
  }
  blocks.push(
    ...(summary.mode === 'lecture'
      ? lectureBlocks(summary, labels)
      : meetingBlocks(summary, labels))
  )
  return blocks
}

function lectureBlocks(summary: LectureSummaryV2, labels: NotesLabels): NotesBlock[] {
  return summary.chapters.flatMap((chapter, index) => {
    const number = index + 1
    const blocks: NotesBlock[] = [
      { kind: 'heading', level: 2, text: `${number}. ${chapter.title}` }
    ]
    if (chapter.startMs > 0) {
      blocks.push({ kind: 'note', text: `${labels.from} ${timestamp(chapter.startMs)}` })
    }
    if (chapter.summary.trim()) {
      blocks.push({ kind: 'paragraph', text: chapter.summary.trim() })
    }
    chapter.subtopics.forEach((subtopic, subtopicIndex) => {
      blocks.push({
        kind: 'heading',
        level: 3,
        text: `${number}.${subtopicIndex + 1} ${subtopic.title}`
      })
      if (subtopic.keyPoints.length > 0) {
        blocks.push({ kind: 'bullets', items: subtopic.keyPoints.map(bulletItem) })
      }
    })
    blocks.push(...groundedSection(labels.emphasis, chapter.emphasis))
    blocks.push(...groundedSection(labels.openQuestions, chapter.openQuestions))
    if (chapter.glossary.length > 0) {
      blocks.push({ kind: 'heading', level: 3, text: labels.glossary })
      blocks.push({
        kind: 'definitions',
        items: chapter.glossary.map((entry) => ({
          term: entry.name,
          description: entry.definition,
          timestamp: firstTimestamp(entry.evidence)
        }))
      })
    }
    if (chapter.studyQuestions.length > 0) {
      blocks.push({ kind: 'heading', level: 3, text: labels.studyQuestions })
      blocks.push({
        kind: 'questions',
        answerLabel: labels.answer,
        items: chapter.studyQuestions.map((entry) => ({
          question: entry.question,
          answer: entry.answer,
          timestamp: firstTimestamp(entry.evidence)
        }))
      })
    }
    return blocks
  })
}

function meetingBlocks(summary: MeetingSummaryV1, labels: NotesLabels): NotesBlock[] {
  const blocks: NotesBlock[] = [
    ...groundedSection(labels.topics, summary.topics, 2),
    ...groundedSection(labels.decisions, summary.decisions, 2)
  ]
  if (summary.actionItems.length > 0) {
    blocks.push({ kind: 'heading', level: 2, text: labels.actionItems })
    blocks.push({
      kind: 'bullets',
      items: summary.actionItems.map((item) => ({
        text: `${item.task} — ${item.assignee ?? labels.unassigned} — ${item.dueText ?? item.dueAt ?? labels.noDueDate}`,
        timestamp: firstTimestamp(item.evidence)
      }))
    })
  }
  blocks.push(...groundedSection(labels.openQuestions, summary.openQuestions, 2))
  blocks.push(...groundedSection(labels.risks, summary.risks, 2))
  return blocks
}

function groundedSection(
  title: string,
  items: readonly { text: string; evidence: EvidenceRef[] }[],
  level: 2 | 3 = 3
): NotesBlock[] {
  if (items.length === 0) return []
  return [
    { kind: 'heading', level, text: title },
    { kind: 'bullets', items: items.map(bulletItem) }
  ]
}

function bulletItem(item: { text: string; evidence: EvidenceRef[] }): BulletItem {
  return { text: item.text, timestamp: firstTimestamp(item.evidence) }
}

function firstTimestamp(evidence: readonly EvidenceRef[]): string | null {
  const earliest = evidence.reduce<number | null>(
    (lowest, reference) =>
      lowest === null ? reference.startMs : Math.min(lowest, reference.startMs),
    null
  )
  return earliest === null ? null : timestamp(earliest)
}

function markdownBlock(block: NotesBlock): string {
  switch (block.kind) {
    case 'heading':
      return `${'#'.repeat(block.level)} ${block.text}`
    case 'paragraph':
      return block.text
    case 'note':
      return `_${block.text}_`
    case 'bullets':
      return block.items.map((item) => `- ${item.text}${suffix(item.timestamp)}`).join('\n')
    case 'definitions':
      return block.items
        .map((item) => `- **${item.term}** — ${item.description}${suffix(item.timestamp)}`)
        .join('\n')
    case 'questions':
      // Collapsed answers keep the file usable for self-testing; the PDF below
      // prints them expanded because a reader cannot click a printed page.
      return block.items
        .map(
          (item, index) =>
            `${index + 1}. ${item.question}\n\n   <details><summary>${block.answerLabel}</summary>\n\n   ${item.answer}${suffix(item.timestamp)}\n\n   </details>`
        )
        .join('\n\n')
  }
}

function suffix(stamp: string | null): string {
  return stamp ? ` (${stamp})` : ''
}

function htmlBlock(block: NotesBlock): string {
  switch (block.kind) {
    case 'heading':
      return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`
    case 'paragraph':
      return `<p>${escapeHtml(block.text)}</p>`
    case 'note':
      return `<p class="note">${escapeHtml(block.text)}</p>`
    case 'bullets':
      return `<ul>\n${block.items
        .map((item) => `<li>${escapeHtml(item.text)}${htmlStamp(item.timestamp)}</li>`)
        .join('\n')}\n</ul>`
    case 'definitions':
      return `<dl>\n${block.items
        .map(
          (item) =>
            `<dt>${escapeHtml(item.term)}</dt><dd>${escapeHtml(item.description)}${htmlStamp(item.timestamp)}</dd>`
        )
        .join('\n')}\n</dl>`
    case 'questions':
      return `<ol class="questions">\n${block.items
        .map(
          (item) =>
            `<li><p class="question">${escapeHtml(item.question)}</p><p class="answer">${escapeHtml(item.answer)}${htmlStamp(item.timestamp)}</p></li>`
        )
        .join('\n')}\n</ol>`
  }
}

function htmlStamp(stamp: string | null): string {
  return stamp ? ` <span class="stamp">${escapeHtml(stamp)}</span>` : ''
}

function timestamp(ms: number): string {
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1_000)
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const PRINT_STYLES = `
@page { size: A4; margin: 18mm 16mm; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 10.5pt;
  line-height: 1.55;
  color: #16191c;
}
h1 { font-size: 21pt; margin: 0 0 18px; }
h2 {
  font-size: 14pt;
  margin: 26px 0 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid #d3d8dd;
  break-after: avoid;
}
h3 { font-size: 11.5pt; margin: 16px 0 6px; break-after: avoid; }
p { margin: 0 0 9px; }
p.note { color: #6b7480; font-size: 9pt; margin-top: -4px; }
ul, ol, dl { margin: 0 0 10px; padding-left: 20px; }
li { margin-bottom: 5px; break-inside: avoid; }
dl { padding-left: 0; }
dt { font-weight: 600; }
dd { margin: 0 0 7px; padding-left: 14px; }
.stamp { color: #6b7480; font-size: 8.5pt; white-space: nowrap; }
ol.questions > li { margin-bottom: 10px; }
p.question { font-weight: 600; margin-bottom: 3px; }
p.answer { margin: 0; padding-left: 12px; border-left: 2px solid #d3d8dd; color: #333b44; }
`
