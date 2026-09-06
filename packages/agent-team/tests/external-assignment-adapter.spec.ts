import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AssignmentStore } from '../src/assignments.ts'
import { ExternalNonCodeAssignmentAdapter } from '../src/external-assignment-adapter.ts'
import { ExternalAssignmentRuntime } from '../src/external-assignment-runtime.ts'
import { ExternalRuntimeStore } from '../src/external-runtime.ts'
import { ExternalRuntimeSupervisorClient } from '../src/external-runtime-supervisor.ts'
import { executionConfigSchema } from '../src/coordinator-execution.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const fixture = resolve('packages/agent-team/tests/fixtures/external-runtime-fixture.mjs')
const admission = { executable: fixture, configuredExecutable: '/configured/codex', version: '0.153.4', executableVerification: 'verified' as const, cwd: process.cwd(), model: 'gpt-5.6-codex', sandbox: 'workspace-write' as const, authStatus: 'authenticated' as const }
const externalPolicy = { projectId: 'project', directory: '', admission, maxSpoolBytes: 65_536, terminateGraceMs: 50 }

async function setup(subject: string, nonCodeCriteria = 'Return the requested report') {
  const root = await mkdtemp(join(tmpdir(), 'gasteam-external-adapter-'))
  roots.push(root)
  const assignments = await AssignmentStore.open(root, { globalCapacity: 1, projectCapacities: { project: 1 } })
  const external = await ExternalRuntimeStore.open(root)
  const client = new ExternalRuntimeSupervisorClient({ executable: process.execPath, helperArgs: ['--import', 'tsx', resolve('packages/agent-team/src/external-runtime-supervisor.ts')] })
  const runtime = new ExternalAssignmentRuntime(external, client)
  const adapter = new ExternalNonCodeAssignmentAdapter(assignments, external, runtime, { ...externalPolicy, directory: root })
  const attempt = await assignments.reserve({ projectId: 'project', teamId: 'team', taskId: `task-${subject}`, workerId: `worker-${subject}`, runtimeId: `runtime-${subject}`, provider: 'external', expectedGeneration: 0,
    checkpoint: { task: { subject, description: 'fixture external non-code task', ...(nonCodeCriteria === '' ? {} : { nonCodeCriteria }) }, step: 'report', artifacts: [], nextAction: 'Return an evidence-backed report' }, externalPolicy: { ...externalPolicy, directory: root } })
  return { assignments, external, runtime, adapter, attempt }
}

it('routes an explicitly non-code assignment through verified external admission and positive terminal proof', async () => {
  const { assignments, external, adapter, attempt } = await setup('codex-report')
  await expect(adapter.start(attempt)).resolves.toMatchObject({ phase: 'active' })
  await waitFor(async () => {
    const current = assignments.list().find(item => item.attemptId === attempt.attemptId)!
    await adapter.observe(current)
    return assignments.list().find(item => item.attemptId === attempt.attemptId)?.phase === 'terminal'
  })
  expect(assignments.list().find(item => item.attemptId === attempt.attemptId)).toMatchObject({ phase: 'terminal', result: 'fixture external report', stopEvidence: { runtimeId: attempt.runtimeId, kind: 'stopped' } })
  expect(external.get(attempt.attemptId, attempt.generation)).toMatchObject({ terminal: { outcome: 'completed' }, retainsCapacity: false, admission: { executableVerification: 'verified' } })
  await external.close()
  await assignments.close()
})

it('classifies a runtime authentication failure as stopped and non-retryable', async () => {
  const { assignments, external, adapter, attempt } = await setup('authentication-failure')
  await adapter.start(attempt)
  await waitFor(async () => {
    const current = assignments.list().find(item => item.attemptId === attempt.attemptId)!
    await adapter.observe(current)
    return assignments.list().find(item => item.attemptId === attempt.attemptId)?.phase === 'terminal'
  })
  expect(assignments.list().find(item => item.attemptId === attempt.attemptId)).toMatchObject({
    phase: 'terminal', stopEvidence: { kind: 'stopped' },
    provisioning: { count: 1, retryable: false, diagnostic: expect.stringMatching(/authentication failed.*credentials are not retained/i) },
  })
  expect(assignments.list().find(item => item.attemptId === attempt.attemptId)?.provisioning?.diagnostic).not.toContain('sk-secret-sentinel')
  expect(await readFile(join(attempt.externalPolicy!.directory, 'assignments.jsonl'), 'utf8')).not.toContain('sk-secret-sentinel')
  await external.close()
  await assignments.close()
})

