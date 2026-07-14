import { createHash } from 'node:crypto'
import { open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { WhisperDownloadAsset } from './constants'
import { ManagedWhisperError, throwIfWhisperCancelled } from './errors'

const HASH_BUFFER_BYTES = 1024 * 1024
const PROGRESS_INTERVAL_BYTES = 1024 * 1024

export type WhisperFetch = (url: string, init: RequestInit) => Promise<Response>

export interface DownloadVerifiedAssetOptions {
  readonly asset: WhisperDownloadAsset
  readonly directory: string
  readonly fetch: WhisperFetch
  readonly signal: AbortSignal
  readonly onProgress: (completedBytes: number, totalBytes: number) => void
}

export async function downloadVerifiedAsset(
  options: DownloadVerifiedAssetOptions
): Promise<string> {
  if (new URL(options.asset.url).protocol !== 'https:') {
    throw new ManagedWhisperError(
      'DOWNLOAD_FAILED',
      'Whisper models must be downloaded over HTTPS.'
    )
  }
  const finalPath = join(options.directory, options.asset.fileName)
  const partialPath = `${finalPath}.part`

  if (await verifyFile(finalPath, options.asset, options.signal)) {
    options.onProgress(options.asset.size, options.asset.size)
    return finalPath
  }
  await rm(finalPath, { force: true })

  let offset = await fileSize(partialPath)
  if (offset > options.asset.size) {
    await rm(partialPath, { force: true })
    offset = 0
  }
  if (offset === options.asset.size) {
    if (await verifyFile(partialPath, options.asset, options.signal)) {
      await rename(partialPath, finalPath)
      options.onProgress(options.asset.size, options.asset.size)
      return finalPath
    }
    await rm(partialPath, { force: true })
    offset = 0
  }

  throwIfWhisperCancelled(options.signal)
  const headers: Record<string, string> = { 'Accept-Encoding': 'identity' }
  if (offset > 0) headers.Range = `bytes=${offset}-`
  let response: Response
  try {
    response = await options.fetch(options.asset.url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: options.signal
    })
  } catch (cause) {
    throwIfWhisperCancelled(options.signal)
    throw new ManagedWhisperError('DOWNLOAD_FAILED', 'A Whisper model download failed.', {
      cause
    })
  }
  if (!response.ok || !response.body) {
    throw new ManagedWhisperError('DOWNLOAD_FAILED', 'A Whisper model download failed.')
  }
  if (response.url && new URL(response.url).protocol !== 'https:') {
    throw new ManagedWhisperError(
      'DOWNLOAD_FAILED',
      'The Whisper model download was redirected to an insecure location.'
    )
  }

  const resumed = offset > 0 && response.status === 206
  if (resumed) {
    const contentRange = response.headers.get('content-range')
    if (!contentRange?.startsWith(`bytes ${offset}-`)) {
      throw new ManagedWhisperError(
        'DOWNLOAD_FAILED',
        'The model server returned an invalid resume response.'
      )
    }
  } else if (offset > 0) {
    offset = 0
  }

  const handle = await open(partialPath, resumed ? 'a' : 'w', 0o600)
  let completed = offset
  let lastReported = offset - PROGRESS_INTERVAL_BYTES
  options.onProgress(completed, options.asset.size)
  try {
    for await (const value of response.body) {
      throwIfWhisperCancelled(options.signal)
      const chunk = Buffer.from(value)
      completed += chunk.length
      if (completed > options.asset.size) {
        throw new ManagedWhisperError(
          'INTEGRITY_FAILED',
          'The downloaded Whisper model has an unexpected size.'
        )
      }
      let written = 0
      while (written < chunk.length) {
        const result = await handle.write(chunk, written, chunk.length - written)
        if (result.bytesWritten === 0) {
          throw new ManagedWhisperError(
            'DOWNLOAD_FAILED',
            'The Whisper model download could not be written to disk.'
          )
        }
        written += result.bytesWritten
      }
      if (completed - lastReported >= PROGRESS_INTERVAL_BYTES || completed === options.asset.size) {
        lastReported = completed
        options.onProgress(completed, options.asset.size)
      }
    }
    await handle.sync()
  } finally {
    await handle.close()
  }

  if (!(await verifyFile(partialPath, options.asset, options.signal))) {
    throw new ManagedWhisperError(
      'INTEGRITY_FAILED',
      'The downloaded Whisper model failed integrity verification.'
    )
  }
  await rename(partialPath, finalPath)
  options.onProgress(options.asset.size, options.asset.size)
  return finalPath
}

export async function verifyFile(
  path: string,
  asset: Pick<WhisperDownloadAsset, 'size' | 'sha256'>,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size !== asset.size) return false
    const handle = await open(path, 'r')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES)
    try {
      let position = 0
      while (position < info.size) {
        throwIfWhisperCancelled(signal)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) return false
        hash.update(buffer.subarray(0, bytesRead))
        position += bytesRead
      }
    } finally {
      await handle.close()
    }
    return hash.digest('hex') === asset.sha256.toLowerCase()
  } catch (error) {
    if (error instanceof ManagedWhisperError) throw error
    return false
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}
