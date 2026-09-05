import { afterEach, expect, it } from 'vitest'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssignmentStore, type AttemptRecord, type RuntimeStopEvidence } from '../src/assignments.ts'

const roots: string[] = []
const stores: AssignmentStore[] = []
const limits = { globalCapacity: 2, projectCapacities: { alpha: 2, beta: 1 } }
const request = {
  projectId: 'alpha', teamId: 'team-a', taskId: 'task-1', workerId: 'worker-a', runtimeId: 'session-a',
  provider: 'dsh', expectedGeneration: 0,
  checkpoint: { task: { subject: 'Implement', description: 'Preserve this context' }, step: 'implement', artifacts: [], nextAction: 'Write the change' },
}
const token = (record: AttemptRecord) => ({ attemptId: record.attemptId, generation: record.generation, expectedRevision: record.revision })
const stopped = (record: AttemptRecord): RuntimeStopEvidence => ({ runtimeId: record.runtimeId, kind: 'stopped', receipt: `observed-exit:${record.runtimeId}` })

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-assignments-'))
  roots.push(directory)
  const store = await AssignmentStore.open(directory, limits)
  stores.push(store)
  return { directory, store }
}




it('bounds recoverable coordinator interruptions while preserving generation and checkpoint context', async () => {
  const { store } = await fixture()
  const first = await store.reserve({ ...request, repairLimit: 2 })
  const firstInterrupted = await store.interrupt(token(first), { runtimeId: first.runtimeId, kind: 'never-started', receipt: 'shutdown-1' })
  expect(firstInterrupted).toMatchObject({ interruption: { reason: 'coordinator-shutdown', count: 1 }, checkpoint: request.checkpoint })
  const second = await store.reserve({ ...request, repairLimit: 2, expectedGeneration: 1, runtimeId: 'session-b' })
  const secondInterrupted = await store.interrupt(token(second), { runtimeId: second.runtimeId, kind: 'never-started', receipt: 'shutdown-2' })
  expect(secondInterrupted.interruption?.count).toBe(2)
  await expect(store.reserve({ ...request, repairLimit: 2, expectedGeneration: 2, runtimeId: 'session-c' })).rejects.toThrow(/retry budget/i)
})

it('replays a legacy external reservation without inventing a verified provider policy', async () => {
  const { store, directory } = await fixture()
  await store.close()
  const index = stores.indexOf(store)
  if (index >= 0) stores.splice(index, 1)
  const legacy = { version: 1, sequence: 1, type: 'assignment/reserved', request: { ...request, provider: 'external' } }
  await appendFile(join(directory, 'assignments.jsonl'), `${JSON.stringify(legacy)}\n`)
  const restored = await AssignmentStore.open(directory, limits)
  stores.push(restored)
  expect(restored.list()).toEqual([expect.objectContaining({ provider: 'external', phase: 'reserved' })])
  expect(restored.list()[0]?.externalPolicy).toBeUndefined()
  await expect(restored.reserve({ ...request, provider: 'external', expectedGeneration: 1 })).rejects.toThrow(/immutable verified provider policy/i)
})

it('requires a complete immutable verified policy before reserving an external attempt', async () => {
  const { store } = await fixture()
  await expect(store.reserve({ ...request, provider: 'external' })).rejects.toThrow(/immutable verified provider policy/i)
  const policy = { projectId: 'alpha', directory: '/tmp/external-policy', admission: { executable: '/usr/bin/codex', configuredExecutable: '/usr/local/bin/codex', version: '0.153.4', executableVerification: 'verified' as const, cwd: '/tmp/project', model: 'gpt-5.6-codex', sandbox: 'workspace-write' as const, authStatus: 'authenticated' as const }, maxSpoolBytes: 1024, terminateGraceMs: 50 }
  await expect(store.reserve({ ...request, provider: 'external', externalPolicy: policy })).resolves.toMatchObject({ provider: 'external', externalPolicy: policy })
})