it('lets cancellation win over a classified authentication failure', async () => {
  const { assignments, external, runtime, adapter, attempt } = await setup('authentication-failure')
  const active = await adapter.start(attempt)
  await waitFor(async () => (await runtime.observe(active.attemptId, active.generation, join(active.externalPolicy!.directory, active.attemptId))).terminal !== undefined)
  const stopping = await assignments.stop({ attemptId: active.attemptId, generation: active.generation, expectedRevision: active.revision }, 'operator cancellation won race')
  await expect(adapter.observe(stopping)).resolves.toMatchObject({ phase: 'terminal', stopReason: 'operator cancellation won race' })
  expect(assignments.list().find(item => item.attemptId === attempt.attemptId)?.provisioning).toBeUndefined()
  await external.close()
  await assignments.close()
})

it('keeps an unclassified failed turn as an execution failure', async () => {
  const { assignments, external, adapter, attempt } = await setup('ordinary-runtime-failure')
  await adapter.start(attempt)
  await waitFor(async () => {
    const current = assignments.list().find(item => item.attemptId === attempt.attemptId)!
    await adapter.observe(current)
    return assignments.list().find(item => item.attemptId === attempt.attemptId)?.phase === 'terminal'
  })
  const failed = assignments.list().find(item => item.attemptId === attempt.attemptId)!
  expect(failed).toMatchObject({ phase: 'terminal', stopReason: 'External runtime failed or completed without a final report', stopEvidence: { kind: 'stopped' } })
  expect(failed.provisioning).toBeUndefined()
  await external.close()
  await assignments.close()
})

it('does not classify a tool ENOENT after turn start as CLI startup failure', async () => {
  const { assignments, external, adapter, attempt } = await setup('tool-enoent-after-turn-started')
  await adapter.start(attempt)
  await waitFor(async () => {
    const current = assignments.list().find(item => item.attemptId === attempt.attemptId)!
    await adapter.observe(current)
    return assignments.list().find(item => item.attemptId === attempt.attemptId)?.phase === 'terminal'
  })
  const failed = assignments.list().find(item => item.attemptId === attempt.attemptId)!
  expect(failed).toMatchObject({ phase: 'terminal', stopReason: 'External runtime failed or completed without a final report', stopEvidence: { kind: 'stopped' } })
  expect(failed.provisioning).toBeUndefined()
  await external.close()
  await assignments.close()
})

it('projects only exact provider-reported usage onto its external attempt and preserves reported zero', async () => {
  const { assignments, external, adapter, attempt } = await setup('codex-usage-report')
  await adapter.start(attempt)
  await waitFor(async () => { const current = assignments.list().find(item => item.attemptId === attempt.attemptId)!; await adapter.observe(current); return current.externalUsage !== undefined || assignments.list().find(item => item.attemptId === attempt.attemptId)?.externalUsage !== undefined })
  const projected = assignments.list().find(item => item.attemptId === attempt.attemptId)!
  expect(projected.externalUsage).toMatchObject({ provider: 'external', attemptId: attempt.attemptId, generation: attempt.generation, inputTokens: 101, cachedInputTokens: 23, outputTokens: 37, reasoningOutputTokens: 11, runtimeRevision: expect.any(Number) })
  await external.close(); await assignments.close()
})

