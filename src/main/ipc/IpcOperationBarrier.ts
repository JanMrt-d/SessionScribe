export class IpcOperationBarrier {
  private blocked = false
  private readonly pending = new Set<Promise<void>>()

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.blocked) {
      return Promise.reject(new Error('SessionScribe is preparing to quit'))
    }

    const result = Promise.resolve().then(operation)
    const completion = result.then(
      () => undefined,
      () => undefined
    )
    this.pending.add(completion)
    void completion.then(() => this.pending.delete(completion))
    return result
  }

  async blockAndWait(): Promise<void> {
    this.blocked = true
    while (this.pending.size > 0) await Promise.all(this.pending)
  }

  resume(): void {
    this.blocked = false
  }
}
