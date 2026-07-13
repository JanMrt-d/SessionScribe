import { EventEmitter } from 'node:events'
import { dirname, join, resolve } from 'node:path'

import {
  captureConfigurationSchema,
  captureStatusSchema,
  type CaptureConfiguration,
  type CaptureStatus,
  type PreflightResult
} from '@shared/capture'

import { CaptureConfigurator, detectCapturePlatform } from './CaptureConfigurator'
import { DEFAULT_REQUEST_TIMEOUT_MS } from './constants'
import { ObsSubsystemError, toErrorMessage } from './errors'
import { ObsGateway } from './ObsGateway'
import { ObsProvisioner } from './ObsProvisioner'
import { ObsResourceLeaseStore } from './ObsResourceLeaseStore'
import { PreflightService } from './PreflightService'
import { RecordingController, type RecordingControllerOptions } from './RecordingController'
import { RecoveryService } from './RecoveryService'
import { SerializedCommandQueue } from './SerializedCommandQueue'
import { SessionManifestStore } from './SessionManifestStore'
import type {
  CaptureDiscovery,
  CapturePlatform,
  LoggerLike,
  ObsConnectionOptions,
  RecordingArtifact,
  RecoveryResult
} from './types'
import { silentLogger } from './types'

type CaptureServiceEvents = {
  status: [status: CaptureStatus]
  artifacts: [sessionId: string, artifacts: RecordingArtifact[]]
  recovery: [result: RecoveryResult]
}

export interface ObsCaptureServiceOptions {
  recordingsRoot: string
  activeManifestPath: string
  resourceLeasePath?: string
  scratchDirectory?: string
  platform?: CapturePlatform
  gateway?: ObsGateway
  controllerOptions?: Omit<RecordingControllerOptions, 'manifestStore'>
  logger?: LoggerLike
}

export interface ObsStopResult {
  status: CaptureStatus
  sessionId: string
  outputPath: string | null
  durationMs: number | null
  sessionDirectory: string
  outputPaths: string[]
}

export class ObsCaptureService extends EventEmitter<CaptureServiceEvents> {
  readonly gateway: ObsGateway
  readonly queue: SerializedCommandQueue
  readonly resourceLeaseStore: ObsResourceLeaseStore
  readonly provisioner: ObsProvisioner
  readonly configurator: CaptureConfigurator
  readonly preflightService: PreflightService
  readonly manifestStore: SessionManifestStore
  readonly controller: RecordingController
  readonly recoveryService: RecoveryService

  private captureStatus: CaptureStatus = {
    connected: false,
    obsVersion: null,
    phase: 'disconnected',
    activeSessionId: null,
    elapsedMs: 0,
    bytesWritten: 0,
    microphoneLevel: 0,
    systemLevel: 0,
    warnings: []
  }
  private lastArtifactsValue: RecordingArtifact[] = []
  private reconnecting: Promise<void> | null = null
  private reconnectAbort: AbortController | null = null
  private readonly logger: LoggerLike
  private readonly recordingsRoot: string

