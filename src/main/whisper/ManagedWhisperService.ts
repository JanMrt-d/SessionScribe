import { constants as fsConstants } from 'node:fs'
import { access, mkdir, rename, stat, statfs, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { ManagedWhisperProgress, ManagedWhisperStatus } from '@shared/whisper'

import {
  MANAGED_WHISPER_CONTAINER_NAME,
  MANAGED_WHISPER_IDLE_TIMEOUT_MS,
  MANAGED_WHISPER_IMAGE,
  MANAGED_WHISPER_LABEL_KEY,
  MANAGED_WHISPER_LABEL_VALUE,
  MANAGED_WHISPER_MINIMUM_FREE_BYTES,
  MANAGED_WHISPER_READINESS_TIMEOUT_MS,
  WHISPER_LARGE_V3_ASSET,
  WHISPER_SILERO_VAD_ASSET,
  type WhisperDownloadAsset
} from './constants'
import { downloadVerifiedAsset, verifyFile, type WhisperFetch } from './download'
import {
  ManagedWhisperError,
  type ManagedWhisperErrorCode,
  managedWhisperCancelled,
  throwIfWhisperCancelled
} from './errors'
import {
  SpawnWhisperCommandRunner,
  type WhisperCommandResult,
  type WhisperCommandRunner
} from './process'

const DOCKER_COMMAND_TIMEOUT_MS = 30_000
const DOCKER_PULL_TIMEOUT_MS = 30 * 60 * 1_000
const HEALTH_REQUEST_TIMEOUT_MS = 2_000
const READINESS_POLL_MS = 250
const INSTALL_MANIFEST_FILE = 'managed-whisper-v1.json'

const DEFAULT_DOCKER_EXECUTABLES = ['/usr/bin/docker', '/usr/local/bin/docker'] as const

/**
 * Conditions under which `stopIfIdle` has nothing to release: managed Whisper is
 * unsupported here, Docker is missing, its socket is not accessible, or nothing was
 * ever installed. A best-effort pre-summary stop must swallow these so a local
 * summary still proceeds. A running container that refuses to stop (`STOP_FAILED`)
 * and cancellation are deliberately excluded so they still propagate.
 */
const IGNORABLE_STOP_IF_IDLE_CODES: ReadonlySet<ManagedWhisperErrorCode> = new Set([
  'UNSUPPORTED',
  'DOCKER_UNAVAILABLE',
  'PERMISSION_DENIED',
  'NOT_INSTALLED'
])

export interface ManagedWhisperLease {
  /** OpenAI-compatible base URL. The caller appends /audio/transcriptions. */
  readonly endpoint: string
  release(): Promise<void>
}

export interface ManagedWhisperScheduler {
  setTimeout(callback: () => void, milliseconds: number): object | number
  clearTimeout(handle: object | number): void
}

export interface ManagedWhisperServiceOptions {
  readonly dataDirectory: string
  readonly platform?: NodeJS.Platform
  readonly architecture?: string
  readonly dockerExecutableCandidates?: readonly string[]
  readonly runner?: WhisperCommandRunner
  readonly fetch?: WhisperFetch
  readonly accessPath?: (path: string, mode: number) => Promise<void>
  readonly freeDiskBytes?: (path: string) => Promise<number>
  readonly now?: () => Date
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly scheduler?: ManagedWhisperScheduler
  readonly healthCheck?: (origin: string, signal: AbortSignal) => Promise<boolean>
  readonly idleTimeoutMs?: number
  readonly readinessTimeoutMs?: number
  /** Intended for small deterministic test assets; production uses the pinned exports. */
  readonly modelAsset?: WhisperDownloadAsset
  /** Intended for small deterministic test assets; production uses the pinned exports. */
  readonly vadAsset?: WhisperDownloadAsset
}

interface InspectedContainer {
  readonly owned: boolean
  readonly expectedImage: boolean
  readonly running: boolean
  readonly origin: string | null
}

export class ManagedWhisperService {
  private readonly dataDirectory: string
  private readonly modelDirectory: string
  private readonly platform: NodeJS.Platform
  private readonly architecture: string
  private readonly dockerExecutableCandidates: readonly string[]
  private readonly runner: WhisperCommandRunner
  private readonly fetch: WhisperFetch
  private readonly accessPath: (path: string, mode: number) => Promise<void>
  private readonly freeDiskBytes: (path: string) => Promise<number>
  private readonly now: () => Date
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly scheduler: ManagedWhisperScheduler
  private readonly healthCheck: (origin: string, signal: AbortSignal) => Promise<boolean>
  private readonly idleTimeoutMs: number
  private readonly readinessTimeoutMs: number
  private readonly modelAsset: WhisperDownloadAsset
  private readonly vadAsset: WhisperDownloadAsset
  private readonly listeners = new Set<(status: ManagedWhisperStatus) => void>()

  private currentStatus: ManagedWhisperStatus
  private dockerExecutable: string | null = null
  private endpoint: string | null = null
  private activeTranscriptions = 0
  private idleTimer: object | number | null = null
  private installController: AbortController | null = null
  private installPromise: Promise<ManagedWhisperStatus> | null = null
  private startPromise: Promise<string> | null = null
  private stopPromise: Promise<void> | null = null
  private artifactsVerified = false
  private shuttingDown = false

  constructor(options: ManagedWhisperServiceOptions) {
    this.dataDirectory = resolve(options.dataDirectory)
    this.modelDirectory = join(this.dataDirectory, 'whisper', 'models')
    if (this.modelDirectory.includes(',') || this.modelDirectory.includes('\0')) {
      throw new ManagedWhisperError(
        'UNSUPPORTED',
        'The application data path cannot be used for the managed Whisper container.'
      )
    }
    this.platform = options.platform ?? process.platform
    this.architecture = options.architecture ?? process.arch
    this.dockerExecutableCandidates =
      options.dockerExecutableCandidates ?? DEFAULT_DOCKER_EXECUTABLES
    this.runner = options.runner ?? new SpawnWhisperCommandRunner()
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init))
    this.accessPath = options.accessPath ?? access
    this.freeDiskBytes = options.freeDiskBytes ?? defaultFreeDiskBytes
    this.now = options.now ?? (() => new Date())
    this.wait = options.wait ?? waitWithAbort
    this.scheduler = options.scheduler ?? defaultScheduler
    this.healthCheck =
      options.healthCheck ?? ((origin, signal) => this.defaultHealthCheck(origin, signal))
    this.idleTimeoutMs = options.idleTimeoutMs ?? MANAGED_WHISPER_IDLE_TIMEOUT_MS
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? MANAGED_WHISPER_READINESS_TIMEOUT_MS
    this.modelAsset = options.modelAsset ?? WHISPER_LARGE_V3_ASSET
    this.vadAsset = options.vadAsset ?? WHISPER_SILERO_VAD_ASSET
    validateAsset(this.modelAsset)
    validateAsset(this.vadAsset)
    if (this.idleTimeoutMs < 0 || this.readinessTimeoutMs <= 0) {
      throw new ManagedWhisperError('UNSUPPORTED', 'Managed Whisper timeout settings are invalid.')
    }
    this.currentStatus = makeStatus(
      this.platform === 'linux' && this.architecture === 'x64'
        ? 'docker-unavailable'
        : 'unsupported',
      this.platform === 'linux' && this.architecture === 'x64'
        ? 'Docker status has not been checked.'
        : 'Managed Whisper requires Linux x64 with Vulkan.',
      false
    )
  }

  subscribe(listener: (status: ManagedWhisperStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async status(signal?: AbortSignal): Promise<ManagedWhisperStatus> {
    throwIfWhisperCancelled(signal)
    if (this.installPromise || this.startPromise || this.stopPromise) return this.snapshot()
    try {
      await this.refreshStatus(signal ?? new AbortController().signal)
    } catch (error) {
      if (error instanceof ManagedWhisperError && error.code === 'CANCELLED') throw error
      this.setFailureStatus(error)
    }
    return this.snapshot()
  }

  install(signal?: AbortSignal): Promise<ManagedWhisperStatus> {
    if (this.installPromise) return this.installPromise
    if (this.startPromise || this.stopPromise || this.activeTranscriptions > 0) {
      return Promise.reject(
        new ManagedWhisperError('BUSY', 'Whisper cannot be installed while it is in use.')
      )
    }
    if (this.shuttingDown) {
      return Promise.reject(new ManagedWhisperError('BUSY', 'SessionScribe is shutting down.'))
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
            message: 'Whisper setup was cancelled. A partial download can be resumed.',
            installed: false,
            progress: null,
            canInstall: true,
            canStart: false,
            canStop: false
          })
          throw managedWhisperCancelled(controller.signal.reason)
        }
        this.setFailureStatus(error, true)
        throw normalizeError(error, 'INSTALL_FAILED', 'Whisper setup failed.')
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

  async start(signal?: AbortSignal): Promise<ManagedWhisperStatus> {
    throwIfWhisperCancelled(signal)
    await this.ensureStarted(signal ?? new AbortController().signal)
    if (this.activeTranscriptions === 0) this.scheduleIdleStop()
    return this.snapshot()
  }

  async stop(signal?: AbortSignal): Promise<ManagedWhisperStatus> {
    if (this.activeTranscriptions > 0) {
      throw new ManagedWhisperError('BUSY', 'Whisper cannot stop during transcription.')
    }
    if (this.installPromise) {
      throw new ManagedWhisperError('BUSY', 'Whisper cannot stop during setup.')
    }
    await this.stopManagedContainer(signal ?? new AbortController().signal, false)
    return this.snapshot()
  }

  async acquire(signal?: AbortSignal): Promise<ManagedWhisperLease> {
    throwIfWhisperCancelled(signal)
    if (this.shuttingDown) {
      throw new ManagedWhisperError('BUSY', 'SessionScribe is shutting down.')
    }
    this.cancelIdleStop()
    this.activeTranscriptions += 1
    this.updateStatus({ activeTranscriptions: this.activeTranscriptions, idleStopAt: null })

    let acquiredEndpoint: string
    try {
      acquiredEndpoint = await this.ensureStarted(signal ?? new AbortController().signal)
    } catch (error) {
      this.activeTranscriptions -= 1
      this.updateStatus({ activeTranscriptions: this.activeTranscriptions })
      if (this.activeTranscriptions === 0 && this.endpoint) this.scheduleIdleStop()
      throw error
    }

    this.updateStatus({
      phase: 'busy',
      message: 'Whisper is transcribing.',
      installed: true,
      activeTranscriptions: this.activeTranscriptions,
      canInstall: false,
      canStart: false,
      canStop: false
    })
    let released = false
    return {
      endpoint: acquiredEndpoint,
      release: async () => {
        if (released) return
        released = true
        this.activeTranscriptions = Math.max(0, this.activeTranscriptions - 1)
        this.updateStatus({
          phase: this.activeTranscriptions === 0 ? 'ready' : 'busy',
          message:
            this.activeTranscriptions === 0 ? 'Whisper is ready.' : 'Whisper is transcribing.',
          activeTranscriptions: this.activeTranscriptions,
          canStop: this.activeTranscriptions === 0
        })
        if (this.activeTranscriptions === 0) this.scheduleIdleStop()
      }
    }
  }

  async stopIfIdle(signal?: AbortSignal): Promise<void> {
    if (this.activeTranscriptions > 0) return
    try {
      await this.stopManagedContainer(signal ?? new AbortController().signal, false)
    } catch (error) {
      if (error instanceof ManagedWhisperError && IGNORABLE_STOP_IF_IDLE_CODES.has(error.code)) {
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
    this.activeTranscriptions = 0
    await this.stopManagedContainer(signal ?? new AbortController().signal, true).catch(
      () => undefined
    )
    this.listeners.clear()
  }

  private async performInstall(signal: AbortSignal): Promise<void> {
    this.updateStatus({
      phase: 'installing',
      message: 'Checking the local Whisper requirements…',
      installed: false,
      progress: progress('checking'),
      idleStopAt: null,
      canInstall: false,
      canStart: false,
      canStop: false
    })
    await mkdir(this.modelDirectory, { recursive: true, mode: 0o700 })
    await this.checkPrerequisites(signal, true)

    this.updateInstallProgress('pulling-image', 'Downloading the Whisper Vulkan container…')
    const pull = await this.runDocker(
      ['image', 'pull', MANAGED_WHISPER_IMAGE],
      signal,
      DOCKER_PULL_TIMEOUT_MS
    )
    this.ensureDockerSuccess(
      pull,
      'INSTALL_FAILED',
      'The Whisper container image could not be downloaded.'
    )

    this.updateInstallProgress(
      'downloading-model',
      'Downloading Whisper Large-v3…',
      0,
      this.modelAsset.size
    )
    await downloadVerifiedAsset({
      asset: this.modelAsset,
      directory: this.modelDirectory,
      fetch: this.fetch,
      signal,
      onProgress: (completedBytes, totalBytes) => {
        this.updateInstallProgress(
          'downloading-model',
          'Downloading Whisper Large-v3…',
          completedBytes,
          totalBytes
        )
      }
    })

    this.updateInstallProgress(
      'downloading-vad',
      'Downloading voice activity detection…',
      0,
      this.vadAsset.size
    )
    await downloadVerifiedAsset({
      asset: this.vadAsset,
      directory: this.modelDirectory,
      fetch: this.fetch,
      signal,
      onProgress: (completedBytes, totalBytes) => {
        this.updateInstallProgress(
          'downloading-vad',
          'Downloading voice activity detection…',
          completedBytes,
          totalBytes
        )
      }
    })
    this.artifactsVerified = true

    this.updateInstallProgress('creating-container', 'Creating the managed Whisper container…')
    await this.createContainer(signal)
    await this.writeInstallManifest()
    this.endpoint = null
    this.updateStatus({
      phase: 'stopped',
      message: 'Whisper is stopped. VRAM is released.',
      installed: true,
      progress: null,
      activeTranscriptions: 0,
      idleStopAt: null,
      canInstall: false,
      canStart: true,
      canStop: false
    })
  }

  private async refreshStatus(signal: AbortSignal): Promise<void> {
    await mkdir(this.modelDirectory, { recursive: true, mode: 0o700 })
    await this.checkPrerequisites(signal, false)
    const container = await this.inspectContainer(signal)
    if (!container) {
      this.endpoint = null
      this.cancelIdleStop()
      this.updateStatus({
        phase: 'not-installed',
        message: 'Whisper is ready to be installed.',
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
    if (!(await this.artifactsPresent())) {
      this.updateStatus({
        phase: 'error',
        message: 'The managed Whisper model files are incomplete. Run setup again.',
        installed: false,
        progress: null,
        idleStopAt: null,
        canInstall: true,
        canStart: false,
        canStop: false
      })
      return
    }
    if (!container.running) {
      this.endpoint = null
      this.cancelIdleStop()
      this.updateStatus({
        phase: 'stopped',
        message: 'Whisper is stopped. VRAM is released.',
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
      throw new ManagedWhisperError('START_FAILED', 'Docker did not expose Whisper on loopback.')
    }
    this.endpoint = `${container.origin}/v1`
    const ready = await this.healthCheck(container.origin, signal).catch(() => false)
    this.updateStatus({
      phase: ready ? (this.activeTranscriptions > 0 ? 'busy' : 'ready') : 'starting',
      message: ready
        ? this.activeTranscriptions > 0
          ? 'Whisper is transcribing.'
          : 'Whisper is ready.'
        : 'Whisper is loading the model into GPU memory…',
      installed: true,
      progress: null,
      canInstall: false,
      canStart: false,
      canStop: this.activeTranscriptions === 0
    })
    if (this.activeTranscriptions === 0 && !this.idleTimer) this.scheduleIdleStop()
  }

  private async checkPrerequisites(signal: AbortSignal, checkDisk: boolean): Promise<void> {
    await this.checkStopPrerequisites(signal)

    try {
      await this.accessPath('/dev/dri', fsConstants.R_OK)
    } catch (cause) {
      this.updateStatus({
        phase: 'unsupported',
        message: 'Vulkan GPU access through /dev/dri is unavailable.',
        installed: false,
        progress: null,
        canInstall: false,
        canStart: false,
        canStop: false
      })
      throw new ManagedWhisperError(
        'UNSUPPORTED',
        'Vulkan GPU access through /dev/dri is unavailable.',
        { cause }
      )
    }
    if (checkDisk) {
      const availableBytes = await this.freeDiskBytes(this.modelDirectory)
      if (availableBytes < MANAGED_WHISPER_MINIMUM_FREE_BYTES) {
        throw new ManagedWhisperError(
          'INSUFFICIENT_DISK_SPACE',
          'At least 6 GiB of free disk space is required for Whisper setup.'
        )
      }
    }
  }

  /**
   * Prerequisites for controlling an existing container's lifecycle (stop/shutdown):
   * a supported platform and a responsive Docker client. Unlike start and install,
   * stopping must not require GPU (`/dev/dri`) or disk headroom — releasing VRAM has
   * to succeed even when the machine can no longer run inference.
   */
  private async checkStopPrerequisites(signal: AbortSignal): Promise<void> {
    throwIfWhisperCancelled(signal)
    if (this.platform !== 'linux' || this.architecture !== 'x64') {
      this.updateStatus({
        phase: 'unsupported',
        message: 'Managed Whisper requires Linux x64 with Vulkan.',
        installed: false,
        progress: null,
        canInstall: false,
        canStart: false,
        canStop: false
      })
      throw new ManagedWhisperError(
        'UNSUPPORTED',
        'Managed Whisper requires Linux x64 with Vulkan.'
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
      throw new ManagedWhisperError('DOCKER_UNAVAILABLE', 'Docker is not installed.')
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

  private async createContainer(signal: AbortSignal): Promise<void> {
    const existing = await this.inspectContainer(signal)
    if (existing) {
      if (!existing.owned) {
        throw new ManagedWhisperError(
          'CONTAINER_CONFLICT',
          `A container named ${MANAGED_WHISPER_CONTAINER_NAME} exists but is not owned by SessionScribe.`
        )
      }
      const removed = await this.runDocker(
        ['container', 'rm', '--force', MANAGED_WHISPER_CONTAINER_NAME],
        signal
      )
      this.ensureDockerSuccess(
        removed,
        'INSTALL_FAILED',
        'The old managed Whisper container could not be replaced.'
      )
    }

    // The ro,z volume option relabels the models directory for SELinux hosts
    // (a plain read-only bind mount is rejected with EACCES there); it is a
    // no-op on systems without SELinux.
    const args = [
      'container',
      'create',
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
      '--network',
      'bridge',
      '--read-only',
      '--volume',
      `${this.modelDirectory}:/models:ro,z`,
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,noexec,size=512m',
      '--tmpfs',
      '/root/.cache:rw,nosuid,nodev,noexec,size=256m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '256',
      '--entrypoint',
      '/app/build/bin/whisper-server',
      MANAGED_WHISPER_IMAGE,
      '--model',
      `/models/${this.modelAsset.fileName}`,
      '--host',
      '0.0.0.0',
      '--port',
      '8080',
      '--inference-path',
      '/v1/audio/transcriptions',
      '--language',
      'auto',
      '--threads',
      '8',
      '--vad',
      '--vad-model',
      `/models/${this.vadAsset.fileName}`,
      '--convert',
      '--tmp-dir',
      '/tmp',
      '--no-language-probabilities'
    ]
    const created = await this.runDocker(args, signal)
    this.ensureDockerSuccess(
      created,
      'INSTALL_FAILED',
      'The managed Whisper container could not be created.'
    )
    const inspected = await this.inspectContainer(signal)
    if (!inspected) {
      throw new ManagedWhisperError(
        'INSTALL_FAILED',
        'Docker did not create the managed Whisper container.'
      )
    }
    this.assertOwnedContainer(inspected)
  }

  private ensureStarted(signal: AbortSignal): Promise<string> {
    if (this.startPromise) return this.startPromise
    if (this.installPromise || this.stopPromise) {
      return Promise.reject(
        new ManagedWhisperError('BUSY', 'Whisper is busy with another operation.')
      )
    }
    if (this.shuttingDown) {
      return Promise.reject(new ManagedWhisperError('BUSY', 'SessionScribe is shutting down.'))
    }
    const operation = this.performStart(signal)
      .catch(async (error: unknown) => {
        const normalized = normalizeError(error, 'START_FAILED', 'Whisper could not be started.')
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
            message: 'Whisper startup was cancelled. VRAM is released.',
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
    throwIfWhisperCancelled(signal)
    await mkdir(this.modelDirectory, { recursive: true, mode: 0o700 })
    await this.checkPrerequisites(signal, false)
    const container = await this.inspectContainer(signal)
    if (!container || !(await this.artifactsPresent())) {
      throw new ManagedWhisperError('NOT_INSTALLED', 'Managed Whisper is not installed.')
    }
    this.assertOwnedContainer(container)
    this.updateStatus({
      phase: 'starting',
      message: 'Whisper is loading the model into GPU memory…',
      installed: true,
      progress: null,
      idleStopAt: null,
      canInstall: false,
      canStart: false,
      canStop: false
    })
    if (!container.running) {
      const started = await this.runDocker(
        ['container', 'start', MANAGED_WHISPER_CONTAINER_NAME],
        signal,
        DOCKER_COMMAND_TIMEOUT_MS
      )
      this.ensureDockerSuccess(
        started,
        'START_FAILED',
        'The managed Whisper container could not be started.'
      )
    }
    const origin = await this.waitUntilReady(signal)
    this.endpoint = `${origin}/v1`
    this.updateStatus({
      phase: this.activeTranscriptions > 0 ? 'busy' : 'ready',
      message: this.activeTranscriptions > 0 ? 'Whisper is transcribing.' : 'Whisper is ready.',
      installed: true,
      progress: null,
      idleStopAt: null,
      canInstall: false,
      canStart: false,
      canStop: this.activeTranscriptions === 0
    })
    return this.endpoint
  }

  private async waitUntilReady(signal: AbortSignal): Promise<string> {
    const deadline = this.now().getTime() + this.readinessTimeoutMs
    while (this.now().getTime() <= deadline) {
      throwIfWhisperCancelled(signal)
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
    throw new ManagedWhisperError(
      'START_FAILED',
      'Whisper did not finish loading within two minutes.'
    )
  }

  private async stopManagedContainer(signal: AbortSignal, force: boolean): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    if (!force && this.activeTranscriptions > 0) return
    const operation = this.performStop(signal)
      .catch((error: unknown) => {
        const normalized = normalizeError(error, 'STOP_FAILED', 'Whisper could not be stopped.')
        if (normalized.code === 'STOP_FAILED') {
          this.updateStatus({
            phase: 'error',
            message: normalized.message,
            installed: true,
            progress: null,
            idleStopAt: null,
            canInstall: false,
            canStart: false,
            canStop: this.activeTranscriptions === 0
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
        message: 'Whisper is ready to be installed.',
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
        message: 'Whisper is stopping and releasing VRAM…',
        installed: true,
        idleStopAt: null,
        canInstall: false,
        canStart: false,
        canStop: false
      })
      const stopped = await this.runDocker(
        ['container', 'stop', '--time', '10', MANAGED_WHISPER_CONTAINER_NAME],
        signal,
        DOCKER_COMMAND_TIMEOUT_MS
      )
      this.ensureDockerSuccess(
        stopped,
        'STOP_FAILED',
        'The managed Whisper container could not be stopped.'
      )
    }
    this.endpoint = null
    this.updateStatus({
      phase: 'stopped',
      message: 'Whisper is stopped. VRAM is released.',
      installed: true,
      progress: null,
      activeTranscriptions: this.activeTranscriptions,
      idleStopAt: null,
      canInstall: false,
      canStart: true,
      canStop: false
    })
  }

  private async stopAfterFailedStart(): Promise<void> {
    // A failed start must never leave a stale endpoint or idle-stop timer behind:
    // acquire() and scheduleIdleStop() treat a non-null endpoint as a running
    // container, so clear both before the best-effort container stop below.
    this.endpoint = null
    this.cancelIdleStop()
    if (!this.dockerExecutable) return
    const signal = new AbortController().signal
    const container = await this.inspectContainer(signal)
    if (!container?.owned || !container.running) return
    await this.runDocker(
      ['container', 'stop', '--time', '10', MANAGED_WHISPER_CONTAINER_NAME],
      signal,
      DOCKER_COMMAND_TIMEOUT_MS
    )
  }

  private scheduleIdleStop(): void {
    if (this.shuttingDown || this.activeTranscriptions > 0 || !this.endpoint) return
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
      ['container', 'inspect', MANAGED_WHISPER_CONTAINER_NAME],
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
      throw new ManagedWhisperError(
        'DOCKER_UNAVAILABLE',
        'Docker returned invalid container information.',
        {
          cause
        }
      )
    }
    const record: unknown = Array.isArray(value) ? value[0] : null
    if (!isRecord(record)) {
      throw new ManagedWhisperError(
        'DOCKER_UNAVAILABLE',
        'Docker returned invalid container information.'
      )
    }
    const config = isRecord(record.Config) ? record.Config : {}
    const labels = isRecord(config.Labels) ? config.Labels : {}
    const state = isRecord(record.State) ? record.State : {}
    const network = isRecord(record.NetworkSettings) ? record.NetworkSettings : {}
    const ports = isRecord(network.Ports) ? network.Ports : {}
    return {
      owned: labels[MANAGED_WHISPER_LABEL_KEY] === MANAGED_WHISPER_LABEL_VALUE,
      expectedImage: config.Image === MANAGED_WHISPER_IMAGE,
      running: state.Running === true,
      origin: parseLoopbackOrigin(ports['8080/tcp'])
    }
  }

  private assertOwnedContainer(container: InspectedContainer): void {
    if (!container.owned) {
      throw new ManagedWhisperError(
        'CONTAINER_CONFLICT',
        `A container named ${MANAGED_WHISPER_CONTAINER_NAME} exists but is not owned by SessionScribe.`
      )
    }
    if (!container.expectedImage) {
      throw new ManagedWhisperError(
        'CONTAINER_CONFLICT',
        'The managed Whisper container does not use the pinned image. Run setup again.'
      )
    }
  }

  private async artifactsPresent(): Promise<boolean> {
    const modelPath = join(this.modelDirectory, this.modelAsset.fileName)
    const vadPath = join(this.modelDirectory, this.vadAsset.fileName)
    if (this.artifactsVerified) {
      return (
        (await hasExactSize(modelPath, this.modelAsset.size)) &&
        (await hasExactSize(vadPath, this.vadAsset.size))
      )
    }
    const verified =
      (await verifyFile(modelPath, this.modelAsset)) && (await verifyFile(vadPath, this.vadAsset))
    this.artifactsVerified = verified
    return verified
  }

  private async writeInstallManifest(): Promise<void> {
    const directory = join(this.dataDirectory, 'whisper')
    const finalPath = join(directory, INSTALL_MANIFEST_FILE)
    const temporaryPath = `${finalPath}.part`
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const contents = JSON.stringify({
      version: 1,
      image: MANAGED_WHISPER_IMAGE,
      model: pickAssetMetadata(this.modelAsset),
      vad: pickAssetMetadata(this.vadAsset),
      verifiedAt: this.now().toISOString()
    })
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, finalPath)
  }

  private async runDocker(
    args: readonly string[],
    signal: AbortSignal,
    timeoutMs = DOCKER_COMMAND_TIMEOUT_MS
  ): Promise<WhisperCommandResult> {
    throwIfWhisperCancelled(signal)
    if (!this.dockerExecutable) {
      throw new ManagedWhisperError('DOCKER_UNAVAILABLE', 'Docker is not available.')
    }
    return this.runner.run(this.dockerExecutable, args, { signal, timeoutMs })
  }

  private ensureDockerSuccess(
    result: WhisperCommandResult,
    code: 'INSTALL_FAILED' | 'START_FAILED' | 'STOP_FAILED',
    message: string
  ): void {
    if (result.exitCode === 0) return
    const diagnostic = `${result.stderr}\n${result.stdout}`
    if (
      /permission denied|access denied|cannot connect|daemon is not running|is the docker daemon running/i.test(
        diagnostic
      )
    ) {
      throw this.dockerResultError(result)
    }
    throw new ManagedWhisperError(code, message)
  }

  private dockerResultError(result: WhisperCommandResult): ManagedWhisperError {
    const diagnostic = `${result.stderr}\n${result.stdout}`
    if (/permission denied|access denied/i.test(diagnostic)) {
      this.updateStatus({
        phase: 'permission-denied',
        message:
          'SessionScribe cannot access Docker. Configure rootless Docker or Docker group access.',
        installed: false,
        progress: null,
        canInstall: false,
        canStart: false,
        canStop: false
      })
      return new ManagedWhisperError(
        'PERMISSION_DENIED',
        'SessionScribe cannot access Docker. Configure rootless Docker or Docker group access.'
      )
    }
    if (/cannot connect|daemon is not running|is the docker daemon running/i.test(diagnostic)) {
      this.updateStatus({
        phase: 'docker-unavailable',
        message: 'The Docker daemon is not running.',
        installed: false,
        progress: null,
        canInstall: false,
        canStart: false,
        canStop: false
      })
      return new ManagedWhisperError('DOCKER_UNAVAILABLE', 'The Docker daemon is not running.')
    }
    return new ManagedWhisperError('DOCKER_UNAVAILABLE', 'Docker could not complete the operation.')
  }

  private async defaultHealthCheck(origin: string, signal: AbortSignal): Promise<boolean> {
    const timeoutSignal = AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS)
    const response = await this.fetch(`${origin}/health`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.any([signal, timeoutSignal])
    })
    if (!response.ok) return false
    const body: unknown = await response.json()
    return isRecord(body) && body.status === 'ok'
  }

  private updateInstallProgress(
    step: ManagedWhisperProgress['step'],
    message: string,
    completedBytes: number | null = null,
    totalBytes: number | null = null
  ): void {
    this.updateStatus({
      phase: 'installing',
      message,
      installed: false,
      progress: { step, completedBytes, totalBytes },
      canInstall: false,
      canStart: false,
      canStop: false
    })
  }

  private setFailureStatus(error: unknown, canInstall = false): void {
    const normalized = normalizeError(
      error,
      'DOCKER_UNAVAILABLE',
      'Managed Whisper encountered an error.'
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
      canInstall,
      canStart: false,
      canStop: false
    })
  }

  private updateStatus(changes: Partial<ManagedWhisperStatus>): void {
    const next: ManagedWhisperStatus = {
      ...this.currentStatus,
      ...changes,
      activeTranscriptions: changes.activeTranscriptions ?? this.activeTranscriptions
    }
    if (JSON.stringify(next) === JSON.stringify(this.currentStatus)) return
    this.currentStatus = next
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  private snapshot(): ManagedWhisperStatus {
    return {
      ...this.currentStatus,
      progress: this.currentStatus.progress ? { ...this.currentStatus.progress } : null
    }
  }
}

function makeStatus(
  phase: ManagedWhisperStatus['phase'],
  message: string,
  installed: boolean
): ManagedWhisperStatus {
  return {
    phase,
    message,
    installed,
    progress: null,
    activeTranscriptions: 0,
    idleStopAt: null,
    canInstall: false,
    canStart: false,
    canStop: false
  }
}

function progress(step: ManagedWhisperProgress['step']): ManagedWhisperProgress {
  return { step, completedBytes: null, totalBytes: null }
}

function normalizeError(
  error: unknown,
  fallbackCode: ConstructorParameters<typeof ManagedWhisperError>[0],
  fallbackMessage: string
): ManagedWhisperError {
  if (error instanceof ManagedWhisperError) return error
  return new ManagedWhisperError(fallbackCode, fallbackMessage, { cause: error })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseLoopbackOrigin(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  for (const binding of value) {
    if (!isRecord(binding)) continue
    if (binding.HostIp !== '127.0.0.1') continue
    if (typeof binding.HostPort !== 'string' || !/^\d{1,5}$/.test(binding.HostPort)) continue
    const port = Number(binding.HostPort)
    if (port >= 1 && port <= 65_535) return `http://127.0.0.1:${port}`
  }
  return null
}

async function hasExactSize(path: string, size: number): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size === size
  } catch {
    return false
  }
}

function pickAssetMetadata(asset: WhisperDownloadAsset): Record<string, string | number> {
  return { fileName: asset.fileName, size: asset.size, sha256: asset.sha256 }
}

function validateAsset(asset: WhisperDownloadAsset): void {
  if (
    !/^[a-zA-Z0-9._-]+$/.test(asset.fileName) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    !/^[a-fA-F0-9]{64}$/.test(asset.sha256)
  ) {
    throw new ManagedWhisperError('UNSUPPORTED', 'Managed Whisper asset metadata is invalid.')
  }
  let url: URL
  try {
    url = new URL(asset.url)
  } catch (cause) {
    throw new ManagedWhisperError('UNSUPPORTED', 'Managed Whisper asset metadata is invalid.', {
      cause
    })
  }
  if (url.protocol !== 'https:') {
    throw new ManagedWhisperError('UNSUPPORTED', 'Managed Whisper assets require HTTPS.')
  }
}

async function defaultFreeDiskBytes(path: string): Promise<number> {
  const info = await statfs(path)
  return Number(info.bavail) * Number(info.bsize)
}

function waitWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal.aborted) {
      reject(managedWhisperCancelled(signal.reason))
      return
    }
    const finish = (): void => {
      signal.removeEventListener('abort', onAbort)
      resolveWait()
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(managedWhisperCancelled(signal.reason))
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const defaultScheduler: ManagedWhisperScheduler = {
  setTimeout(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds)
    timer.unref()
    return timer
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout)
  }
}
