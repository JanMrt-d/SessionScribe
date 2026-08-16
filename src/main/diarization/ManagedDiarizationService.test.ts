import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ManagedDiarizationStatus } from '@shared/diarization'

import type { WhisperFetch } from '../whisper/download'
import type { WhisperCommandResult, WhisperCommandRunner } from '../whisper/process'
import {
  type DiarizationDownloadAsset,
  MANAGED_DIARIZATION_CONTAINER_NAME,
  MANAGED_DIARIZATION_IMAGE_TAG,
  MANAGED_DIARIZATION_LABEL_KEY,
  MANAGED_DIARIZATION_LABEL_VALUE
} from './constants'
import {
  ManagedDiarizationService,
  type ManagedDiarizationScheduler,
  type ManagedDiarizationServiceOptions
} from './ManagedDiarizationService'

const temporaryDirectories: string[] = []
const CONFIG = Buffer.from('pipeline fixture config')
const SEGMENTATION = Buffer.from('segmentation fixture weights')
const EMBEDDING = Buffer.from('embedding fixture weights')
const ASSETS: DiarizationDownloadAsset[] = [
  asset('config.yaml', 'config.yaml', CONFIG),
  asset('pytorch_model.bin', 'segmentation/pytorch_model.bin', SEGMENTATION),
  asset('pytorch_model.bin', 'embedding/pytorch_model.bin', EMBEDDING)
]

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('ManagedDiarizationService setup', () => {
  it('reports unsupported systems without invoking Docker', async () => {
    const runner = new FakeDockerRunner()
    const service = await createService({ runner, platform: 'darwin' })

    await expect(service.status()).resolves.toMatchObject({ phase: 'unsupported' })
    expect(runner.calls).toHaveLength(0)
  })

  it('builds the image, downloads verified models, and creates a hardened container', async () => {
    const runner = new FakeDockerRunner()
    const service = await createService({ runner })

    const status = await service.install()

    expect(status).toMatchObject({ phase: 'stopped', installed: true, canStart: true })
    const build = runner.calls.find((call) => call[0] === 'build')
    expect(build).toBeDefined()
    expect(build).toContain(MANAGED_DIARIZATION_IMAGE_TAG)
    const create = runner.calls.find((call) => call[0] === 'container' && call[1] === 'create')
    expect(create).toBeDefined()
    expect(create).toContain('/dev/kfd:/dev/kfd')
    expect(create).toContain('/dev/dri:/dev/dri')
    expect(create).toContain('127.0.0.1::8000')
    expect(create).toContain('ALL')
    expect(create).toContain('no-new-privileges')
    expect(create?.join(' ')).toContain('--group-add 485')
    expect(create?.join(' ')).toMatch(/--volume \S+:\/models:ro,z/)
  })

  it('leaves the nested model tree readable by a container that cannot bypass permission bits', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'managed-diarization-modes-'))
    temporaryDirectories.push(dataDirectory)
    const service = await createService({ runner: new FakeDockerRunner(), dataDirectory })

    await service.install()

    const modelDirectory = join(dataDirectory, 'diarization', 'models')
    expect((await stat(modelDirectory)).mode & 0o777).toBe(0o755)
    for (const asset of ASSETS) {
      const segments = asset.relativePath.split('/')
      // Every directory on the way to a weight must be traversable, not just the root.
      for (let depth = 1; depth < segments.length; depth += 1) {
        const directory = join(modelDirectory, ...segments.slice(0, depth))
        expect((await stat(directory)).mode & 0o777).toBe(0o755)
      }
      expect((await stat(join(modelDirectory, ...segments))).mode & 0o777).toBe(0o644)
    }
    expect((await stat(join(dataDirectory, 'diarization'))).mode & 0o777).toBe(0o700)
  })

  it('refuses to control a same-named container without the ownership label', async () => {
    const runner = new FakeDockerRunner()
    runner.container = {
      owned: false,
      image: MANAGED_DIARIZATION_IMAGE_TAG,
      running: false,
      port: '46000'
    }
    const service = await createService({ runner })

    await expect(service.install()).rejects.toMatchObject({ code: 'CONTAINER_CONFLICT' })
  })
})

