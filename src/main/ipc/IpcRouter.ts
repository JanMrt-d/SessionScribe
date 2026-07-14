import { constants, realpathSync, statSync } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import {
  captureConfigurationSchema,
  IPC,
  providerProfileSchema,
  sessionModeSchema,
  summaryDocumentSchema,
  transcriptDocumentSchema,
  type ManagedWhisperStatus,
  type ProviderProfileV1,
  type SessionScribeEvent
} from '@shared/index'
import type { AppDatabase } from '../persistence/Database'
import type { SessionService } from '../sessions/SessionService'
import type { ProviderProfileService } from '../settings/ProviderProfileService'
import type { ExportService } from '../exports/ExportService'
import type { ArtifactStore } from '../artifacts/ArtifactStore'
import type { SecretStore } from '../security/SecretStore'
import type { CaptureController, ProcessingController } from '../app/contracts'
import { isTrustedRendererLocation } from '../security/rendererNavigation'
import { logger } from '../logging/logger'
import { IpcOperationBarrier } from './IpcOperationBarrier'

const idSchema = z.string().uuid()
const noInputSchema = z.unknown().optional()
const externalUrlSchema = z.object({ url: z.string().url() })
const createSessionSchema = z.object({ title: z.string().max(240), mode: sessionModeSchema })
const importSchema = z.object({
  mode: sessionModeSchema,
  transcriptionProfileId: idSchema,
  summaryProfileId: idSchema.nullable()
})
const connectSchema = z.object({
  url: z.string().url(),
  password: z.string(),
  rememberPassword: z.boolean()
})
const providerInputSchema = z.object({
  profile: providerProfileSchema,
  secrets: z.record(z.string(), z.string())
})
const exportSchema = z.object({
  sessionId: idSchema,
  directory: z.string().min(1),
  formats: z.array(z.enum(['markdown', 'json', 'srt', 'vtt'])).min(1)
})

interface RouterDependencies {
  window: BrowserWindow
  rendererLocation: string
  allowRendererOrigin: boolean
  version: string
  database: AppDatabase
  sessions: SessionService
  profiles: ProviderProfileService
  exports: ExportService
  artifacts: ArtifactStore
  secrets: SecretStore
  capture: CaptureController
  processing: ProcessingController
  whisper: {
    status(signal?: AbortSignal): Promise<ManagedWhisperStatus>
    install(signal?: AbortSignal): Promise<ManagedWhisperStatus>
    cancelInstall(): void
    start(signal?: AbortSignal): Promise<ManagedWhisperStatus>
    stop(signal?: AbortSignal): Promise<ManagedWhisperStatus>
    subscribe(listener: (status: ManagedWhisperStatus) => void): () => void
  }
}

export class IpcRouter {
  private unsubscribeCapture: (() => void) | null = null
  private unsubscribeProcessing: (() => void) | null = null
  private unsubscribeWhisper: (() => void) | null = null
  private readonly authorizedExportDirectories = new Set<string>()
  private readonly authorizedProviderExecutables = new Set<string>()
  private readonly captureStartProviderIds = new Set<string>()
  private readonly ipcOperations = new IpcOperationBarrier()
  private captureStartingSessionId: string | null = null
  private captureConnectGeneration = 0

  constructor(private readonly dependencies: RouterDependencies) {
    for (const profile of dependencies.profiles.list()) {
      if (profile.kind !== 'local-cli') continue
      try {
        const executable = realpathSync.native(profile.executable)
        if (statSync(executable).isFile()) this.authorizedProviderExecutables.add(executable)
      } catch {
        // Missing executables must be selected again before the profile can run.
      }
    }
  }

  register(): void {
    ipcMain.handle(IPC.invoke, async (event, method: unknown, input: unknown) => {
      this.validateSender(event)
      if (typeof method !== 'string') throw new Error('Invalid IPC method')
      return await this.invoke(method, input)
    })
    this.unsubscribeCapture = this.dependencies.capture.subscribe((status) => {
      this.emit({ type: 'capture-status', payload: status })
    })
    this.unsubscribeProcessing = this.dependencies.processing.subscribe((job) => {
      this.emit({ type: 'job-updated', payload: job })
      const session = this.dependencies.database.getSession(job.sessionId)
      if (session) this.emit({ type: 'session-updated', payload: session })
    })
    this.unsubscribeWhisper = this.dependencies.whisper.subscribe((status) => {
      this.emit({ type: 'whisper-status', payload: status })
    })
  }

