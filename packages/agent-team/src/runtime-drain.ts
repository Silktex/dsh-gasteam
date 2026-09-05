/** A deadline bounds observation, never proves runtime termination. */
export interface RuntimeDrainDeadline {
  set(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout>
  clear(timer: ReturnType<typeof setTimeout>): void
}

export class RuntimeDrain {
  private readonly pending = new Map<string, Promise<void>>()
  constructor(private readonly timeoutMs = 30_000, private readonly deadline: RuntimeDrainDeadline = { set: setTimeout, clear: clearTimeout }) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Drain timeout must be a positive integer')
  }

  async wait(identity: string, stop: () => Promise<unknown>): Promise<void> {
    let operation = this.pending.get(identity)
    if (operation === undefined) {
      operation = Promise.resolve().then(stop).then(() => {})
      this.pending.set(identity, operation)
      const forget = () => { if (this.pending.get(identity) === operation) this.pending.delete(identity) }
      // Observe both outcomes even when every deadline has already expired.
      void operation.then(forget, forget)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = this.deadline.set(() => reject(new Error(`Runtime drain timed out for ${identity}; termination is unconfirmed and capacity remains reserved`)), this.timeoutMs)
        }),
      ])
    } finally { if (timer !== undefined) this.deadline.clear(timer) }
  }
}
