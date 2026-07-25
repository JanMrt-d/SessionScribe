import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'

/**
 * Serves local media files with HTTP byte-range support for the custom media
 * protocol. Electron's net.fetch ignores Range headers for file:// URLs, which
 * breaks <video> seeking beyond the buffered data: Chromium only seeks forward
 * when the source answers 206 Partial Content.
 */

const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav'
}

export interface ByteRange {
  readonly start: number
  readonly end: number
}

/**
 * Parses a single-range `Range: bytes=…` header against a file size.
 * Returns the inclusive range to serve, `null` for a full-body response
 * (absent or syntactically foreign header), or `'unsatisfiable'` when the
 * header is valid range syntax that cannot be satisfied (RFC 9110 → 416).
 * Multi-range requests fall back to a full response; Chromium's media stack
 * only ever sends single ranges.
 */
export function parseByteRange(
  header: string | null,
  size: number
): ByteRange | null | 'unsatisfiable' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, startText, endText] = match
  if (startText === '' && endText === '') return null
  if (size === 0) return 'unsatisfiable'

  if (startText === '') {
    // Suffix range: last N bytes.
    const suffixLength = Number(endText)
    if (suffixLength === 0) return 'unsatisfiable'
    const start = Math.max(0, size - suffixLength)
    return { start, end: size - 1 }
  }

  const start = Number(startText)
  if (start >= size) return 'unsatisfiable'
  const end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

export function mediaContentType(path: string): string {
  return MEDIA_CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export async function mediaFileResponse(
  path: string,
  rangeHeader: string | null
): Promise<Response> {
  const stats = await stat(path)
  const range = parseByteRange(rangeHeader, stats.size)
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${stats.size}` }
    })
  }

  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Type': mediaContentType(path)
  })
  if (!range) {
    headers.set('Content-Length', String(stats.size))
    const body = stats.size === 0 ? null : streamFile(path)
    return new Response(body, { status: 200, headers })
  }

  headers.set('Content-Length', String(range.end - range.start + 1))
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${stats.size}`)
  return new Response(streamFile(path, range), { status: 206, headers })
}

function streamFile(path: string, range?: ByteRange): ReadableStream {
  const stream = range
    ? createReadStream(path, { start: range.start, end: range.end })
    : createReadStream(path)
  return Readable.toWeb(stream) as ReadableStream
}
