import { describe, expect, it, vi } from 'vitest'

import { IpcRouter } from './IpcRouter'

describe('IpcRouter OBS connection cancellation', () => {
  it('cancels an attempt that is still waiting for a remembered password', async () => {
    const rememberedPassword = deferred<string | null>()
    const connect = vi.fn(async () => ({ connected: true }))
    const cancelConnect = vi.fn(async () => undefined)
    const getSecret = vi.fn(() => rememberedPassword.promise)
    const router = new IpcRouter({
      profiles: { list: () => [] },
      secrets: { get: getSecret },
      capture: { connect, cancelConnect }
    } as never)
    const invoke = (
      router as unknown as {
        invokeMethod(method: string, input: unknown): Promise<unknown>
      }
    ).invokeMethod.bind(router)

    const connection = invoke('capture.connect', {
      url: 'ws://127.0.0.1:4455',
      password: '',
      rememberPassword: false
    })
    const cancelled = expect(connection).rejects.toThrow('The OBS connection attempt was cancelled')
    await vi.waitFor(() => {
      expect(getSecret).toHaveBeenCalledOnce()
    })
    await invoke('capture.cancelConnect', undefined)
    rememberedPassword.resolve(null)
    await cancelled

    expect(cancelConnect).toHaveBeenCalledOnce()
    expect(connect).not.toHaveBeenCalled()
  })

  it('disconnects a completed attempt when cancellation wins during password storage', async () => {
    const passwordStored = deferred<void>()
    const connect = vi.fn(async () => ({ connected: true }))
    const cancelConnect = vi.fn(async () => undefined)
    const disconnect = vi.fn(async () => undefined)
    const putSecret = vi.fn(() => passwordStored.promise)
    const router = new IpcRouter({
      profiles: { list: () => [] },
      secrets: { get: vi.fn(async () => null), put: putSecret },
      capture: { connect, cancelConnect, disconnect }
    } as never)
    const invoke = (
      router as unknown as {
        invokeMethod(method: string, input: unknown): Promise<unknown>
      }
    ).invokeMethod.bind(router)

    const connection = invoke('capture.connect', {
      url: 'ws://127.0.0.1:4455',
      password: 'secret',
      rememberPassword: true
    })
    const cancelled = expect(connection).rejects.toThrow('The OBS connection attempt was cancelled')
    await vi.waitFor(() => expect(putSecret).toHaveBeenCalledOnce())
    await invoke('capture.cancelConnect', undefined)
    passwordStored.resolve()
    await cancelled

    expect(connect).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('cleans up when cancellation wins as the capture connection completes', async () => {
    const connected = deferred<{ connected: boolean }>()
    const connect = vi.fn(() => connected.promise)
    const cancelConnect = vi.fn(async () => undefined)
    const router = new IpcRouter({
      profiles: { list: () => [] },
      secrets: { get: vi.fn(async () => null) },
      capture: { connect, cancelConnect }
    } as never)
    const invoke = (
      router as unknown as {
        invokeMethod(method: string, input: unknown): Promise<unknown>
      }
    ).invokeMethod.bind(router)

    const connection = invoke('capture.connect', {
      url: 'ws://127.0.0.1:4455',
      password: 'secret',
      rememberPassword: false
    })
    const cancelled = expect(connection).rejects.toThrow('The OBS connection attempt was cancelled')
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
    await invoke('capture.cancelConnect', undefined)
    connected.resolve({ connected: true })
    await cancelled

    expect(cancelConnect).toHaveBeenCalledTimes(2)
  })
})

describe('IpcRouter managed Whisper', () => {
  it('installs the runtime and creates an idempotent default profile', async () => {
    const status = {
      phase: 'stopped',
      message: 'Whisper is installed and stopped.',
      installed: true,
      progress: null,
      activeTranscriptions: 0,
      idleStopAt: null,
      canInstall: false,
      canStart: true,
      canStop: false
    } as const
    const profile = { id: 'managed-profile', kind: 'managed-whisper' }
    const install = vi.fn(async () => status)
    const ensureManagedWhisperDefault = vi.fn(() => profile)
    const router = new IpcRouter({
      profiles: { list: () => [], ensureManagedWhisperDefault },
      whisper: { install }
    } as never)
    const invoke = (
      router as unknown as {
        invokeMethod(method: string, input: unknown): Promise<unknown>
      }
    ).invokeMethod.bind(router)

    await expect(invoke('whisper.install', undefined)).resolves.toEqual({ status, profile })
    expect(install).toHaveBeenCalledOnce()
    expect(ensureManagedWhisperDefault).toHaveBeenCalledOnce()
  })

  it('accepts a missing summary profile while still requiring transcription', () => {
    const getProviderProfile = vi.fn((id: string) =>
      id === 'transcription' ? { id, task: 'transcription', kind: 'managed-whisper' } : null
    )
    const router = new IpcRouter({
      profiles: { list: () => [] },
      database: { getProviderProfile }
    } as never)
    const validate = (
      router as unknown as {
        validateProcessingProfiles(transcriptionId: string, summaryId: string | null): void
      }
    ).validateProcessingProfiles.bind(router)

    expect(() => validate('transcription', null)).not.toThrow()
    expect(() => validate('missing', null)).toThrow('Choose an available transcription provider')
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = (value) => {
      resolve(value)
    }
  })
  return { promise, resolve: resolvePromise }
}