it('keeps absent usage unknown, preserves provider-reported zero, and rejects a mismatched receipt', async () => {
  const unknown = await setup('codex-report')
  await unknown.adapter.start(unknown.attempt)
  await waitFor(async () => { const current = unknown.assignments.list().find(item => item.attemptId === unknown.attempt.attemptId)!; await unknown.adapter.observe(current); return unknown.assignments.list().find(item => item.attemptId === unknown.attempt.attemptId)?.phase === 'terminal' })
  expect(unknown.assignments.list().find(item => item.attemptId === unknown.attempt.attemptId)?.externalUsage).toBeUndefined()
  await unknown.external.close(); await unknown.assignments.close()

  const zero = await setup('codex-zero-usage-report')
  await zero.adapter.start(zero.attempt)
  await waitFor(async () => { const current = zero.assignments.list().find(item => item.attemptId === zero.attempt.attemptId)!; await zero.adapter.observe(current); return zero.assignments.list().find(item => item.attemptId === zero.attempt.attemptId)?.externalUsage !== undefined })
  const receipt = zero.assignments.list().find(item => item.attemptId === zero.attempt.attemptId)!.externalUsage!
  expect(receipt).toMatchObject({ inputTokens: 0, outputTokens: 0 })
  const current = zero.assignments.list().find(item => item.attemptId === zero.attempt.attemptId)!
  await expect(zero.assignments.externalUsage({ attemptId: current.attemptId, generation: current.generation, expectedRevision: current.revision }, { ...receipt, generation: current.generation + 1 })).rejects.toThrow(/bind/i)
  expect(() => zero.assignments.externalUsage({ attemptId: current.attemptId, generation: current.generation, expectedRevision: current.revision }, { ...receipt, provider: 'other' as never })).toThrow()
  await zero.external.close(); await zero.assignments.close()
})

it('fences a first usage receipt after assignment cancellation or terminal retirement, but exactly replays a persisted receipt after reopen', async () => {
  const { assignments, external, attempt } = await setup('silent')
  const usage = { provider: 'external' as const, attemptId: attempt.attemptId, generation: attempt.generation, runtimeRevision: 7, inputTokens: 0 }
  const stopping = await assignments.stop({ attemptId: attempt.attemptId, generation: attempt.generation, expectedRevision: attempt.revision }, 'operator cancellation')
  await expect(assignments.externalUsage({ attemptId: stopping.attemptId, generation: stopping.generation, expectedRevision: stopping.revision }, usage)).rejects.toThrow(/fenced/i)
  const terminal = await assignments.retire({ attemptId: stopping.attemptId, generation: stopping.generation, expectedRevision: stopping.revision }, { runtimeId: stopping.runtimeId, kind: 'stopped', receipt: 'test' })
  await expect(assignments.externalUsage({ attemptId: terminal.attemptId, generation: terminal.generation, expectedRevision: terminal.revision }, usage)).rejects.toThrow(/terminal/i)
  await external.close(); await assignments.close()

  const projected = await setup('silent')
  const recorded = await projected.assignments.externalUsage({ attemptId: projected.attempt.attemptId, generation: projected.attempt.generation, expectedRevision: projected.attempt.revision }, { ...usage, attemptId: projected.attempt.attemptId, generation: projected.attempt.generation })
  await projected.assignments.close(); await projected.external.close()
  const restored = await AssignmentStore.open(projected.attempt.externalPolicy!.directory, { globalCapacity: 1, projectCapacities: { project: 1 } })
  await expect(restored.externalUsage({ attemptId: recorded.attemptId, generation: recorded.generation, expectedRevision: recorded.revision }, recorded.externalUsage!)).resolves.toMatchObject({ revision: recorded.revision })
  await restored.close()
})

it('cancels through the live external helper and never turns cancellation output into a report', async () => {
  const { assignments, external, adapter, attempt } = await setup('silent')
  const active = await adapter.start(attempt)
  await waitFor(async () => external.get(attempt.attemptId, attempt.generation)?.phase === 'running')
  await adapter.cancel(active, 'operator cancellation')
  await waitFor(async () => {
    const current = assignments.list().find(item => item.attemptId === attempt.attemptId)!
    await adapter.observe(current)
    return assignments.list().find(item => item.attemptId === attempt.attemptId)?.phase === 'terminal'
  })
  const terminal = assignments.list().find(item => item.attemptId === attempt.attemptId)!
  expect(terminal).toMatchObject({ phase: 'terminal', stopReason: 'operator cancellation' })
  expect(terminal.result).toBeUndefined()
  expect(external.get(attempt.attemptId, attempt.generation)).toMatchObject({ terminal: { outcome: 'cancelled' }, retainsCapacity: false })
  await external.close()
  await assignments.close()
})

