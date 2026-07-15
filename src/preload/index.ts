import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  ExportRequest,
  ProviderInput,
  SessionDetails,
  SessionScribeApi,
  SessionScribeEvent
} from '@shared/ipc'
import type { AppBootstrap, Job, Session } from '@shared/domain'
import type { AudioDevice, CaptureStatus, CaptureTarget, PreflightResult } from '@shared/capture'
import type { ProviderProfileV1 } from '@shared/providers'
import type { SummaryDocumentV1 } from '@shared/summary'
import type { TranscriptDocumentV1 } from '@shared/transcript'
import type { ManagedDiarizationStatus } from '@shared/diarization'
import type { ManagedWhisperStatus } from '@shared/whisper'

const invoke = <T>(method: string, input?: unknown): Promise<T> =>
  ipcRenderer.invoke(IPC.invoke, method, input) as Promise<T>

const api: SessionScribeApi = {
  app: {
    bootstrap: () => invoke<AppBootstrap>('app.bootstrap'),
    openExternal: (url) => invoke<void>('app.openExternal', { url })
  },
  sessions: {
    list: () => invoke<Session[]>('sessions.list'),
    get: (id) => invoke<SessionDetails>('sessions.get', id),
    create: (input) => invoke<Session>('sessions.create', input),
    importMedia: (input) => invoke<Session>('sessions.importMedia', input),
    delete: (id) => invoke<void>('sessions.delete', id)
  },
  capture: {
    connect: (input) => invoke<CaptureStatus>('capture.connect', input),
    cancelConnect: () => invoke<void>('capture.cancelConnect'),
    disconnect: () => invoke<void>('capture.disconnect'),
    discover: () =>
      invoke<{ targets: CaptureTarget[]; audioDevices: AudioDevice[] }>('capture.discover'),
    configure: (input) => invoke<CaptureStatus>('capture.configure', input),
    selectPortalTarget: () => invoke<void>('capture.selectPortalTarget'),
    preflight: () => invoke<PreflightResult>('capture.preflight'),
    start: (input) => invoke<CaptureStatus>('capture.start', input),
    stop: () => invoke<CaptureStatus>('capture.stop'),
    status: () => invoke<CaptureStatus>('capture.status')
  },
  providers: {
    list: () => invoke<ProviderProfileV1[]>('providers.list'),
    chooseExecutable: () => invoke<string | null>('providers.chooseExecutable'),
    save: (input: ProviderInput) => invoke<ProviderProfileV1>('providers.save', input),
    delete: (id) => invoke<void>('providers.delete', id),
    test: (input) => invoke('providers.test', input)
  },
  whisper: {
    status: () => invoke<ManagedWhisperStatus>('whisper.status'),
    install: () =>
      invoke<{ status: ManagedWhisperStatus; profile: ProviderProfileV1 }>('whisper.install'),
    cancelInstall: () => invoke<void>('whisper.cancelInstall'),
    start: () => invoke<ManagedWhisperStatus>('whisper.start'),
    stop: () => invoke<ManagedWhisperStatus>('whisper.stop')
  },
  diarization: {
    status: () => invoke<ManagedDiarizationStatus>('diarization.status'),
    install: () => invoke<ManagedDiarizationStatus>('diarization.install'),
    cancelInstall: () => invoke<void>('diarization.cancelInstall'),
    start: () => invoke<ManagedDiarizationStatus>('diarization.start'),
    stop: () => invoke<ManagedDiarizationStatus>('diarization.stop')
  },
  jobs: {
    retry: (id) => invoke<Job>('jobs.retry', id),
    cancel: (id) => invoke<void>('jobs.cancel', id)
  },
  transcript: {
    save: (input) => invoke<TranscriptDocumentV1>('transcript.save', input),
    renameSpeaker: (input) => invoke<TranscriptDocumentV1>('transcript.renameSpeaker', input),
    mergeSpeakers: (input) => invoke<TranscriptDocumentV1>('transcript.mergeSpeakers', input)
  },
  summary: {
    generate: (input) => invoke<Job>('summary.generate', input),
    save: (input) => invoke<SummaryDocumentV1>('summary.save', input)
  },
  exports: {
    chooseDirectory: () => invoke<string | null>('exports.chooseDirectory'),
    write: (input: ExportRequest) => invoke<string[]>('exports.write', input)
  },
  events: {
    subscribe: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: SessionScribeEvent): void =>
        listener(value)
      ipcRenderer.on(IPC.event, handler)
      return () => ipcRenderer.removeListener(IPC.event, handler)
    }
  }
}

contextBridge.exposeInMainWorld('sessionScribe', api)
