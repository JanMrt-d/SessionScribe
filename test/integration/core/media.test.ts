import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FfmpegService, runProcess } from '@main/media/FfmpegService'

describe('FFmpeg media workflow', () => {
  let directory: string
  let ffmpeg: FfmpegService

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sessionscribe-media-'))
    ffmpeg = await FfmpegService.create({ resourcesPath: resolve('resources') })
  })

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('probes, creates a browser proxy, and extracts speech audio', async () => {
    const input = join(directory, 'fixture.mkv')
    await runProcess(
      ffmpeg.ffmpegPath,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=320x180:d=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-shortest',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        input
      ],
      { timeoutMs: 30_000 }
    )

    const probe = await ffmpeg.probe(input)
    expect(probe.hasVideo).toBe(true)
    expect(probe.hasAudio).toBe(true)

    const proxy = join(directory, 'playback.mp4')
    await ffmpeg.makePlaybackProxy(input, proxy)
    expect((await ffmpeg.probe(proxy)).hasVideo).toBe(true)

    const audio = join(directory, 'audio.flac')
    await ffmpeg.extractSpeechAudio(input, audio)
    const audioProbe = await ffmpeg.probe(audio)
    expect(audioProbe.hasAudio).toBe(true)
    expect(audioProbe.hasVideo).toBe(false)
  })

  it('rejects a pre-aborted subprocess without spawning it', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      runProcess(resolve(directory, 'must-not-be-spawned'), [], {
        signal: controller.signal,
        timeoutMs: 30_000
      })
    ).rejects.toMatchObject({ name: 'AbortError' })

    await expect(
      ffmpeg.sha256(resolve(directory, 'must-not-be-read'), controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
