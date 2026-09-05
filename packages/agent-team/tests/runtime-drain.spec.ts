import { afterEach, expect, it, vi } from 'vitest'
import { MAX_TIMER_TIMEOUT_MS, RetainedShutdown, RuntimeDrain } from '../src/runtime-drain.ts'
afterEach(() => vi.useRealTimers())

it('rejects timer delays Node would clamp', () => {
  expect(() => new RuntimeDrain(MAX_TIMER_TIMEOUT_MS + 1)).toThrow(/maximum timer delay/)
  expect(() => new RetainedShutdown(MAX_TIMER_TIMEOUT_MS + 1)).toThrow(/maximum timer delay/)
})

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

it('bounds one retained whole shutdown, joins after timeout, and releases only after completion', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const shutdown = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const retained = new RetainedShutdown(100)

  const first = expect(retained.close(shutdown)).rejects.toThrow(/shutdown is unconfirmed/)
  await vi.advanceTimersByTimeAsync(100)
  await first

  const joined = retained.close(shutdown)
  expect(shutdown).toHaveBeenCalledTimes(1)
  finish()
  await joined
  await retained.close(shutdown)
  expect(shutdown).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('propagates a retained shutdown failure to joiners and permits an explicit later retry', async () => {
  let fail!: (error: Error) => void
  const shutdown = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject }))
  const retained = new RetainedShutdown(100)
  const first = retained.close(shutdown)
  const joined = retained.close(shutdown)
  await Promise.resolve()
  expect(shutdown).toHaveBeenCalledTimes(1)
  fail(new Error('provider close failed'))
  await expect(first).rejects.toThrow('provider close failed')
  await expect(joined).rejects.toThrow('provider close failed')
  await retained.close(async () => {})
  expect(shutdown).toHaveBeenCalledTimes(1)
})
