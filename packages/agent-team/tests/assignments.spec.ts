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

it('requires a durable stopped handoff intent before one fenced replacement can reserve', async () => {
  const { store, directory } = await fixture()
  const active = await store.activate(token(await store.reserve({ ...request, provider: 'spawn', handoffLimit: 1 })))
  const handoff = { id: 'handoff-one', round: 1, workerId: 'handoff-worker', runtimeId: 'handoff-runtime',
    checkpoint: { ...active.checkpoint, artifacts: [...active.checkpoint.artifacts, { kind: 'file' as const, ref: '/retained/dirty-worktree' }], nextAction: 'Inspect retained dirty worktree.' } }
  const intended = await store.handoffIntent(token(active), handoff)
  await expect(store.reserve({ ...request, workerId: handoff.workerId, runtimeId: handoff.runtimeId, expectedGeneration: 1, handoffLimit: 1,
    checkpoint: handoff.checkpoint, handoff: { previousAttemptId: active.attemptId, intentId: handoff.id, round: 1 } })).rejects.toThrow(/owned|stopped/i)
  const stopping = await store.stop(token(intended), 'Operator-authorized checkpointed handoff')
  const terminal = await store.retire(token(stopping), stopped(stopping))
  const replacement = await store.reserve({ ...request, provider: 'spawn', workerId: handoff.workerId, runtimeId: handoff.runtimeId, expectedGeneration: 1, handoffLimit: 1,
    checkpoint: handoff.checkpoint, handoff: { previousAttemptId: active.attemptId, intentId: handoff.id, round: 1 } })
  expect(replacement).toMatchObject({ generation: 2, checkpoint: handoff.checkpoint, handoff: { intentId: handoff.id } })
  const replacementActive = await store.activate(token(replacement))
  await expect(store.handoffIntent(token(replacementActive), { ...handoff, id: 'forged-old-round', round: 1,
    workerId: 'forged-worker', runtimeId: 'forged-runtime' })).rejects.toThrow(/round.*lineage/i)
  await expect(store.handoffIntent(token(replacementActive), { ...handoff, id: 'handoff-two', round: 2,
    workerId: 'handoff-worker-two', runtimeId: 'handoff-runtime-two' })).rejects.toThrow(/budget/i)
  await expect(store.reserve({ ...request, workerId: 'extra', runtimeId: 'extra', expectedGeneration: 2, handoffLimit: 1,
    checkpoint: handoff.checkpoint, handoff: { previousAttemptId: terminal.attemptId, intentId: handoff.id, round: 1 } })).rejects.toThrow(/owned|handoff/i)
  await store.close(); stores.splice(stores.indexOf(store), 1)
  const reopened = await AssignmentStore.open(directory, limits); stores.push(reopened)
  expect(reopened.list()).toHaveLength(2)
  await expect(reopened.handoffIntent(token(active), handoff)).rejects.toThrow(/terminal|stale/i)
})

it('reopens a handoff intent before stop and a stopped intent before its one replacement', async () => {
  const { store, directory } = await fixture()
  const active = await store.activate(token(await store.reserve({ ...request, provider: 'spawn', handoffLimit: 1 })))
  const handoff = { id: 'reopen-handoff', round: 1, workerId: 'reopen-worker', runtimeId: 'reopen-runtime', checkpoint: active.checkpoint }
  await store.handoffIntent(token(active), handoff)
  await store.close(); stores.splice(stores.indexOf(store), 1)
  const afterIntent = await AssignmentStore.open(directory, limits); stores.push(afterIntent)
  const intended = afterIntent.list()[0]!
  const stopping = await afterIntent.stop(token(intended), 'checkpointed handoff')
  await afterIntent.retire(token(stopping), stopped(stopping))
  await afterIntent.close(); stores.splice(stores.indexOf(afterIntent), 1)
  const afterStop = await AssignmentStore.open(directory, limits); stores.push(afterStop)
  const predecessor = afterStop.list()[0]!
  const replacement = await afterStop.reserve({ ...request, provider: 'spawn', expectedGeneration: predecessor.generation,
    workerId: handoff.workerId, runtimeId: handoff.runtimeId, handoffLimit: 1, checkpoint: handoff.checkpoint,
    handoff: { previousAttemptId: predecessor.attemptId, intentId: handoff.id, round: 1 } })
  expect(replacement).toMatchObject({ generation: 2, handoff: { intentId: handoff.id } })
})

