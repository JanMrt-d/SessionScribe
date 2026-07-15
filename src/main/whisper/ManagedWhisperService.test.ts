import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ManagedWhisperStatus } from '@shared/whisper'

import {
  MANAGED_WHISPER_CONTAINER_NAME,
  MANAGED_WHISPER_IMAGE,
  MANAGED_WHISPER_LABEL_KEY,
  MANAGED_WHISPER_LABEL_VALUE,
  type WhisperDownloadAsset
} from './constants'
import {
  ManagedWhisperService,
  type ManagedWhisperScheduler,
  type ManagedWhisperServiceOptions
} from './ManagedWhisperService'
import type { WhisperFetch } from './download'
import type { WhisperCommandResult, WhisperCommandRunner } from './process'

const temporaryDirectories: string[] = []
const MODEL = Buffer.from('small fixture model')
const VAD = Buffer.from('small fixture vad')
const MODEL_ASSET = asset('model.bin', 'https://fixtures.invalid/model', MODEL)
const VAD_ASSET = asset('vad.bin', 'https://fixtures.invalid/vad', VAD)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('ManagedWhisperService diagnostics and setup', () => {
  it('reports unsupported systems without invoking Docker', async () => {
    const runner = new FakeDockerRunner()
    const service = await createService({ runner, platform: 'win32' })

    const status = await service.status()

    expect(status).toMatchObject({ phase: 'unsupported', installed: false, canInstall: false })
    expect(runner.calls).toEqual([])
  })

  it('distinguishes a missing Docker client from Docker socket permission errors', async () => {
    const missingRunner = new FakeDockerRunner()
    const missing = await createService({
      runner: missingRunner,
      accessPath: async () => {
        throw new Error('missing')
      }
    })
    await expect(missing.status()).resolves.toMatchObject({ phase: 'docker-unavailable' })

    const deniedRunner = new FakeDockerRunner()
    deniedRunner.versionError =
      'permission denied while trying to connect to the Docker daemon socket'
    const denied = await createService({ runner: deniedRunner })
    await expect(denied.status()).resolves.toMatchObject({
      phase: 'permission-denied',
      canInstall: false
    })
  })

  it('downloads verified assets and creates a hardened, loopback-only container', async () => {
    const runner = new FakeDockerRunner()
    const statuses: ManagedWhisperStatus[] = []
    const service = await createService({ runner })
    service.subscribe((status) => statuses.push(status))

    const installed = await service.install()

    expect(installed).toMatchObject({ phase: 'stopped', installed: true, canStart: true })
    expect(statuses.map((status) => status.progress?.step).filter(Boolean)).toEqual(
      expect.arrayContaining([
        'checking',
        'pulling-image',
        'downloading-model',
        'downloading-vad',
        'creating-container'
      ])
    )
    expect(runner.calls).toContainEqual(['image', 'pull', MANAGED_WHISPER_IMAGE])
    const create = runner.calls.find((args) => args[0] === 'container' && args[1] === 'create')
    expect(create).toEqual(expect.any(Array))
    expect(create).toEqual(
      expect.arrayContaining([
        '--name',
        MANAGED_WHISPER_CONTAINER_NAME,
        '--label',
        `${MANAGED_WHISPER_LABEL_KEY}=${MANAGED_WHISPER_LABEL_VALUE}`,
        '--restart',
        'no',
        '--device',
        '/dev/dri:/dev/dri',
        '--publish',
        '127.0.0.1::8080',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--entrypoint',
        '/app/build/bin/whisper-server',
        MANAGED_WHISPER_IMAGE,
        '--vad',
        '--convert'
      ])
    )
    expect(create?.join(' ')).not.toContain('docker.sock')
    expect(create?.join(' ')).not.toContain('0.0.0.0:')
    const manifest = JSON.parse(
      await readFile(
        join(serviceDataDirectory(service), 'whisper', 'managed-whisper-v1.json'),
        'utf8'
      )
    ) as Record<string, unknown>
    expect(manifest).toMatchObject({ version: 1, image: MANAGED_WHISPER_IMAGE })
  })

  it('refuses to remove or control a same-named container without its ownership label', async () => {
    const runner = new FakeDockerRunner()
    runner.container = { owned: false, image: MANAGED_WHISPER_IMAGE, running: false, port: '45123' }
    const service = await createService({ runner })

    await expect(service.install()).rejects.toMatchObject({ code: 'CONTAINER_CONFLICT' })
    expect(runner.calls.some((args) => args[1] === 'rm')).toBe(false)
  })

  it('cancels setup synchronously and leaves a resumable installation state', async () => {
    const runner = new FakeDockerRunner()
    let downloadStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve
    })
    const service = await createService({
      runner,
      fetch: async (_url, init) => {
        downloadStarted?.()
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
    })

    const installation = service.install()
    await started
    service.cancelInstall()

    await expect(installation).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(service.status()).resolves.toMatchObject({ phase: 'not-installed' })
  })
})

