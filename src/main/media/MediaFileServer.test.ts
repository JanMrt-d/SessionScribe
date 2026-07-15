import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { mediaContentType, mediaFileResponse, parseByteRange } from './MediaFileServer'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('parseByteRange', () => {
  it('serves the full body when no Range header is present', () => {
    expect(parseByteRange(null, 100)).toBeNull()
  })

  it('parses bounded, open-ended, and suffix ranges', () => {
    expect(parseByteRange('bytes=0-49', 100)).toEqual({ start: 0, end: 49 })
    expect(parseByteRange('bytes=50-', 100)).toEqual({ start: 50, end: 99 })
    expect(parseByteRange('bytes=-30', 100)).toEqual({ start: 70, end: 99 })
  })

  it('clamps an end beyond the file and a suffix longer than the file', () => {
    expect(parseByteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
    expect(parseByteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
  })

  it('rejects unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=20-10', 100)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=-0', 100)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable')
  })

  it('falls back to the full body for foreign or multi-range headers', () => {
    expect(parseByteRange('bytes=0-10,20-30', 100)).toBeNull()
    expect(parseByteRange('items=0-10', 100)).toBeNull()
    expect(parseByteRange('bytes=-', 100)).toBeNull()
  })
})

describe('mediaContentType', () => {
  it('maps known media extensions and falls back to octet-stream', () => {
    expect(mediaContentType('/tmp/playback.mp4')).toBe('video/mp4')
    expect(mediaContentType('/tmp/RECORDING.MKV')).toBe('video/x-matroska')
    expect(mediaContentType('/tmp/audio.wav')).toBe('audio/wav')
    expect(mediaContentType('/tmp/unknown.xyz')).toBe('application/octet-stream')
  })
})

describe('mediaFileResponse', () => {
  it('answers a Range request with 206 Partial Content and the exact bytes', async () => {
    const path = await fixtureFile('playback.mp4', '0123456789')

    const response = await mediaFileResponse(path, 'bytes=2-5')

    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10')
    expect(response.headers.get('Content-Length')).toBe('4')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('Content-Type')).toBe('video/mp4')
    expect(await response.text()).toBe('2345')
  })

  it('answers an open-ended Range request used for forward seeks', async () => {
    const path = await fixtureFile('playback.mp4', '0123456789')

    const response = await mediaFileResponse(path, 'bytes=7-')

    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 7-9/10')
    expect(await response.text()).toBe('789')
  })

  it('serves the whole file with Accept-Ranges when no Range is requested', async () => {
    const path = await fixtureFile('recording.mkv', '0123456789')

    const response = await mediaFileResponse(path, null)

    expect(response.status).toBe(200)
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('Content-Length')).toBe('10')
    expect(response.headers.get('Content-Type')).toBe('video/x-matroska')
    expect(await response.text()).toBe('0123456789')
  })

  it('answers an unsatisfiable Range with 416 and the file size', async () => {
    const path = await fixtureFile('playback.mp4', '0123456789')

    const response = await mediaFileResponse(path, 'bytes=10-')

    expect(response.status).toBe(416)
    expect(response.headers.get('Content-Range')).toBe('bytes */10')
  })
})

async function fixtureFile(name: string, content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'media-file-server-'))
  temporaryDirectories.push(directory)
  const path = join(directory, name)
  await writeFile(path, content)
  return path
}
