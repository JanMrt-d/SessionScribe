import { ObsSubsystemError } from './errors'

export class SerializedCommandQueue {
  private tail: Promise<void> = Promise.resolve()
  private stopped = false
  private activeCount = 0

  get pending(): number {
    return this.activeCount
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) {
      throw new ObsSubsystemError('OBS_QUEUE_CLOSED', 'The OBS command queue is closed')
    }

    this.activeCount += 1
    const result = this.tail.then(operation)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )

    try {
      return await result
    } finally {
      this.activeCount -= 1
    }
  }

  async idle(): Promise<void> {
    await this.tail
  }

  close(): void {
    this.stopped = true
  }
}
