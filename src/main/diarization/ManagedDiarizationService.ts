import { constants as fsConstants } from 'node:fs'
import { access, mkdir, stat, statfs } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type {
  DiarizationSegment,
  ManagedDiarizationProgress,
  ManagedDiarizationStatus
} from '@shared/diarization'

import { downloadVerifiedAsset, verifyFile, type WhisperFetch } from '../whisper/download'
import { ManagedWhisperError } from '../whisper/errors'
import {
  SpawnWhisperCommandRunner,
  type WhisperCommandResult,
  type WhisperCommandRunner
} from '../whisper/process'
import {
  DIARIZATION_MODEL_ASSETS,
  type DiarizationDownloadAsset,
  MANAGED_DIARIZATION_BUILD_TIMEOUT_MS,
  MANAGED_DIARIZATION_CONTAINER_NAME,
  MANAGED_DIARIZATION_IDLE_TIMEOUT_MS,
  MANAGED_DIARIZATION_IMAGE_TAG,
  MANAGED_DIARIZATION_LABEL_KEY,
  MANAGED_DIARIZATION_LABEL_VALUE,
  MANAGED_DIARIZATION_MINIMUM_FREE_BYTES,
  MANAGED_DIARIZATION_READINESS_TIMEOUT_MS
} from './constants'
import {
  ManagedDiarizationError,
  managedDiarizationCancelled,
  throwIfDiarizationCancelled
} from './errors'

const DOCKER_COMMAND_TIMEOUT_MS = 30_000
const HEALTH_REQUEST_TIMEOUT_MS = 2_000
const READINESS_POLL_MS = 500
const DIARIZE_REQUEST_TIMEOUT_MS = 30 * 60 * 1_000
const MAX_RESPONSE_BYTES = 64 * 1_024 * 1_024

const DEFAULT_DOCKER_EXECUTABLES = ['/usr/bin/docker', '/usr/local/bin/docker'] as const

export interface ManagedDiarizationScheduler {
  setTimeout(callback: () => void, milliseconds: number): object | number
  clearTimeout(handle: object | number): void
}

export interface DiarizeRequestOptions {
  readonly sampleRate: number
  readonly numSpeakers?: number | null
  readonly signal?: AbortSignal
}

export interface ManagedDiarizationServiceOptions {
  readonly dataDirectory: string
  /** Directory containing the embedded Dockerfile and server.py. */
  readonly buildContextDirectory: string
  readonly platform?: NodeJS.Platform
  readonly architecture?: string
  readonly dockerExecutableCandidates?: readonly string[]
  readonly runner?: WhisperCommandRunner
  readonly fetch?: WhisperFetch
  readonly accessPath?: (path: string, mode: number) => Promise<void>
  readonly statPath?: (path: string) => Promise<{ gid: number }>
  readonly freeDiskBytes?: (path: string) => Promise<number>
  readonly now?: () => Date
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly scheduler?: ManagedDiarizationScheduler
  readonly healthCheck?: (origin: string, signal: AbortSignal) => Promise<boolean>
  readonly idleTimeoutMs?: number
  readonly readinessTimeoutMs?: number
  /** Intended for small deterministic test assets; production uses the pinned exports. */
  readonly modelAssets?: readonly DiarizationDownloadAsset[]
}

interface InspectedContainer {
  readonly owned: boolean
  readonly expectedImage: boolean
  readonly running: boolean
  readonly origin: string | null
}

export class ManagedDiarizationService {
  private readonly dataDirectory: string
  private readonly modelDirectory: string
  private readonly buildContextDirectory: string
  private readonly platform: NodeJS.Platform
  private readonly architecture: string
  private readonly dockerExecutableCandidates: readonly string[]
  private readonly runner: WhisperCommandRunner
  private readonly fetch: WhisperFetch
  private readonly accessPath: (path: string, mode: number) => Promise<void>
  private readonly statPath: (path: string) => Promise<{ gid: number }>
  private readonly freeDiskBytes: (path: string) => Promise<number>
  private readonly now: () => Date
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly scheduler: ManagedDiarizationScheduler
  private readonly healthCheck: (origin: string, signal: AbortSignal) => Promise<boolean>
  private readonly idleTimeoutMs: number
  private readonly readinessTimeoutMs: number
  private readonly modelAssets: readonly DiarizationDownloadAsset[]
  private readonly listeners = new Set<(status: ManagedDiarizationStatus) => void>()

  private currentStatus: ManagedDiarizationStatus
  private dockerExecutable: string | null = null
  private endpoint: string | null = null
  private activeJobs = 0
  private idleTimer: object | number | null = null
  private installController: AbortController | null = null
  private installPromise: Promise<ManagedDiarizationStatus> | null = null
  private startPromise: Promise<string> | null = null
  private stopPromise: Promise<void> | null = null
  private shuttingDown = false

