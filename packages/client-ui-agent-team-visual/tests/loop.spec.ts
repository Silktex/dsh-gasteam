/** RAF loop coverage: injected scheduler, dt clamping, stop, setTimeout fallback. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { startLoop } from '../src/engine/loop.ts'

/** Manual frame scheduler: queue callbacks, flush them one by one. */
function fakeScheduler(): {
  requestFrame: (cb: () => void) => number
  cancelFrame: (id: number) => void
  runNext: () => boolean
  pending: () => number
} {
  let nextId = 0
  const queue = new Map<number, () => void>()
  return {
    requestFrame(cb: () => void): number {
      nextId += 1
      queue.set(nextId, cb)
      return nextId
    },
    cancelFrame(id: number): void {
      queue.delete(id)
    },
    runNext(): boolean {
      const first = queue.keys().next()
      if (first.done) return false
      const cb = queue.get(first.value)
      queue.delete(first.value)
      cb?.()
      return true
    },
    pending(): number {
      return queue.size
    },
  }
}

describe('startLoop', () => {
  it('invokes the callback on every scheduled frame with time and dt', () => {
    const scheduler = fakeScheduler()
    let clock = 1000
    const seen: [number, number][] = []
    startLoop((timeMs, dtMs) => { seen.push([timeMs, dtMs]) }, {
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
      now: () => clock,
    })
    scheduler.runNext()
    clock = 1016
    scheduler.runNext()
    clock = 1048
    scheduler.runNext()
    expect(seen).toEqual([[1000, 0], [1016, 16], [1048, 32]])
  })

  it('clamps dtMs to maxDtMs (default 100)', () => {
    const scheduler = fakeScheduler()
    let clock = 0
    const dts: number[] = []
    startLoop((_timeMs, dtMs) => { dts.push(dtMs) }, {
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
      now: () => clock,
    })
    scheduler.runNext()
    clock = 5000 // huge gap (tab was hidden)
    scheduler.runNext()
    expect(dts).toEqual([0, 100])
  })

  it('honors a custom maxDtMs', () => {
    const scheduler = fakeScheduler()
    let clock = 0
    const dts: number[] = []
    startLoop((_timeMs, dtMs) => { dts.push(dtMs) }, {
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
      maxDtMs: 40,
      now: () => clock,
    })
    scheduler.runNext()
    clock = 90
    scheduler.runNext()
    expect(dts).toEqual([0, 40])
  })

  it('stop() cancels the pending frame and prevents rescheduling', () => {
    const scheduler = fakeScheduler()
    let calls = 0
    const handle = startLoop(() => { calls += 1 }, {
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    })
    scheduler.runNext()
    handle.stop()
    expect(scheduler.pending()).toBe(0)
    expect(scheduler.runNext()).toBe(false)
    handle.stop() // idempotent
    expect(calls).toBe(1)
  })

  it('stop() inside the callback prevents the next frame', () => {
    const scheduler = fakeScheduler()
    let calls = 0
    const handle = startLoop(() => {
      calls += 1
      handle.stop()
    }, {
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    })
    scheduler.runNext()
    expect(calls).toBe(1)
    expect(scheduler.pending()).toBe(0)
  })

  it('propagates callback errors to the frame caller', () => {
    const scheduler = fakeScheduler()
    startLoop(() => { throw new Error('boom') }, {
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    })
    expect(() => { scheduler.runNext() }).toThrow('boom')
  })

  describe('setTimeout fallback (no requestAnimationFrame)', () => {
    const original = globalThis.requestAnimationFrame
    afterEach(() => {
      vi.restoreAllMocks()
      Object.defineProperty(globalThis, 'requestAnimationFrame', {
        value: original, configurable: true, writable: true,
      })
    })

    it('drives frames through setTimeout when rAF is unavailable', () => {
      // jsdom/node safety: no rAF and none injected → 16ms setTimeout loop.
      Object.defineProperty(globalThis, 'requestAnimationFrame', {
        value: undefined, configurable: true, writable: true,
      })
      const timeouts: number[] = []
      const pending: (() => void)[] = []
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        cb: () => void, ms?: number,
      ) => {
        timeouts.push(ms ?? 0)
        pending.push(cb)
        return pending.length
      }) as typeof setTimeout)
      let clock = 0
      const seen: [number, number][] = []
      const handle = startLoop((timeMs, dtMs) => { seen.push([timeMs, dtMs]) }, { now: () => clock })
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
      expect(timeouts).toEqual([16])
      clock = 16
      pending.shift()?.()
      clock = 48
      pending.shift()?.()
      expect(seen).toEqual([[16, 16], [48, 32]])
      handle.stop()
      // Cancelled frames are logical no-ops: running leftovers changes nothing.
      pending.splice(0).forEach(cb => { cb() })
      expect(seen).toHaveLength(2)
    })
  })
})
