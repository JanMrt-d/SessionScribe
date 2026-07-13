import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { z } from 'zod'

import { ObsSubsystemError } from './errors'

const execFileAsync = promisify(execFile)

const probeSchema = z.object({
  streams: z.array(z.object({ codec_type: z.string() })),
  format: z.object({ duration: z.coerce.number().positive() })
})

export interface ArtifactProbe {
  probe(path: string): Promise<{ durationSeconds: number; hasVideo: boolean; hasAudio: boolean }>
}

export class FfprobeArtifactProbe implements ArtifactProbe {
  constructor(private readonly executable = 'ffprobe') {}

  async probe(
    path: string
  ): Promise<{ durationSeconds: number; hasVideo: boolean; hasAudio: boolean }> {
    let stdout: string
    try {
      const result = await execFileAsync(
        this.executable,
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type',
          '-show_entries',
          'format=duration',
          '-of',
          'json',
          path
        ],
        { encoding: 'utf8', timeout: 15_000, maxBuffer: 1_000_000 }
      )
      stdout = result.stdout
    } catch (error) {
      throw new ObsSubsystemError(
        'OBS_RECORDING_UNREADABLE',
        'The completed recording is not readable',
        error
      )
    }

    let parsed: z.infer<typeof probeSchema>
    try {
      parsed = probeSchema.parse(JSON.parse(stdout))
    } catch (error) {
      throw new ObsSubsystemError(
        'OBS_RECORDING_UNREADABLE',
        'ffprobe returned invalid recording metadata',
        error
      )
    }
    const hasVideo = parsed.streams.some((stream) => stream.codec_type === 'video')
    const hasAudio = parsed.streams.some((stream) => stream.codec_type === 'audio')
    if (!hasVideo || !hasAudio) {
      throw new ObsSubsystemError(
        'OBS_RECORDING_STREAM_MISSING',
        `The completed recording is missing its ${hasVideo ? 'audio' : 'video'} stream`
      )
    }
    return { durationSeconds: parsed.format.duration, hasVideo, hasAudio }
  }
}
