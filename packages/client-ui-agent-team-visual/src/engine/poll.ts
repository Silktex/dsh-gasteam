/** Adaptive RPC poller: active/idle cadence, exponential error backoff, poke/stop. */

/** Handle returned by startPoller. */
export interface Poller { stop(): void; poke(): void }

/** Options for startPoller; `schedule` is injectable so tests need no real timers. */
export interface PollerOptions {
  readonly activeMs: number
  readonly idleMs: number
  readonly isActive: () => boolean
  readonly schedule?: (cb: () => void, ms: number) => void
}

/** Cap for the exponential error backoff. */
const MAX_BACKOFF_MS = 30000

/**
 * Run `task` immediately, then reschedule after `activeMs` when isActive()
 * else `idleMs`. On task rejection wait min(2^errors * activeMs, 30000);
 * errors reset on success. poke() runs the task now and cancels the pending
 * schedule (manual refresh). stop() cancels the pending schedule and prevents
 * further runs. The task never runs concurrently with itself; a stale
 * scheduled callback (cancelled by poke/stop) is invalidated via a generation
 * token because the injectable schedule signature returns no handle.
 */
export function startPoller(task: () => Promise<void>, options: PollerOptions): Poller {
  const schedule = options.schedule
    ?? ((cb: () => void, ms: number): void => { setTimeout(cb, ms) })
  let stopped = false
  let running = false
  let errors = 0
  let token = 0

  const scheduleNext = (ms: number): void => {
    const mine = ++token
    schedule(() => {
      if (stopped || mine !== token) return
      void run()
    }, ms)
  }

  const run = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    try {
      await task()
      errors = 0
      if (!stopped) scheduleNext(options.isActive() ? options.activeMs : options.idleMs)
    } catch {
      errors += 1
      if (!stopped) scheduleNext(Math.min(2 ** errors * options.activeMs, MAX_BACKOFF_MS))
    } finally {
      running = false
    }
  }

  void run()

  return {
    stop(): void {
      stopped = true
      token += 1 // invalidate any pending scheduled callback
    },
    poke(): void {
      if (stopped) return
      token += 1 // cancel the pending schedule
      void run()
    },
  }
}
