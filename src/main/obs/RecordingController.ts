import { EventEmitter } from 'node:events'
import { mkdir, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { z } from 'zod'

import {
  RECORD_STARTED,
  RECORD_START_TIMEOUT_MS,
  RECORD_STOPPED,
  RECORD_STOP_TIMEOUT_MS
} from './constants'
import { type ArtifactProbe, FfprobeArtifactProbe } from './ArtifactProbe'
import { ObsSubsystemError, toErrorMessage } from './errors'
import type { ObsGateway } from './ObsGateway'
import { confineOutputPath, stableFile } from './pathSafety'
import { RecordingHealthMonitor } from './RecordingHealthMonitor'
import type { SerializedCommandQueue } from './SerializedCommandQueue'
import type { SessionManifestStore } from './SessionManifestStore'
import type {
  ConfiguredCapture,
  RecordingArtifact,
  RecordingTelemetry,
  SessionManifest
} from './types'
import { type LoggerLike, silentLogger } from './types'

type ControllerEvents = {
  telemetry: [telemetry: RecordingTelemetry]
  warning: [warning: string]
  manifest: [manifest: SessionManifest]
}

export interface RecordingControllerOptions {
  manifestStore: SessionManifestStore
  artifactProbe?: ArtifactProbe
  healthMonitor?: RecordingHealthMonitor
  now?: () => Date
  wait?: (ms: number) => Promise<void>
}

export class RecordingController extends EventEmitter<ControllerEvents> {
  private manifest: SessionManifest | null = null
  private readonly probe: ArtifactProbe
  private readonly monitor: RecordingHealthMonitor
  private readonly now: () => Date
  private readonly wait: (ms: number) => Promise<void>
  private persistInFlight: Promise<void> = Promise.resolve()

  constructor(
    private readonly gateway: ObsGateway,
    private readonly queue: SerializedCommandQueue,
    private readonly options: RecordingControllerOptions,
    private readonly logger: LoggerLike = silentLogger
  ) {
    super()
    this.probe = options.artifactProbe ?? new FfprobeArtifactProbe()
    this.monitor = options.healthMonitor ?? new RecordingHealthMonitor(gateway)
    this.now = options.now ?? (() => new Date())
    this.wait = options.wait ?? ((ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)))
    this.monitor.on('telemetry', (telemetry) => {
      this.emit('telemetry', telemetry)
      const manifest = this.manifest
      if (!manifest || manifest.state !== 'recording') return
      manifest.lastDurationMs = telemetry.durationMs
      manifest.lastBytes = telemetry.bytes
      this.persistInFlight = this.persistInFlight
        .then(async () => {
          if (this.manifest === manifest) await this.persist(manifest)
        })
        .catch((error: unknown) => {
          this.logger.warn('Failed to persist OBS recording telemetry', {
            error: toErrorMessage(error)
          })
        })
    })
    this.monitor.on('warning', (warning) => this.emit('warning', warning))
    this.monitor.on('error', (error) => {
      this.logger.warn('OBS health monitor failed', { error: error.message })
    })
    this.gateway.onObsEvent('RecordFileChanged', (event) => {
      void this.captureOutputPath(event.newOutputPath)
    })
  }

  get currentManifest(): SessionManifest | null {
    return this.manifest ? structuredClone(this.manifest) : null
  }

  async start(
    sessionId: string,
    capture: ConfiguredCapture,
    recordDirectory: string
  ): Promise<SessionManifest> {
    return this.queue.run(async () => {
      z.string().uuid().parse(sessionId)
      const pendingManifest = this.manifest ?? (await this.options.manifestStore.load())
      if (pendingManifest) {
        this.manifest ??= structuredClone(pendingManifest)
        throw new ObsSubsystemError(
          'OBS_RECORDING_PENDING_ACKNOWLEDGEMENT',
          `Recording ${pendingManifest.sessionId} must be handed off before another recording can start`
        )
      }
      if (!capture.resources.windowInput) {
        throw new ObsSubsystemError(
          'OBS_TARGET_UNCONFIGURED',
          'No window capture source is configured'
        )
      }
      const status = await this.gateway.call('GetRecordStatus')
      if (status.outputActive) {
        throw new ObsSubsystemError(
          'OBS_EXTERNAL_RECORDING_ACTIVE',
          'OBS is already recording and SessionScribe will not take control of it'
        )
      }
      await mkdir(recordDirectory, { recursive: true })
      const canonicalDirectory = resolve(recordDirectory)
      await this.gateway.call('SetRecordDirectory', { recordDirectory: canonicalDirectory })
      const configuredDirectory = await this.gateway.call('GetRecordDirectory')
      if (resolve(configuredDirectory.recordDirectory) !== canonicalDirectory) {
        throw new ObsSubsystemError(
          'OBS_RECORD_DIRECTORY_FAILED',
          'OBS did not retain the session directory'
        )
      }

      const timestamp = this.now().toISOString()
      const manifest: SessionManifest = {
        version: 1,
        sessionId,
        state: 'ready',
        recordDirectory: canonicalDirectory,
        outputPaths: [],
        profileName: capture.resources.profileName,
        sceneCollectionName: capture.resources.sceneCollectionName,
        previousProfileName: capture.resources.previousProfileName,
        previousSceneCollectionName: capture.resources.previousSceneCollectionName,
        platform: capture.platform,
        configuration: { ...capture.configuration },
        windowInputUuid: capture.resources.windowInput.uuid,
        microphoneInputUuid: capture.resources.microphoneInput?.uuid ?? null,
        systemAudioInputUuid: capture.resources.systemAudioInput?.uuid ?? null,
        startedAt: null,
        stopRequestedAt: null,
        completedAt: null,
        lastDurationMs: 0,
        lastBytes: 0,
        error: null,
        updatedAt: timestamp
      }
      this.manifest = manifest
      await this.persist(manifest)
      manifest.state = 'start-intent'
      await this.persist(manifest)

      const abort = new AbortController()
      const startedEvent = this.gateway.waitForObsEvent(
        'RecordStateChanged',
        (event) => event.outputState === RECORD_STARTED,
        RECORD_START_TIMEOUT_MS,
        abort.signal
      )
      try {
        await this.gateway.call('StartRecord')
      } catch (error) {
        let reconciled
        try {
          reconciled = await this.gateway.call('GetRecordStatus')
        } catch (reconciliationError) {
          abort.abort()
          await startedEvent.catch(() => undefined)
          throw new ObsSubsystemError(
            'OBS_START_AMBIGUOUS',
            'OBS disconnected before recording start could be confirmed',
            { operationError: error, reconciliationError }
          )
        }
        if (!reconciled.outputActive) {
          abort.abort()
          await startedEvent.catch(() => undefined)
          manifest.state = 'failed'
          manifest.error = toErrorMessage(error)
          await this.persist(manifest)
          throw error
        }
      }

      try {
        const event = await startedEvent
        if (event.outputPath) await this.addOutputPath(event.outputPath, manifest)
      } catch (error) {
        let reconciled
        try {
          reconciled = await this.gateway.call('GetRecordStatus')
        } catch (reconciliationError) {
          throw new ObsSubsystemError(
            'OBS_START_AMBIGUOUS',
            'OBS recording state could not be reconciled after the start event was missed',
            { eventError: error, reconciliationError }
          )
        }
        if (!reconciled.outputActive) {
          manifest.state = 'failed'
          manifest.error = toErrorMessage(error)
          await this.persist(manifest)
          throw error
        }
      }

      manifest.state = 'recording'
      manifest.startedAt = this.now().toISOString()
      manifest.error = null
      await this.persist(manifest)
      this.monitor.start()
      return structuredClone(manifest)
    })
  }

  async stop(): Promise<{ manifest: SessionManifest; artifacts: RecordingArtifact[] }> {
    return this.queue.run(async () => {
      const manifest = this.requireOwnedManifest()
      manifest.state = 'stop-intent'
      manifest.stopRequestedAt = this.now().toISOString()
      await this.persist(manifest)

      const current = await this.gateway.call('GetRecordStatus')
      manifest.lastDurationMs = Math.max(
        manifest.lastDurationMs,
        Math.max(0, Math.trunc(current.outputDuration))
      )
      manifest.lastBytes = Math.max(
        manifest.lastBytes,
        Math.max(0, Math.trunc(current.outputBytes))
      )
      let stoppedOutputPath: string | null = null
      if (current.outputActive) {
        const directory = await this.gateway.call('GetRecordDirectory')
        if (resolve(directory.recordDirectory) !== resolve(manifest.recordDirectory)) {
          throw new ObsSubsystemError(
            'OBS_EXTERNAL_RECORDING_ACTIVE',
            'OBS is recording to a directory not owned by this SessionScribe session'
          )
        }
        const abort = new AbortController()
        const stoppedEvent = this.gateway.waitForObsEvent(
          'RecordStateChanged',
          (event) => event.outputState === RECORD_STOPPED,
          RECORD_STOP_TIMEOUT_MS,
          abort.signal
        )
        try {
          await this.gateway.call('StopRecord')
        } catch (error) {
          let reconciled
          try {
            reconciled = await this.gateway.call('GetRecordStatus')
          } catch (reconciliationError) {
            abort.abort()
            await stoppedEvent.catch(() => undefined)
            throw new ObsSubsystemError(
              'OBS_STOP_AMBIGUOUS',
              'OBS disconnected before recording stop could be confirmed',
              { operationError: error, reconciliationError }
            )
          }
          if (reconciled.outputActive) {
            abort.abort()
            await stoppedEvent.catch(() => undefined)
            throw error
          }
          abort.abort()
          await stoppedEvent.catch(() => undefined)
        }
        if (!abort.signal.aborted) {
          try {
            const event = await stoppedEvent
            stoppedOutputPath = event.outputPath ?? null
          } catch (error) {
            let reconciled
            try {
              reconciled = await this.gateway.call('GetRecordStatus')
            } catch (reconciliationError) {
              throw new ObsSubsystemError(
                'OBS_STOP_AMBIGUOUS',
                'OBS recording state could not be reconciled after the stop event was missed',
                { eventError: error, reconciliationError }
              )
            }
            if (reconciled.outputActive) throw error
          }
        }
      }
      this.monitor.stop()
      if (stoppedOutputPath) await this.addOutputPath(stoppedOutputPath, manifest)
      manifest.state = 'finalizing'
      await this.persist(manifest)
      const artifacts = await this.finalizeArtifacts(manifest)
      manifest.state = 'complete'
      manifest.completedAt = this.now().toISOString()
      manifest.error = null
      await this.persist(manifest)
      return { manifest: structuredClone(manifest), artifacts }
    })
  }

  attach(manifest: SessionManifest): Promise<void> {
    this.manifest = structuredClone(manifest)
    if (manifest.state === 'recording' || manifest.state === 'start-intent') this.monitor.start()
    return Promise.resolve()
  }

  async finalizeRecovered(
    manifest: SessionManifest,
    interrupted: boolean
  ): Promise<RecordingArtifact[]> {
    return this.queue.run(async () => {
      this.manifest = manifest
      manifest.state = 'finalizing'
      await this.persist(manifest)
      try {
        const artifacts = await this.finalizeArtifacts(manifest)
        manifest.state = interrupted ? 'interrupted' : 'complete'
        manifest.completedAt = this.now().toISOString()
        await this.persist(manifest)
        return artifacts
      } catch (error) {
        manifest.state = 'interrupted'
        manifest.error = toErrorMessage(error)
        await this.persist(manifest)
        throw error
      }
    })
  }

  acknowledge(sessionId: string): Promise<void> {
    return this.queue.run(async () => {
      const manifest = this.manifest ?? (await this.options.manifestStore.load())
      if (!manifest || manifest.sessionId !== sessionId) return
      if (!['complete', 'interrupted', 'failed'].includes(manifest.state)) {
        throw new ObsSubsystemError(
          'OBS_RECORDING_ACTIVE',
          'An active recording manifest cannot be acknowledged'
        )
      }
      await this.options.manifestStore.remove()
      this.manifest = null
    })
  }

  private requireOwnedManifest(): SessionManifest {
    if (
      !this.manifest ||
      !['start-intent', 'recording', 'stop-intent'].includes(this.manifest.state)
    ) {
      throw new ObsSubsystemError(
        'OBS_RECORDING_NOT_OWNED',
        'SessionScribe has no active recording to stop'
      )
    }
    return this.manifest
  }

  private async captureOutputPath(path: string): Promise<void> {
    const manifest = this.manifest
    if (!manifest || !['start-intent', 'recording', 'stop-intent'].includes(manifest.state)) return
    try {
      await this.addOutputPath(path, manifest)
    } catch (error) {
      this.logger.warn('Rejected OBS output path', { error: toErrorMessage(error) })
    }
  }

  private async addOutputPath(path: string, manifest: SessionManifest): Promise<void> {
    const confined = await confineOutputPath(manifest.recordDirectory, path)
    if (!manifest.outputPaths.includes(confined)) {
      manifest.outputPaths.push(confined)
      await this.persist(manifest)
    }
  }

  private async finalizeArtifacts(manifest: SessionManifest): Promise<RecordingArtifact[]> {
    const directoryEntries = await readdir(manifest.recordDirectory, { withFileTypes: true })
    const candidates = new Set(manifest.outputPaths)
    for (const entry of directoryEntries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.mkv')) {
        candidates.add(resolve(manifest.recordDirectory, entry.name))
      }
    }
    const artifacts: RecordingArtifact[] = []
    for (const candidate of candidates) {
      const confined = await confineOutputPath(manifest.recordDirectory, candidate)
      const stable = await stableFile(confined, this.wait)
      if (!stable) continue
      await this.probe.probe(stable.path)
      artifacts.push(stable)
    }
    if (artifacts.length === 0) {
      throw new ObsSubsystemError(
        'OBS_RECORDING_MISSING',
        'OBS stopped without producing a valid recording file'
      )
    }
    manifest.outputPaths = artifacts.map((artifact) => artifact.path)
    return artifacts
  }

  private async persist(manifest: SessionManifest): Promise<void> {
    manifest.updatedAt = this.now().toISOString()
    await this.options.manifestStore.save(manifest)
    this.emit('manifest', structuredClone(manifest))
  }
}
