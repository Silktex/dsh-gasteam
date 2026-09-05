import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HealthStore } from '../src/health.ts'
import { HealthRuntimeObservationAdapter, DshHealthRuntimeObserver, type HealthRuntimeSources } from '../src/health-runtime-observation.ts'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { toolCallResponse, MockAdapter } from '../../../tests/support/mock-adapter.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TeamService from '../src/index.ts'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

const roots: string[] = []
const stores: HealthStore[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const attempt = { attemptId: 'attempt-1', generation: 2, provider: 'dsh' as const, runtimeId: 'runtime-1', work: { projectId: 'project', teamId: 'lead', taskId: 'task', state: 'active' as const } }
const config = { dshDeadlineMs: 100, externalDeadlineMs: 200, escalationCooldownMs: 10, maxEscalationsPerCondition: 2 }
async function store() { const directory = await mkdtemp(join(tmpdir(), 'gasteam-health-observation-')); roots.push(directory); const value = await HealthStore.open(directory, config); stores.push(value); return { directory, value } }
function adapter(sources: Partial<HealthRuntimeSources>): HealthRuntimeObservationAdapter {
  return new HealthRuntimeObservationAdapter({ dsh: async () => ({ availability: 'unknown' }), external: async () => ({ availability: 'unknown', execution: 'unknown' }), ...sources })
}

it('pins a known DSH operation deadline, then ages only after the exact operation evidence stops', async () => {
  const { value } = await store()
  const runtime = adapter({ dsh: async () => ({ availability: 'available', runtimeId: 'runtime-1', execution: 'known-active-operation', operationId: 'tool-1' }) })
  expect((await value.assess(await runtime.observe(attempt), 0)).health).toMatchObject({ classification: 'progressing', deadlineAt: 100 })
  expect((await value.assess(await runtime.observe(attempt), 99)).health.classification).toBe('progressing')
  const idle = adapter({ dsh: async () => ({ availability: 'available', runtimeId: 'runtime-1', execution: 'idle' }) })
  expect((await value.assess(await idle.observe(attempt), 100)).health.classification).toBe('stale')
})

it('keeps operator wait authoritative and fails closed on a mismatched DSH runtime identity', async () => {
  const { value } = await store()
  const wait = { ...attempt, work: { ...attempt.work, state: 'operator-wait' as const } }
  const idle = adapter({ dsh: async () => ({ availability: 'available', runtimeId: 'runtime-1', execution: 'idle' }) })
  expect((await value.assess(await idle.observe(wait), 10_000)).health.classification).toBe('operator-wait')
  const mismatch = adapter({ dsh: async () => ({ availability: 'available', runtimeId: 'other-runtime', execution: 'known-active-operation', operationId: 'forged' }) })
  expect((await value.assess(await mismatch.observe(attempt), 10_001)).health).toMatchObject({ classification: 'unavailable', certainty: 'uncertain' })
})

it('requires a fresh external ownership observation across a fresh HealthStore', async () => {
  const { directory, value } = await store()
  const externalAttempt = { ...attempt, provider: 'external' as const, runtimeId: 'external-directory' }
  const owned = adapter({ external: async () => ({ availability: 'available', execution: 'known-active-operation', operationId: 'supervisor:17:birth' }) })
  await value.assess(await owned.observe(externalAttempt), 0)
  await value.close(); stores.splice(stores.indexOf(value), 1)
  const restored = await HealthStore.open(directory, config); stores.push(restored)
  const uncertain = adapter({ external: async () => ({ availability: 'unknown', execution: 'unknown' }) })
  expect((await restored.assess(await uncertain.observe(externalAttempt), 200)).health).toMatchObject({ classification: 'unavailable', certainty: 'uncertain', deadlineAt: 200 })
  expect((await restored.assess(await uncertain.observe(externalAttempt), 201)).health.classification).toBe('unavailable')
})

it('recognizes an unresolved tool receipt only while the exact real worker remains live and owned', async () => {
  const ctx = new Context(); contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-health-live-tool-')); roots.push(directory)
  await ctx.plugin(JsonlSessionPersistence, { root: directory })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService)
  let started!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  ctx.tools.register(defineContentToolFixture({
    name: 'health_long_tool', description: 'Controlled test operation', parameters: {},
    async execute() { started(); await blocked; return [{ type: 'text', text: 'released' }] },
  }))
  const lead = ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([toolCallResponse('health-long-call', 'health_long_tool', {})]))
  const observer = new DshHealthRuntimeObserver(ctx)
  await ctx.agentTeams.spawnReservedTeammate(lead, {
    name: 'attempt-1', description: 'controlled long tool', prompt: [{ type: 'text', text: 'start the operation' }], context: 'fresh', provider: 'spawn', signal: new AbortController().signal,
  }, SessionId('runtime-1'))
  await entered
  expect(observer.observe({ attemptId: 'attempt-1', teamId: lead.id, runtimeId: 'runtime-1' })).toMatchObject({
    availability: 'available', execution: 'known-active-operation', operationId: 'health-long-call',
  })
  // A coincident resident worker from another assignment cannot inherit this proof.
  expect(observer.observe({ attemptId: 'other-attempt', teamId: lead.id, runtimeId: 'runtime-1' })).toEqual({ availability: 'unknown' })
  release()
  await vi.waitFor(() => expect(ctx.agents.get(SessionId('runtime-1'))).toBeUndefined())
  expect(observer.observe({ attemptId: 'attempt-1', teamId: lead.id, runtimeId: 'runtime-1' })).toEqual({ availability: 'unknown' })
  // A reconstructed host has durable session history but no live activation;
  // history alone is deliberately insufficient to revive active-tool health.
  await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)
  const fresh = new Context(); contexts.push(fresh)
  await mountAgentLoopTestDependencies(fresh)
  await fresh.plugin(SessionProjectionRegistry)
  await fresh.plugin(JsonlSessionPersistence, { root: directory })
  await fresh.plugin(AgentLoop, { agents: [] })
  await fresh.plugin(SubagentService)
  await fresh.plugin(SubagentSpawn, { providerName: 'spawn' })
  await fresh.plugin(TeamService)
  expect(new DshHealthRuntimeObserver(fresh).observe({ attemptId: 'attempt-1', teamId: lead.id, runtimeId: 'runtime-1' })).toEqual({ availability: 'unknown' })
})