  constructor(options: ObsCaptureServiceOptions) {
    super()
    this.logger = options.logger ?? silentLogger
    this.recordingsRoot = resolve(options.recordingsRoot)
    this.gateway = options.gateway ?? new ObsGateway(undefined, this.logger)
    this.queue = new SerializedCommandQueue()
    this.resourceLeaseStore = new ObsResourceLeaseStore(
      options.resourceLeasePath ??
        join(dirname(options.activeManifestPath), 'obs-resource-restoration.json')
    )
    this.provisioner = new ObsProvisioner(
      this.gateway,
      this.queue,
      this.resourceLeaseStore,
      this.logger
    )
    this.configurator = new CaptureConfigurator(
      this.gateway,
      this.provisioner,
      options.platform ?? detectCapturePlatform()
    )
    this.preflightService = new PreflightService(this.gateway, {
      scratchDirectory: options.scratchDirectory ?? join(this.recordingsRoot, '.preflight')
    })
    this.manifestStore = new SessionManifestStore(options.activeManifestPath)
    this.controller = new RecordingController(
      this.gateway,
      this.queue,
      { manifestStore: this.manifestStore, ...options.controllerOptions },
      this.logger
    )
    this.recoveryService = new RecoveryService(this.gateway, this.manifestStore, this.controller)

    this.controller.on('telemetry', (telemetry) => {
      this.updateStatus({
        elapsedMs: telemetry.durationMs,
        bytesWritten: telemetry.bytes
      })
    })
    this.controller.on('warning', (warning) => this.addWarning(warning))
    this.gateway.on('volumeMeters', (event) => this.handleVolumeMeters(event.inputs))
    this.gateway.on('disconnected', (error) => this.handleDisconnect(error))
  }

  get lastArtifacts(): readonly RecordingArtifact[] {
    return this.lastArtifactsValue
  }

