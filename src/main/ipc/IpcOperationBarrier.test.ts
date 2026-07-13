import { describe, expect, it } from 'vitest'
import { IpcOperationBarrier } from './IpcOperationBarrier'

describe('IpcOperationBarrier', () => {
  it('blocks new IPC work and waits for in-flight work until shutdown is cancelled', async () => {
    const barrier = new IpcOperationBarrier()
    const work = deferred<void>()
    const operation = barrier.run(() => work.promise)
    const shutdown = barrier.blockAndWait()
    let shutdownFinished = false
    void shutdown.then(() => {
      shutdownFinished = true
    })

    await Promise.resolve()
    expect(shutdownFinished).toBe(false)
    await expect(barrier.run(async () => undefined)).rejects.toThrow(
      'SessionScribe is preparing to quit'
    )

    work.resolve()
    await expect(operation).resolves.toBeUndefined()
    await expect(shutdown).resolves.toBeUndefined()

    barrier.resume()
    await expect(barrier.run(async () => undefined)).resolves.toBeUndefined()
  })
})

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}
