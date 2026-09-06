import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DispatchQueue } from '../src/dispatch-queue.ts'

const directories: string[] = []
const queues: DispatchQueue[] = []
afterEach(async () => {
  for (const queue of queues.splice(0)) await queue.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-dispatch-'))
  directories.push(directory)
  const queue = await DispatchQueue.open(directory)
  queues.push(queue)
  return { directory, queue }
}
const work = (projectId: string, taskId: string) => ({ projectId, teamId: `${projectId}-team`, taskId })

it('preserves stable queue order and scoped priority across restart', async () => {
  const { directory, queue } = await fixture()
  await queue.enqueue(work('a', 'first'))
  await queue.enqueue(work('a', 'second'))
  await queue.enqueue(work('b', 'third'))
  await queue.enqueue(work('a', 'first'))
  await queue.reprioritize(work('a', 'second'), 1, 10)
  await expect(queue.reprioritize(work('a', 'second'), 1, 100)).rejects.toThrow(/Stale/)
  await queue.close()
  const restored = await DispatchQueue.open(directory)
  queues.push(restored)
  expect(restored.list()).toHaveLength(3)
  expect(await restored.select(() => true, 1_000, 0)).toMatchObject({ projectId: 'a', taskId: 'second', priority: 10, revision: 2 })
  // Project turns outrank per-project priority, so a busy project cannot starve b.
  expect(await restored.select(() => true, 1_000, 0)).toMatchObject({ projectId: 'b', taskId: 'third' })
})

it('persists pacing and fair turns even if a process dies before reserving its selection', async () => {
  const { directory, queue } = await fixture()
  await queue.enqueue(work('a', 'first'))
  await queue.enqueue(work('b', 'second'))
  expect(await queue.select(() => true, 1_000, 100)).toMatchObject({ projectId: 'a' })
  await queue.close()
  const restored = await DispatchQueue.open(directory)
  queues.push(restored)
  expect(await restored.select(() => true, 1_099, 100)).toBeUndefined()
  expect(await restored.select(() => true, 999, 100)).toBeUndefined()
  expect(await restored.select(() => true, 1_100, 100)).toMatchObject({ projectId: 'b' })
  // A selected request is not consumed: assignment identity is the authoritative fence.
  expect(await restored.select(request => request.projectId === 'a', 1_200, 100)).toMatchObject({ taskId: 'first' })
})

it('skips paused, capacity-blocked or dependency-blocked work without changing its order', async () => {
  const { queue } = await fixture()
  await queue.enqueue(work('a', 'blocked'))
  await queue.enqueue(work('b', 'ready'))
  await queue.enqueue(work('a', 'later'))
  const original = queue.list()
  expect(await queue.select(request => request.projectId === 'b', 10, 0)).toMatchObject({ taskId: 'ready' })
  expect(await queue.select(request => request.projectId === 'a', 11, 0)).toMatchObject({ taskId: 'blocked' })
  expect(queue.list()).toEqual(original)
})


it('records a selected operator retry with durable enqueue age while preserving global pacing', async () => {
  const { directory, queue } = await fixture()
  await queue.enqueue(work('a', 'retry'), 123)
  expect(queue.list()[0]).toMatchObject({ enqueuedAt: 123 })
  expect(await queue.selectExact(work('a', 'retry'), 1_000, 100)).toMatchObject({ taskId: 'retry' })
  await queue.close()
  const restored = await DispatchQueue.open(directory)
  queues.push(restored)
  expect(restored.list()[0]).toMatchObject({ enqueuedAt: 123 })
  expect(await restored.selectExact(work('a', 'retry'), 1_099, 100)).toBeUndefined()
})