it('fences a completed external report and usage when assignment cancellation wins before reconciliation', async () => {
  const { assignments, external, runtime, adapter, attempt } = await setup('codex-usage-report')
  const active = await adapter.start(attempt)
  await waitFor(async () => (await runtime.observe(attempt.attemptId, attempt.generation, join(external.list().find(item => item.attemptId === attempt.attemptId)!.spool!.directory))).terminal !== undefined)
  const stopping = await assignments.stop({ attemptId: active.attemptId, generation: active.generation, expectedRevision: active.revision }, 'operator cancellation won race')
  await expect(adapter.observe(stopping)).resolves.toMatchObject({ phase: 'terminal', stopReason: 'operator cancellation won race' })
  expect(assignments.list().find(item => item.attemptId === attempt.attemptId)?.result).toBeUndefined()
  expect(assignments.list().find(item => item.attemptId === attempt.attemptId)?.externalUsage).toBeUndefined()
  expect(external.get(attempt.attemptId, attempt.generation)).toMatchObject({ terminal: { outcome: 'completed' } })
  await external.close()
  await assignments.close()
})

it('starts a reserved restart with no external intent instead of stranding its assignment capacity', async () => {
  const { assignments, external, adapter, attempt } = await setup('silent')
  await expect(adapter.observe(attempt)).resolves.toMatchObject({ phase: 'active' })
  expect(external.get(attempt.attemptId, attempt.generation)).toMatchObject({ phase: 'running' })
  const active = assignments.list().find(item => item.attemptId === attempt.attemptId)!
  await adapter.cancel(active, 'test cleanup')
  await waitFor(async () => {
    const current = assignments.list().find(item => item.attemptId === attempt.attemptId)!
    await adapter.observe(current)
    return assignments.list().find(item => item.attemptId === attempt.attemptId)?.phase === 'terminal'
  })
  await external.close()
  await assignments.close()
})




it('preserves a completed external terminal report when shutdown observes it before cancelling', async () => {
  const { assignments, external, runtime, adapter, attempt } = await setup('codex-report')
  const active = await adapter.start(attempt)
  await waitFor(async () => (await runtime.observe(active.attemptId, active.generation, join(active.externalPolicy!.directory, active.attemptId))).terminal !== undefined)
  await adapter.drain([active])
  expect(assignments.list().find(record => record.attemptId === active.attemptId)).toMatchObject({ phase: 'terminal', result: 'fixture external report' })
  expect(assignments.list().find(record => record.attemptId === active.attemptId)?.interruption).toBeUndefined()
  await external.close()
  await assignments.close()
})

it('replays a shutdown cancellation journal as a recoverable interruption after restart', async () => {
  const { assignments, external, runtime, adapter, attempt } = await setup('silent')
  const active = await adapter.start(attempt)
  await runtime.cancel(active.attemptId, active.generation, join(active.externalPolicy!.directory, active.attemptId), 'Coordinator shutdown')
  await external.close()
  await assignments.close()
  const restoredAssignments = await AssignmentStore.open(active.externalPolicy!.directory, { globalCapacity: 1, projectCapacities: { project: 1 } })
  const restoredExternal = await ExternalRuntimeStore.open(active.externalPolicy!.directory)
  const restored = new ExternalNonCodeAssignmentAdapter(restoredAssignments, restoredExternal, new ExternalAssignmentRuntime(restoredExternal), active.externalPolicy!)
  await waitFor(async () => {
    const current = restoredAssignments.list().find(record => record.attemptId === active.attemptId)!
    await restored.observe(current)
    return restoredAssignments.list().find(record => record.attemptId === active.attemptId)?.phase === 'terminal'
  })
  expect(restoredAssignments.list().find(record => record.attemptId === active.attemptId)).toMatchObject({ interruption: { reason: 'coordinator-shutdown' } })
  expect(restoredAssignments.list().find(record => record.attemptId === active.attemptId)?.stopReason).toBeUndefined()
  await restoredExternal.close()
  await restoredAssignments.close()
})


it('never launches a reserved no-intent assignment in recovery-only mode', async () => {
  const { assignments, external, runtime, attempt } = await setup('silent')
  const recovery = new ExternalNonCodeAssignmentAdapter(assignments, external, runtime, attempt.externalPolicy!, false)
  await expect(recovery.observe(attempt)).rejects.toThrow(/recovery mode/i)
  expect(external.get(attempt.attemptId, attempt.generation)).toBeUndefined()
  await external.close()
  await assignments.close()
})