  constructor(options: ManagedDiarizationServiceOptions) {
    this.dataDirectory = resolve(options.dataDirectory)
    this.modelDirectory = join(this.dataDirectory, 'diarization', 'models')
    if (this.modelDirectory.includes(',') || this.modelDirectory.includes('\0')) {
      throw new ManagedDiarizationError(
        'UNSUPPORTED',
        'The application data path cannot be used for the managed diarization container.'
      )
    }
    this.buildContextDirectory = resolve(options.buildContextDirectory)
    this.platform = options.platform ?? process.platform
    this.architecture = options.architecture ?? process.arch
    this.dockerExecutableCandidates =
      options.dockerExecutableCandidates ?? DEFAULT_DOCKER_EXECUTABLES
    this.runner = options.runner ?? new SpawnWhisperCommandRunner()
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init))
    this.accessPath = options.accessPath ?? access
    this.statPath = options.statPath ?? ((path) => stat(path))
    this.freeDiskBytes = options.freeDiskBytes ?? defaultFreeDiskBytes
    this.now = options.now ?? (() => new Date())
    this.wait = options.wait ?? waitWithAbort
    this.scheduler = options.scheduler ?? defaultScheduler
    this.healthCheck =
      options.healthCheck ?? ((origin, signal) => this.defaultHealthCheck(origin, signal))
    this.idleTimeoutMs = options.idleTimeoutMs ?? MANAGED_DIARIZATION_IDLE_TIMEOUT_MS
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? MANAGED_DIARIZATION_READINESS_TIMEOUT_MS
    this.modelAssets = options.modelAssets ?? DIARIZATION_MODEL_ASSETS
    if (this.idleTimeoutMs < 0 || this.readinessTimeoutMs <= 0) {
      throw new ManagedDiarizationError(
        'UNSUPPORTED',
        'Managed diarization timeout settings are invalid.'
      )
    }
    const supported = this.platform === 'linux' && this.architecture === 'x64'
    this.currentStatus = makeStatus(
      supported ? 'docker-unavailable' : 'unsupported',
      supported
        ? 'Docker status has not been checked.'
        : 'Managed diarization requires Linux x64 with an AMD GPU (ROCm).',
      false
    )
  }

  subscribe(listener: (status: ManagedDiarizationStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async status(signal?: AbortSignal): Promise<ManagedDiarizationStatus> {
    throwIfDiarizationCancelled(signal)
    if (this.installPromise || this.startPromise || this.stopPromise) return this.snapshot()
    try {
      await this.refreshStatus(signal ?? new AbortController().signal)
    } catch (error) {
      this.setFailureStatus(error)
    }
    return this.snapshot()
  }

  install(signal?: AbortSignal): Promise<ManagedDiarizationStatus> {
    if (this.installPromise) return this.installPromise
    if (this.startPromise || this.stopPromise || this.activeJobs > 0) {
      return Promise.reject(
        new ManagedDiarizationError('BUSY', 'Diarization cannot be installed while it is in use.')
      )
    }
    if (this.shuttingDown) {
      return Promise.reject(new ManagedDiarizationError('BUSY', 'SessionScribe is shutting down.'))
    }

    const controller = new AbortController()
    this.installController = controller
    const forwardAbort = (): void => controller.abort(signal?.reason)
    if (signal?.aborted) controller.abort(signal.reason)
    else signal?.addEventListener('abort', forwardAbort, { once: true })

    const operation = this.performInstall(controller.signal)
      .then(() => this.snapshot())
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          this.updateStatus({
            phase: 'not-installed',
            message: 'Diarization setup was cancelled. It can be resumed.',
            installed: false,
            progress: null,
            canInstall: true,
            canStart: false,
            canStop: false
          })
          throw managedDiarizationCancelled(controller.signal.reason)
        }
        const normalized = this.normalize(error, 'INSTALL_FAILED', 'Diarization setup failed.')
        this.updateStatus({
          phase: 'error',
          message: normalized.message,
          installed: false,
          progress: null,
          idleStopAt: null,
          canInstall: true,
          canStart: false,
          canStop: false
        })
        throw normalized
      })
      .finally(() => {
        signal?.removeEventListener('abort', forwardAbort)
        this.installController = null
        this.installPromise = null
      })
    this.installPromise = operation
    return operation
  }

  cancelInstall(): void {
    this.installController?.abort('Installation cancelled by the user')
  }

  async start(signal?: AbortSignal): Promise<ManagedDiarizationStatus> {
    throwIfDiarizationCancelled(signal)
    await this.ensureStarted(signal ?? new AbortController().signal)
    if (this.activeJobs === 0) this.scheduleIdleStop()
    return this.snapshot()
  }

  async stop(signal?: AbortSignal): Promise<ManagedDiarizationStatus> {
    if (this.activeJobs > 0) {
      throw new ManagedDiarizationError('BUSY', 'Diarization cannot stop while running.')
    }
    if (this.installPromise) {
      throw new ManagedDiarizationError('BUSY', 'Diarization cannot stop during setup.')
    }
    await this.stopManagedContainer(signal ?? new AbortController().signal, false)
    return this.snapshot()
  }

  /**
   * Best-effort stop for VRAM coordination. "Nothing to release" conditions
   * (unsupported platform, missing Docker, no installation) are swallowed so
   * callers such as the local-summary path never fail merely because managed
   * diarization is absent. Genuine stop failures and cancellation propagate.
   */
  async stopIfIdle(signal?: AbortSignal): Promise<void> {
    if (this.activeJobs > 0) return
    try {
      await this.stopManagedContainer(signal ?? new AbortController().signal, false)
    } catch (error) {
      if (
        error instanceof ManagedDiarizationError &&
        (error.code === 'UNSUPPORTED' ||
          error.code === 'DOCKER_UNAVAILABLE' ||
          error.code === 'PERMISSION_DENIED' ||
          error.code === 'NOT_INSTALLED')
      ) {
        return
      }
      throw error
    }
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.cancelIdleStop()
    this.cancelInstall()
    if (this.installPromise) await this.installPromise.catch(() => undefined)
    if (this.startPromise) await this.startPromise.catch(() => undefined)
    this.activeJobs = 0
    await this.stopManagedContainer(signal ?? new AbortController().signal, true).catch(
      () => undefined
    )
    this.listeners.clear()
  }

  /**
   * Runs diarization for a mono float32 PCM buffer. Starts the container on
   * demand and arms the idle-stop timer after the last concurrent job ends.
   */
  async diarize(pcm: Buffer, options: DiarizeRequestOptions): Promise<DiarizationSegment[]> {
    throwIfDiarizationCancelled(options.signal)
    if (this.shuttingDown) {
      throw new ManagedDiarizationError('BUSY', 'SessionScribe is shutting down.')
    }
    this.cancelIdleStop()
    this.activeJobs += 1
    this.updateStatus({ activeJobs: this.activeJobs, idleStopAt: null })

    let endpoint: string
    try {
      endpoint = await this.ensureStarted(options.signal ?? new AbortController().signal)
    } catch (error) {
      this.releaseJob()
      throw error
    }

    this.updateStatus({
      phase: 'busy',
      message: 'Identifying speakers…',
      installed: true,
      activeJobs: this.activeJobs,
      canInstall: false,
      canStart: false,
      canStop: false
    })
    try {
      return await this.requestDiarization(endpoint, pcm, options)
    } finally {
      this.releaseJob()
    }
  }

  private releaseJob(): void {
    this.activeJobs = Math.max(0, this.activeJobs - 1)
    const idle = this.activeJobs === 0
    this.updateStatus({
      phase: this.endpoint ? (idle ? 'ready' : 'busy') : this.currentStatus.phase,
      message: this.endpoint
        ? idle
          ? 'Diarization is ready.'
          : 'Identifying speakers…'
        : this.currentStatus.message,
      activeJobs: this.activeJobs,
      canStop: idle && this.endpoint !== null
    })
    if (idle && this.endpoint) this.scheduleIdleStop()
  }

  private async requestDiarization(
    endpoint: string,
    pcm: Buffer,
    options: DiarizeRequestOptions
  ): Promise<DiarizationSegment[]> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'X-Sample-Rate': String(options.sampleRate)
    }
    if (options.numSpeakers) headers['X-Num-Speakers'] = String(options.numSpeakers)

    const timeout = AbortSignal.timeout(DIARIZE_REQUEST_TIMEOUT_MS)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetch(`${endpoint}/diarize`, {
        method: 'POST',
        headers,
        body: pcm,
        signal
      })
    } catch (cause) {
      throwIfDiarizationCancelled(options.signal)
      throw new ManagedDiarizationError('REQUEST_FAILED', 'The diarization request failed.', {
        cause
      })
    }
    const body = await this.readBounded(response)
    if (!response.ok) {
      throw new ManagedDiarizationError(
        'REQUEST_FAILED',
        `Diarization failed with status ${response.status}.`
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch (cause) {
      throw new ManagedDiarizationError(
        'REQUEST_FAILED',
        'The diarization response was not valid JSON.',
        { cause }
      )
    }
    return parseSegments(parsed)
  }

  private async readBounded(response: Response): Promise<string> {
    if (!response.body) return ''
    const chunks: Buffer[] = []
    let total = 0
    for await (const value of response.body as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(value)
      total += chunk.length
      if (total > MAX_RESPONSE_BYTES) {
        throw new ManagedDiarizationError(
          'REQUEST_FAILED',
          'The diarization response exceeded the size limit.'
        )
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  private async performInstall(signal: AbortSignal): Promise<void> {
    this.updateStatus({
      phase: 'installing',
      message: 'Checking the diarization requirements…',
      installed: false,
      progress: progress('checking'),
      idleStopAt: null,
      canInstall: false,
      canStart: false,
      canStop: false
    })
    await mkdir(this.modelDirectory, { recursive: true, mode: 0o700 })
    await this.checkPrerequisites(signal, true)

    this.updateStatus({
      phase: 'installing',
      message: 'Building the diarization runtime (large download, one time)…',
      progress: progress('building-image')
    })
    const build = await this.runDocker(
      ['build', '--tag', MANAGED_DIARIZATION_IMAGE_TAG, this.buildContextDirectory],
      signal,
      MANAGED_DIARIZATION_BUILD_TIMEOUT_MS
    )
    if (build.exitCode !== 0) {
      throw new ManagedDiarizationError(
        'BUILD_FAILED',
        'The diarization runtime image could not be built.'
      )
    }

    const totalBytes = this.modelAssets.reduce((sum, asset) => sum + asset.size, 0)
    let completedBase = 0
    for (const asset of this.modelAssets) {
      throwIfDiarizationCancelled(signal)
      const targetDirectory = join(this.modelDirectory, dirname(asset.relativePath))
      await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
      const base = completedBase
      try {
        await downloadVerifiedAsset({
          asset,
          directory: targetDirectory,
          fetch: this.fetch,
          signal,
          onProgress: (completedBytes) => {
            this.updateStatus({
              progress: {
                step: 'downloading-models',
                completedBytes: base + completedBytes,
                totalBytes
              },
              message: 'Downloading the speaker models…'
            })
          }
        })
      } catch (error) {
        throw this.normalize(error, 'DOWNLOAD_FAILED', 'A speaker model download failed.')
      }
      completedBase += asset.size
    }

    this.updateStatus({
      progress: progress('creating-container'),
      message: 'Creating the managed diarization container…'
    })
    await this.createContainer(signal)
    this.endpoint = null
    this.updateStatus({
      phase: 'stopped',
      message: 'Diarization is installed and stopped.',
      installed: true,
      progress: null,
      activeJobs: 0,
      idleStopAt: null,
      canInstall: false,
      canStart: true,
      canStop: false
    })
  }

  private async refreshStatus(signal: AbortSignal): Promise<void> {
    await this.checkStopPrerequisites(signal)
    const container = await this.inspectContainer(signal)
    if (!container || !(await this.artifactsPresent(signal))) {
      this.endpoint = null
      this.cancelIdleStop()
      this.updateStatus({
        phase: 'not-installed',
        message: 'Speaker identification is ready to be installed.',
        installed: false,
        progress: null,
        idleStopAt: null,
        canInstall: true,
        canStart: false,
        canStop: false
      })
      return
    }
    this.assertOwnedContainer(container)
    if (!container.running) {
      this.endpoint = null
      this.cancelIdleStop()
      this.updateStatus({
        phase: 'stopped',
        message: 'Diarization is installed and stopped.',
        installed: true,
        progress: null,
        idleStopAt: null,
        canInstall: false,
        canStart: true,
        canStop: false
      })
      return
    }
    if (!container.origin) {
      throw new ManagedDiarizationError(
        'START_FAILED',
        'Docker did not expose diarization on loopback.'
      )
    }
    this.endpoint = container.origin
    const ready = await this.healthCheck(container.origin, signal).catch(() => false)
    this.updateStatus({
      phase: ready ? (this.activeJobs > 0 ? 'busy' : 'ready') : 'starting',
      message: ready
        ? this.activeJobs > 0
          ? 'Identifying speakers…'
          : 'Diarization is ready.'
        : 'Diarization is loading the models…',
      installed: true,
      progress: null,
      canInstall: false,
      canStart: false,
      canStop: this.activeJobs === 0
    })
    if (this.activeJobs === 0 && !this.idleTimer) this.scheduleIdleStop()
  }

  /** Full prerequisites for install/start: platform, Docker, AMD GPU, disk. */
  private async checkPrerequisites(signal: AbortSignal, checkDisk: boolean): Promise<void> {
    await this.checkStopPrerequisites(signal)
    try {
      await this.accessPath('/dev/kfd', fsConstants.R_OK | fsConstants.W_OK)
      await this.accessPath('/dev/dri', fsConstants.R_OK)
    } catch (cause) {
      this.updateStatus({
        phase: 'unsupported',
        message: 'AMD GPU compute access through /dev/kfd is unavailable.',
        installed: false,
        progress: null,
        canInstall: false,
        canStart: false,
        canStop: false
      })
      throw new ManagedDiarizationError(
        'UNSUPPORTED',
        'AMD GPU compute access through /dev/kfd is unavailable.',
        { cause }
      )
    }
    if (checkDisk) {
      const availableBytes = await this.freeDiskBytes(this.modelDirectory)
      if (availableBytes < MANAGED_DIARIZATION_MINIMUM_FREE_BYTES) {
        throw new ManagedDiarizationError(
          'INSUFFICIENT_DISK_SPACE',
          'At least 25 GiB of free disk space is required for diarization setup.'
        )
      }
    }
  }

  /**
   * Prerequisites for stopping only: platform and a responsive Docker client.
   * Releasing VRAM must not require GPU or disk access.
   */
  private async checkStopPrerequisites(signal: AbortSignal): Promise<void> {
    throwIfDiarizationCancelled(signal)
    if (this.platform !== 'linux' || this.architecture !== 'x64') {
      this.updateStatus({
        phase: 'unsupported',
        message: 'Managed diarization requires Linux x64 with an AMD GPU (ROCm).',
        installed: false,
        progress: null,
        canInstall: false,
        canStart: false,
        canStop: false
      })
      throw new ManagedDiarizationError(
        'UNSUPPORTED',
        'Managed diarization requires Linux x64 with an AMD GPU (ROCm).'
      )
    }
    this.dockerExecutable = await this.locateDocker()
    if (!this.dockerExecutable) {
      this.updateStatus({
        phase: 'docker-unavailable',
        message: 'Docker is not installed.',
        installed: false,
        progress: null,
        canInstall: false,
        canStart: false,
        canStop: false
      })
      throw new ManagedDiarizationError('DOCKER_UNAVAILABLE', 'Docker is not installed.')
    }
    const version = await this.runner.run(
      this.dockerExecutable,
      ['version', '--format', '{{.Server.Version}}'],
      { signal, timeoutMs: DOCKER_COMMAND_TIMEOUT_MS }
    )
    if (version.exitCode !== 0) throw this.dockerResultError(version)
  }

  private async locateDocker(): Promise<string | null> {
    if (this.dockerExecutable) return this.dockerExecutable
    for (const candidate of this.dockerExecutableCandidates) {
      if (!candidate.startsWith('/')) continue
      try {
        await this.accessPath(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        // Continue through the fixed, trusted candidate list.
      }
    }
    return null
  }

  private async gpuGroupIds(): Promise<number[]> {
    const groups = new Set<number>()
    for (const device of ['/dev/kfd', '/dev/dri/renderD128', '/dev/dri/renderD129']) {
      try {
        groups.add((await this.statPath(device)).gid)
      } catch {
        // Optional device nodes; at least /dev/kfd resolved via prerequisites.
      }
    }
    return [...groups]
  }

  private async createContainer(signal: AbortSignal): Promise<void> {
    const existing = await this.inspectContainer(signal)
    if (existing) {
      if (!existing.owned) {
        throw new ManagedDiarizationError(
          'CONTAINER_CONFLICT',
          `A container named ${MANAGED_DIARIZATION_CONTAINER_NAME} exists but is not owned by SessionScribe.`
        )
      }
      const removed = await this.runDocker(
        ['container', 'rm', '--force', MANAGED_DIARIZATION_CONTAINER_NAME],
        signal
      )
      if (removed.exitCode !== 0) {
        throw new ManagedDiarizationError(
          'INSTALL_FAILED',
          'The old managed diarization container could not be replaced.'
        )
      }
    }

    const groupArgs = (await this.gpuGroupIds()).flatMap((gid) => ['--group-add', String(gid)])
    // The ro,z volume option relabels the models directory for SELinux hosts
    // (verified necessary on enforcing systems); it is a no-op elsewhere.
    // MIOpen JIT-compiles kernels on first use: it needs a writable HOME on
    // the tmpfs (noexec is fine — GPU code objects load via the kernel
    // driver) and enough of a pids budget for its compile worker threads.
    const args = [
      'container',
      'create',
      '--name',
      MANAGED_DIARIZATION_CONTAINER_NAME,
      '--label',
      `${MANAGED_DIARIZATION_LABEL_KEY}=${MANAGED_DIARIZATION_LABEL_VALUE}`,
      '--restart',
      'no',
      '--device',
      '/dev/kfd:/dev/kfd',
      '--device',
      '/dev/dri:/dev/dri',
      ...groupArgs,
      '--publish',
      '127.0.0.1::8000',
      '--network',
      'bridge',
      '--read-only',
      '--volume',
      `${this.modelDirectory}:/models:ro,z`,
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,noexec,size=2048m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '512',
      MANAGED_DIARIZATION_IMAGE_TAG
    ]
    const created = await this.runDocker(args, signal)
    if (created.exitCode !== 0) {
      throw new ManagedDiarizationError(
        'INSTALL_FAILED',
        'The managed diarization container could not be created.'
      )
    }
    const inspected = await this.inspectContainer(signal)
    if (!inspected) {
      throw new ManagedDiarizationError(
        'INSTALL_FAILED',
        'Docker did not create the managed diarization container.'
      )
    }
    this.assertOwnedContainer(inspected)
  }

  private ensureStarted(signal: AbortSignal): Promise<string> {
    if (this.startPromise) return this.startPromise
    if (this.installPromise || this.stopPromise) {
      return Promise.reject(
        new ManagedDiarizationError('BUSY', 'Diarization is busy with another operation.')
      )
    }
    if (this.shuttingDown) {
      return Promise.reject(new ManagedDiarizationError('BUSY', 'SessionScribe is shutting down.'))
    }
    const operation = this.performStart(signal)
      .catch(async (error: unknown) => {
        const normalized = this.normalize(
          error,
          'START_FAILED',
          'Diarization could not be started.'
        )
        await this.stopAfterFailedStart().catch(() => undefined)
        if (normalized.code === 'NOT_INSTALLED') {
          this.updateStatus({
            phase: 'not-installed',
            message: normalized.message,
            installed: false,
            progress: null,
            idleStopAt: null,
            canInstall: true,
            canStart: false,
            canStop: false
          })
        } else if (normalized.code === 'CANCELLED') {
          this.updateStatus({
            phase: 'stopped',
            message: 'Diarization startup was cancelled. VRAM is released.',
            installed: true,
            progress: null,
            idleStopAt: null,
            canInstall: false,
            canStart: true,
            canStop: false
          })
        } else if (normalized.code === 'START_FAILED') {
          this.updateStatus({
            phase: 'error',
            message: normalized.message,
            installed: true,
            progress: null,
            idleStopAt: null,
            canInstall: false,
            canStart: true,
            canStop: false
          })
        } else {
          this.setFailureStatus(normalized)
        }
        throw normalized
      })
      .finally(() => {
        this.startPromise = null
      })
    this.startPromise = operation
    return operation
  }

  private async performStart(signal: AbortSignal): Promise<string> {
    throwIfDiarizationCancelled(signal)
    await mkdir(this.modelDirectory, { recursive: true, mode: 0o700 })
    await this.checkPrerequisites(signal, false)
    const container = await this.inspectContainer(signal)
    if (!container || !(await this.artifactsPresent(signal))) {
      throw new ManagedDiarizationError('NOT_INSTALLED', 'Managed diarization is not installed.')
    }
    this.assertOwnedContainer(container)
    this.updateStatus({
      phase: 'starting',
      message: 'Diarization is loading the models into GPU memory…',
      installed: true,
      progress: null,
      idleStopAt: null,
      canInstall: false,
      canStart: false,
      canStop: false
    })
    if (!container.running) {
      const started = await this.runDocker(
        ['container', 'start', MANAGED_DIARIZATION_CONTAINER_NAME],
        signal,
        DOCKER_COMMAND_TIMEOUT_MS
      )
      if (started.exitCode !== 0) {
        throw new ManagedDiarizationError(
          'START_FAILED',
          'The managed diarization container could not be started.'
        )
      }
    }
    const origin = await this.waitUntilReady(signal)
    this.endpoint = origin
    this.updateStatus({
      phase: this.activeJobs > 0 ? 'busy' : 'ready',
      message: this.activeJobs > 0 ? 'Identifying speakers…' : 'Diarization is ready.',
      installed: true,
      progress: null,
      idleStopAt: null,
      canInstall: false,
      canStart: false,
      canStop: this.activeJobs === 0
    })
    return origin
  }

  private async waitUntilReady(signal: AbortSignal): Promise<string> {
    const deadline = this.now().getTime() + this.readinessTimeoutMs
    while (this.now().getTime() <= deadline) {
      throwIfDiarizationCancelled(signal)
      const container = await this.inspectContainer(signal)
      if (!container) break
      this.assertOwnedContainer(container)
      if (!container.running) break
      if (
        container.origin &&
        (await this.healthCheck(container.origin, signal).catch(() => false))
      ) {
        return container.origin
      }
      await this.wait(READINESS_POLL_MS, signal)
    }
    throw new ManagedDiarizationError('START_FAILED', 'Diarization did not finish loading in time.')
  }

  private async stopManagedContainer(signal: AbortSignal, force: boolean): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    if (!force && this.activeJobs > 0) return
    const operation = this.performStop(signal)
      .catch((error: unknown) => {
        const normalized = this.normalize(error, 'STOP_FAILED', 'Diarization could not be stopped.')
        if (normalized.code === 'STOP_FAILED') {
          this.updateStatus({
            phase: 'error',
            message: normalized.message,
            installed: true,
            progress: null,
            idleStopAt: null,
            canInstall: false,
            canStart: false,
            canStop: this.activeJobs === 0
          })
        } else {
          this.setFailureStatus(normalized)
        }
        throw normalized
      })
      .finally(() => {
        this.stopPromise = null
      })
    this.stopPromise = operation
    return operation
  }

  private async performStop(signal: AbortSignal): Promise<void> {
    this.cancelIdleStop()
    await this.checkStopPrerequisites(signal)
    const container = await this.inspectContainer(signal)
    if (!container) {
      this.endpoint = null
      this.updateStatus({
        phase: 'not-installed',
        message: 'Speaker identification is ready to be installed.',
        installed: false,
        progress: null,
        idleStopAt: null,
        canInstall: true,
        canStart: false,
        canStop: false
      })
      return
    }
    this.assertOwnedContainer(container)
    if (container.running) {
      this.updateStatus({
        phase: 'stopping',
        message: 'Diarization is stopping and releasing VRAM…',
        installed: true,
        idleStopAt: null,
        canInstall: false,
        canStart: false,
        canStop: false
      })
      const stopped = await this.runDocker(
        ['container', 'stop', '--time', '10', MANAGED_DIARIZATION_CONTAINER_NAME],
        signal,
        DOCKER_COMMAND_TIMEOUT_MS
      )
      if (stopped.exitCode !== 0) {
        throw new ManagedDiarizationError(
          'STOP_FAILED',
          'The managed diarization container could not be stopped.'
        )
      }
    }
    this.endpoint = null
    this.updateStatus({
      phase: 'stopped',
      message: 'Diarization is stopped. VRAM is released.',
      installed: true,
      progress: null,
      activeJobs: this.activeJobs,
      idleStopAt: null,
      canInstall: false,
      canStart: true,
      canStop: false
    })
  }

  private async stopAfterFailedStart(): Promise<void> {
    // Clear the endpoint and idle timer before the best-effort stop so no
    // failure path can leave a stale "running" signal behind.
    this.endpoint = null
    this.cancelIdleStop()
    if (!this.dockerExecutable) return
    const signal = new AbortController().signal
    const container = await this.inspectContainer(signal)
    if (!container?.owned || !container.running) return
    await this.runDocker(
      ['container', 'stop', '--time', '10', MANAGED_DIARIZATION_CONTAINER_NAME],
      signal,
      DOCKER_COMMAND_TIMEOUT_MS
    )
  }

  private scheduleIdleStop(): void {
    if (this.shuttingDown || this.activeJobs > 0 || !this.endpoint) return
    this.cancelIdleStop()
    const stopAt = new Date(this.now().getTime() + this.idleTimeoutMs).toISOString()
    this.idleTimer = this.scheduler.setTimeout(() => {
      this.idleTimer = null
      this.updateStatus({ idleStopAt: null })
      void this.stopIfIdle().catch(() => undefined)
    }, this.idleTimeoutMs)
    this.updateStatus({ idleStopAt: stopAt })
  }

  private cancelIdleStop(): void {
    if (this.idleTimer !== null) this.scheduler.clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private async inspectContainer(signal: AbortSignal): Promise<InspectedContainer | null> {
    const result = await this.runDocker(
      ['container', 'inspect', MANAGED_DIARIZATION_CONTAINER_NAME],
      signal,
      DOCKER_COMMAND_TIMEOUT_MS
    )
    if (result.exitCode !== 0) {
      if (/no such (?:object|container)/i.test(result.stderr)) return null
      throw this.dockerResultError(result)
    }
    let value: unknown
    try {
      value = JSON.parse(result.stdout)
    } catch (cause) {
      throw new ManagedDiarizationError(
        'DOCKER_UNAVAILABLE',
        'Docker returned an unreadable container description.',
        { cause }
      )
    }
    if (!Array.isArray(value) || value.length === 0) return null
    const entry = value[0] as {
      Config?: { Image?: unknown; Labels?: Record<string, unknown> }
      State?: { Running?: unknown }
      NetworkSettings?: {
        Ports?: Record<string, Array<{ HostIp?: unknown; HostPort?: unknown }> | null>
      }
    }
    const labels = entry.Config?.Labels ?? {}
    const owned = labels[MANAGED_DIARIZATION_LABEL_KEY] === MANAGED_DIARIZATION_LABEL_VALUE
    const expectedImage = entry.Config?.Image === MANAGED_DIARIZATION_IMAGE_TAG
    const running = entry.State?.Running === true
    let origin: string | null = null
    const bindings = entry.NetworkSettings?.Ports?.['8000/tcp']
    if (Array.isArray(bindings)) {
      for (const binding of bindings) {
        if (binding?.HostIp === '127.0.0.1' && typeof binding.HostPort === 'string') {
          origin = `http://127.0.0.1:${binding.HostPort}`
          break
        }
      }
    }
    return { owned, expectedImage, running, origin }
  }

  private assertOwnedContainer(container: InspectedContainer): void {
    if (!container.owned || !container.expectedImage) {
      throw new ManagedDiarizationError(
        'CONTAINER_CONFLICT',
        `A container named ${MANAGED_DIARIZATION_CONTAINER_NAME} exists but is not owned by SessionScribe.`
      )
    }
  }

  private async artifactsPresent(signal: AbortSignal): Promise<boolean> {
    for (const asset of this.modelAssets) {
      const path = join(this.modelDirectory, ...asset.relativePath.split('/'))
      try {
        if (!(await verifyFile(path, asset, signal))) return false
      } catch (error) {
        throw this.normalize(error, 'INTEGRITY_FAILED', 'Speaker model verification failed.')
      }
    }
    const image = await this.runDocker(
      ['image', 'inspect', MANAGED_DIARIZATION_IMAGE_TAG],
      signal,
      DOCKER_COMMAND_TIMEOUT_MS
    )
    return image.exitCode === 0
  }

  private async runDocker(
    args: readonly string[],
    signal: AbortSignal,
    timeoutMs: number = DOCKER_COMMAND_TIMEOUT_MS
  ): Promise<WhisperCommandResult> {
    throwIfDiarizationCancelled(signal)
    if (!this.dockerExecutable) {
      throw new ManagedDiarizationError('DOCKER_UNAVAILABLE', 'Docker is not installed.')
    }
    try {
      return await this.runner.run(this.dockerExecutable, args, { signal, timeoutMs })
    } catch (error) {
      throw this.normalize(error, 'DOCKER_UNAVAILABLE', 'Docker could not be reached.')
    }
  }

  private dockerResultError(result: WhisperCommandResult): ManagedDiarizationError {
    if (/permission denied|connect: (?:permission|access)/i.test(result.stderr)) {
      this.updateStatus({
        phase: 'permission-denied',
        message: 'SessionScribe does not have permission to use Docker.',
        installed: false,
        progress: null,
        canInstall: false,
        canStart: false,
        canStop: false
      })
      return new ManagedDiarizationError(
        'PERMISSION_DENIED',
        'SessionScribe does not have permission to use Docker.'
      )
    }
    return new ManagedDiarizationError('DOCKER_UNAVAILABLE', 'Docker reported an error.')
  }

  private async defaultHealthCheck(origin: string, signal: AbortSignal): Promise<boolean> {
    const timeout = AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS)
    try {
      const response = await this.fetch(`${origin}/health`, {
        method: 'GET',
        signal: AbortSignal.any([signal, timeout])
      })
      if (!response.ok) return false
      const body = (await response.json()) as { status?: unknown }
      return body.status === 'ok'
    } catch {
      return false
    }
  }

  private normalize(
    error: unknown,
    fallbackCode: ManagedDiarizationError['code'],
    fallbackMessage: string
  ): ManagedDiarizationError {
    if (error instanceof ManagedDiarizationError) return error
    if (error instanceof ManagedWhisperError) {
      const code =
        error.code === 'DOWNLOAD_FAILED' ||
        error.code === 'INTEGRITY_FAILED' ||
        error.code === 'CANCELLED' ||
        error.code === 'DOCKER_UNAVAILABLE'
          ? error.code
          : fallbackCode
      return new ManagedDiarizationError(code, error.message, { cause: error })
    }
    return new ManagedDiarizationError(fallbackCode, fallbackMessage, { cause: error })
  }

  private setFailureStatus(error: unknown): void {
    const normalized = this.normalize(
      error,
      'DOCKER_UNAVAILABLE',
      'Managed diarization encountered an error.'
    )
    if (
      normalized.code === 'PERMISSION_DENIED' ||
      normalized.code === 'DOCKER_UNAVAILABLE' ||
      normalized.code === 'UNSUPPORTED'
    ) {
      if (this.currentStatus.phase !== 'installing') return
    }
    this.updateStatus({
      phase: 'error',
      message: normalized.message,
      installed: false,
      progress: null,
      idleStopAt: null,
      canInstall: false,
      canStart: false,
      canStop: false
    })
  }

  private updateStatus(changes: Partial<ManagedDiarizationStatus>): void {
    const next: ManagedDiarizationStatus = {
      ...this.currentStatus,
      ...changes,
      activeJobs: changes.activeJobs ?? this.activeJobs
    }
    if (JSON.stringify(next) === JSON.stringify(this.currentStatus)) return
    this.currentStatus = next
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  private snapshot(): ManagedDiarizationStatus {
    return {
      ...this.currentStatus,
      progress: this.currentStatus.progress ? { ...this.currentStatus.progress } : null
    }
  }
}

function makeStatus(
  phase: ManagedDiarizationStatus['phase'],
  message: string,
  installed: boolean
): ManagedDiarizationStatus {
  return {
    phase,
    message,
    installed,
    progress: null,
    activeJobs: 0,
    idleStopAt: null,
    canInstall: false,
    canStart: false,
    canStop: false
  }
}

function progress(step: ManagedDiarizationProgress['step']): ManagedDiarizationProgress {
  return { step, completedBytes: null, totalBytes: null }
}

function parseSegments(parsed: unknown): DiarizationSegment[] {
  const body = parsed as { segments?: unknown }
  if (!Array.isArray(body.segments)) {
    throw new ManagedDiarizationError(
      'REQUEST_FAILED',
      'The diarization response is missing segments.'
    )
  }
  const segments: DiarizationSegment[] = []
  for (const entry of body.segments) {
    const candidate = entry as { startMs?: unknown; endMs?: unknown; speaker?: unknown }
    if (
      typeof candidate.startMs !== 'number' ||
      typeof candidate.endMs !== 'number' ||
      typeof candidate.speaker !== 'string' ||
      !Number.isFinite(candidate.startMs) ||
      !Number.isFinite(candidate.endMs) ||
      candidate.startMs < 0 ||
      candidate.endMs < candidate.startMs
    ) {
      throw new ManagedDiarizationError(
        'REQUEST_FAILED',
        'The diarization response contains an invalid segment.'
      )
    }
    segments.push({
      startMs: Math.round(candidate.startMs),
      endMs: Math.round(candidate.endMs),
      speaker: candidate.speaker
    })
  }
  return segments
}

async function defaultFreeDiskBytes(path: string): Promise<number> {
  const stats = await statfs(path)
  return stats.bavail * stats.bsize
}

function waitWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal.aborted) {
      reject(managedDiarizationCancelled(signal.reason))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveWait()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(managedDiarizationCancelled(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer.unref?.()
  })
}

const defaultScheduler: ManagedDiarizationScheduler = {
  setTimeout(callback, milliseconds) {
    const handle = setTimeout(callback, milliseconds)
    handle.unref?.()
    return handle
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout)
  }
}
