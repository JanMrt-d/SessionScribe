import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, protocol, session, shell } from 'electron'
import { AppDatabase } from './persistence/Database'
import { ArtifactStore } from './artifacts/ArtifactStore'
import { SecretStore } from './security/SecretStore'
import { ProviderProfileService } from './settings/ProviderProfileService'
import { SessionService } from './sessions/SessionService'
import { ExportService } from './exports/ExportService'
import { IpcRouter } from './ipc/IpcRouter'
import { DurableProcessingController } from './pipeline/ProcessingController'
import { FfmpegService } from './media/FfmpegService'
import { mediaFileResponse } from './media/MediaFileServer'
import { createDefaultProviderRegistry } from './providers/index'
import { logger } from './logging/logger'
import { FfprobeArtifactProbe, ObsCaptureService, type LoggerLike } from './obs/index'
import { LaunchableObsCaptureController } from './capture/LaunchableObsCaptureController'
import { RecoveredRecordingHandler } from './capture/RecoveredRecordingHandler'
import type { CaptureController, ProcessingController } from './app/contracts'
import { isTrustedRendererLocation } from './security/rendererNavigation'
import { ManagedDiarizationService } from './diarization'
import { ManagedWhisperService } from './whisper'
import packageMetadata from '../../package.json'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'sessionscribe-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

let mainWindow: BrowserWindow | null = null
let database: AppDatabase | null = null
let router: IpcRouter | null = null
let captureController: CaptureController | null = null
let processingController: ProcessingController | null = null
let sessionService: SessionService | null = null
let whisperService: ManagedWhisperService | null = null
let diarizationService: ManagedDiarizationService | null = null
let quitPreparing = false
let quitFinalized = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app
    .whenReady()
    .then(startApplication)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('SessionScribe startup failed', { error: message })
      dialog.showErrorBox('SessionScribe could not start', message)
      quitFinalized = true
      app.quit()
    })
}

async function startApplication(): Promise<void> {
  const userData = app.getPath('userData')
  database = new AppDatabase(join(userData, 'sessionscribe.db'))
  database.recoverRunningJobs()
  const artifacts = new ArtifactStore(
    process.env.SESSION_SCRIBE_VIDEOS_DIR || app.getPath('videos')
  )
  await artifacts.initialize()
  const secrets = new SecretStore(join(userData, 'secrets.json'))
  const profiles = new ProviderProfileService(database, secrets)
  await profiles.initializeDefaults()
  const whisper = new ManagedWhisperService({ dataDirectory: userData })
  whisperService = whisper
  const diarization = new ManagedDiarizationService({
    dataDirectory: userData,
    buildContextDirectory: app.isPackaged
      ? join(process.resourcesPath, 'diarization')
      : join(app.getAppPath(), 'resources', 'diarization')
  })
  diarizationService = diarization
  const sessions = new SessionService(database, artifacts)
  sessionService = sessions
  const exports = new ExportService(database)
  const ffmpeg = await FfmpegService.create({ resourcesPath: process.resourcesPath })
  const obsLogger: LoggerLike = {
    debug: (message, context) => logger.debug(message, context ?? {}),
    info: (message, context) => logger.info(message, context ?? {}),
    warn: (message, context) => logger.warn(message, context ?? {}),
    error: (message, context) => logger.error(message, context ?? {})
  }
  const obsCapture = new ObsCaptureService({
    recordingsRoot: artifacts.root,
    activeManifestPath: join(userData, 'active-recording.json'),
    scratchDirectory: join(userData, 'obs-preflight'),
    controllerOptions: { artifactProbe: new FfprobeArtifactProbe(ffmpeg.ffprobePath) },
    logger: obsLogger
  })
  const capture = new LaunchableObsCaptureController(obsCapture, { logger: obsLogger })
  captureController = capture
  const processing = new DurableProcessingController(
    database,
    artifacts,
    sessions,
    secrets,
    ffmpeg,
    createDefaultProviderRegistry(whisper),
    whisper,
    diarization
  )
  processingController = processing
  const recoveredRecordings = new RecoveredRecordingHandler(database, sessions, processing)
  obsCapture.on('recovery', (result) => {
    void recoveredRecordings
      .handle(result)
      .then(async (handoff) => {
        if (handoff.acknowledgeManifest) {
          await capture.acknowledgeRecording(result.manifest.sessionId).catch((error: unknown) => {
            logger.warn('Recovered OBS manifest could not be acknowledged', {
              sessionId: result.manifest.sessionId,
              error: error instanceof Error ? error.message : String(error)
            })
          })
        }
        const recoveredSession = database?.getSession(result.manifest.sessionId)
        if (recoveredSession) router?.emit({ type: 'session-updated', payload: recoveredSession })
      })
      .catch((error: unknown) => {
        logger.error('Recovered OBS recording could not be attached', {
          sessionId: result.manifest.sessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
  })

  const developmentRenderer = process.env.ELECTRON_RENDERER_URL
  const rendererLocation =
    developmentRenderer ?? pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
  mainWindow = createWindow(rendererLocation, Boolean(developmentRenderer))
  registerMediaProtocol(database, artifacts, Boolean(developmentRenderer))
  router = new IpcRouter({
    window: mainWindow,
    rendererLocation,
    allowRendererOrigin: Boolean(developmentRenderer),
    version: app.isPackaged ? app.getVersion() : packageMetadata.version,
    database,
    sessions,
    profiles,
    exports,
    artifacts,
    secrets,
    capture,
    processing,
    whisper,
    diarization
  })
  router.register()
  processing.resumePending()

  if (developmentRenderer) {
    await mainWindow.loadURL(developmentRenderer)
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createWindow(rendererLocation: string, allowRendererOrigin: boolean): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#f4f5f7',
    title: 'SessionScribe',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererLocation(url, rendererLocation, allowRendererOrigin)) {
      event.preventDefault()
    }
  })
  window.on('close', (event) => {
    if (quitFinalized) return
    event.preventDefault()
    if (!quitPreparing) void prepareToQuit()
  })
  return window
}

function registerMediaProtocol(
  db: AppDatabase,
  artifacts: ArtifactStore,
  allowDevelopmentConnections: boolean
): void {
  protocol.handle('sessionscribe-media', async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'session') return new Response('Not found', { status: 404 })
    const sessionId = url.pathname.replace(/^\//, '')
    const recordingPath = db.getMediaPath(sessionId)
    if (!recordingPath) return new Response('Not found', { status: 404 })
    try {
      const safePath = artifacts.assertSessionPath(sessionId, recordingPath)
      // Served manually with Range support: net.fetch ignores Range headers on
      // file:// URLs, and without 206 responses <video> cannot seek forward.
      return await mediaFileResponse(safePath, request.headers.get('range'))
    } catch {
      return new Response('Forbidden', { status: 403 })
    }
  })

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const connectSources = allowDevelopmentConnections
      ? "'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*"
      : "'self'"
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' sessionscribe-media:; connect-src ${connectSources}`
        ]
      }
    })
  })
}