it('does not treat a durable tool request waiting on pre-execution policy as active', async () => {
  const ctx = new Context(); contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-health-pending-tool-')); roots.push(directory)
  await ctx.plugin(JsonlSessionPersistence, { root: directory })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService)
  let entered!: () => void
  let release!: () => void
  const pending = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  ctx.tools.register(defineContentToolFixture({ name: 'health_policy_tool', description: 'Policy-gated test operation', parameters: {}, async execute() { return [{ type: 'text', text: 'ran' }] } }))
  ctx.on('tools/pre-execute', async (_execution, next) => { entered(); await gate; return await next() })
  const lead = ctx.agentLoop.create(SessionId('pending-lead'), { provider: 'mock', model: 'mock' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([toolCallResponse('pending-call', 'health_policy_tool', {})]))
  const observer = new DshHealthRuntimeObserver(ctx)
  await ctx.agentTeams.spawnReservedTeammate(lead, {
    name: 'pending-attempt', description: 'policy wait', prompt: [{ type: 'text', text: 'request the tool' }], context: 'fresh', provider: 'spawn', signal: new AbortController().signal,
  }, SessionId('pending-runtime'))
  await pending
  expect(observer.observe({ attemptId: 'pending-attempt', teamId: lead.id, runtimeId: 'pending-runtime' })).toMatchObject({ availability: 'available', execution: 'unknown' })
  release()
  await vi.waitFor(() => expect(ctx.agents.get(SessionId('pending-runtime'))).toBeUndefined())
})

it('retains an outer active dispatch after its nested call settles, then clears it on outer error', async () => {
  const ctx = new Context(); contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-health-nested-tool-')); roots.push(directory)
  await ctx.plugin(JsonlSessionPersistence, { root: directory })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService)
  let nestedSettled!: () => void
  let releaseOuter!: () => void
  const nestedDone = new Promise<void>(resolve => { nestedSettled = resolve })
  const outerGate = new Promise<void>(resolve => { releaseOuter = resolve })
  ctx.tools.register(defineContentToolFixture({ name: 'health_nested_inner', description: 'Fast nested test operation', parameters: {}, async execute() { return [{ type: 'text', text: 'inner complete' }] } }))
  ctx.tools.register(defineContentToolFixture({
    name: 'health_nested_outer', description: 'Outer nested test operation', parameters: {},
    async execute(_args, execution) {
      if (execution.agent === undefined) throw new Error('Expected worker Agent')
      await ctx.tools.execute({ callId: ToolCallId('nested-call'), rootCallId: execution.rootCallId, name: 'health_nested_inner', arguments: {}, agent: execution.agent, parent: execution.token, signal: execution.signal })
      nestedSettled()
      await outerGate
      throw new Error('outer dispatch failure')
    },
  }))
  const lead = ctx.agentLoop.create(SessionId('nested-lead'), { provider: 'mock', model: 'mock' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([toolCallResponse('outer-call', 'health_nested_outer', {})]))
  const observer = new DshHealthRuntimeObserver(ctx)
  await ctx.agentTeams.spawnReservedTeammate(lead, {
    name: 'nested-attempt', description: 'nested operation', prompt: [{ type: 'text', text: 'run outer tool' }], context: 'fresh', provider: 'spawn', signal: new AbortController().signal,
  }, SessionId('nested-runtime'))
  await nestedDone
  expect(observer.observe({ attemptId: 'nested-attempt', teamId: lead.id, runtimeId: 'nested-runtime' })).toMatchObject({ availability: 'available', execution: 'known-active-operation', operationId: 'outer-call' })
  releaseOuter()
  await vi.waitFor(() => expect(ctx.agents.get(SessionId('nested-runtime'))).toBeUndefined())
  expect(observer.observe({ attemptId: 'nested-attempt', teamId: lead.id, runtimeId: 'nested-runtime' })).toEqual({ availability: 'unknown' })
})
