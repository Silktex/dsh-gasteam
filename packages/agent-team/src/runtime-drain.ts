/** A deadline bounds observation, never proves runtime termination. */
export interface RuntimeDrainDeadline {
  set(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout>
  clear(timer: ReturnType<typeof setTimeout>): void
}

/** Node clamps larger timer delays to one millisecond. */
export const MAX_TIMER_TIMEOUT_MS = 2_147_483_647

export class RuntimeDrain {
  private readonly pending = new Map<string, Promise<void>>()
  constructor(private readonly timeoutMs = 30_000, private readonly deadline: RuntimeDrainDeadline = { set: setTimeout, clear: clearTimeout }) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_TIMEOUT_MS) throw new Error('Drain timeout must be a positive integer no greater than Node\'s maximum timer delay')
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

/**
 * Bounds observation of one coordinator-wide shutdown without treating a
 * deadline as proof that its cancellation/drain work stopped.  A later close
 * joins the retained operation; only a positive completion makes close a
 * no-op.  A definite failure is surfaced to all joiners and may be retried.
 */
export class RetainedShutdown {
  private operation: Promise<void> | undefined
  private completed = false

  constructor(private readonly timeoutMs = 30_000, private readonly deadline: RuntimeDrainDeadline = { set: setTimeout, clear: clearTimeout }) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_TIMEOUT_MS) throw new Error('Shutdown timeout must be a positive integer no greater than Node\'s maximum timer delay')
  }

  close(shutdown: () => Promise<unknown>): Promise<void> {
    if (this.completed) return Promise.resolve()
    let operation = this.operation
    if (operation === undefined) {
      operation = Promise.resolve().then(shutdown).then(() => { this.completed = true })
      this.operation = operation
      void operation.then(
        () => { if (this.operation === operation) this.operation = undefined },
        () => { if (this.operation === operation) this.operation = undefined },
      )
    }
    return this.observe(operation)
  }

  private async observe(operation: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = this.deadline.set(() => reject(new Error('Coordinator shutdown timed out; shutdown is unconfirmed and ownership remains retained')), this.timeoutMs)
        }),
      ])
    } finally { if (timer !== undefined) this.deadline.clear(timer) }
  }
}
