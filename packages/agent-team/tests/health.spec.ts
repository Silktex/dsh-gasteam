import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HealthStore, type AttemptHealthObservation } from '../src/health.ts'

const roots: string[] = []
const stores: HealthStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0).reverse()) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const config = { dshDeadlineMs: 1_000, externalDeadlineMs: 5_000, escalationCooldownMs: 2_000, maxEscalationsPerCondition: 2 }
const active = (overrides: Partial<AttemptHealthObservation> = {}): AttemptHealthObservation => ({
  attemptId: 'attempt-1', generation: 1, provider: 'dsh',
  work: { projectId: 'project-1', teamId: 'team-1', taskId: 'task-1', state: 'active' },
  runtime: { availability: 'available', execution: 'known-active-operation' },
  ...overrides,
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-health-'))
  roots.push(directory)
  const store = await HealthStore.open(directory, config)
  stores.push(store)
  return { directory, store }
}

it('pins the active-operation deadline across restart and configuration changes', async () => {
  const { directory, store } = await fixture()
  expect((await store.assess(active(), 10_000)).health).toMatchObject({ classification: 'progressing', deadlineAt: 11_000, deadlineMs: 1_000 })
  await store.close()
  stores.splice(stores.indexOf(store), 1)
  const restored = await HealthStore.open(directory, { ...config, dshDeadlineMs: 1, escalationCooldownMs: 1, maxEscalationsPerCondition: 100 })
  stores.push(restored)
  expect(restored.listHealth()[0]).toMatchObject({ deadlineMs: 1_000, escalationCooldownMs: 2_000, maxEscalationsPerCondition: 2 })
  expect((await restored.assess(active(), 10_999)).health.classification).toBe('progressing')
  expect((await restored.assess(active(), 11_000)).health.classification).toBe('stale')
  const advanced = await restored.assess(active({ progress: { source: 'durable-checkpoint', cursor: 'checkpoint-1' } }), 11_001)
  expect(advanced.health).toMatchObject({ classification: 'progressing', deadlineMs: 1_000, deadlineAt: 12_001 })
  expect((await restored.assess(active(), 12_000)).health.classification).toBe('progressing')
  expect((await restored.assess(active(), 12_001)).health.classification).toBe('stale')
})

it('deduplicates a stale escalation through repeated scans and restores the inbox', async () => {
  const { directory, store } = await fixture()
  await store.assess(active(), 0)
  const first = await store.assess(active(), 1_000)
  const repeated = await store.assess(active(), 1_500)
  expect(first.escalation).toMatchObject({ severity: 'warning', source: 'health', work: { taskId: 'task-1' } })
  expect(repeated.escalation).toBeUndefined()
  expect(store.listEscalations()).toHaveLength(1)
  await store.close()
  stores.splice(stores.indexOf(store), 1)
  const restored = await HealthStore.open(directory, config)
  stores.push(restored)
  expect(restored.listEscalations()).toEqual(store.listEscalations())
})

it('classifies durable dependency and operator waits without aging them into stale work', async () => {
  const { store } = await fixture()
  expect((await store.assess(active({ work: { projectId: 'project-1', teamId: 'team-1', taskId: 'task-1', state: 'dependency-wait' }, runtime: { availability: 'available', execution: 'idle' } }), 0)).health.classification).toBe('dependency-wait')
  expect((await store.assess(active({ work: { projectId: 'project-1', teamId: 'team-1', taskId: 'task-1', state: 'operator-wait' }, runtime: { availability: 'available', execution: 'idle' } }), 50_000)).health.classification).toBe('operator-wait')
  expect(store.listEscalations()).toEqual([])
})

it('keeps unknown live execution uncertain and never offers an ownership action', async () => {
  const { store } = await fixture()
  const result = await store.assess(active({ runtime: { availability: 'available', execution: 'unknown' } }), 0)
  expect(result.health).toMatchObject({ classification: 'unavailable', certainty: 'uncertain' })
  expect(result.escalation).toBeUndefined()
  expect(store.listEscalations()).toEqual([])
})

it('keeps escalations open through ambiguous runtime state and resolves only on positive recovery evidence', async () => {
  const { store } = await fixture()
  await store.assess(active(), 0)
  const stale = (await store.assess(active(), 1_000)).escalation!
  await store.assess(active({ runtime: { availability: 'unknown', execution: 'unknown' } }), 1_001)
  expect(store.listEscalations()[0]?.id).toBe(stale.id)
  expect(store.listEscalations()[0]?.resolution).toBeUndefined()
  await store.assess(active({ progress: { source: 'provider', cursor: 'tool-finished' } }), 1_002)
  expect(store.listEscalations()[0]).toMatchObject({ resolution: { reason: 'condition-cleared', source: 'health-observation', at: 1_002 } })

  const failed = active({ attemptId: 'failed-attempt', work: { projectId: 'project-1', teamId: 'team-1', taskId: 'failed-task', state: 'failed' }, runtime: { availability: 'available', execution: 'failed' } })
  expect((await store.assess({ ...failed, diagnostic: 'Provider exited with code 17', evidenceRef: 'runtime-17' }, 2_000)).escalation).toMatchObject({ diagnostics: 'Provider exited with code 17 [evidence: runtime-17]' })
  await store.assess({ ...failed, work: { ...failed.work, state: 'active' }, runtime: { availability: 'unknown', execution: 'unknown' } }, 2_001)
  expect(store.listEscalations()[1]?.condition).toBe('failed')
  expect(store.listEscalations()[1]?.resolution).toBeUndefined()
})

it('rejects invalid policies before it acquires a journal, unsafe deadline arithmetic, and backwards clocks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-health-invalid-'))
  roots.push(directory)
  await expect(HealthStore.open(directory, { ...config, dshDeadlineMs: 0 })).rejects.toThrow()
  const store = await HealthStore.open(directory, config)
  stores.push(store)
  await expect(store.assess(active(), Number.MAX_SAFE_INTEGER)).rejects.toThrow(/safe|range/i)
  expect(store.listHealth()).toEqual([])
  await store.assess(active(), 100)
  await expect(store.assess(active({ progress: { source: 'provider', cursor: 'late-clock' } }), 99)).rejects.toThrow(/clock|backward/i)
  expect(store.listHealth()[0]).toMatchObject({ observedAt: 100, deadlineAt: 1_100 })
})