it('reserves exactly one owner under concurrent claims, before runtime activation', async () => {
  const { store, directory } = await fixture()
  const results = await Promise.allSettled([
    store.reserve(request), store.reserve({ ...request, workerId: 'worker-b', runtimeId: 'session-b' }),
  ])
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect(store.list()).toEqual([expect.objectContaining({ phase: 'reserved', generation: 1, revision: 1 })])
  const events = (await readFile(join(directory, 'assignments.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(events).toHaveLength(1)
  expect(events[0].type).toBe('assignment/reserved')
})

it('restores a provisioning intent and its structured context without allocating a replacement', async () => {
  const { store, directory } = await fixture()
  const reserved = await store.reserve(request)
  await store.close()
  const restored = await AssignmentStore.open(directory, limits)
  stores.push(restored)
  expect(restored.list()).toEqual([reserved])
  await expect(restored.reserve({ ...request, expectedGeneration: 1 })).rejects.toThrow(/owned/)
  expect((await restored.activate(token(reserved))).checkpoint).toEqual(request.checkpoint)
})

it('fences stale attempts and revisions after a quiescent replacement', async () => {
  const { store } = await fixture()
  const first = await store.activate(token(await store.reserve(request)))
  const stopping = await store.stop(token(first), 'handoff')
  await expect(store.reserve({ ...request, expectedGeneration: 1 })).rejects.toThrow(/owned/)
  await expect(store.retire(token(stopping), { ...stopped(first), runtimeId: 'wrong-session' })).rejects.toThrow(/runtime/i)
  await store.retire(token(stopping), stopped(first))
  const replacement = await store.reserve({ ...request, expectedGeneration: 1, runtimeId: 'session-b' })
  expect(replacement.generation).toBe(2)
  expect(replacement.attemptId).not.toBe(first.attemptId)
  expect(replacement.assignmentId).not.toBe(first.assignmentId)
  expect(replacement.workerId).toBe(first.workerId)
  await expect(store.report(token(first), 'late completion')).rejects.toThrow(/stale|terminal/)
  await expect(store.checkpoint(token(first), request.checkpoint)).rejects.toThrow(/stale|terminal/)
  const active = await store.activate(token(replacement))
  await expect(store.checkpoint(token(replacement), request.checkpoint)).rejects.toThrow(/revision/)
  expect(store.list().at(-1)).toEqual(active)
})

it('bounds concurrent reservations and allows nine sequential completed workers', async () => {
  const { store } = await fixture()
  const held = await store.reserve({ ...request, taskId: 'held', workerId: 'held', runtimeId: 'held' })
  for (let index = 0; index < 9; index++) {
    const active = await store.activate(token(await store.reserve({
      ...request, taskId: `task-${index}`, workerId: `worker-${index}`, runtimeId: `session-${index}`,
    })))
    await expect(store.reserve({ ...request, taskId: 'overflow', workerId: 'overflow', runtimeId: 'overflow' })).rejects.toThrow(/capacity/)
    const report = await store.report(token(active), `Completed attempt ${index}; task acceptance is separate`)
    expect(report.phase).toBe('active')
    await store.retire(token(report), stopped(report))
  }
  expect(store.list().filter(record => record.phase !== 'terminal')).toEqual([held])
  expect(store.list().filter(record => record.phase === 'terminal')).toHaveLength(9)
})

it('enforces project capacity and prevents a worker or runtime from owning two assignments', async () => {
  const { store } = await fixture()
  await store.reserve({ ...request, projectId: 'beta' })
  await expect(store.reserve({ ...request, projectId: 'beta', taskId: 'task-2', workerId: 'b', runtimeId: 'b' })).rejects.toThrow(/capacity/)
  await expect(store.reserve({ ...request, taskId: 'task-2', runtimeId: 'different' })).rejects.toThrow(/worker/i)
  await expect(store.reserve({ ...request, taskId: 'task-2', workerId: 'different' })).rejects.toThrow(/runtime/i)
  await expect(store.reserve({ ...request, projectId: 'toString' })).rejects.toThrow(/project/i)
})

it('requires runtime evidence before freeing capacity and rejects illegal transitions', async () => {
  const { store } = await fixture()
  const reserved = await store.reserve(request)
  await expect(store.report(token(reserved), 'not started')).rejects.toThrow(/active/)
  await expect(store.retire(token(reserved), { runtimeId: reserved.runtimeId, kind: 'timeout', receipt: 'lease expired' })).rejects.toThrow()
  const active = await store.activate(token(reserved))
  await expect(store.activate(token(active))).rejects.toThrow(/reserved/)
  await expect(store.retire(token(active), { ...stopped(active), kind: 'never-started' })).rejects.toThrow(/reserved/)
  expect(store.list()[0].phase).toBe('active')
})

it('preserves immutable attempt evidence and restores the latest checkpoint and report', async () => {
  const { store, directory } = await fixture()
  const active = await store.activate(token(await store.reserve(request)))
  const checkpoint = { ...request.checkpoint, step: 'test', artifacts: [{ kind: 'commit', ref: 'abc123' }], nextAction: 'Run verification' }
  const checked = await store.checkpoint(token(active), checkpoint)
  const reported = await store.report(token(checked), 'Ready for verification')
  const terminal = await store.retire(token(reported), stopped(reported))
  await expect(store.checkpoint(token(terminal), request.checkpoint)).rejects.toThrow(/terminal/)
  await store.close()
  const restored = await AssignmentStore.open(directory, limits)
  stores.push(restored)
  expect(restored.list()).toEqual([terminal])
  expect(restored.list()[0]).toMatchObject({ checkpoint, result: 'Ready for verification', stopEvidence: stopped(reported) })
  const detached = restored.list()
  detached[0].checkpoint.artifacts.push({ kind: 'file', ref: 'tampered' })
  expect(restored.list()[0].checkpoint.artifacts).toEqual(checkpoint.artifacts)
})

it('rejects invalid replay transitions instead of silently accepting corrupt ownership', async () => {
  const { store, directory } = await fixture()
  await store.reserve(request)
  await store.close()
  const filename = join(directory, 'assignments.jsonl')
  const first = JSON.parse((await readFile(filename, 'utf8')).trim())
  await appendFile(filename, `${JSON.stringify({ ...first, sequence: 2 })}\n`)
  await expect(AssignmentStore.open(directory, limits)).rejects.toThrow(/line 2.*backup/)
})

it('rejects a second journal owner and releases ownership on close', async () => {
  const { store, directory } = await fixture()
  const second = AssignmentStore.open(directory, limits).then(store => { stores.push(store); return store })
  await expect(second).rejects.toThrow(/already owned/)
  await store.close()
  const reopened = await AssignmentStore.open(directory, limits)
  stores.push(reopened)
  expect(reopened.list()).toEqual([])
})

it('persists recovery intent and budget across replay without releasing ownership', async () => {
  const { store, directory } = await fixture()
  let record = await store.activate(token(await store.reserve(request)))
  record = await store.recover(token(record), 10, 1_000, 'recovery-1')
  await store.close()
  const restored = await AssignmentStore.open(directory, limits)
  stores.push(restored)
  expect(restored.list()[0]).toEqual(record)
  await expect(restored.reserve({ ...request, expectedGeneration: 1 })).rejects.toThrow(/owned/)
  record = await restored.recover(token(record), 20, 3_000, 'recovery-2')
  record = await restored.recover(token(record), 30, 7_000, 'recovery-3')
  expect(record.recovery).toEqual({ count: 3, observedSequence: 30, notBefore: 7_000, messageId: 'recovery-3' })
  await expect(restored.recover(token(record), 40, 15_000, 'recovery-4')).rejects.toThrow(/budget/)
  expect(restored.list()[0]!.phase).toBe('active')
})


it('pins repair policy and predecessor evidence across JSONL replay and rejects budget resets', async () => {
  const { directory, store } = await fixture()
  let first = await store.activate(token(await store.reserve({ ...request, repairLimit: 1 })))
  first = await store.report(token(first), 'Original submission evidence')
  first = await store.retire(token(first), stopped(first))
  const repairRequest = { ...request, repairLimit: 1, expectedGeneration: first.generation, runtimeId: 'repair-runtime',
    repair: { previousAttemptId: first.attemptId, submissionId: 'original-submission', integrationId: 'failed-integration',
      sourceCommit: 'a'.repeat(40), candidateCwd: '/retained/candidate', diagnostic: 'verification failed', round: 1 } }
  await expect(store.reserve({ ...repairRequest, repairLimit: 2 })).rejects.toThrow(/immutable/)
  await expect(store.reserve({ ...repairRequest, repair: { ...repairRequest.repair, previousAttemptId: 'wrong-attempt' } })).rejects.toThrow(/Invalid/)
  const reserved = await store.reserve(repairRequest)
  await store.close()
  const restored = await AssignmentStore.open(directory, limits)
  stores.push(restored)
  expect(restored.list()).toEqual([first, reserved])
  await expect(restored.reserve(repairRequest)).rejects.toThrow(/generation|owned/)
  let repair = await restored.activate(token(reserved))
  repair = await restored.report(token(repair), 'Repair also failed')
  repair = await restored.retire(token(repair), stopped(repair))
  await expect(restored.reserve({ ...repairRequest, expectedGeneration: repair.generation, runtimeId: 'extra-runtime',
    repair: { ...repairRequest.repair, previousAttemptId: repair.attemptId, round: 2 } })).rejects.toThrow(/exhausted/)
  await expect(restored.reserve({ ...request, repairLimit: 1, expectedGeneration: repair.generation, runtimeId: 'reset-runtime' })).rejects.toThrow(/erase/)
})
