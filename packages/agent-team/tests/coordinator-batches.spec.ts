import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoordinatorBatchStore, type WorkspaceTaskRef } from '../src/coordinator-batches.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const ref = (projectId: string, teamId: string, taskId: string): WorkspaceTaskRef => ({ projectId, teamId, taskId })
async function fixture(): Promise<{ root: string; batches: CoordinatorBatchStore }> { const root = await mkdtemp(join(tmpdir(), 'gasteam-batches-')); roots.push(root); return { root, batches: await CoordinatorBatchStore.open(root, (() => { let at = 10; return () => ++at })()) } }

it('rejects cross-project dependency cycles and derives only accepted required work as complete', async () => {
  const { batches } = await fixture()
  const a = ref('project-a', 'lead-a', 'a'), b = ref('project-b', 'lead-b', 'b')
  await expect(batches.create({ name: 'cycle', items: [{ ref: a, dependsOn: [b] }, { ref: b, dependsOn: [a] }] })).rejects.toThrow(/cycle/)
  const created = await batches.create({ id: 'across', name: 'across projects', items: [{ ref: a }, { ref: b, dependsOn: [a] }] })
  expect(created.readyWithoutActiveAssignment).toEqual([a])
  let current = await batches.observe('across', [{ ref: a, revision: { task: 1, generation: 0, attempt: 0, acceptance: 0 }, state: 'accepted', activeAssignment: false }, { ref: b, revision: { task: 1, generation: 0, attempt: 0, acceptance: 0 }, state: 'blocked', activeAssignment: false }])
  expect(current).toMatchObject({ phase: 'blocked', completedRequired: 1, required: 2 })
  expect(current.readyWithoutActiveAssignment).toEqual([])
  current = await batches.observe('across', [{ ref: b, revision: { task: 2, generation: 0, attempt: 0, acceptance: 0 }, state: 'waiting', activeAssignment: false }])
  expect(current.readyWithoutActiveAssignment).toEqual([b])
  current = await batches.observe('across', [{ ref: b, revision: { task: 3, generation: 0, attempt: 0, acceptance: 0 }, state: 'accepted', activeAssignment: false }])
  expect(current).toMatchObject({ phase: 'completed', completionEpoch: 1, completedRequired: 2 })
  await batches.close()
})

it('leaves an unrelated project item ready after another required item fails', async () => {
  const { batches } = await fixture()
  const failed = ref('project-a', 'lead-a', 'failed'), independent = ref('project-b', 'lead-b', 'independent')
  await batches.create({ id: 'independent-after-failure', name: 'independent after failure', items: [{ ref: failed }, { ref: independent }] })
  const view = await batches.observe('independent-after-failure', [
    { ref: failed, revision: { task: 2, generation: 1, attempt: 1, acceptance: 0 }, state: 'failed', activeAssignment: false },
    { ref: independent, revision: { task: 1, generation: 0, attempt: 0, acceptance: 0 }, state: 'waiting', activeAssignment: false },
  ])
  expect(view.phase).toBe('failed')
  expect(view.readyWithoutActiveAssignment).toEqual([independent])
  await batches.close()
})

it('reopens a failed current integration for its active repair generation and retains its failure history', async () => {
  const { batches } = await fixture()
  const work = ref('project-a', 'lead-a', 'repairable')
  await batches.create({ id: 'repair-current-outcome', name: 'repair current outcome', items: [{ ref: work }] })
  const failed = await batches.observe('repair-current-outcome', [{ ref: work, revision: { task: 1, generation: 1, attempt: 1, acceptance: 1 }, state: 'failed', activeAssignment: true }])
  expect(failed).toMatchObject({ phase: 'failed', items: [{ state: 'failed', activeAssignment: true }] })
  const active = await batches.observe('repair-current-outcome', [{ ref: work, revision: { task: 1, generation: 2, attempt: 1, acceptance: 0 }, state: 'active', activeAssignment: true }])
  expect(active).toMatchObject({ phase: 'active', items: [{ state: 'active', activeAssignment: true, history: [{ state: 'failed' }, { state: 'active' }] }], history: [{ phase: 'failed' }] })
  await expect(batches.observe('repair-current-outcome', [{ ref: work, revision: { task: 2, generation: 2, attempt: 1, acceptance: 2 }, state: 'accepted', activeAssignment: false }]))
    .resolves.toMatchObject({ phase: 'completed', completedRequired: 1 })
  await batches.close()
})