it('acknowledges with a revision fence and only re-escalates after the condition cleared and cooldown elapsed', async () => {
  const { store } = await fixture()
  await store.assess(active(), 0)
  const stale = (await store.assess(active(), 1_000)).escalation!
  await expect(store.acknowledge(stale.id, stale.revision + 1, 'operator', 1_001)).rejects.toThrow(/revision/i)
  const acknowledged = await store.acknowledge(stale.id, stale.revision, 'operator', 1_001)
  expect(acknowledged.acknowledgement).toEqual({ actor: 'operator', at: 1_001 })
  expect((await store.assess(active(), 3_000)).escalation).toBeUndefined()
  const progress = active({ progress: { source: 'durable-checkpoint', cursor: 'checkpoint-2' } })
  expect((await store.assess(progress, 3_001)).health.classification).toBe('progressing')
  expect(store.listEscalations()[0]).toMatchObject({ acknowledgement: { actor: 'operator' }, resolution: { reason: 'condition-cleared' } })
  expect((await store.assess(active(), 4_000)).escalation).toBeUndefined()
  const second = await store.assess(active(), 5_001)
  expect(second.escalation?.id).not.toBe(stale.id)
  expect(store.listEscalations()).toHaveLength(2)
  await store.assess(active({ progress: { source: 'provider', cursor: 'completed-tool-1' } }), 5_002)
  const bounded = await store.assess(active(), 6_002)
  expect(bounded.escalation).toBeUndefined()
  expect(store.listEscalations()).toHaveLength(2)
})

it('records a fenced handoff as resolution of only the retired stale generation and re-escalates the replacement independently', async () => {
  const { directory, store } = await fixture()
  await store.assess(active(), 0)
  const stale = (await store.assess(active(), 1_000)).escalation!
  await store.acknowledge(stale.id, stale.revision, 'operator', 1_001)
  await store.clearHandoffAttempt('attempt-1', 1, 'attempt-2', 1_002)
  expect(store.listEscalations()[0]).toMatchObject({ acknowledgement: { actor: 'operator' }, resolution: {
    reason: 'handoff-replaced', source: 'operator-handoff', replacementAttemptId: 'attempt-2', at: 1_002,
  } })
  await store.close(); stores.splice(stores.indexOf(store), 1)
  const restored = await HealthStore.open(directory, config); stores.push(restored)
  expect(restored.listEscalations()[0]?.resolution).toMatchObject({ reason: 'handoff-replaced', replacementAttemptId: 'attempt-2' })
  await restored.assess(active({ attemptId: 'attempt-2', generation: 2 }), 2_000)
  expect((await restored.assess(active({ attemptId: 'attempt-2', generation: 2 }), 3_000)).escalation).toMatchObject({ attemptId: 'attempt-2', generation: 2 })
})

it('does not append unchanged uncertain patrols and clears only from an accepted terminal receipt', async () => {
  const { directory, store } = await fixture()
  await store.assess(active({ runtime: { availability: 'available', execution: 'unknown' } }), 0)
  await store.assess(active({ runtime: { availability: 'available', execution: 'unknown' } }), 50_000)
  expect((await (await import('node:fs/promises')).readFile(join(directory, 'health.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
  const stale = (await store.assess(active(), 50_001)).escalation!
  await store.clearAcceptedAttempt('attempt-1', 1, 'accepted-report', 'report-1', 50_002)
  expect(store.listEscalations().find(item => item.id === stale.id)).toMatchObject({ resolution: { reason: 'accepted-terminal', source: 'accepted-report', at: 50_002 } })
  expect(store.listHealth()[0]).toMatchObject({ classification: 'stale', terminalClearance: { source: 'accepted-report', receiptId: 'report-1', at: 50_002 } })
})

it('validates immutable bindings even when an unchanged uncertain patrol would be a no-op', async () => {
  const { store } = await fixture()
  await store.assess(active({ runtime: { availability: 'available', execution: 'unknown' } }), 0)
  await expect(store.assess(active({ work: { projectId: 'project-1', teamId: 'team-1', taskId: 'forged-task', state: 'active' }, runtime: { availability: 'available', execution: 'unknown' } }), 1)).rejects.toThrow(/binding.*immutable/i)
})
