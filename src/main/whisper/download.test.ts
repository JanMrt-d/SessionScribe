import { createHash } from 'node:crypto'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WhisperDownloadAsset } from './constants'
import { downloadVerifiedAsset, verifyFile, type WhisperFetch } from './download'

const temporaryDirectories: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('downloadVerifiedAsset', () => {
  it('resumes a partial file, verifies it, and atomically promotes it', async () => {
    const directory = await temporaryDirectory()
    const contents = Buffer.from('verified model contents')
    const asset = testAsset(contents)
    await writeFile(join(directory, `${asset.fileName}.part`), contents.subarray(0, 9))
    const fetch = vi.fn<WhisperFetch>(async (_url, init) => {
      expect(new Headers(init.headers).get('range')).toBe('bytes=9-')
      expect(new Headers(init.headers).get('accept-encoding')).toBe('identity')
      return new Response(contents.subarray(9), {
        status: 206,
        headers: { 'content-range': `bytes 9-${contents.length - 1}/${contents.length}` }
      })
    })
    const progress = vi.fn()

    const result = await downloadVerifiedAsset({
      asset,
      directory,
      fetch,
      signal: new AbortController().signal,
      onProgress: progress
    })

    expect(result).toBe(join(directory, asset.fileName))
    await expect(readFile(result)).resolves.toEqual(contents)
    await expect(stat(`${result}.part`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(progress).toHaveBeenLastCalledWith(contents.length, contents.length)
  })

  it('restarts from zero when the server ignores the range request', async () => {
    const directory = await temporaryDirectory()
    const contents = Buffer.from('replacement bytes')
    const asset = testAsset(contents)
    await writeFile(join(directory, `${asset.fileName}.part`), Buffer.from('stale'))
    const fetch = vi.fn<WhisperFetch>(async () => new Response(contents, { status: 200 }))

    const result = await downloadVerifiedAsset({
      asset,
      directory,
      fetch,
      signal: new AbortController().signal,
      onProgress: vi.fn()
    })

    await expect(readFile(result)).resolves.toEqual(contents)
  })

  it('rejects checksum mismatches without accepting a final file', async () => {
    const directory = await temporaryDirectory()
    const contents = Buffer.from('downloaded bytes')
    const asset = { ...testAsset(contents), sha256: '0'.repeat(64) }

    await expect(
      downloadVerifiedAsset({
        asset,
        directory,
        fetch: async () => new Response(contents),
        signal: new AbortController().signal,
        onProgress: vi.fn()
      })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await expect(stat(join(directory, asset.fileName))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(directory, `${asset.fileName}.part`))).resolves.toMatchObject({
      size: contents.length
    })
  })

  it('keeps a resumable partial file when cancellation interrupts the stream', async () => {
    const directory = await temporaryDirectory()
    const firstChunkBytes = 1_024 * 1_024
    const contents = Buffer.alloc(firstChunkBytes * 2, 7)
    const asset = testAsset(contents)
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      start(target) {
        target.enqueue(contents.subarray(0, firstChunkBytes))
        target.enqueue(contents.subarray(firstChunkBytes))
        target.close()
      }
    })

    await expect(
      downloadVerifiedAsset({
        asset,
        directory,
        fetch: async () => new Response(stream),
        signal: controller.signal,
        onProgress: (completedBytes) => {
          if (completedBytes === firstChunkBytes) controller.abort()
        }
      })
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(stat(join(directory, asset.fileName))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(directory, `${asset.fileName}.part`))).resolves.toMatchObject({
      size: firstChunkBytes
    })
  })

  it('short-circuits an already verified final file without fetching', async () => {
    const directory = await temporaryDirectory()
    const contents = Buffer.from('already present')
    const asset = testAsset(contents)
    const path = join(directory, asset.fileName)
    await writeFile(path, contents)
    const fetch = vi.fn<WhisperFetch>()

    await expect(
      downloadVerifiedAsset({
        asset,
        directory,
        fetch,
        signal: new AbortController().signal,
        onProgress: vi.fn()
      })
    ).resolves.toBe(path)
    expect(fetch).not.toHaveBeenCalled()
    await expect(verifyFile(path, asset)).resolves.toBe(true)
  })
})

function testAsset(contents: Buffer): WhisperDownloadAsset {
  return {
    fileName: 'asset.bin',
    url: 'https://fixtures.invalid/asset.bin',
    size: contents.length,
    sha256: createHash('sha256').update(contents).digest('hex')
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sessionscribe-whisper-download-'))
  temporaryDirectories.push(directory)
  return directory
}
