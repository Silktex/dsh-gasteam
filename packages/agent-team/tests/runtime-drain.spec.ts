import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeDrain } from '../src/runtime-drain.ts'
afterEach(() => vi.useRealTimers())

it('bounds observation while retaining and rejoining the same pending shutdown', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const stop = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const drains = new RuntimeDrain(100)
  const first = expect(drains.wait('worker', stop)).rejects.toThrow(/termination is unconfirmed/)
  await vi.advanceTimersByTimeAsync(100)
  await first
  const second = drains.wait('worker', stop)
  expect(stop).toHaveBeenCalledTimes(1)
  finish()
  await second
  expect(vi.getTimerCount()).toBe(0)
})

it('lets unrelated workers drain and observes late failure without leaving timers', async () => {
  vi.useFakeTimers()
  let fail!: (error: Error) => void
  const drains = new RuntimeDrain(100)
  const stalled = expect(drains.wait('stalled', () => new Promise<void>((_resolve, reject) => { fail = reject }))).rejects.toThrow(/timed out/)
  await drains.wait('healthy', async () => {})
  await vi.advanceTimersByTimeAsync(100)
  await stalled
  const lateFailure = expect(drains.wait('stalled', async () => {})).rejects.toThrow('provider failed after timeout')
  fail(new Error('provider failed after timeout'))
  await lateFailure
  await drains.wait('stalled', async () => {})
  expect(vi.getTimerCount()).toBe(0)
})
