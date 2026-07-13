import { describe, expect, it, vi } from 'vitest'

import type { CaptureStatus } from '@shared/capture'
import type { ObsCaptureService } from '../obs/ObsCaptureService'
import { ObsSubsystemError } from '../obs/errors'
import { LaunchableObsCaptureController } from './LaunchableObsCaptureController'

const READY_STATUS: CaptureStatus = {
  connected: true,
  obsVersion: '32.0.0',
  phase: 'ready',
  activeSessionId: null,
  elapsedMs: 0,
  bytesWritten: 0,
  microphoneLevel: 0,
  systemLevel: 0,
  warnings: []
}

const EXECUTABLE = {
  command: 'flatpak',
  args: ['run', 'com.obsproject.Studio'],
  kind: 'flatpak' as const
}

describe('LaunchableObsCaptureController', () => {
  it('reports a disabled local WebSocket server without launching or retrying', async () => {
    const connect = vi.fn().mockRejectedValue(unavailableError())
    const { service } = createService(connect)
    const discovery = {
      locate: vi.fn(async () => EXECUTABLE),
      readWebSocketSettings: vi.fn(async () => ({ enabled: false, port: 4455 })),
      launch: vi.fn(async () => undefined)
    }
    const controller = new LaunchableObsCaptureController(service, { discovery })

    await expect(
      controller.connect({ url: 'ws://127.0.0.1:4455', password: '' })
    ).rejects.toMatchObject({ code: 'OBS_WEBSOCKET_DISABLED' })
    expect(discovery.launch).not.toHaveBeenCalled()
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('reports the configured OBS port instead of retrying the wrong address', async () => {
    const connect = vi.fn().mockRejectedValue(unavailableError())
    const { service } = createService(connect)
    const discovery = {
      locate: vi.fn(async () => EXECUTABLE),
      readWebSocketSettings: vi.fn(async () => ({ enabled: true, port: 4466 })),
      launch: vi.fn(async () => undefined)
    }
    const controller = new LaunchableObsCaptureController(service, { discovery })

    await expect(
      controller.connect({ url: 'ws://127.0.0.1:4455', password: '' })
    ).rejects.toMatchObject({
      code: 'OBS_WEBSOCKET_PORT_MISMATCH',
      message:
        'OBS is configured for WebSocket port 4466, but SessionScribe is trying port 4455. Use ws://127.0.0.1:4466 and connect again.'
    })
    expect(discovery.launch).not.toHaveBeenCalled()
  })

  it('launches OBS and bounds every retry by the remaining startup deadline', async () => {
    let now = 0
    const connect = vi.fn().mockRejectedValue(unavailableError())
    const { service } = createService(connect)
    const discovery = {
      locate: vi.fn(async () => EXECUTABLE),
      readWebSocketSettings: vi.fn(async () => ({ enabled: true, port: 4455 })),
      launch: vi.fn(async () => undefined)
    }
    const controller = new LaunchableObsCaptureController(service, {
      discovery,
      launchTimeoutMs: 1_000,
      retryConnectTimeoutMs: 10_000,
      retryIntervalMs: 750,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds
      }
    })

    await expect(
      controller.connect({ url: 'ws://127.0.0.1:4455', password: '' })
    ).rejects.toMatchObject({ code: 'OBS_LAUNCH_TIMEOUT' })
    expect(discovery.launch).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect.mock.calls[1]?.[0]).toMatchObject({ timeoutMs: 250 })
    expect(now).toBe(1_000)
  })

  it('stops retry work when the connection dialog cancels', async () => {
    let markWaitStarted!: () => void
    const waitStarted = new Promise<void>((resolve) => {
      markWaitStarted = resolve
    })
    const connect = vi.fn().mockRejectedValue(unavailableError())
    const { service, cancelConnect } = createService(connect)
    const discovery = {
      locate: vi.fn(async () => EXECUTABLE),
      readWebSocketSettings: vi.fn(async () => ({ enabled: true, port: 4455 })),
      launch: vi.fn(async () => undefined)
    }
    const controller = new LaunchableObsCaptureController(service, {
      discovery,
      wait: (_milliseconds, signal) =>
        new Promise((_resolve, reject) => {
          markWaitStarted()
          signal.addEventListener(
            'abort',
            () =>
              reject(
                new ObsSubsystemError(
                  'OBS_CONNECT_CANCELLED',
                  'The OBS connection attempt was cancelled'
                )
              ),
            { once: true }
          )
        })
    })

    const attempt = controller.connect({ url: 'ws://127.0.0.1:4455', password: '' })
    const cancelled = expect(attempt).rejects.toMatchObject({ code: 'OBS_CONNECT_CANCELLED' })
    await waitStarted
    await controller.cancelConnect()
    await cancelled

    expect(cancelConnect).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('returns the status once OBS accepts a retry', async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(unavailableError())
      .mockResolvedValue(READY_STATUS)
    const { service } = createService(connect)
    const discovery = {
      locate: vi.fn(async () => EXECUTABLE),
      readWebSocketSettings: vi.fn(async () => ({ enabled: true, port: 4455 })),
      launch: vi.fn(async () => undefined)
    }
    const controller = new LaunchableObsCaptureController(service, {
      discovery,
      wait: async () => undefined
    })

    await expect(
      controller.connect({ url: 'ws://127.0.0.1:4455', password: 'secret' })
    ).resolves.toEqual(READY_STATUS)
    expect(connect).toHaveBeenCalledTimes(2)
  })
})

function unavailableError(): Error & { code: number } {
  return Object.assign(new Error('OBS is unavailable'), { code: -1 })
}

function createService(connect: ReturnType<typeof vi.fn>): {
  service: ObsCaptureService
  cancelConnect: ReturnType<typeof vi.fn>
} {
  const cancelConnect = vi.fn(async () => undefined)
  return {
    service: {
      connect,
      cancelConnect,
      gateway: { connected: false }
    } as unknown as ObsCaptureService,
    cancelConnect
  }
}
