import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HealthRecoveryStore, HealthRecoveryExecutor } from '../src/health-recovery.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function open() { const root = await mkdtemp(join(tmpdir(), 'gasteam-health-recovery-')); roots.push(root); return { root, store: await HealthRecoveryStore.open(root) } }
const input = { attemptId: 'attempt', generation: 1, healthRevision: 4, condition: 'stale' as const, maxNudges: 2 }

it('persists immutable intent, deterministic reserved message identity, and exactly-once transitions across restore', async () => {
  const { root, store } = await open()
  const intent = await store.intent(input)
  expect(intent).toMatchObject({ phase: 'intent', messageId: expect.stringMatching(/^health-nudge-[0-9a-f]{48}$/) })
  expect(await store.intent(input)).toEqual(intent)
  const binding = { attemptId: input.attemptId, generation: input.generation, healthRevision: input.healthRevision, condition: input.condition }
  await store.revalidate(binding); await store.request(binding)
  const done = await store.receipt(binding, 'mailbox-receipt')
  await store.close()
  const restored = await HealthRecoveryStore.open(root)
  expect(restored.list()).toEqual([done])
  expect(await restored.receipt(binding, 'mailbox-receipt')).toEqual(done)
  await restored.close()
})

it('rejects non-actionable classifications, changed immutable policy, and out-of-order effects', async () => {
  const { store } = await open()
  await expect(store.intent({ ...input, condition: 'unknown' as never })).rejects.toThrow()
  await store.intent(input)
  await expect(store.intent({ ...input, maxNudges: 3 })).rejects.toThrow(/immutable/)
  await expect(store.request({ attemptId: input.attemptId, generation: input.generation, healthRevision: input.healthRevision, condition: input.condition })).rejects.toThrow(/Invalid/)
  await store.close()
})

it('pins one generation budget across revisions and preserves completed replay identity', async () => {
  const { root, store } = await open()
  await store.intent(input)
  await expect(store.intent({ ...input, healthRevision: 5, maxNudges: 3 })).rejects.toThrow(/immutable/)
  const next = { ...input, healthRevision: 5 }
  await store.intent(next)
  await expect(store.intent({ ...input, healthRevision: 6, maxNudges: 9 })).rejects.toThrow(/budget/)
  const binding = { attemptId: input.attemptId, generation: 1, healthRevision: 4, condition: 'stale' as const }
  await store.revalidate(binding); await store.request(binding); const receipt = await store.receipt(binding, 'delivery')
  expect(await store.intent(input)).toEqual(receipt)
  await expect(store.receipt(binding, 'different')).rejects.toThrow(/receipt/)
  await store.close()
  const restored = await HealthRecoveryStore.open(root)
  expect(restored.list()).toHaveLength(2)
  await restored.close()
})

it('uses valid bounded IDs and atomically admits one concurrent immutable intent', async () => {
  const { store } = await open()
  const long = { attemptId: `a${'x'.repeat(127)}`, generation: 2, healthRevision: 1, condition: 'failed' as const, maxNudges: 1 }
  const [left, right] = await Promise.all([store.intent(long), store.intent(long)])
  expect(left).toEqual(right)
  expect(left.messageId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
  await store.close()
})

it('replays one reserved delivery after crash boundaries and fences changed state', async () => {
  const { store } = await open(); let reserve = 0, deliver = 0
  let current = { attemptId: 'attempt', generation: 1, healthRevision: 4, condition: 'stale' as const, actionable: true, acknowledged: false, assignmentRevision: 1, observedSequence: 1, active: true }
  const executor = new HealthRecoveryExecutor(store, {
    current: async () => current,
    reserve: async () => { reserve++ },
    deliver: async () => { deliver++; return 'receipt-1' },
  })
  await executor.nudge(input); await executor.nudge(input)
  expect({ reserve, deliver }).toEqual({ reserve: 1, deliver: 1 })
  current = { ...current, acknowledged: true }
  expect(await executor.nudge({ ...input, healthRevision: 5 })).toBeUndefined()
  expect({ reserve, deliver }).toEqual({ reserve: 1, deliver: 1 })
  await store.close()
})

it('reserves no host effect for an acknowledged current health incident', async () => {
  const { store } = await open(); let reserve = 0, deliver = 0
  const executor = new HealthRecoveryExecutor(store, {
    current: async () => ({ attemptId: 'attempt', generation: 1, healthRevision: 4, condition: 'stale' as const, actionable: true, acknowledged: true, assignmentRevision: 1, observedSequence: 1, active: true }),
    reserve: async () => { reserve++ }, deliver: async () => { deliver++; return 'unexpected' },
  })
  expect(await executor.nudge(input)).toBeUndefined()
  expect({ reserve, deliver }).toEqual({ reserve: 0, deliver: 0 })
  expect(store.list()[0]).toMatchObject({ phase: 'intent' })
  await store.close()
})

it('fences a capability result for a different current attempt or generation', async () => {
  const { store } = await open(); let reserve = 0, deliver = 0
  const executor = new HealthRecoveryExecutor(store, {
    current: async () => ({ attemptId: 'different', generation: 2, healthRevision: 4, condition: 'stale' as const, actionable: true, acknowledged: false, assignmentRevision: 1, observedSequence: 1, active: true }),
    reserve: async () => { reserve++ }, deliver: async () => { deliver++; return 'unexpected' },
  })
  expect(await executor.nudge(input)).toBeUndefined()
  expect({ reserve, deliver }).toEqual({ reserve: 0, deliver: 0 })
  await store.close()
})

it('reopens a requested intent after a delivery crash without consuming another nudge', async () => {
  const { root, store } = await open(); let calls = 0
  const current = { attemptId: 'attempt', generation: 1, healthRevision: 4, condition: 'stale' as const, actionable: true, acknowledged: false, assignmentRevision: 1, observedSequence: 1, active: true }
  const caps = { current: async () => current, reserve: async () => {}, deliver: async ({ messageId }: { messageId: string }) => { calls++; if (calls === 1) throw new Error('crash after reserved delivery'); return `receipt-${messageId}` } }
  await expect(new HealthRecoveryExecutor(store, caps).nudge(input)).rejects.toThrow('crash')
  await store.close()
  const restored = await HealthRecoveryStore.open(root)
  const completed = await new HealthRecoveryExecutor(restored, caps).nudge(input)
  expect(completed).toMatchObject({ phase: 'receipt', messageId: expect.stringMatching(/^health-nudge-/) })
  expect(calls).toBe(2)
  expect(restored.list()).toHaveLength(1)
  await restored.close()
})