it('retains failed and reopened history and deduplicates completion intents across JSONL restart', async () => {
  const { root, batches } = await fixture()
  const work = ref('project-a', 'lead-a', 'task')
  await batches.create({ id: 'restart', name: 'restart', items: [{ ref: work }], subscriptions: [{ id: 'operator', destination: 'ops://batch' }] })
  await batches.observe('restart', [{ ref: work, revision: { task: 1, generation: 0, attempt: 0, acceptance: 0 }, state: 'failed', activeAssignment: false }])
  await batches.observe('restart', [{ ref: work, revision: { task: 2, generation: 0, attempt: 0, acceptance: 0 }, state: 'accepted', activeAssignment: false }])
  const first = await batches.notificationIntents()
  expect(first).toHaveLength(1)
  await batches.close()
  const restored = await CoordinatorBatchStore.open(root)
  expect(await restored.notificationIntents()).toEqual([first[0]])
  await restored.recordNotificationReceipt(first[0]!.intentId, 'delivered-1')
  await restored.recordNotificationReceipt(first[0]!.intentId, 'delivered-1')
  await expect(restored.recordNotificationReceipt(first[0]!.intentId, 'different-receipt')).rejects.toThrow(/replay differs/)
  expect(await restored.notificationIntents()).toEqual([])
  await restored.observe('restart', [{ ref: work, revision: { task: 3, generation: 0, attempt: 0, acceptance: 0 }, state: 'waiting', activeAssignment: false }])
  expect(restored.inspect('restart')).toMatchObject({ phase: 'active', completionEpoch: 1, history: [{ phase: 'failed' }, { phase: 'completed' }, { phase: 'reopened' }] })
  await restored.observe('restart', [{ ref: work, revision: { task: 4, generation: 0, attempt: 0, acceptance: 0 }, state: 'accepted', activeAssignment: false }])
  const second = await restored.notificationIntents()
  expect(second).toHaveLength(1)
  expect(second[0]).toMatchObject({ completionEpoch: 2 })
  expect(second[0]!.intentId).not.toBe(first[0]!.intentId)
  await restored.subscribe('restart', { id: 'audit', destination: 'ops://audit' })
  const late = await restored.notificationIntents()
  expect(late).toHaveLength(2)
  expect(late.find(value => value.subscriptionId === 'audit')).toMatchObject({ completionEpoch: 2 })
  await restored.close()
})

it('records a durable accepted receipt that materializes after an otherwise unchanged terminal attempt', async () => {
  const { batches } = await fixture()
  const work = ref('project-a', 'lead-a', 'receipt')
  await batches.create({ id: 'receipt-transition', name: 'receipt transition', items: [{ ref: work }] })
  await batches.observe('receipt-transition', [{ ref: work, revision: { task: 2, generation: 1, attempt: 4, acceptance: 0 }, state: 'blocked', activeAssignment: false }])
  await expect(batches.observe('receipt-transition', [{ ref: work, revision: { task: 2, generation: 1, attempt: 4, acceptance: 1 }, state: 'accepted', activeAssignment: false }]))
    .resolves.toMatchObject({ phase: 'completed', completedRequired: 1 })
  await batches.close()
})

