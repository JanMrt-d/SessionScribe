import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, rm, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { spawn } from 'node:child_process'

export interface MediaProbe {
  durationMs: number
  sizeBytes: number
  hasVideo: boolean
  hasAudio: boolean
  videoCodec: string | null
  audioCodec: string | null
}

interface ProbeResponse {
  format?: { duration?: string; size?: string }
  streams?: Array<{ codec_type?: string; codec_name?: string }>
}

export class FfmpegService {
  readonly ffmpegPath: string
  readonly ffprobePath: string

  private constructor(ffmpegPath: string, ffprobePath: string) {
    this.ffmpegPath = ffmpegPath
    this.ffprobePath = ffprobePath
  }

  static async create(options: {
    resourcesPath: string
    overrideFfmpeg?: string | null
    overrideFfprobe?: string | null
  }): Promise<FfmpegService> {
    const ffmpeg = await locateBinary(
      'ffmpeg',
      options.overrideFfmpeg,
      join(options.resourcesPath, 'bin', executableName('ffmpeg'))
    )
    const ffprobe = await locateBinary(
      'ffprobe',
      options.overrideFfprobe,
      join(options.resourcesPath, 'bin', executableName('ffprobe'))
    )
    return new FfmpegService(ffmpeg, ffprobe)
  }

  async probe(inputPath: string, signal?: AbortSignal): Promise<MediaProbe> {
    const result = await runProcess(
      this.ffprobePath,
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', inputPath],
      { signal, timeoutMs: 60_000 }
    )
    const parsed = JSON.parse(result.stdout) as ProbeResponse
    const video = parsed.streams?.find((stream) => stream.codec_type === 'video')
    const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio')
    const inputStat = await stat(inputPath)
    const duration = Number(parsed.format?.duration ?? 0)
    return {
      durationMs: Number.isFinite(duration) ? Math.max(0, Math.round(duration * 1_000)) : 0,
      sizeBytes: Number(parsed.format?.size ?? inputStat.size),
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null
    }
  }

  async makePlaybackProxy(
    inputPath: string,
    outputPath: string,
    signal?: AbortSignal
  ): Promise<string> {
    await mkdir(join(outputPath, '..'), { recursive: true })
    await rm(outputPath, { force: true })
    try {
      await runProcess(
        this.ffmpegPath,
        [
          '-y',
          '-v',
          'error',
          '-i',
          inputPath,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          outputPath
        ],
        { signal, timeoutMs: 60 * 60_000 }
      )
    } catch (error) {
      await rm(outputPath, { force: true })
      if (signal?.aborted) throw error
      await runProcess(
        this.ffmpegPath,
        [
          '-y',
          '-v',
          'error',
          '-i',
          inputPath,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-b:a',
          '96k',
          '-movflags',
          '+faststart',
          outputPath
        ],
        { signal, timeoutMs: 4 * 60 * 60_000 }
      )
    }
    await this.probe(outputPath, signal)
    return outputPath
  }

  async extractSpeechAudio(
    inputPath: string,
    outputPath: string,
    signal?: AbortSignal
  ): Promise<string> {
    await mkdir(join(outputPath, '..'), { recursive: true })
    await rm(outputPath, { force: true })
    await runProcess(
      this.ffmpegPath,
      [
        '-y',
        '-v',
        'error',
        '-i',
        inputPath,
        '-map',
        '0:a:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'flac',
        outputPath
      ],
      { signal, timeoutMs: 4 * 60 * 60_000 }
    )
    const probe = await this.probe(outputPath, signal)
    if (!probe.hasAudio || probe.durationMs === 0) throw new Error('Extracted audio is empty')
    return outputPath
  }

  async sha256(inputPath: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError')
    const hash = createHash('sha256')
    await new Promise<void>((resolvePromise, reject) => {
      const input = createReadStream(inputPath, { signal })
      input.on('data', (chunk) => hash.update(chunk))
      input.on('error', reject)
      input.on('end', resolvePromise)
    })
    return hash.digest('hex')
  }
}

async function locateBinary(
  name: 'ffmpeg' | 'ffprobe',
  override: string | null | undefined,
  packagedPath: string
): Promise<string> {
  const candidates = [override, packagedPath, ...pathCandidates(name)].filter(
    (candidate): candidate is string => Boolean(candidate)
  )
  for (const candidate of candidates) {
    try {
      await access(candidate)
      await runProcess(candidate, ['-version'], { timeoutMs: 10_000 })
      return candidate
    } catch {
      // Continue through explicit, packaged, and PATH candidates.
    }
  }
  throw new Error(`${name} was not found. Configure a binary path or install FFmpeg.`)
}

function pathCandidates(name: string): string[] {
  const value = process.env.PATH ?? ''
  return value
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, executableName(name)))
}

function executableName(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}

export async function runProcess(
  executable: string,
  args: string[],
  options: {
    signal?: AbortSignal | undefined
    timeoutMs: number
    env?: NodeJS.ProcessEnv | undefined
    cwd?: string | undefined
  }
): Promise<{ stdout: string; stderr: string }> {
  if (!isAbsolute(executable)) throw new Error('Subprocess executable must be an absolute path')
  if (options.signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError')
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env,
      cwd: options.cwd
    })
    let stdout = ''
    let stderr = ''
    const cap = 2 * 1024 * 1024
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < cap) stdout += chunk.slice(0, cap - stdout.length)
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < cap) stderr += chunk.slice(0, cap - stderr.length)
    })
    const terminate = (): void => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }
    const timeout = setTimeout(terminate, options.timeoutMs)
    const abort = (): void => terminate()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.once('error', (error) => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('exit', (code, childSignal) => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      if (options.signal?.aborted) {
        reject(new DOMException('Operation cancelled', 'AbortError'))
      } else if (code === 0) {
        resolvePromise({ stdout, stderr })
      } else {
        reject(
          new Error(`Process failed (${code ?? childSignal ?? 'unknown'}): ${stderr.slice(-2_000)}`)
        )
      }
    })
  })
}