it('preserves an existing repair lineage through handoff without spending or resetting repair rounds', async () => {
  const { store } = await fixture()
  const original = await store.activate(token(await store.reserve({ ...request, provider: 'spawn', repairLimit: 2, handoffLimit: 1 })))
  const reported = await store.report(token(original), 'candidate ready')
  const terminal = await store.retire(token(reported), stopped(reported))
  const repair = { previousAttemptId: terminal.attemptId, submissionId: 'submission-1', integrationId: 'integration-1',
    sourceCommit: 'a'.repeat(40), candidateCwd: '/retained/candidate', diagnostic: 'verification failed', round: 1 }
  const repairing = await store.activate(token(await store.reserve({ ...request, provider: 'spawn', repairLimit: 2, handoffLimit: 1,
    expectedGeneration: terminal.generation, workerId: 'repair-worker', runtimeId: 'repair-runtime', checkpoint: terminal.checkpoint, repair })))
  const intent = { id: 'repair-handoff', round: 1, workerId: 'repair-handoff-worker', runtimeId: 'repair-handoff-runtime', checkpoint: repairing.checkpoint }
  const intended = await store.handoffIntent(token(repairing), intent)
  const stoppedRepair = await store.stop(token(intended), 'checkpointed repair handoff')
  const retiredRepair = await store.retire(token(stoppedRepair), stopped(stoppedRepair))
  const handedOff = await store.reserve({ ...request, provider: 'spawn', repairLimit: 2, handoffLimit: 1, expectedGeneration: retiredRepair.generation,
    workerId: intent.workerId, runtimeId: intent.runtimeId, checkpoint: intent.checkpoint, repair,
    handoff: { previousAttemptId: retiredRepair.attemptId, intentId: intent.id, round: 1 } })
  expect(handedOff.repair).toEqual(repair)
  const rerun = await store.retire(token(await store.report(token(await store.activate(token(handedOff))), 'candidate retry ready')), stopped(handedOff))
  const secondRepair = { ...repair, previousAttemptId: rerun.attemptId, submissionId: 'submission-2', integrationId: 'integration-2',
    sourceCommit: 'b'.repeat(40), candidateCwd: '/retained/candidate-two', round: 2 }
  await expect(store.reserve({ ...request, provider: 'spawn', repairLimit: 2, handoffLimit: 1, expectedGeneration: rerun.generation,
    workerId: 'second-repair-worker', runtimeId: 'second-repair-runtime', checkpoint: rerun.checkpoint, repair: secondRepair })).resolves.toMatchObject({ repair: secondRepair })
})

it('retains a durable never-started provisioning lineage, deadline, and exact replacement budget', async () => {
  const { store, directory } = await fixture()
  const policy = { maxAttempts: 1, initialDelayMs: 50, multiplier: 2, maxDelayMs: 100 }
  const first = await store.reserve({ ...request, retryPolicy: policy })
  const failed = await store.provisionFailed(token(first), { runtimeId: first.runtimeId, kind: 'stopped', receipt: 'provider-drained' }, 'temporary provider outage', 1_050, true)
  expect(failed).toMatchObject({ phase: 'terminal', stopEvidence: { kind: 'stopped' }, provisioning: { count: 1, notBefore: 1_050, diagnostic: 'temporary provider outage', retryable: true } })
  await store.close(); stores.splice(stores.indexOf(store), 1)
  const restored = await AssignmentStore.open(directory, limits); stores.push(restored)
  const retry = await restored.reserve({ ...request, expectedGeneration: 1, runtimeId: 'session-retry', retryPolicy: policy })
  const exhausted = await restored.provisionFailed(token(retry), { runtimeId: retry.runtimeId, kind: 'stopped', receipt: 'provider-drained-2' }, 'temporary provider outage', 1_150, true)
  expect(exhausted.provisioning).toMatchObject({ count: 2, notBefore: 1_150 })
  await expect(restored.reserve({ ...request, expectedGeneration: 2, runtimeId: 'session-extra', retryPolicy: policy })).rejects.toThrow(/provisioning retry budget/i)
})

it('persists a classified non-retryable provisioning failure without reopening its lineage', async () => {
  const { store } = await fixture()
  const first = await store.reserve({ ...request, retryPolicy: { maxAttempts: 3, initialDelayMs: 1, multiplier: 1, maxDelayMs: 1 } })
  const failed = await store.provisionFailed(token(first), { runtimeId: first.runtimeId, kind: 'never-started', receipt: 'auth-rejected' }, 'authentication policy rejected', 1, false)
  expect(failed.provisioning).toMatchObject({ count: 1, retryable: false })
  await expect(store.reserve({ ...request, expectedGeneration: 1, runtimeId: 'session-retry' })).rejects.toThrow(/not retryable/i)
})