it('upgrades a legacy accepted receipt revision without creating a second completion epoch', async () => {
  const { batches } = await fixture()
  const work = ref('project-a', 'lead-a', 'legacy-accepted')
  await batches.create({ id: 'legacy-accepted-receipt', name: 'legacy accepted receipt', items: [{ ref: work }] })
  await batches.observe('legacy-accepted-receipt', [{ ref: work, revision: { task: 2, generation: 1, attempt: 4, acceptance: 1 }, state: 'accepted', activeAssignment: false }])
  const upgraded = await batches.observe('legacy-accepted-receipt', [{ ref: work, revision: { task: 2, generation: 1, attempt: 4, acceptance: 2 }, state: 'accepted', activeAssignment: false }])
  expect(upgraded).toMatchObject({ phase: 'completed', completionEpoch: 1, history: [{ phase: 'completed' }] })
  await batches.close()
})

it('reopens a published numeric-observation journal and replaces its lossy revision on host reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gasteam-batches-legacy-')); roots.push(root)
  const work = ref('project-a', 'lead-a', 'legacy')
  const created = { version: 1, sequence: 1, type: 'batch/created', batch: { id: 'legacy', name: 'legacy revision',
    items: [{ ref: work, dependsOn: [], observationRevision: 0, state: 'waiting', activeAssignment: false, history: [] }], subscriptions: [], phase: 'active', completionEpoch: 0, history: [] } }
  const observed = { version: 1, sequence: 2, type: 'batch/observed', batchId: 'legacy', observations: [{ ref: work, revision: 7_001_001, state: 'accepted', activeAssignment: false }], at: 10 }
  await writeFile(join(root, 'coordinator-batches.jsonl'), `${JSON.stringify(created)}\n${JSON.stringify(observed)}\n`)
  const batches = await CoordinatorBatchStore.open(root)
  expect(batches.inspect('legacy')).toMatchObject({ phase: 'completed', completedRequired: 1, items: [{ state: 'accepted' }] })
  await batches.observe('legacy', [{ ref: work, revision: { task: 1, generation: 0, attempt: 0, acceptance: 0 }, state: 'waiting', activeAssignment: false }])
  expect(batches.inspect('legacy')).toMatchObject({ phase: 'active', completionEpoch: 1, history: [{ phase: 'completed' }, { phase: 'reopened' }], items: [{ state: 'waiting' }] })
  await batches.close()
})

it('rejects unrequired observations and makes missing ready assignment actionable', async () => {
  const { batches } = await fixture()
  const work = ref('project-a', 'lead-a', 'task'), other = ref('project-b', 'lead-b', 'other')
  await batches.create({ id: 'actionable', name: 'actionable', items: [{ ref: work }] })
  await expect(batches.observe('actionable', [{ ref: other, revision: { task: 1, generation: 0, attempt: 0, acceptance: 0 }, state: 'accepted', activeAssignment: false }])).rejects.toThrow(/not required/)
  expect((await batches.observe('actionable', [{ ref: work, revision: { task: 1, generation: 0, attempt: 0, acceptance: 0 }, state: 'waiting', activeAssignment: true }])).readyWithoutActiveAssignment).toEqual([])
  expect((await batches.observe('actionable', [{ ref: work, revision: { task: 2, generation: 0, attempt: 0, acceptance: 0 }, state: 'waiting', activeAssignment: false }])).readyWithoutActiveAssignment).toEqual([work])
  await batches.close()
})

