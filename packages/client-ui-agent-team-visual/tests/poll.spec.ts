/** Adaptive poller coverage: intervals, backoff, poke, overlap safety, stop. */

import { describe, expect, it } from 'vitest'
import { startPoller } from '../src/engine/poll.ts'

/** Injected schedule registry keeping every pending callback (stale ones included). */
function scheduler(): {
  readonly schedule: (cb: () => void, ms: number) => void
  readonly last: () => number | null
  readonly pendingCount: () => number
  readonly fireLatest: () => boolean
  readonly fireAll: () => void
} {
  const pending: { cb: () => void; ms: number }[] = []
  return {
    schedule(cb: () => void, ms: number): void {
      pending.push({ cb, ms })
    },
    last: () => pending.length === 0 ? null : (pending[pending.length - 1]?.ms ?? null),
    pendingCount: () => pending.length,
    fireLatest(): boolean {
      const entry = pending.pop()
      if (entry === undefined) return false
      entry.cb()
      return true
    },
    fireAll(): void {
      pending.splice(0).forEach(entry => { entry.cb() })
    },
  }
}

/** Manually gated task for overlap testing. */
function gate(): {
  readonly task: () => Promise<void>
  readonly runs: () => number
  readonly resolve: () => void
} {
  let runs = 0
  let resolveTask: (() => void) | null = null
  return {
    task(): Promise<void> {
      runs += 1
      return new Promise<void>(resolve => { resolveTask = resolve })
    },
    runs: () => runs,
    resolve(): void { resolveTask?.() },
  }
}

const tick = async (): Promise<void> => { await Promise.resolve() }

describe('startPoller', () => {
  it('runs the task immediately, then reschedules at activeMs when active', async () => {
    const timer = scheduler()
    let runs = 0
    startPoller(() => { runs += 1; return Promise.resolve() }, {
      activeMs: 2000, idleMs: 10000, isActive: () => true, schedule: timer.schedule,
    })
    expect(runs).toBe(1)
    await tick()
    expect(timer.last()).toBe(2000)
  })

  it('reschedules at idleMs when inactive', async () => {
    const timer = scheduler()
    startPoller(() => Promise.resolve(), {
      activeMs: 2000, idleMs: 10000, isActive: () => false, schedule: timer.schedule,
    })
    await tick()
    expect(timer.last()).toBe(10000)
  })

  it('re-runs the task when the scheduled delay fires', async () => {
    const timer = scheduler()
    let runs = 0
    startPoller(() => { runs += 1; return Promise.resolve() }, {
      activeMs: 2000, idleMs: 10000, isActive: () => true, schedule: timer.schedule,
    })
    await tick()
    timer.fireLatest()
    expect(runs).toBe(2)
    await tick()
    expect(timer.last()).toBe(2000)
  })

  it('backs off exponentially on errors (2^errors * activeMs, capped at 30000)', async () => {
    const timer = scheduler()
    let failures = 0
    startPoller(() => {
      failures += 1
      return Promise.reject(new Error('offline'))
    }, {
      activeMs: 2000, idleMs: 10000, isActive: () => true, schedule: timer.schedule,
    })
    const expected = [4000, 8000, 16000, 30000, 30000]
    for (const wait of expected) {
      await tick()
      expect(timer.last()).toBe(wait)
      timer.fireLatest()
    }
    expect(failures).toBe(expected.length + 1)
  })

  it('resets the error backoff after a success', async () => {
    const timer = scheduler()
    let fail = true
    startPoller(() => fail ? Promise.reject(new Error('x')) : Promise.resolve(), {
      activeMs: 2000, idleMs: 10000, isActive: () => true, schedule: timer.schedule,
    })
    await tick()
    expect(timer.last()).toBe(4000) // one failure
    fail = false
    timer.fireLatest()
    await tick()
    expect(timer.last()).toBe(2000) // success resets to the active interval
  })

  it('poke() cancels the pending schedule and runs immediately', async () => {
    const timer = scheduler()
    let runs = 0
    const poller = startPoller(() => { runs += 1; return Promise.resolve() }, {
      activeMs: 2000, idleMs: 10000, isActive: () => true, schedule: timer.schedule,
    })
    await tick()
    poller.poke()
    expect(runs).toBe(2)
    await tick()
    // Stale pre-poke callback plus the poke's own reschedule are both pending.
    expect(timer.pendingCount()).toBe(2)
    timer.fireAll() // stale entry is a no-op; only the fresh one re-runs the task
    expect(runs).toBe(3)
  })

  it('never runs concurrently with itself (poke while pending is dropped)', async () => {
    const timer = scheduler()
    const gated = gate()
    const poller = startPoller(gated.task, {
      activeMs: 2000, idleMs: 10000, isActive: () => true, schedule: timer.schedule,
    })
    expect(gated.runs()).toBe(1)
    poller.poke() // task still pending → no second run
    expect(gated.runs()).toBe(1)
    gated.resolve()
    await tick()
    expect(timer.last()).toBe(2000) // the single in-flight run reschedules once
    poller.stop()
  })

  it('stop() cancels the pending schedule; no further runs', async () => {
    const timer = scheduler()
    let runs = 0
    const poller = startPoller(() => { runs += 1; return Promise.resolve() }, {
      activeMs: 2000, idleMs: 10000, isActive: () => true, schedule: timer.schedule,
    })
    await tick()
    poller.stop()
    poller.poke()
    timer.fireAll()
    expect(runs).toBe(1)
  })

  it('does not reschedule when a task finishes after stop()', async () => {
    const timer = scheduler()
    const gated = gate()
    const poller = startPoller(gated.task, {
      activeMs: 2000, idleMs: 10000, isActive: () => true, schedule: timer.schedule,
    })
    poller.stop()
    gated.resolve()
    await tick()
    expect(timer.pendingCount()).toBe(0)
  })
})