it('does not let a DSH assignment relabel an active runtime as a provisioning failure', async () => {
  const { store } = await fixture()
  const active = await store.activate(token(await store.reserve(request)))
  await expect(store.provisionFailed(token(active), { runtimeId: active.runtimeId, kind: 'stopped', receipt: 'unexpected-active-provider-failure' }, 'provider failed', 1, true)).rejects.toThrow(/active external/i)
})

it('pins recovery deliveries separately from health nudges and preserves the policy on reopen', async () => {
  const { store, directory } = await fixture()
  const policy = { maxAttempts: 1, initialDelayMs: 7, multiplier: 3, maxDelayMs: 99 }
  const active = await store.activate(token(await store.reserve({ ...request, retryPolicy: policy })))
  const health = await store.recoverHealth(token(active), 4, 20, 'health-nudge-a')
  expect(health).toMatchObject({ retryPolicy: policy, healthRecovery: { count: 1, messageId: 'health-nudge-a' } })
  expect(health.recovery).toBeUndefined()
  const runtime = await store.recover(token(health), 5, 30, 'runtime-retry-a')
  await expect(store.recover(token(runtime), 6, 40, 'runtime-retry-b')).rejects.toThrow(/remaining budget/)
  await store.close(); stores.splice(stores.indexOf(store), 1)
  const reopened = await AssignmentStore.open(directory, limits); stores.push(reopened)
  expect(reopened.list()[0]).toMatchObject({ retryPolicy: policy, recovery: { count: 1 }, healthRecovery: { count: 1 } })
})

it('normalizes a legacy reservation and adds an immutable health attribution receipt', async () => {
  const { store, directory } = await fixture()
  await store.close(); stores.splice(stores.indexOf(store), 1)
  const reservation = { version: 1, sequence: 1, type: 'assignment/reserved', request }
  const active = { version: 1, sequence: 2, type: 'attempt/activated', token: { attemptId: 'attempt-1', generation: 1, expectedRevision: 1 } }
  const legacy = { version: 1, sequence: 3, type: 'attempt/recovery', token: { attemptId: 'attempt-1', generation: 1, expectedRevision: 2 }, observedSequence: 5, notBefore: 10, messageId: 'health-nudge-old' }
  await appendFile(join(directory, 'assignments.jsonl'), `${JSON.stringify(reservation)}\n${JSON.stringify(active)}\n${JSON.stringify(legacy)}\n`)
  const reopened = await AssignmentStore.open(directory, limits); stores.push(reopened)
  expect(reopened.list()[0]?.retryPolicy.maxAttempts).toBe(3)
  await reopened.attributeLegacyHealthRecoveries([{ attemptId: 'attempt-1', generation: 1, messageId: 'health-nudge-old' }])
  expect(reopened.list()[0]).toMatchObject({ healthRecovery: { messageId: 'health-nudge-old' } })
  expect(reopened.list()[0]?.recovery).toBeUndefined()
  expect((await readFile(join(directory, 'assignments.jsonl'), 'utf8')).split('\n').filter(Boolean).at(-1)).toContain('attempt/recovery-attributed')
})

it('chronologically attributes realistic mixed legacy recovery history without spending runtime deliveries', async () => {
  const { store, directory } = await fixture()
  await store.close(); stores.splice(stores.indexOf(store), 1)
  const header = [
    { version: 1, sequence: 1, type: 'assignment/reserved', request },
    { version: 1, sequence: 2, type: 'attempt/activated', token: { attemptId: 'attempt-1', generation: 1, expectedRevision: 1 } },
  ]
  const recoveries = [
    ['runtime-a', 3, 10], ['health-nudge-one', 4, 20], ['runtime-b', 5, 30],
  ].map(([messageId, observedSequence, notBefore], index) => ({ version: 1, sequence: index + 3, type: 'attempt/recovery', token: { attemptId: 'attempt-1', generation: 1, expectedRevision: index + 2 }, messageId, observedSequence, notBefore }))
  await appendFile(join(directory, 'assignments.jsonl'), [...header, ...recoveries].map(event => JSON.stringify(event)).join('\n') + '\n')
  let reopened = await AssignmentStore.open(directory, limits); stores.push(reopened)
  await reopened.attributeLegacyHealthRecoveries([
    { attemptId: 'attempt-1', generation: 1, messageId: 'health-nudge-one' },
  ])
  expect(reopened.list()[0]).toMatchObject({ recovery: { count: 2, messageId: 'runtime-b', notBefore: 30 }, healthRecovery: { count: 1, messageId: 'health-nudge-one', notBefore: 20 } })
  await reopened.close(); stores.splice(stores.indexOf(reopened), 1)
  reopened = await AssignmentStore.open(directory, limits); stores.push(reopened)
  await reopened.attributeLegacyHealthRecoveries([
    { attemptId: 'attempt-1', generation: 1, messageId: 'health-nudge-one' },
  ])
  expect(reopened.list()[0]).toMatchObject({ recovery: { count: 2, messageId: 'runtime-b' }, healthRecovery: { count: 1, messageId: 'health-nudge-one' } })
  expect((await readFile(join(directory, 'assignments.jsonl'), 'utf8')).match(/attempt\/recovery-attributed/g)).toHaveLength(1)
})