app.on('window-all-closed', () => app.quit())
app.on('before-quit', (event) => {
  if (quitFinalized) return
  event.preventDefault()
  if (!quitPreparing) void prepareToQuit()
})

async function prepareToQuit(): Promise<void> {
  quitPreparing = true
  try {
    await router?.prepareForShutdown()
    const capture = captureController
    const status = capture ? await capture.status() : null
    let leaveRecordingRunning = false
    if (capture && status?.activeSessionId) {
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Recording in progress',
        message: 'SessionScribe is currently recording with OBS.',
        detail:
          'Stop finalizes the MKV and queues transcription for the next launch. Leaving it running keeps OBS recording and SessionScribe will recover it when reopened.',
        buttons: ['Stop recording and quit', 'Leave recording running', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      })
      if (choice === 2) {
        router?.cancelShutdownPreparation()
        quitPreparing = false
        return
      }
      if (choice === 0) await stopRecordingBeforeQuit(capture)
      else leaveRecordingRunning = true
    }
    if (capture && !leaveRecordingRunning && !(await capture.status()).activeSessionId) {
      await capture.disconnect().catch((error: unknown) => {
        logger.warn('OBS resources could not be restored during shutdown', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
    }
    await processingController?.shutdown()
    await whisperService?.shutdown()
    await diarizationService?.shutdown()
    finalizeQuit()
  } catch (error) {
    dialog.showErrorBox(
      'SessionScribe could not finish the recording',
      error instanceof Error ? error.message : String(error)
    )
    router?.cancelShutdownPreparation()
    quitPreparing = false
  }
}

async function stopRecordingBeforeQuit(capture: CaptureController): Promise<void> {
  const result = await capture.stop()
  if (!result.sessionId || !result.outputPath || !database || !sessionService) return
  sessionService.attachRecording(result.sessionId, result.outputPath, result.durationMs)
  const processing = database.getSetting<{
    transcriptionProfileId: string
    summaryProfileId: string | null
    mode: 'meeting' | 'lecture'
  } | null>(`capture-processing:${result.sessionId}`, null)
  if (processing && processingController) {
    try {
      await processingController.enqueue({ sessionId: result.sessionId, ...processing })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Processing could not start'
      database.updateSession(result.sessionId, { status: 'failed', lastError: message })
      logger.error('Stopped recording could not be queued', {
        sessionId: result.sessionId,
        error: message
      })
    }
  } else {
    database.updateSession(result.sessionId, {
      status: 'interrupted',
      lastError: 'The recording finished without provider selections.'
    })
  }
  await capture.acknowledgeRecording(result.sessionId).catch((error: unknown) => {
    logger.warn('Finalized OBS manifest could not be acknowledged before shutdown', {
      sessionId: result.sessionId,
      error: error instanceof Error ? error.message : String(error)
    })
  })
}

function finalizeQuit(): void {
  quitFinalized = true
  router?.dispose()
  router = null
  database?.close()
  database = null
  logger.info('SessionScribe shutdown complete')
  app.quit()
}