  async connect(input: ObsConnectionOptions): Promise<CaptureStatus> {
    await this.stopAutomaticReconnect()
    const context = {
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {})
    }
    return this.gateway.runWithConnectionContext(context, () => this.connectInContext(input))
  }

  private async connectInContext(input: ObsConnectionOptions): Promise<CaptureStatus> {
    this.updateStatus({ phase: 'configuring', warnings: [] })
    try {
      const version = await this.gateway.connect(input)
      this.updateStatus({ connected: true, obsVersion: version.obsVersion })
      const recovery = await this.recoveryService.recover()
      throwIfConnectionCancelled(input.signal)
      if (recovery) {
        await this.handleRecoveryResult(recovery)
        throwIfConnectionCancelled(input.signal)
        if (recovery.action === 'reattached' || recovery.action === 'ownership-conflict') {
          return this.snapshot()
        }
      }
      await this.provisioner.provisionBase()
      throwIfConnectionCancelled(input.signal)
      if (recovery && ['finalized', 'interrupted', 'failed'].includes(recovery.action)) {
        this.provisioner.attachRecoveredResources(recovery.manifest)
      }
      this.updateStatus({ phase: 'ready', activeSessionId: null })
      return this.snapshot()
    } catch (error) {
      this.updateStatus({
        connected: this.gateway.connected,
        phase: this.gateway.connected ? 'configuring' : 'disconnected'
      })
      throw error
    }
  }

  cancelConnect(): Promise<void> {
    this.gateway.cancelPendingConnection()
    this.updateStatus({ connected: false, obsVersion: null, phase: 'disconnected' })
    return Promise.resolve()
  }

  async disconnect(): Promise<void> {
    if (this.captureStatus.activeSessionId) {
      throw new ObsSubsystemError(
        'OBS_RECORDING_ACTIVE',
        'Stop the active SessionScribe recording before disconnecting from OBS'
      )
    }
    await this.stopAutomaticReconnect()
    try {
      await this.provisioner.restorePreviousResources()
    } catch (error) {
      this.logger.warn('Failed to restore the previous OBS profile or scene collection', {
        error: toErrorMessage(error)
      })
    }
    await this.gateway.disconnect()
    this.updateStatus({ connected: false, obsVersion: null, phase: 'disconnected' })
  }

  async discover(): Promise<CaptureDiscovery> {
    this.requireConnected()
    await this.requireObsIdle()
    return this.configurator.discover()
  }

  async selectPortalTarget(): Promise<void> {
    this.requireConnected()
    if (this.captureStatus.activeSessionId) {
      throw new ObsSubsystemError(
        'OBS_RECORDING_ACTIVE',
        'The Wayland capture target cannot be changed while recording'
      )
    }
    await this.requireObsIdle()
    await this.configurator.selectAnotherWaylandTarget()
  }

  async configure(configuration: CaptureConfiguration): Promise<CaptureStatus> {
    this.requireConnected()
    if (this.captureStatus.activeSessionId) {
      throw new ObsSubsystemError(
        'OBS_RECORDING_ACTIVE',
        'Capture cannot be reconfigured while recording'
      )
    }
    await this.requireObsIdle()
    const parsed = captureConfigurationSchema.parse(configuration)
    this.updateStatus({ phase: 'configuring' })
    try {
      await this.configurator.configure(parsed)
      this.updateStatus({ phase: 'ready' })
      return this.snapshot()
    } catch (error) {
      this.updateStatus({ phase: this.gateway.connected ? 'ready' : 'disconnected' })
      throw error
    }
  }

  async preflight(): Promise<PreflightResult> {
    this.requireConnected()
    const capture = this.configurator.currentConfiguration
    if (!capture) {
      return {
        ok: false,
        blockers: ['Configure a window and audio source first.'],
        warnings: [],
        screenshotDataUrl: null
      }
    }
    const result = await this.preflightService.run(capture)
    this.updateStatus({ warnings: result.warnings })
    return result
  }

  async start(
    sessionId: string,
    sessionDirectory = join(this.recordingsRoot, sessionId)
  ): Promise<CaptureStatus> {
    this.requireConnected()
    if (this.captureStatus.activeSessionId) {
      throw new ObsSubsystemError(
        'OBS_RECORDING_ACTIVE',
        'Only one SessionScribe recording can run at a time'
      )
    }
    const capture = this.configurator.currentConfiguration
    if (!capture)
      throw new ObsSubsystemError('OBS_NOT_CONFIGURED', 'Configure capture before recording')
    const preflight = await this.preflightService.run(capture)
    if (!preflight.ok) {
      throw new ObsSubsystemError('OBS_PREFLIGHT_FAILED', preflight.blockers.join(' '))
    }
    this.updateStatus({ phase: 'configuring', warnings: preflight.warnings })
    let manifest
    try {
      manifest = await this.controller.start(sessionId, capture, sessionDirectory)
    } catch (error) {
      const pending = this.controller.currentManifest
      const recoverable =
        pending !== null && ['start-intent', 'recording', 'stop-intent'].includes(pending.state)
      if (pending && this.gateway.connected) {
        try {
          const recovery = await this.recoveryService.recover()
          if (recovery) {
            await this.handleRecoveryResult(recovery)
            if (recovery.action === 'reattached') return this.snapshot()
          }
        } catch (recoveryError) {
          this.logger.warn('Could not reconcile an ambiguous OBS start', {
            error: toErrorMessage(recoveryError)
          })
        }
      }
      this.updateStatus({
        phase: recoverable ? 'recovering' : this.gateway.connected ? 'ready' : 'disconnected',
        activeSessionId: recoverable ? pending.sessionId : null
      })
      throw error
    }
    this.lastArtifactsValue = []
    this.updateStatus({
      phase: 'recording',
      activeSessionId: manifest.sessionId,
      elapsedMs: manifest.lastDurationMs,
      bytesWritten: manifest.lastBytes
    })
    return this.snapshot()
  }

  async stop(): Promise<ObsStopResult> {
    this.requireConnected()
    if (!this.captureStatus.activeSessionId) {
      throw new ObsSubsystemError(
        'OBS_RECORDING_NOT_OWNED',
        'There is no active SessionScribe recording'
      )
    }
    this.updateStatus({ phase: 'finalizing' })
    const result = await this.controller.stop()
    this.lastArtifactsValue = result.artifacts
    this.emit('artifacts', result.manifest.sessionId, result.artifacts)
    this.updateStatus({
      phase: 'ready',
      activeSessionId: null,
      elapsedMs: result.manifest.lastDurationMs,
      bytesWritten: result.manifest.lastBytes,
      microphoneLevel: 0,
      systemLevel: 0
    })
    return {
      status: this.snapshot(),
      sessionId: result.manifest.sessionId,
      outputPath: result.artifacts[0]?.path ?? null,
      durationMs: result.manifest.lastDurationMs,
      sessionDirectory: result.manifest.recordDirectory,
      outputPaths: result.artifacts.map((artifact) => artifact.path)
    }
  }

  acknowledgeRecording(sessionId: string): Promise<void> {
    return this.controller.acknowledge(sessionId)
  }

  status(): Promise<CaptureStatus> {
    return Promise.resolve(this.snapshot())
  }

  subscribe(listener: (status: CaptureStatus) => void): () => void {
    this.on('status', listener)
    return () => this.off('status', listener)
  }

  private snapshot(): CaptureStatus {
    return structuredClone(this.captureStatus)
  }

  async recover(): Promise<RecoveryResult | null> {
    this.requireConnected()
    const result = await this.recoveryService.recover()
    if (result) {
      await this.handleRecoveryResult(result)
    }
    return result
  }

  private requireConnected(): void {
    if (!this.gateway.connected)
      throw new ObsSubsystemError('OBS_DISCONNECTED', 'OBS is not connected')
  }

  private async requireObsIdle(): Promise<void> {
    if ((await this.gateway.call('GetRecordStatus')).outputActive) {
      throw new ObsSubsystemError(
        'OBS_EXTERNAL_RECORDING_ACTIVE',
        'OBS is already recording; capture sources will not be changed'
      )
    }
  }

  private applyRecovery(result: RecoveryResult): void {
    if (result.artifacts.length) {
      this.lastArtifactsValue = result.artifacts
      this.emit('artifacts', result.manifest.sessionId, result.artifacts)
    }
    if (result.action === 'reattached') {
      this.updateStatus({
        connected: true,
        phase: result.manifest.state === 'stop-intent' ? 'finalizing' : 'recording',
        activeSessionId: result.manifest.sessionId,
        elapsedMs: result.manifest.lastDurationMs,
        bytesWritten: result.manifest.lastBytes
      })
    } else if (result.action === 'ownership-conflict') {
      this.addWarning(
        'OBS is recording to a directory not owned by the active SessionScribe session.'
      )
      this.updateStatus({ phase: 'recovering', activeSessionId: null })
    } else {
      if (result.action === 'interrupted' && result.manifest.error) {
        this.addWarning(`An interrupted recording could not be finalized: ${result.manifest.error}`)
      }
      this.updateStatus({ phase: 'ready', activeSessionId: null })
    }
  }

  private async handleRecoveryResult(result: RecoveryResult): Promise<void> {
    await this.provisioner.adoptRestorationLease(result.manifest)
    if (result.action === 'reattached' && !this.provisioner.currentResources) {
      this.provisioner.attachRecoveredResources(result.manifest)
    }
    this.applyRecovery(result)
    this.emit('recovery', result)
  }

  private handleDisconnect(error: Error | null): void {
    if (!this.captureStatus.connected) return
    const closeCode = error && 'code' in error && typeof error.code === 'number' ? error.code : null
    if (closeCode === 4011) {
      this.addWarning('OBS invalidated this websocket session; reconnect manually.')
      this.updateStatus({ connected: false, phase: 'disconnected' })
      return
    }
    const manifest = this.controller.currentManifest
    const manifestIsActive =
      manifest !== null && ['start-intent', 'recording', 'stop-intent'].includes(manifest.state)
    const activeSessionId =
      this.captureStatus.activeSessionId ?? (manifestIsActive ? manifest.sessionId : null)
    const hasActiveSession = activeSessionId !== null
    this.updateStatus({
      connected: false,
      phase: hasActiveSession ? 'recovering' : 'disconnected',
      activeSessionId
    })
    if (hasActiveSession && !this.reconnecting) {
      const abortController = new AbortController()
      this.reconnectAbort = abortController
      this.reconnecting = this.reconnectActiveSession(abortController.signal).finally(() => {
        if (this.reconnectAbort === abortController) {
          this.reconnecting = null
          this.reconnectAbort = null
        }
      })
    }
  }

  private async reconnectActiveSession(
    signal: AbortSignal = new AbortController().signal
  ): Promise<void> {
    let delayMs = 500
    const deadline = Date.now() + 30_000
    await this.gateway.runWithConnectionContext({ signal, deadlineMs: deadline }, async () => {
      while (!signal.aborted && Date.now() < deadline) {
        await waitForReconnect(delayMs, signal)
        if (signal.aborted) return
        try {
          const remainingMs = Math.max(1, deadline - Date.now())
          const version = await this.gateway.reconnect(
            Math.min(DEFAULT_REQUEST_TIMEOUT_MS, remainingMs),
            signal,
            deadline
          )
          if (signal.aborted) return
          this.updateStatus({ connected: true, obsVersion: version.obsVersion })
          const result = await this.recoveryService.recover()
          if (signal.aborted) return
          if (result) await this.handleRecoveryResult(result)
          else this.updateStatus({ phase: 'ready', activeSessionId: null })
          return
        } catch (error) {
          if (signal.aborted) return
          this.logger.warn('OBS reconnect attempt failed', { error: toErrorMessage(error) })
        }
        delayMs = Math.min(delayMs * 2, 5_000)
      }
    })
    if (!signal.aborted) {
      this.addWarning('OBS could not be reconnected; the MKV will be recovered when OBS stops.')
      this.updateStatus({ phase: 'disconnected' })
    }
  }

  private async stopAutomaticReconnect(): Promise<void> {
    const reconnecting = this.reconnecting
    if (!reconnecting) return
    this.reconnectAbort?.abort()
    this.gateway.cancelPendingConnection()
    await reconnecting
  }

  private handleVolumeMeters(inputs: readonly unknown[]): void {
    const resources = this.provisioner.currentResources
    if (!resources) return
    let microphoneLevel = this.captureStatus.microphoneLevel
    let systemLevel = this.captureStatus.systemLevel
    for (const input of inputs) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) continue
      const record = input as Record<string, unknown>
      if (typeof record.inputName !== 'string') continue
      const level = this.maximumLevel(record.inputLevelsMul)
      if (record.inputName === resources.microphoneInput?.name) microphoneLevel = level
      if (
        record.inputName === resources.systemAudioInput?.name ||
        (record.inputName === resources.windowInput?.name &&
          this.configurator.currentConfiguration?.configuration.outputDeviceId === 'window-audio')
      ) {
        systemLevel = level
      }
    }
    this.updateStatus({ microphoneLevel, systemLevel })
  }

  private maximumLevel(value: unknown): number {
    if (!Array.isArray(value)) return 0
    let maximum = 0
    const visit = (item: unknown): void => {
      if (typeof item === 'number' && Number.isFinite(item)) maximum = Math.max(maximum, item)
      else if (Array.isArray(item)) item.forEach(visit)
    }
    visit(value)
    return Math.max(0, Math.min(1, maximum))
  }

  private addWarning(warning: string): void {
    const warnings = [
      ...this.captureStatus.warnings.filter((item) => item !== warning),
      warning
    ].slice(-10)
    this.updateStatus({ warnings })
  }

  private updateStatus(patch: Partial<CaptureStatus>): void {
    this.captureStatus = captureStatusSchema.parse({ ...this.captureStatus, ...patch })
    this.emit('status', this.snapshot())
  }
}

function throwIfConnectionCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ObsSubsystemError('OBS_CONNECT_CANCELLED', 'The OBS connection attempt was cancelled')
  }
}

function waitForReconnect(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = (): void => {
      cleanup()
      resolve()
    }
    const onAbort = (): void => finish()
    const timer = setTimeout(finish, milliseconds)
    timer.unref?.()
    if (signal.aborted) return finish()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
