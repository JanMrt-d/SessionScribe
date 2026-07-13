import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ObsGateway } from './ObsGateway'

class HangingObsClient extends EventEmitter {
  identified = false
  connect = vi.fn(() => new Promise<never>(() => undefined))
  disconnect = vi.fn(async () => undefined)
  call = vi.fn(() => new Promise<never>(() => undefined))
}

class StagedObsClient extends EventEmitter {
  identified = false
  connect = vi.fn(
    () =>
      new Promise<{ negotiatedRpcVersion: number }>((resolve) => {
        setTimeout(() => {
          this.identified = true
          resolve({ negotiatedRpcVersion: 1 })
        }, 40)
      })
  )
  disconnect = vi.fn(async () => undefined)
  call = vi.fn(() => new Promise<never>(() => undefined))
}

describe('ObsGateway connection lifetime', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('closes a pending socket when the connection is cancelled', async () => {
    const client = new HangingObsClient()
    const gateway = new ObsGateway(client as never)
    const abortController = new AbortController()
    const connection = gateway.connect({
      url: 'ws://127.0.0.1:4455',
      password: '',
      timeoutMs: 10_000,
      signal: abortController.signal
    })
    const cancelled = expect(connection).rejects.toMatchObject({ code: 'OBS_CONNECT_CANCELLED' })

    abortController.abort()
    await cancelled
    await Promise.resolve()
    expect(client.disconnect).toHaveBeenCalledOnce()
  })

  it('closes a silent socket when the handshake deadline expires', async () => {
    vi.useFakeTimers()
    const client = new HangingObsClient()
    const gateway = new ObsGateway(client as never)
    const connection = gateway.connect({
      url: 'ws://127.0.0.1:4455',
      password: '',
      timeoutMs: 50
    })
    const timedOut = expect(connection).rejects.toMatchObject({ code: 'OBS_TIMEOUT' })

    await vi.advanceTimersByTimeAsync(50)
    await timedOut
    await Promise.resolve()
    expect(client.disconnect).toHaveBeenCalledOnce()
  })

  it('shares one deadline between identification and GetVersion', async () => {
    vi.useFakeTimers()
    const client = new StagedObsClient()
    const gateway = new ObsGateway(client as never)
    const connection = gateway.connect({
      url: 'ws://127.0.0.1:4455',
      password: '',
      timeoutMs: 50
    })
    const timedOut = expect(connection).rejects.toMatchObject({ code: 'OBS_TIMEOUT' })

    await vi.advanceTimersByTimeAsync(50)
    await timedOut
    expect(client.call).toHaveBeenCalledWith('GetVersion', undefined)
    expect(client.disconnect).toHaveBeenCalledOnce()
  })

  it('applies the ambient connection cancellation signal to provisioning requests', async () => {
    const client = new HangingObsClient()
    client.identified = true
    const gateway = new ObsGateway(client as never)
    const abortController = new AbortController()
    const request = gateway.runWithConnectionContext({ signal: abortController.signal }, () =>
      gateway.call('GetVersion')
    )
    const cancelled = expect(request).rejects.toMatchObject({ code: 'OBS_CONNECT_CANCELLED' })

    abortController.abort()
    await cancelled
  })

  it('applies the ambient connection deadline to provisioning requests', async () => {
    vi.useFakeTimers()
    const client = new HangingObsClient()
    client.identified = true
    const gateway = new ObsGateway(client as never)
    const request = gateway.runWithConnectionContext({ deadlineMs: Date.now() + 50 }, () =>
      gateway.call('GetVersion')
    )
    const timedOut = expect(request).rejects.toMatchObject({ code: 'OBS_TIMEOUT' })

    await vi.advanceTimersByTimeAsync(50)
    await timedOut
  })

  it('bounds an unresponsive graceful disconnect', async () => {
    vi.useFakeTimers()
    const client = new HangingObsClient()
    client.disconnect = vi.fn(() => new Promise<never>(() => undefined))
    const gateway = new ObsGateway(client as never)
    const disconnect = gateway.disconnect(50)
    const timedOut = expect(disconnect).rejects.toMatchObject({ code: 'OBS_TIMEOUT' })

    await vi.advanceTimersByTimeAsync(50)
    await timedOut
  })
})