describe('ManagedWhisperService lifecycle', () => {
  it('returns to an installable state when a managed profile is used before setup', async () => {
    const runner = new FakeDockerRunner()
    const service = await createService({ runner })

    await expect(service.acquire()).rejects.toMatchObject({ code: 'NOT_INSTALLED' })
    expect(await service.status()).toMatchObject({
      phase: 'not-installed',
      installed: false,
      canInstall: true,
      activeTranscriptions: 0
    })
  })

  it('starts on acquisition, rejects a busy stop, and stops after the idle deadline', async () => {
    const runner = new FakeDockerRunner()
    const scheduler = new FakeScheduler()
    const service = await createService({ runner, scheduler, idleTimeoutMs: 300_000 })
    await service.install()

    const lease = await service.acquire()
    const secondLease = await service.acquire()

    expect(lease.endpoint).toBe('http://127.0.0.1:45123/v1')
    await expect(service.status()).resolves.toMatchObject({
      phase: 'busy',
      activeTranscriptions: 2,
      canStop: false
    })
    await expect(service.stop()).rejects.toMatchObject({ code: 'BUSY' })
    await lease.release()
    await lease.release()
    await expect(service.status()).resolves.toMatchObject({
      phase: 'busy',
      activeTranscriptions: 1,
      idleStopAt: null
    })
    await secondLease.release()
    const idleStatus = await service.status()
    expect(idleStatus).toMatchObject({ phase: 'ready', activeTranscriptions: 0 })
    expect(typeof idleStatus.idleStopAt).toBe('string')

    scheduler.fireLatest()
    await vi.waitFor(() => {
      expect(runner.container?.running).toBe(false)
    })
    await expect(service.status()).resolves.toMatchObject({
      phase: 'stopped',
      idleStopAt: null
    })
  })

  it('adopts an owned running container after restart and validates artifact hashes', async () => {
    const runner = new FakeDockerRunner()
    const directory = await newTemporaryDirectory()
    const first = serviceWithDirectory(directory, { runner })
    await first.install()
    runner.container = { owned: true, image: MANAGED_WHISPER_IMAGE, running: true, port: '45123' }

    const restarted = serviceWithDirectory(directory, { runner, scheduler: new FakeScheduler() })
    const adoptedStatus = await restarted.status()
    expect(adoptedStatus).toMatchObject({ phase: 'ready', installed: true })
    expect(typeof adoptedStatus.idleStopAt).toBe('string')

    await writeFile(
      join(directory, 'whisper', 'models', MODEL_ASSET.fileName),
      Buffer.alloc(MODEL.length)
    )
    const tamperedRestart = serviceWithDirectory(directory, { runner })
    await expect(tamperedRestart.status()).resolves.toMatchObject({
      phase: 'error',
      installed: false,
      canInstall: true
    })
  })

  it('stops a container after readiness timeout and on application shutdown', async () => {
    const runner = new FakeDockerRunner()
    const directory = await newTemporaryDirectory()
    let time = 0
    const service = serviceWithDirectory(directory, {
      runner,
      readinessTimeoutMs: 500,
      now: () => new Date(time),
      wait: async (_milliseconds, signal) => {
        if (signal.aborted) throw signal.reason
        time += 251
      },
      healthCheck: async () => false
    })
    await service.install()

    await expect(service.start()).rejects.toMatchObject({ code: 'START_FAILED' })
    expect(runner.container?.running).toBe(false)
    expect(await service.status()).toMatchObject({
      phase: 'stopped',
      installed: true,
      canStart: true
    })

    const healthy = serviceWithDirectory(directory, { runner, healthCheck: async () => true })
    await healthy.start()
    expect(runner.container?.running).toBe(true)
    await healthy.shutdown()
    expect(runner.container?.running).toBe(false)
  })

  it('keeps Stop available when Docker reports a recoverable stop failure', async () => {
    const runner = new FakeDockerRunner()
    const service = await createService({ runner })
    await service.install()
    await service.start()
    runner.stopError = 'container did not stop'

    await expect(service.stop()).rejects.toMatchObject({ code: 'STOP_FAILED' })
    expect(await service.status()).toMatchObject({
      phase: 'ready',
      installed: true,
      canStop: true
    })
  })

  it('clears the stale endpoint and idle timer when a failed start finds no container', async () => {
    const runner = new FakeDockerRunner()
    const scheduler = new FakeScheduler()
    const service = await createService({ runner, scheduler })
    await service.install()
    await service.start()
    expect(runner.container?.running).toBe(true)

    const emitted: ManagedWhisperStatus[] = []
    service.subscribe((status) => emitted.push(status))

    runner.container = null // removed outside the app
    await expect(service.acquire()).rejects.toMatchObject({ code: 'NOT_INSTALLED' })

    expect(() => scheduler.fireLatest()).toThrow('No timer was scheduled')
    expect(emitted.at(-1)).toMatchObject({ phase: 'not-installed', idleStopAt: null })
  })

  it('recovers with a clean retry after a start that never became healthy', async () => {
    const runner = new FakeDockerRunner()
    let time = 0
    let healthy = false
    const service = await createService({
      runner,
      readinessTimeoutMs: 500,
      now: () => new Date(time),
      wait: async (_milliseconds, signal) => {
        if (signal.aborted) throw signal.reason
        time += 251
      },
      healthCheck: async () => healthy
    })
    await service.install()

    await expect(service.start()).rejects.toMatchObject({ code: 'START_FAILED' })
    expect(runner.container?.running).toBe(false)

    healthy = true
    await expect(service.start()).resolves.toMatchObject({ phase: 'ready', installed: true })
    expect(runner.container?.running).toBe(true)
  })

  it('stops a running container to free VRAM even when GPU access is gone', async () => {
    const runner = new FakeDockerRunner()
    let gpuAvailable = true
    const service = await createService({
      runner,
      accessPath: async (path: string) => {
        if (path === '/dev/dri' && !gpuAvailable) throw new Error('no /dev/dri')
      }
    })
    await service.install()
    await service.start()
    expect(runner.container?.running).toBe(true)

    const emitted: ManagedWhisperStatus[] = []
    service.subscribe((status) => emitted.push(status))

    gpuAvailable = false
    await expect(service.stopIfIdle()).resolves.toBeUndefined()
    expect(runner.container?.running).toBe(false)
    expect(emitted.at(-1)).toMatchObject({ phase: 'stopped', installed: true })
  })

  it('treats stopIfIdle as a no-op when Whisper was never installed', async () => {
    const runner = new FakeDockerRunner()
    const service = await createService({ runner })

    await expect(service.stopIfIdle()).resolves.toBeUndefined()
    expect(runner.calls.some((call) => call[0] === 'container' && call[1] === 'stop')).toBe(false)
  })

  it('treats stopIfIdle as a no-op when Docker is unavailable', async () => {
    const runner = new FakeDockerRunner()
    const service = await createService({
      runner,
      accessPath: async (path: string) => {
        if (path === '/trusted/docker') throw new Error('missing docker client')
      }
    })

    await expect(service.stopIfIdle()).resolves.toBeUndefined()
    expect(runner.calls).toHaveLength(0)
  })

  it('does not swallow a genuine stop failure during stopIfIdle', async () => {
    const runner = new FakeDockerRunner()
    const service = await createService({ runner })
    await service.install()
    await service.start()
    runner.stopError = 'container did not stop'

    await expect(service.stopIfIdle()).rejects.toMatchObject({ code: 'STOP_FAILED' })
  })

  it('emits defensive status snapshots that listeners cannot mutate', async () => {
    const runner = new FakeDockerRunner()
    const service = await createService({ runner })
    const seen: ManagedWhisperStatus[] = []
    service.subscribe((status) => {
      seen.push(status)
      if (status.progress) status.progress.completedBytes = 999
    })

    await service.install()

    expect(seen.length).toBeGreaterThan(3)
    expect((await service.status()).progress).toBeNull()
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
  versionError: string | null = null
  stopError: string | null = null

  async run(executable: string, args: readonly string[]): Promise<WhisperCommandResult> {
    expect(executable.startsWith('/')).toBe(true)
    const copy = [...args]
    this.calls.push(copy)
    if (args[0] === 'version') {
      return this.versionError ? failure(this.versionError) : success('27.0.0')
    }
    if (args[0] === 'image' && args[1] === 'pull') return success()
    if (args[0] === 'container' && args[1] === 'inspect') {
      if (!this.container)
        return failure(`Error: No such container: ${MANAGED_WHISPER_CONTAINER_NAME}`)
      return success(
        JSON.stringify([
          {
            Config: {
              Image: this.container.image,
              Labels: this.container.owned
                ? { [MANAGED_WHISPER_LABEL_KEY]: MANAGED_WHISPER_LABEL_VALUE }
                : {}
            },
            State: { Running: this.container.running },
            NetworkSettings: {
              Ports: {
                '8080/tcp': this.container.running
                  ? [{ HostIp: '127.0.0.1', HostPort: this.container.port }]
                  : null
              }
            }
          }
        ])
      )
    }
    if (args[0] === 'container' && args[1] === 'create') {
      this.container = { owned: true, image: MANAGED_WHISPER_IMAGE, running: false, port: '45123' }
      return success(MANAGED_WHISPER_CONTAINER_NAME)
    }
    if (args[0] === 'container' && args[1] === 'rm') {
      this.container = null
      return success()
    }
    if (args[0] === 'container' && args[1] === 'start') {
      if (!this.container) return failure('No such container')
      this.container.running = true
      return success(MANAGED_WHISPER_CONTAINER_NAME)
    }
    if (args[0] === 'container' && args[1] === 'stop') {
      if (this.stopError) return failure(this.stopError)
      if (this.container) this.container.running = false
      return success(MANAGED_WHISPER_CONTAINER_NAME)
    }
    return failure('Unexpected fake Docker command')
  }
}

class FakeScheduler implements ManagedWhisperScheduler {
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
  overrides: Partial<ManagedWhisperServiceOptions> & { runner: WhisperCommandRunner }
): Promise<ManagedWhisperService> {
  return serviceWithDirectory(await newTemporaryDirectory(), overrides)
}

function serviceWithDirectory(
  dataDirectory: string,
  overrides: Partial<ManagedWhisperServiceOptions> & { runner: WhisperCommandRunner }
): ManagedWhisperService {
  const fetchFixture: WhisperFetch = async (url) => {
    if (url === MODEL_ASSET.url) return new Response(MODEL)
    if (url === VAD_ASSET.url) return new Response(VAD)
    throw new Error(`Unexpected fixture URL: ${url}`)
  }
  return new ManagedWhisperService({
    dataDirectory,
    dockerExecutableCandidates: ['/trusted/docker'],
    accessPath: async () => undefined,
    freeDiskBytes: async () => 10 * 1_024 * 1_024 * 1_024,
    fetch: fetchFixture,
    healthCheck: async () => true,
    modelAsset: MODEL_ASSET,
    vadAsset: VAD_ASSET,
    ...overrides
  })
}

function serviceDataDirectory(service: ManagedWhisperService): string {
  return (service as unknown as { dataDirectory: string }).dataDirectory
}

function success(stdout = ''): WhisperCommandResult {
  return { exitCode: 0, stdout, stderr: '', outputTruncated: false }
}

function failure(stderr: string): WhisperCommandResult {
  return { exitCode: 1, stdout: '', stderr, outputTruncated: false }
}

function asset(fileName: string, url: string, contents: Buffer): WhisperDownloadAsset {
  return {
    fileName,
    url,
    size: contents.length,
    sha256: createHash('sha256').update(contents).digest('hex')
  }
}

async function newTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sessionscribe-whisper-service-'))
  temporaryDirectories.push(directory)
  return directory
}