it('rejects a cycle formed by two individually acyclic batches and stale observation races', async () => {
  const { batches } = await fixture()
  const a = ref('project-a', 'lead-a', 'a'), b = ref('project-b', 'lead-b', 'b')
  await batches.create({ id: 'first', name: 'first', items: [{ ref: a, dependsOn: [b] }, { ref: b }] })
  await expect(batches.create({ id: 'second', name: 'second', items: [{ ref: b, dependsOn: [a] }, { ref: a }] })).rejects.toThrow(/cross-batch cycle/)
  const work = ref('project-c', 'lead-c', 'work')
  await batches.create({ id: 'race', name: 'race', items: [{ ref: work }] })
  const outcomes = await Promise.allSettled([
    batches.observe('race', [{ ref: work, revision: { task: 2, generation: 0, attempt: 0, acceptance: 0 }, state: 'accepted', activeAssignment: false }]),
    batches.observe('race', [{ ref: work, revision: { task: 1, generation: 0, attempt: 0, acceptance: 0 }, state: 'waiting', activeAssignment: false }]),
  ])
  expect(outcomes.map(value => value.status)).toEqual(['fulfilled', 'rejected'])
  expect(batches.inspect('race')).toMatchObject({ phase: 'completed', completedRequired: 1 })
  // A tuple is not the former lossy `task * 1e6 + generation * 1e3 + revision` packing:
  // generation 2 / revision 1 is later than generation 1 / revision 1001.
  await batches.observe('race', [{ ref: work, revision: { task: 2, generation: 1, attempt: 1001, acceptance: 0 }, state: 'accepted', activeAssignment: false }])
  await expect(batches.observe('race', [{ ref: work, revision: { task: 2, generation: 2, attempt: 1, acceptance: 0 }, state: 'waiting', activeAssignment: false }]))
    .resolves.toMatchObject({ phase: 'active' })
  await batches.close()
})

it('deduplicates concurrent intents, suppresses an undelivered old epoch on reopen, and enforces durable bounds', async () => {
  const { batches } = await fixture()
  const work = ref('project-a', 'lead-a', 'bounded')
  await batches.create({ id: 'notice', name: 'notice', items: [{ ref: work }], subscriptions: [{ id: 'ops', destination: 'ops://batch' }] })
  await batches.observe('notice', [{ ref: work, revision: { task: 1, generation: 0, attempt: 0, acceptance: 0 }, state: 'accepted', activeAssignment: false }])
  const concurrent = await Promise.all([batches.notificationIntents(), batches.notificationIntents()])
  expect(concurrent[0]).toEqual(concurrent[1])
  expect(concurrent[0]).toHaveLength(1)
  await batches.observe('notice', [{ ref: work, revision: { task: 2, generation: 0, attempt: 0, acceptance: 0 }, state: 'waiting', activeAssignment: false }])
  expect(await batches.notificationIntents()).toEqual([])
  await expect(batches.recordNotificationReceipt(concurrent[0]![0]!.intentId, 'late delivery')).rejects.toThrow(/suppressed/)
  await batches.observe('notice', [{ ref: work, revision: { task: 3, generation: 0, attempt: 0, acceptance: 0 }, state: 'accepted', activeAssignment: false }])
  expect(await batches.notificationIntents()).toMatchObject([{ completionEpoch: 2 }])
  const subscriptions = Array.from({ length: 256 }, (_, index) => ({ id: `sub-${index}`, destination: `ops://${index}` }))
  await batches.create({ id: 'subscriptions', name: 'subscriptions', items: [{ ref: ref('project-z', 'lead-z', 'task') }], subscriptions })
  await expect(batches.subscribe('subscriptions', { id: 'one-too-many', destination: 'ops://extra' })).rejects.toThrow(/limit/)
  const history = ref('project-z', 'lead-z', 'history')
  await batches.create({ id: 'history', name: 'history', items: [{ ref: history }] })
  for (let revision = 1; revision <= 1024; revision++) await batches.observe('history', [{ ref: history, revision: { task: revision, generation: 0, attempt: 0, acceptance: 0 }, state: revision % 2 === 0 ? 'waiting' : 'active', activeAssignment: revision % 2 === 1 }])
  await expect(batches.observe('history', [{ ref: history, revision: { task: 1025, generation: 0, attempt: 0, acceptance: 0 }, state: 'waiting', activeAssignment: false }])).rejects.toThrow(/history limit/)
  expect(batches.inspect('history')!.items[0]!.history).toHaveLength(1024)
  await batches.close()
})