describe('ManagedDiarizationService lifecycle', () => {
  it('diarizes on demand, sends PCM with headers, and idle-stops after the deadline', async () => {
    const runner = new FakeDockerRunner()
    const scheduler = new FakeScheduler()
    const requests: Array<{ url: string; headers: Record<string, string>; bytes: number }> = []
    const service = await createService({
      runner,
      scheduler,
      fetch: fetchWithDiarization(requests)
    })
    await service.install()

    const pcm = Buffer.alloc(16_000 * 4)
    const segments = await service.diarize(pcm, { sampleRate: 16_000, numSpeakers: 2 })

    expect(segments).toEqual([
      { startMs: 0, endMs: 500, speaker: 'SPEAKER_00' },
      { startMs: 500, endMs: 1000, speaker: 'SPEAKER_01' }
    ])
    const diarizeRequest = requests.find((request) => request.url.endsWith('/diarize'))
    expect(diarizeRequest).toMatchObject({
      headers: { 'X-Sample-Rate': '16000', 'X-Num-Speakers': '2' },
      bytes: pcm.length
    })

    const idleStatus = await service.status()
    expect(idleStatus).toMatchObject({ phase: 'ready', activeJobs: 0 })
    expect(typeof idleStatus.idleStopAt).toBe('string')

    scheduler.fireLatest()
    await vi.waitFor(() => {
      expect(runner.container?.running).toBe(false)
    })
  })

  it('returns to an installable state when diarization is used before setup', async () => {
    const runner = new FakeDockerRunner()
    const service = await createService({ runner })

    await expect(service.diarize(Buffer.alloc(4), { sampleRate: 16_000 })).rejects.toMatchObject({
      code: 'NOT_INSTALLED'
    })
    expect(await service.status()).toMatchObject({ phase: 'not-installed', canInstall: true })
  })

  it('treats stopIfIdle as a no-op when nothing is installed or Docker is missing', async () => {
    const runner = new FakeDockerRunner()
    const service = await createService({ runner })
    await expect(service.stopIfIdle()).resolves.toBeUndefined()

    const withoutDocker = await createService({
      runner: new FakeDockerRunner(),
      accessPath: async (path: string) => {
        if (path === '/trusted/docker') throw new Error('missing docker client')
      }
    })
    await expect(withoutDocker.stopIfIdle()).resolves.toBeUndefined()
  })

  it('clears the stale endpoint and idle timer when a failed start finds no container', async () => {
    const runner = new FakeDockerRunner()
    const scheduler = new FakeScheduler()
    const service = await createService({ runner, scheduler })
    await service.install()
    await service.start()
    expect(runner.container?.running).toBe(true)

    const emitted: ManagedDiarizationStatus[] = []
    service.subscribe((status) => emitted.push(status))

    runner.container = null // removed outside the app
    await expect(service.diarize(Buffer.alloc(4), { sampleRate: 16_000 })).rejects.toMatchObject({
      code: 'NOT_INSTALLED'
    })

    expect(() => scheduler.fireLatest()).toThrow('No timer was scheduled')
    expect(emitted.at(-1)).toMatchObject({ phase: 'not-installed', idleStopAt: null })
  })

  it('stops the container on shutdown', async () => {
    const runner = new FakeDockerRunner()
    const service = await createService({ runner })
    await service.install()
    await service.start()
    expect(runner.container?.running).toBe(true)

    await service.shutdown()
    expect(runner.container?.running).toBe(false)
  })

  it('rejects malformed diarization responses', async () => {
    const runner = new FakeDockerRunner()
    const service = await createService({
      runner,
      fetch: async (url) => {
        if (url.endsWith('/health')) return jsonResponse({ status: 'ok' })
        if (url.endsWith('/diarize')) {
          return jsonResponse({ segments: [{ startMs: 100, endMs: 50, speaker: 'A' }] })
        }
        return fetchModelFixture(url)
      }
    })
    await service.install()

    await expect(service.diarize(Buffer.alloc(4), { sampleRate: 16_000 })).rejects.toMatchObject({
      code: 'REQUEST_FAILED'
    })
  })
})

interface FakeContainer {
  owned: boolean
  image: string
  running: boolean
  port: string
}

class FakeDockerRunner implements WhisperCommandRunner {
  readonly calls: string[][] = []
  container: FakeContainer | null = null
  imageBuilt = false

