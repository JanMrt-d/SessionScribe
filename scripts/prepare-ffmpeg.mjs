import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

if (typeof ffmpegPath !== 'string' || typeof ffprobePath !== 'string') {
  throw new Error('Static FFmpeg packages did not expose executable paths')
}

const destination = resolve('resources/bin')
await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })

const suffix = process.platform === 'win32' ? '.exe' : ''
const ffmpegDestination = join(destination, `ffmpeg${suffix}`)
const ffprobeDestination = join(destination, `ffprobe${suffix}`)
await copyFile(ffmpegPath, ffmpegDestination)
await copyFile(ffprobePath, ffprobeDestination)
if (process.platform !== 'win32') {
  await chmod(ffmpegDestination, 0o755)
  await chmod(ffprobeDestination, 0o755)
}

await copyFile(
  resolve('node_modules/ffmpeg-static/LICENSE'),
  join(destination, 'FFMPEG-GPL-3.0.txt')
)
await copyFile(
  resolve('node_modules/ffprobe-static/LICENSE'),
  join(destination, 'FFPROBE-WRAPPER-MIT.txt')
)

const versions = [
  `Packaged for ${process.platform}-${process.arch}`,
  `Source package: ffmpeg-static@5.3.0 (${basename(ffmpegPath)})`,
  `Source package: ffprobe-static@3.1.0 (${basename(ffprobePath)})`,
  '',
  execFileSync(ffmpegDestination, ['-version'], { encoding: 'utf8' })
    .split('\n')
    .slice(0, 4)
    .join('\n'),
  '',
  execFileSync(ffprobeDestination, ['-version'], { encoding: 'utf8' })
    .split('\n')
    .slice(0, 4)
    .join('\n'),
  '',
  'FFmpeg build source: https://github.com/eugeneware/ffmpeg-static',
  'FFmpeg 7.0.2 corresponding source: https://ffmpeg.org/releases/ffmpeg-7.0.2.tar.xz',
  'FFprobe 4.0.2 corresponding source: https://ffmpeg.org/releases/ffmpeg-4.0.2.tar.xz',
  'Upstream source index: https://ffmpeg.org/download.html'
]
await writeFile(join(destination, 'BUILD-INFO.txt'), `${versions.join('\n')}\n`, 'utf8')