it('uses a pinned recovery-only policy to stop a live helper without re-admission or relaunch', async () => {
  const { assignments, external, runtime, adapter, attempt } = await setup('silent')
  const active = await adapter.start(attempt)
  const recovery = new ExternalNonCodeAssignmentAdapter(assignments, external, runtime, active.externalPolicy!, false)
  await expect(recovery.start(active)).rejects.toThrow(/recovery mode/i)
  await recovery.drain([active])
  expect(assignments.list().find(record => record.attemptId === active.attemptId)).toMatchObject({ phase: 'terminal', interruption: { reason: 'coordinator-shutdown' } })
  expect(external.get(active.attemptId, active.generation)).toMatchObject({ terminal: { outcome: 'cancelled' }, retainsCapacity: false })
  await external.close()
  await assignments.close()
})

it('rejects a changed provider policy before an existing reservation can launch', async () => {
  const { assignments, external, runtime, attempt } = await setup('silent')
  const changed = new ExternalNonCodeAssignmentAdapter(assignments, external, runtime, { ...externalPolicy, directory: external.list().length === 0 ? (assignments.list()[0]!.externalPolicy!.directory) : '', admission: { ...admission, model: 'other-model' } })
  await expect(changed.start(attempt)).rejects.toThrow(/immutable assignment policy/i)
  expect(external.get(attempt.attemptId, attempt.generation)).toBeUndefined()
  await external.close()
  await assignments.close()
})

it('does not treat a swapped live helper identity as health evidence for another external attempt', async () => {
  const left = await setup('silent')
  const right = await setup('silent')
  const leftActive = await left.adapter.start(left.attempt)
  await right.adapter.start(right.attempt)
  await waitFor(async () => left.external.get(left.attempt.attemptId, left.attempt.generation)?.phase === 'running'
    && right.external.get(right.attempt.attemptId, right.attempt.generation)?.phase === 'running')
  const leftDirectory = join(leftActive.externalPolicy!.directory, leftActive.attemptId)
  const rightDirectory = join(right.attempt.externalPolicy!.directory, right.attempt.attemptId)
  // Both stores issue attempt-1/generation-1, so this proves that PID/birth
  // identities, rather than the path or tuple alone, fence health liveness.
  const originalIdentity = await readFile(join(leftDirectory, 'supervisor.json'))
  await writeFile(join(leftDirectory, 'supervisor.json'), await readFile(join(rightDirectory, 'supervisor.json')))
  await expect(left.adapter.health(leftActive)).resolves.toEqual({ availability: 'unknown', execution: 'unknown' })
  await writeFile(join(leftDirectory, 'supervisor.json'), originalIdentity)
  await left.adapter.drain([leftActive])
  await right.adapter.drain([right.assignments.list()[0]!])
  await left.external.close(); await left.assignments.close()
  await right.external.close(); await right.assignments.close()
})

it('rejects code assignments before any external launch intent', async () => {
  const { assignments, external, adapter, attempt } = await setup('code', '')
  await expect(adapter.start(attempt)).rejects.toThrow(/non-code/i)
  expect(external.get(attempt.attemptId, attempt.generation)).toBeUndefined()
  await external.close()
  await assignments.close()
})

it('requires an explicit bounded external-Codex opt-in alongside ordinary coordinator execution policy', () => {
  expect(executionConfigSchema.parse({ modelProvider: 'mock', model: 'mock', maxConcurrent: 1, externalCodex: {
    projectId: 'project', directory: '/tmp/external-provider', cwd: process.cwd(), executable: fixture, version: '0.153.4', model: 'gpt-5.6-codex', sandbox: 'workspace-write', maxSpoolBytes: 65_536, terminateGraceMs: 50,
  } })).toMatchObject({ externalCodex: { executable: fixture, terminateGraceMs: 50, admissionMaxOutputBytes: 16_384, admissionTimeoutMs: 5_000 } })
  expect(() => executionConfigSchema.parse({ modelProvider: 'mock', model: 'mock', maxConcurrent: 1, externalCodex: {
    projectId: 'project', directory: '/tmp/external-provider', cwd: process.cwd(), executable: fixture, version: '0.153.4', model: 'gpt-5.6-codex', sandbox: 'workspace-write', maxSpoolBytes: 65_536, terminateGraceMs: 0,
  } })).toThrow()
})

async function waitFor(condition: () => Promise<boolean>, timeout = 3_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for external assignment adapter')
}