it('deduplicates same-ID legacy replay while retaining multiple exact health bindings', async () => {
  const { store, directory } = await fixture()
  await store.close(); stores.splice(stores.indexOf(store), 1)
  const events = [
    { version: 1, sequence: 1, type: 'assignment/reserved', request },
    { version: 1, sequence: 2, type: 'attempt/activated', token: { attemptId: 'attempt-1', generation: 1, expectedRevision: 1 } },
    { version: 1, sequence: 3, type: 'attempt/recovery', token: { attemptId: 'attempt-1', generation: 1, expectedRevision: 2 }, observedSequence: 3, notBefore: 10, messageId: 'health-nudge-one' },
    { version: 1, sequence: 4, type: 'attempt/recovery', token: { attemptId: 'attempt-1', generation: 1, expectedRevision: 3 }, observedSequence: 3, notBefore: 10, messageId: 'health-nudge-one' },
    { version: 1, sequence: 5, type: 'attempt/recovery', token: { attemptId: 'attempt-1', generation: 1, expectedRevision: 3 }, observedSequence: 4, notBefore: 20, messageId: 'health-nudge-two' },
  ]
  await appendFile(join(directory, 'assignments.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n')
  const reopened = await AssignmentStore.open(directory, limits); stores.push(reopened)
  await reopened.attributeLegacyHealthRecoveries([
    { attemptId: 'attempt-1', generation: 1, messageId: 'health-nudge-one' },
    { attemptId: 'attempt-1', generation: 1, messageId: 'health-nudge-two' },
  ])
  expect(reopened.list()[0]).toMatchObject({ healthRecovery: { count: 2, messageId: 'health-nudge-two', notBefore: 20 } })
  expect(reopened.list()[0]?.recovery).toBeUndefined()
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


it('replays one recovery message identity after reopening without incrementing its budget', async () => {
  const { store, directory } = await fixture()
  const active = await store.activate(token(await store.reserve(request)))
  const recovered = await store.recover(token(active), 10, 1_000, 'recovery-replay')
  await store.close()
  stores.splice(stores.indexOf(store), 1)
  const restored = await AssignmentStore.open(directory, limits)
  stores.push(restored)
  const replay = await restored.recover(token(recovered), 99, 9_999, 'recovery-replay')
  expect(replay).toEqual(recovered)
  expect(restored.list()).toEqual([recovered])
  await expect(restored.recover(token(recovered), 20, 2_000, 'other-recovery')).resolves.toMatchObject({ recovery: { count: 2, messageId: 'other-recovery' } })
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

it('preserves a spent repair lineage when that repair worker has a retryable provisioning failure', async () => {
  const { store } = await fixture()
  const policy = { maxAttempts: 1, initialDelayMs: 10, multiplier: 1, maxDelayMs: 10 }
  const original = await store.activate(token(await store.reserve({ ...request, provider: 'spawn', repairLimit: 1, retryPolicy: policy })))
  const terminal = await store.retire(token(await store.report(token(original), 'candidate ready')), stopped(original))
  const repair = { previousAttemptId: terminal.attemptId, submissionId: 'submission-1', integrationId: 'integration-1',
    sourceCommit: 'a'.repeat(40), candidateCwd: '/retained/candidate', diagnostic: 'verification failed', round: 1 }
  const repairReservation = await store.reserve({ ...request, provider: 'spawn', repairLimit: 1, expectedGeneration: terminal.generation,
    workerId: 'repair-worker', runtimeId: 'repair-runtime', checkpoint: terminal.checkpoint, repair,
    retryPolicy: policy })
  const failed = await store.provisionFailed(token(repairReservation), stopped(repairReservation), 'temporary provisioning failure', 10, true)
  await expect(store.reserve({ ...request, provider: 'spawn', repairLimit: 1, expectedGeneration: failed.generation,
    workerId: 'repair-retry-worker', runtimeId: 'repair-retry-runtime', checkpoint: failed.checkpoint, repair,
    retryPolicy: failed.retryPolicy })).resolves.toMatchObject({ generation: 3, repair, checkpoint: failed.checkpoint })
})