  dispose(): void {
    ipcMain.removeHandler(IPC.invoke)
    this.unsubscribeCapture?.()
    this.unsubscribeProcessing?.()
    this.unsubscribeWhisper?.()
  }

  emit(event: SessionScribeEvent): void {
    if (!this.dependencies.window.isDestroyed())
      this.dependencies.window.webContents.send(IPC.event, event)
  }

  async prepareForShutdown(): Promise<void> {
    this.dependencies.whisper.cancelInstall()
    await this.ipcOperations.blockAndWait()
  }

  cancelShutdownPreparation(): void {
    this.ipcOperations.resume()
  }

  private invoke(method: string, input: unknown): Promise<unknown> {
    return this.ipcOperations.run(() => this.invokeMethod(method, input))
  }

  private async invokeMethod(method: string, input: unknown): Promise<unknown> {
    const services = this.dependencies
    switch (method) {
      case 'app.bootstrap': {
        noInputSchema.parse(input)
        const capture = await services.capture.status()
        return {
          version: services.version,
          platform: process.platform,
          sessions: services.sessions.list(),
          obsConnected: capture.connected,
          activeSessionId: capture.activeSessionId,
          encryptionAvailable: services.secrets.isPersistentEncryptionAvailable()
        }
      }
      case 'app.openExternal': {
        const { url } = externalUrlSchema.parse(input)
        const parsed = new URL(url)
        if (!['https:', 'http:'].includes(parsed.protocol))
          throw new Error('Unsupported external URL')
        await shell.openExternal(parsed.toString())
        return undefined
      }
      case 'sessions.list':
        noInputSchema.parse(input)
        return services.sessions.list()
      case 'sessions.get':
        return services.sessions.get(idSchema.parse(input))
      case 'sessions.create': {
        const parsed = createSessionSchema.parse(input)
        const session = await services.sessions.create(parsed.title, parsed.mode)
        this.emit({ type: 'session-updated', payload: session })
        return session
      }
      case 'sessions.importMedia': {
        const parsed = importSchema.parse(input)
        this.validateProcessingProfiles(parsed.transcriptionProfileId, parsed.summaryProfileId)
        const result = await dialog.showOpenDialog(services.window, {
          title: 'Import a meeting or lecture recording',
          properties: ['openFile'],
          filters: [
            {
              name: 'Media',
              extensions: ['mkv', 'mp4', 'mov', 'webm', 'mp3', 'm4a', 'wav', 'ogg', 'flac']
            }
          ]
        })
        if (result.canceled || !result.filePaths[0]) throw new Error('Import cancelled')
        const session = await services.sessions.importMedia(result.filePaths[0], parsed.mode)
        this.emit({ type: 'session-updated', payload: session })
        void services.processing
          .enqueue({
            sessionId: session.id,
            transcriptionProfileId: parsed.transcriptionProfileId,
            summaryProfileId: parsed.summaryProfileId,
            mode: parsed.mode
          })
          .then((job) => this.emit({ type: 'job-updated', payload: job }))
          .catch((error: unknown) => {
            const failed = services.database.updateSession(session.id, {
              status: 'failed',
              lastError: error instanceof Error ? error.message : 'Processing could not start'
            })
            this.emit({ type: 'session-updated', payload: failed })
          })
        return session
      }
      case 'sessions.delete': {
        const sessionId = idSchema.parse(input)
        if (this.captureStartingSessionId === sessionId) {
          throw new Error('Wait for the recording start to finish before deleting this session')
        }
        if ((await services.capture.status()).activeSessionId === sessionId) {
          throw new Error('Stop the active recording before deleting this session')
        }
        await Promise.all(
          services.database
            .listJobs(sessionId)
            .filter((job) => job.status === 'queued' || job.status === 'running')
            .map((job) => services.processing.cancel(job.id))
        )
        await services.sessions.delete(sessionId)
        return undefined
      }
      case 'capture.connect': {
        const connectGeneration = ++this.captureConnectGeneration
        const parsed = connectSchema.parse(input)
        const url = new URL(parsed.url)
        if (!['ws:', 'wss:'].includes(url.protocol)) {
          throw new Error('OBS WebSocket addresses must use ws:// or wss://')
        }
        if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
          throw new Error('SessionScribe connects to OBS on this computer only')
        }
        const remembered =
          parsed.password || (await services.secrets.get('obs/websocket-password')) || ''
        if (connectGeneration !== this.captureConnectGeneration) {
          throw new Error('The OBS connection attempt was cancelled')
        }
        const status = await services.capture.connect({ url: parsed.url, password: remembered })
        if (connectGeneration !== this.captureConnectGeneration) {
          await services.capture.cancelConnect()
          throw new Error('The OBS connection attempt was cancelled')
        }
        if (parsed.rememberPassword && parsed.password) {
          await services.secrets.put('obs/websocket-password', parsed.password)
        }
        if (connectGeneration !== this.captureConnectGeneration) {
          await services.capture.disconnect()
          throw new Error('The OBS connection attempt was cancelled')
        }
        return status
      }
      case 'capture.cancelConnect':
        noInputSchema.parse(input)
        this.captureConnectGeneration += 1
        await services.capture.cancelConnect()
        return undefined
      case 'capture.disconnect':
        noInputSchema.parse(input)
        await services.capture.disconnect()
        return undefined
      case 'capture.discover':
        noInputSchema.parse(input)
        return await services.capture.discover()
      case 'capture.configure':
        return await services.capture.configure(captureConfigurationSchema.parse(input))
      case 'capture.selectPortalTarget':
        noInputSchema.parse(input)
        await services.capture.selectPortalTarget()
        return undefined
      case 'capture.preflight':
        noInputSchema.parse(input)
        return await services.capture.preflight()
      case 'capture.start': {
        const parsed = z
          .object({
            sessionId: idSchema,
            transcriptionProfileId: idSchema,
            summaryProfileId: idSchema.nullable()
          })
          .parse(input)
        if (this.captureStartingSessionId) {
          throw new Error('Another recording is already starting')
        }
        const existingSession = services.database.getSession(parsed.sessionId)
        if (!existingSession) throw new Error('Session not found')
        if (existingSession.status !== 'draft') {
          throw new Error('Only a new draft session can start a recording')
        }
        if (
          services.database.getRecordingPath(parsed.sessionId) ||
          existingSession.transcriptRevision > 0
        ) {
          throw new Error('This session already has a recording')
        }
        this.validateProcessingProfiles(parsed.transcriptionProfileId, parsed.summaryProfileId)
        services.database.setSetting(`capture-processing:${parsed.sessionId}`, {
          transcriptionProfileId: parsed.transcriptionProfileId,
          summaryProfileId: parsed.summaryProfileId,
          mode: existingSession.preferredMode
        })
        this.captureStartingSessionId = parsed.sessionId
        this.captureStartProviderIds.add(parsed.transcriptionProfileId)
        if (parsed.summaryProfileId) this.captureStartProviderIds.add(parsed.summaryProfileId)
        try {
          const status = await services.capture.start(
            parsed.sessionId,
            await services.artifacts.ensureSession(parsed.sessionId)
          )
          const session = services.database.updateSession(parsed.sessionId, {
            status: 'recording'
          })
          this.emit({ type: 'session-updated', payload: session })
          return status
        } catch (error) {
          const capture = await services.capture.status().catch(() => null)
          if (capture?.activeSessionId !== parsed.sessionId) {
            const restored = services.database.updateSession(parsed.sessionId, {
              status: 'draft',
              lastError: error instanceof Error ? error.message : 'Recording could not start'
            })
            this.emit({ type: 'session-updated', payload: restored })
          }
          throw error
        } finally {
          this.captureStartingSessionId = null
          this.captureStartProviderIds.delete(parsed.transcriptionProfileId)
          if (parsed.summaryProfileId) this.captureStartProviderIds.delete(parsed.summaryProfileId)
        }
      }
      case 'capture.stop': {
        const result = await services.capture.stop()
        if (result.sessionId && result.outputPath) {
          const attached = services.sessions.attachRecording(
            result.sessionId,
            result.outputPath,
            result.durationMs
          )
          this.emit({ type: 'session-updated', payload: attached })
          const processing = services.database.getSetting<{
            transcriptionProfileId: string
            summaryProfileId: string | null
            mode: 'meeting' | 'lecture'
          } | null>(`capture-processing:${result.sessionId}`, null)
          if (processing) {
            try {
              await services.processing.enqueue({ sessionId: result.sessionId, ...processing })
            } catch (error) {
              const failed = services.database.updateSession(result.sessionId, {
                status: 'failed',
                lastError: error instanceof Error ? error.message : 'Processing could not start'
              })
              this.emit({ type: 'session-updated', payload: failed })
            } finally {
              await this.acknowledgeRecording(result.sessionId)
            }
          } else {
            const interrupted = services.database.updateSession(result.sessionId, {
              status: 'interrupted',
              lastError: 'The recording finished without provider selections.'
            })
            this.emit({ type: 'session-updated', payload: interrupted })
            await this.acknowledgeRecording(result.sessionId)
          }
        }
        return result.status
      }
      case 'capture.status':
        noInputSchema.parse(input)
        return await services.capture.status()
      case 'providers.list':
        noInputSchema.parse(input)
        return services.profiles.list()
      case 'providers.chooseExecutable': {
        noInputSchema.parse(input)
        const result = await dialog.showOpenDialog(services.window, {
          title: 'Choose a local transcription executable',
          properties: ['openFile']
        })
        if (result.canceled || !result.filePaths[0]) return null
        const executable = await canonicalExecutable(result.filePaths[0])
        this.authorizedProviderExecutables.add(executable)
        return executable
      }
      case 'providers.save': {
        const parsed = providerInputSchema.parse(input)
        const profile = await this.authorizeProviderExecutable(parsed.profile)
        return await services.profiles.save(profile, parsed.secrets)
      }
      case 'providers.delete': {
        const profileId = idSchema.parse(input)
        if (this.captureStartProviderIds.has(profileId)) {
          throw new Error('Wait for the recording start to finish before deleting this provider')
        }
        const activeSessionId = (await services.capture.status()).activeSessionId
        if (activeSessionId) {
          const processing = services.database.getSetting<{
            transcriptionProfileId: string
            summaryProfileId: string | null
          } | null>(`capture-processing:${activeSessionId}`, null)
          if (
            processing?.transcriptionProfileId === profileId ||
            processing?.summaryProfileId === profileId
          ) {
            throw new Error('Stop the active recording before deleting one of its providers')
          }
        }
        if (services.database.hasActiveJobReferencingProvider(profileId)) {
          throw new Error('Wait for active processing jobs before deleting this provider')
        }
        await services.profiles.delete(profileId)
        return undefined
      }
      case 'providers.test': {
        const parsed = providerInputSchema.parse(input)
        const profile = await this.authorizeProviderExecutable(parsed.profile)
        services.profiles.validate(profile, Object.keys(parsed.secrets))
        return await services.processing.testProvider(profile, parsed.secrets)
      }
      case 'whisper.status':
        noInputSchema.parse(input)
        return await services.whisper.status()
      case 'whisper.install': {
        noInputSchema.parse(input)
        const status = await services.whisper.install()
        const profile = services.profiles.ensureManagedWhisperDefault()
        return { status, profile }
      }
      case 'whisper.cancelInstall':
        noInputSchema.parse(input)
        services.whisper.cancelInstall()
        return undefined
      case 'whisper.start':
        noInputSchema.parse(input)
        return await services.whisper.start()
      case 'whisper.stop':
        noInputSchema.parse(input)
        return await services.whisper.stop()
      case 'jobs.retry': {
        const job = await services.processing.retry(idSchema.parse(input))
        this.emit({ type: 'job-updated', payload: job })
        return job
      }
      case 'jobs.cancel':
        await services.processing.cancel(idSchema.parse(input))
        return undefined
      case 'transcript.save': {
        const parsed = z
          .object({ sessionId: idSchema, document: transcriptDocumentSchema })
          .parse(input)
        if (parsed.sessionId !== parsed.document.sessionId) throw new Error('Session mismatch')
        return services.sessions.saveTranscript(parsed.document)
      }
      case 'transcript.renameSpeaker': {
        const parsed = z
          .object({
            sessionId: idSchema,
            speakerId: z.string().min(1),
            displayName: z.string().max(120)
          })
          .parse(input)
        return services.sessions.renameSpeaker(
          parsed.sessionId,
          parsed.speakerId,
          parsed.displayName
        )
      }
      case 'transcript.mergeSpeakers': {
        const parsed = z
          .object({ sessionId: idSchema, sourceId: z.string().min(1), targetId: z.string().min(1) })
          .parse(input)
        return services.sessions.mergeSpeakers(parsed.sessionId, parsed.sourceId, parsed.targetId)
      }
      case 'summary.generate': {
        const parsed = z
          .object({ sessionId: idSchema, mode: sessionModeSchema, profileId: idSchema })
          .parse(input)
        return await services.processing.generateSummary(parsed)
      }
      case 'summary.save': {
        const parsed = z
          .object({ sessionId: idSchema, document: summaryDocumentSchema })
          .parse(input)
        if (parsed.sessionId !== parsed.document.sessionId) throw new Error('Session mismatch')
        return services.sessions.saveSummary(parsed.document)
      }
      case 'exports.chooseDirectory': {
        const result = await dialog.showOpenDialog(services.window, {
          title: 'Choose export folder',
          properties: ['openDirectory', 'createDirectory']
        })
        const directory = result.canceled ? null : (result.filePaths[0] ?? null)
        if (directory) this.authorizedExportDirectories.add(resolve(directory))
        return directory
      }
      case 'exports.write': {
        const request = exportSchema.parse(input)
        if (!this.authorizedExportDirectories.has(resolve(request.directory))) {
          throw new Error('Choose the export directory through SessionScribe first')
        }
        return await services.exports.write(request)
      }
      default:
        throw new Error(`Unknown IPC method: ${method}`)
    }
  }

  private validateSender(event: IpcMainInvokeEvent): void {
    if (
      event.sender !== this.dependencies.window.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      !isTrustedRendererLocation(
        event.senderFrame.url,
        this.dependencies.rendererLocation,
        this.dependencies.allowRendererOrigin
      )
    ) {
      throw new Error('Rejected IPC call from an untrusted frame')
    }
  }

  private validateProcessingProfiles(
    transcriptionProfileId: string,
    summaryProfileId: string | null
  ): void {
    const transcription = this.dependencies.database.getProviderProfile(transcriptionProfileId)
    if (!transcription || transcription.task !== 'transcription') {
      throw new Error('Choose an available transcription provider')
    }
    if (summaryProfileId !== null) {
      const summary = this.dependencies.database.getProviderProfile(summaryProfileId)
      if (!summary || summary.task !== 'summary') {
        throw new Error('Choose an available summary provider')
      }
    }
  }

  private async authorizeProviderExecutable(
    profile: ProviderProfileV1
  ): Promise<ProviderProfileV1> {
    if (profile.kind !== 'local-cli') return profile
    let executable: string
    try {
      executable = await canonicalExecutable(profile.executable)
    } catch {
      throw new Error('Choose the local CLI executable through SessionScribe first')
    }
    if (!this.authorizedProviderExecutables.has(executable)) {
      throw new Error('Choose the local CLI executable through SessionScribe first')
    }
    return { ...profile, executable }
  }

  private async acknowledgeRecording(sessionId: string): Promise<void> {
    await this.dependencies.capture.acknowledgeRecording(sessionId).catch((error: unknown) => {
      logger.warn('A finalized OBS manifest could not be acknowledged', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }
}

async function canonicalExecutable(candidate: string): Promise<string> {
  const executable = await realpath(resolve(candidate))
  if (!(await stat(executable)).isFile()) throw new Error('The selected executable is not a file')
  await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
  return executable
}