  async run(executable: string, args: readonly string[]): Promise<WhisperCommandResult> {
    expect(executable.startsWith('/')).toBe(true)
    const copy = [...args]
    this.calls.push(copy)
    if (args[0] === 'version') return success('27.0.0')
    if (args[0] === 'build') {
      this.imageBuilt = true
      return success('sha256:fixture')
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      return this.imageBuilt ? success('[{}]') : failure('Error: No such image')
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      if (!this.container)
        return failure(`Error: No such container: ${MANAGED_DIARIZATION_CONTAINER_NAME}`)
      return success(
        JSON.stringify([
          {
            Config: {
              Image: this.container.image,
              Labels: this.container.owned
                ? { [MANAGED_DIARIZATION_LABEL_KEY]: MANAGED_DIARIZATION_LABEL_VALUE }
                : {}
            },
            State: { Running: this.container.running },
            NetworkSettings: {
              Ports: {
                '8000/tcp': this.container.running
                  ? [{ HostIp: '127.0.0.1', HostPort: this.container.port }]
                  : null
              }
            }
          }
        ])
      )
    }
    if (args[0] === 'container' && args[1] === 'create') {
      if (this.container && !this.container.owned) {
        return failure('name already in use')
      }
      this.container = {
        owned: true,
        image: MANAGED_DIARIZATION_IMAGE_TAG,
        running: false,
        port: '46000'
      }
      return success(MANAGED_DIARIZATION_CONTAINER_NAME)
    }
    if (args[0] === 'container' && args[1] === 'rm') {
      this.container = null
      return success()
    }
    if (args[0] === 'container' && args[1] === 'start') {
      if (!this.container) return failure('No such container')
      this.container.running = true
      return success(MANAGED_DIARIZATION_CONTAINER_NAME)
    }
    if (args[0] === 'container' && args[1] === 'stop') {
      if (this.container) this.container.running = false
      return success(MANAGED_DIARIZATION_CONTAINER_NAME)
    }
    return failure('Unexpected fake Docker command')
  }
}

class FakeScheduler implements ManagedDiarizationScheduler {
  private callbacks = new Map<object, () => void>()

  setTimeout(callback: () => void, milliseconds: number): object {
    void milliseconds
    const handle = {}
    this.callbacks.set(handle, callback)
    return handle
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'object' && handle) this.callbacks.delete(handle)
  }

  fireLatest(): void {
    const entry = [...this.callbacks.entries()].at(-1)
    if (!entry) throw new Error('No timer was scheduled')
    this.callbacks.delete(entry[0])
    entry[1]()
  }
}

async function createService(
  overrides: Partial<ManagedDiarizationServiceOptions> & { runner: WhisperCommandRunner }
): Promise<ManagedDiarizationService> {
  const directory = await mkdtemp(join(tmpdir(), 'managed-diarization-'))
  temporaryDirectories.push(directory)
  return new ManagedDiarizationService({
    dataDirectory: directory,
    buildContextDirectory: directory,
    platform: 'linux',
    architecture: 'x64',
    dockerExecutableCandidates: ['/trusted/docker'],
    accessPath: async () => undefined,
    statPath: async () => ({ gid: 485 }),
    freeDiskBytes: async () => 100 * 1_024 * 1_024 * 1_024,
    fetch: fetchWithDiarization([]),
    healthCheck: async () => true,
    modelAssets: ASSETS,
    ...overrides
  })
}

function fetchWithDiarization(
  requests: Array<{ url: string; headers: Record<string, string>; bytes: number }>
): WhisperFetch {
  return async (url, init) => {
    if (url.endsWith('/health')) return jsonResponse({ status: 'ok' })
    if (url.endsWith('/diarize')) {
      const body = init.body as Buffer
      requests.push({
        url,
        headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
        bytes: body.length
      })
      return jsonResponse({
        segments: [
          { startMs: 0, endMs: 500, speaker: 'SPEAKER_00' },
          { startMs: 500, endMs: 1000, speaker: 'SPEAKER_01' }
        ]
      })
    }
    return fetchModelFixture(url)
  }
}

const FIXTURE_CONTENT: ReadonlyMap<string, Buffer> = new Map([
  ['https://fixtures.invalid/config.yaml', CONFIG],
  ['https://fixtures.invalid/segmentation/pytorch_model.bin', SEGMENTATION],
  ['https://fixtures.invalid/embedding/pytorch_model.bin', EMBEDDING]
])

function fetchModelFixture(url: string): Response {
  const content = FIXTURE_CONTENT.get(url)
  if (!content) throw new Error(`Unexpected fixture URL: ${url}`)
  return new Response(content)
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

function asset(fileName: string, relativePath: string, content: Buffer): DiarizationDownloadAsset {
  return {
    fileName,
    relativePath,
    url: `https://fixtures.invalid/${relativePath}`,
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex')
  }
}

function success(stdout = ''): WhisperCommandResult {
  return { exitCode: 0, stdout, stderr: '', outputTruncated: false }
}

function failure(stderr: string): WhisperCommandResult {
  return { exitCode: 1, stdout: '', stderr, outputTruncated: false }
}
