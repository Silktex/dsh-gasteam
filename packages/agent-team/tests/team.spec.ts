import { queueSubagentPrompt, type HostPromptQueue } from '@deepseek-ai/dsh-subagent/internal'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { execa } from 'execa'
import { GitIntegrationProvider } from '../src/git-integration-provider.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../tests/support/mock-adapter.ts'
import TeamService, { TeamError, TeamId, TeamMessageId, TeamTaskId } from '../src/index.ts'
import { TeamRuntimeLifecycle } from '../src/lifecycle.ts'
import { teamProjectionDefinition } from '../src/projection.ts'
import type { TeamMemberSnapshot, TeamMessageSnapshot, TeamTaskSnapshot, TeamIntegrationSpec, TeamIntegrationId, TeamCommitId } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { gitFixture } from './git-fixture.ts'
import * as GitWorktrees from '../src/git-worktrees.ts'
import * as IntegrationWorker from '../src/integration-worker.ts'
import * as Supervisor from '../src/supervisor.ts'
import { AssignmentStore, type AttemptRecord } from '../src/assignments.ts'
import { acquireIntegrationOwnership } from '../src/integration-ownership.ts'
import { DshAssignmentRuntime } from '../src/dsh-assignment-runtime.ts'
import { RuntimeDrain } from '../src/runtime-drain.ts'

const SIGNAL = new AbortController().signal
const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Detached durable Team read through the same projection definition as the service. */
function durable(agent: Agent): {
  members: TeamMemberSnapshot[]
  tasks: TeamTaskSnapshot[]
  pendingMessages: TeamMessageSnapshot[]
} {
  let projected = teamProjectionDefinition.init(agent.session.header)
  for (const event of agent.session.snapshotEvents()) projected = teamProjectionDefinition.apply(projected, event)
  if (projected.failure !== undefined) throw new Error(projected.failure)
  const state = projected
  return {
    members: state.members,
    tasks: state.tasks,
    pendingMessages: state.messages.filter(message => !state.delivered.includes(message.id)),
  }
}

async function setup(
  script: ConstructorParameters<typeof MockAdapter>[0],
  config: ConstructorParameters<typeof TeamService>[1] = {},
  cwd?: string,
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  const teamFiber = await ctx.plugin(TeamService, config)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' }, cwd === undefined ? {} : { cwd })
  return { ctx, lead, adapter, storageRoot, teamFiber }
}

/** Native completion notices wake the Lead; keep them out of the worker response script. */
async function setupWorkers(script: ConstructorParameters<typeof MockAdapter>[0], config: ConstructorParameters<typeof TeamService>[1], cwd?: string) {
  const fixture = await setup(script, config, cwd)
  const stream = fixture.adapter.stream.bind(fixture.adapter)
  vi.spyOn(fixture.adapter, 'stream').mockImplementation(async function* (options) {
    if (options.sessionId === fixture.lead.id) yield* textResponse('Lead noted completion')
    else yield* stream(options)
  })
  return fixture
}

function content(text: string) {
  return [{ type: 'text' as const, text }]
}

interface TeamServiceInternals {
  readonly roster: {
    readonly inFlightCreations: Set<Promise<unknown>>
    checkpointInitialPrompt(childId: SessionId, messageId: string, signal: AbortSignal): Promise<void>
    reconcileProvisioning(root: Agent, signal: AbortSignal): Promise<void>
    liveChildrenByRoot(): Map<Agent, SessionId[]>
  }
  readonly mailbox: {
    tryDispatch(root: Agent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean>
    serializeDispatch(message: TeamMessageSnapshot, operation: () => Promise<boolean>): Promise<boolean>
    markDelivered(root: Agent, messageId: ReturnType<typeof TeamMessageId>, targetId: SessionId): Promise<void>
  }
  readonly journal: {
    state(root: Agent): unknown
  }
  disposeRuntime(): Promise<void>
  recoverFor(agent: Agent): Promise<void>
  scheduleRecovery(agent: Agent): void
}

/** White-box access follows the runtime owners so coverage does not widen the service API. */
function teamInternals(ctx: Context): TeamServiceInternals {
  return ctx.agentTeams as unknown as TeamServiceInternals
}

function spawn(
  ctx: Context,
  lead: Agent,
  name: string,
  options: { context?: 'fresh' | 'fork'; provider?: string } = {},
) {
  const context = options.context ?? 'fresh'
  return ctx.agentTeams.spawnTeammate(lead, {
    name,
    description: `${name} responsibility`,
    prompt: content(`${name} initial`),
    context,
    provider: options.provider ?? (context === 'fork' ? 'fork' : 'spawn'),
    signal: SIGNAL,
  })
}

async function waitNoAgent(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 5_000 })
}

async function waitRunning(ctx: Context, id: SessionId): Promise<Agent> {
  return vi.waitFor(() => {
    const agent = ctx.agents.get(id)
    expect(agent?.status).toBe('running')
    return agent!
  }, { timeout: 5_000 })
}

describe('Team identity and provisioning', () => {
  it('rejects missing and failed authoritative Team projections', async () => {
    const first = await setup([])
    const journal = teamInternals(first.ctx).journal
    const stateOf = first.ctx.sessionProjections.stateOf.bind(first.ctx.sessionProjections)
    const stateOfSpy = vi.spyOn(first.ctx.sessionProjections, 'stateOf').mockImplementation((session, key) => (
      key === 'agentTeam' ? undefined : stateOf(session, key)
    ))
    expect(() => journal.state(first.lead)).toThrow('Agent Teams projection is not registered')
    stateOfSpy.mockImplementation((session, key) => key === 'agentTeam'
      ? { ...teamProjectionDefinition.init(session.header), failure: 'failed Team projection' }
      : stateOf(session, key))
    expect(() => journal.state(first.lead)).toThrow('failed Team projection')
    stateOfSpy.mockRestore()
  })

  it('rejects deployment limits that are not positive safe integers', async () => {
    const fields = [
      'maxMembers',
      'maxConcurrentMembers',
      'maxTasks',
      'maxBatches',
      'maxRecoveryAttempts',
      'maxBatchTextLength',
      'maxTaskResultLength',
      'maxPendingMessagesPerMember',
      'maxMessageBytes',
      'disposalTimeoutMs',
    ] as const
    for (const field of fields) {
      for (const value of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(setup([], { [field]: value })).rejects.toThrow()
      }
    }
  })

  it('supports direct-constructor defaults and recovers roots that already exist', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-direct-'))
    roots.push(storageRoot)
    await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    const lead = ctx.agentLoop.create(SessionId('preexisting-lead'), {})
    const service = new TeamService(ctx)

    expect(service.listMembers(lead)).toEqual([expect.objectContaining({
      name: 'lead',
      status: 'idle',
      diagnostics: [],
    })])
    const provisioning = {
      id: SessionId('preexisting-child'),
      name: 'preexisting-worker',
      description: 'preexisting responsibility',
      provider: 'spawn',
      context: 'fresh' as const,
      phase: 'provisioning' as const,
    }
    lead.session.append('team/member', {
      version: 1,
      teamId: TeamId(lead.id),
      member: provisioning,
    })
    expect(service.listMembers(lead)[1]).toEqual(expect.objectContaining({
      name: 'preexisting-worker',
      status: 'provisioning',
      diagnostics: [],
    }))
    expect(service.listMembers(lead)[1]).not.toHaveProperty('model')
    await Promise.resolve()
  })

  it('creates fresh and fork teammates with immutable names and bounded roster size', async () => {
    const { ctx, lead } = await setup([
      textResponse('lead answer'),
      textResponse('fork answer'),
      textResponse('fresh answer'),
    ], { maxMembers: 2 })
    lead.followup(createUserMessage({ content: content('lead turn'), source: { kind: 'user' } }))
    await lead.whenIdle()

    const forked = await spawn(ctx, lead, 'fork-worker', { context: 'fork' })
    await waitNoAgent(ctx, forked.member.id)
    const fresh = await spawn(ctx, lead, 'fresh-worker')
    await waitNoAgent(ctx, fresh.member.id)

    expect((await ctx.sessionPersistence.inspect(forked.member.id)).inheritedEventCount).toBeGreaterThan(0)
    expect((await ctx.sessionPersistence.inspect(fresh.member.id)).inheritedEventCount).toBe(0)
    expect(ctx.agentTeams.listMembers(lead).map(row => [row.name, row.context, row.status])).toEqual([
      ['lead', undefined, 'idle'],
      ['fork-worker', 'fork', 'inactive'],
      ['fresh-worker', 'fresh', 'inactive'],
    ])
    await expect(spawn(ctx, lead, 'third-worker')).rejects.toMatchObject({ code: 'TEAM_MEMBER_LIMIT' })
    await expect(spawn(ctx, lead, 'fresh-worker')).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })
  })

  it('runs nine sequential teammates with capacity two while retaining immutable history', async () => {
    const { ctx, lead } = await setupWorkers(Array.from({ length: 9 }, () => textResponse('done')), { maxConcurrentMembers: 2 })
    for (let index = 0; index < 9; index++) {
      const child = await spawn(ctx, lead, `turnover-${index}`)
      await waitNoAgent(ctx, child.member.id)
      const stored = await ctx.sessionPersistence.inspect(child.member.id)
      expect(stored.events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text === 'done'))).toBe(true)
    }
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(10)
    expect(durable(lead).members.every(member => member.phase === 'active')).toBe(true)
  })

  it('reserves concurrent spawn slots before provisioning and rejects overflow without consuming a name', async () => {
    const { ctx, lead } = await setupWorkers(['hang', 'hang', 'hang'], { maxConcurrentMembers: 2 })
    const results = await Promise.allSettled(['one', 'two', 'three'].map(name => spawn(ctx, lead, name)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2)
    expect(results.filter(result => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'TEAM_CONCURRENT_LIMIT' }) }),
    ])
    expect(durable(lead).members).toHaveLength(2)
  })

  it('keeps a capacity-blocked wakeup durable and dispatches it when the occupied slot is released', async () => {
    const { ctx, lead } = await setupWorkers([textResponse('initial'), 'hang', textResponse('resumed')], { maxConcurrentMembers: 1 })
    const old = await spawn(ctx, lead, 'old')
    await waitNoAgent(ctx, old.member.id)
    const busy = await spawn(ctx, lead, 'busy')
    expect(ctx.agents.get(busy.member.id)).toBeDefined()
    expect(ctx.agents.get(old.member.id)).toBeUndefined()
    const receipt = await ctx.agentTeams.sendMessage(lead, { target: 'old', content: content('resume after capacity'), delivery: 'wakeup', signal: SIGNAL })
    expect(receipt.status).toBe('queued')
    expect(ctx.agents.get(old.member.id)).toBeUndefined()
    ctx.agentTeams.interrupt(lead, 'busy')
    await waitNoAgent(ctx, busy.member.id)
    await vi.waitFor(() => { expect(durable(lead).pendingMessages).toEqual([]) })
    await waitNoAgent(ctx, old.member.id)
    const stored = await ctx.sessionPersistence.inspect(old.member.id)
    expect(stored.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'team-message'
      && event.data.source.messageId === receipt.messageId)).toHaveLength(1)
  })

  it('retries capacity-blocked mail after provisioning fails without creating a runtime', async () => {
    const { ctx, lead } = await setupWorkers([textResponse('initial'), textResponse('resumed')], { maxConcurrentMembers: 1 })
    const old = await spawn(ctx, lead, 'old')
    await waitNoAgent(ctx, old.member.id)
    const entered = Promise.withResolvers<void>()
    const failure = Promise.withResolvers<never>()
    vi.spyOn(ctx.subagents, 'startContinuable').mockImplementationOnce(async () => {
      entered.resolve()
      return await failure.promise
    })
    const provisioning = spawn(ctx, lead, 'failed')
    const rejected = expect(provisioning).rejects.toThrow('provider failed')
    await entered.promise
    const receipt = await ctx.agentTeams.sendMessage(lead, { target: 'old', content: content('wait for failed provisioning'), delivery: 'wakeup', signal: SIGNAL })
    expect(receipt.status).toBe('queued')
    failure.reject(new Error('provider failed'))
    await rejected
    await vi.waitFor(() => { expect(durable(lead).pendingMessages).toEqual([]) })
    await waitNoAgent(ctx, old.member.id)
    expect(durable(lead).members.find(member => member.name === 'failed')?.phase).toBe('failed')
  })

  it('admits the persisted runtime identity and rejects reused durable identities before roster mutation', async () => {
    const { ctx, lead } = await setupWorkers([textResponse('assigned result')], {})
    const request = { name: 'assigned', description: 'Reserved runtime', prompt: content('durable checkpoint'), context: 'fresh' as const, provider: 'spawn', signal: SIGNAL }
    const result = await ctx.agentTeams.spawnReservedTeammate(lead, request, 'reserved-runtime')
    expect(result.member.id).toBe('reserved-runtime')
    await waitNoAgent(ctx, result.member.id)
    const stored = await ctx.sessionPersistence.inspect(SessionId('reserved-runtime'))
    expect(stored.events.some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text === 'durable checkpoint'))).toBe(true)
    await expect(ctx.agentTeams.spawnReservedTeammate(lead, { ...request, name: 'duplicate' }, 'reserved-runtime')).rejects.toMatchObject({ code: 'TEAM_RUNTIME_ID_TAKEN' })
    await expect(ctx.agentTeams.spawnReservedTeammate(lead, { ...request, name: 'steal-lead' }, lead.id)).rejects.toMatchObject({ code: 'TEAM_RUNTIME_ID_TAKEN' })
    expect(durable(lead).members).toHaveLength(1)
  })

  it('serializes reserved runtime identity across racing Team roots', async () => {
    const { ctx, lead } = await setupWorkers(['hang', 'hang'], {})
    const other = ctx.agentLoop.create(SessionId('other-lead'), { provider: 'mock', model: 'mock' })
    const request = { name: 'reserved', description: 'One runtime owner', prompt: content('one owner'), context: 'fresh' as const, provider: 'spawn', signal: SIGNAL }
    const results = await Promise.allSettled([lead, other].map(root => ctx.agentTeams.spawnReservedTeammate(root, request, 'shared-runtime')))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: 'TEAM_RUNTIME_ID_TAKEN' }) })])
    expect(durable(lead).members.length + durable(other).members.length).toBe(1)
  })

  it('deduplicates reserved recovery mail and rejects reuse with changed content', async () => {
    const { ctx, lead } = await setupWorkers(['hang'], {})
    await spawn(ctx, lead, 'recoverable')
    const request = { target: 'recoverable', delivery: 'quiet' as const, content: content('Checkpoint recovery'), signal: SIGNAL }
    const replies = await Promise.all([1, 2].map(() => ctx.agentTeams.sendReservedMessage(lead, request, 'reserved-recovery-message')))
    expect(replies.map(reply => reply.messageId)).toEqual(['reserved-recovery-message', 'reserved-recovery-message'])
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/message/queued' && event.data.message.id === 'reserved-recovery-message')).toHaveLength(1)
    await expect(ctx.agentTeams.sendReservedMessage(lead, { ...request, content: content('Changed checkpoint') }, 'reserved-recovery-message')).rejects.toMatchObject({ code: 'TEAM_MESSAGE_CONFLICT' })
  })

  it('starts a reserved DSH assignment once and records its completed report without accepting the task', async () => {
    const { ctx, lead } = await setupWorkers([textResponse('assignment report')], {})
    const task = await ctx.agentTeams.createTask(lead, { subject: 'Assigned work', description: 'Run one worker' })
    const assignmentDirectory = mkdtempSync(join(tmpdir(), 'gasteam-runtime-assignments-'))
    roots.push(assignmentDirectory)
    const assignments = await AssignmentStore.open(assignmentDirectory, { globalCapacity: 2, projectCapacities: { project: 2 } })
    try {
      const reserved = await assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: task.id, workerId: 'worker', runtimeId: 'assigned-session', provider: 'spawn', expectedGeneration: 0,
        checkpoint: { task: { subject: task.subject, description: task.description }, step: 'implement', artifacts: [], nextAction: 'Produce the result' } })
      const runtime = new DshAssignmentRuntime(ctx, assignments)
      const token = (record: AttemptRecord) => ({ attemptId: record.attemptId, generation: record.generation, expectedRevision: record.revision })
      const active = await runtime.start(lead, token(reserved))
      expect(active.phase).toBe('active')
      expect(await runtime.start(lead, token(active))).toEqual(active)
      expect(ctx.agentTeams.listMembers(lead).filter(member => member.id === reserved.runtimeId)).toHaveLength(1)
      await waitNoAgent(ctx, SessionId(reserved.runtimeId))
      const terminal = await runtime.observe(lead, token(active))
      expect(terminal).toMatchObject({ phase: 'terminal', result: 'assignment report', stopEvidence: { runtimeId: reserved.runtimeId, kind: 'stopped' } })
      expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('pending')
      const stored = await ctx.sessionPersistence.inspect(SessionId(reserved.runtimeId))
      expect(stored.events.some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.includes(reserved.assignmentId) && block.text.includes('Produce the result')))).toBe(true)
    } finally { await assignments.close() }
  })

  it('releases a positively absent temporary provisioner for its durable retry but holds uncertain ownership', async () => {
    const { ctx, lead } = await setupWorkers(['hang'], {})
    const task = await ctx.agentTeams.createTask(lead, { subject: 'Provision retry', description: 'Only retry after absence is proven' })
    const assignmentDirectory = mkdtempSync(join(tmpdir(), 'gasteam-runtime-provision-retry-'))
    roots.push(assignmentDirectory)
    let assignments = await AssignmentStore.open(assignmentDirectory, { globalCapacity: 1, projectCapacities: { project: 1 } })
    const token = (value: AttemptRecord) => ({ attemptId: value.attemptId, generation: value.generation, expectedRevision: value.revision })
    const checkpoint = { task: { subject: task.subject, description: task.description }, step: 'implement', artifacts: [], nextAction: 'Wait for provision' }
    try {
      let now = 1_000
      let runtime = new DshAssignmentRuntime(ctx, assignments, 30_000, true, undefined, () => now)
      const first = await assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: task.id, workerId: 'first', runtimeId: 'temporary-runtime', provider: 'spawn', expectedGeneration: 0,
        retryPolicy: { maxAttempts: 1, initialDelayMs: 50, multiplier: 2, maxDelayMs: 100 }, checkpoint })
      vi.spyOn(ctx.agentTeams, 'spawnReservedTeammate').mockRejectedValueOnce(new Error('temporary provider unavailable'))
      await expect(runtime.start(lead, token(first))).rejects.toThrow(/temporary provider unavailable/i)
      expect(assignments.list()[0]).toMatchObject({ phase: 'terminal', provisioning: { count: 1, notBefore: 1_050, retryable: true }, stopEvidence: { kind: 'stopped' } })
      const retry = await assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: task.id, workerId: 'second', runtimeId: 'replacement-runtime', provider: 'spawn', expectedGeneration: 1,
        retryPolicy: first.retryPolicy, checkpoint })
      expect(retry.generation).toBe(2)
      now = 1_050
      vi.spyOn(ctx.agentTeams, 'spawnReservedTeammate').mockRejectedValueOnce(new Error('temporary provider unavailable'))
      await expect(runtime.start(lead, token(retry))).rejects.toThrow(/temporary provider unavailable/i)
      expect(assignments.list().at(-1)).toMatchObject({ phase: 'terminal', provisioning: { count: 2, notBefore: 1_150, retryable: true }, stopEvidence: { kind: 'stopped' } })
      await assignments.close()
      assignments = await AssignmentStore.open(assignmentDirectory, { globalCapacity: 1, projectCapacities: { project: 1 } })
      await expect(assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: task.id, workerId: 'extra', runtimeId: 'extra-runtime', provider: 'spawn', expectedGeneration: 2,
        retryPolicy: first.retryPolicy, checkpoint })).rejects.toThrow(/provisioning retry budget/i)

      const uncertainTask = await ctx.agentTeams.createTask(lead, { subject: 'Uncertain provision', description: 'Hold the reserved slot' })
      const uncertain = await assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: uncertainTask.id, workerId: 'uncertain', runtimeId: 'uncertain-runtime', provider: 'spawn', expectedGeneration: 0, checkpoint })
      vi.spyOn(ctx.agentTeams, 'spawnReservedTeammate').mockRejectedValueOnce(new Error('temporary provider unavailable'))
      vi.spyOn(ctx.subagents, 'drainContinuableChildren').mockRejectedValueOnce(new Error('provider ownership probe failed'))
      runtime = new DshAssignmentRuntime(ctx, assignments, 30_000, true, undefined, () => now)
      await expect(runtime.start(lead, token(uncertain))).rejects.toThrow(/ownership probe failed/i)
      expect(assignments.list().find(item => item.attemptId === uncertain.attemptId)).toMatchObject({ phase: 'reserved' })
      await expect(assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: 'blocked-by-uncertain', workerId: 'blocked', runtimeId: 'blocked-runtime', provider: 'spawn', expectedGeneration: 0, checkpoint })).rejects.toThrow(/capacity/i)
    } finally { await assignments.close() }
  })

  it('records authentication and policy admission failures as non-retryable terminal evidence', async () => {
    const { ctx, lead } = await setupWorkers(['hang'], {})
    const task = await ctx.agentTeams.createTask(lead, { subject: 'Invalid admission', description: 'Do not retry credentials' })
    const assignmentDirectory = mkdtempSync(join(tmpdir(), 'gasteam-runtime-provision-auth-'))
    roots.push(assignmentDirectory)
    const assignments = await AssignmentStore.open(assignmentDirectory, { globalCapacity: 1, projectCapacities: { project: 1 } })
    try {
      const record = await assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: task.id, workerId: 'auth', runtimeId: 'auth-runtime', provider: 'spawn', expectedGeneration: 0,
        checkpoint: { task: { subject: task.subject, description: task.description }, step: 'implement', artifacts: [], nextAction: 'Never start' } })
      vi.spyOn(ctx.agentTeams, 'spawnReservedTeammate').mockRejectedValueOnce(new Error('authentication policy rejected'))
      const runtime = new DshAssignmentRuntime(ctx, assignments)
      await expect(runtime.start(lead, { attemptId: record.attemptId, generation: record.generation, expectedRevision: record.revision })).rejects.toThrow(/authentication policy rejected/i)
      expect(assignments.list()[0]).toMatchObject({ phase: 'terminal', provisioning: { retryable: false }, stopEvidence: { kind: 'stopped' } })
      await expect(assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: task.id, workerId: 'retry', runtimeId: 'auth-retry', provider: 'spawn', expectedGeneration: 1,
        retryPolicy: record.retryPolicy, checkpoint: record.checkpoint })).rejects.toThrow(/not retryable/i)
    } finally { await assignments.close() }
  })

  it('treats a crash after a later turn starts as recovery instead of reusing the old report', async () => {
    const { ctx, lead } = await setupWorkers([textResponse('assignment report')], {})
    const task = await ctx.agentTeams.createTask(lead, { subject: 'Assigned work', description: 'Run one worker' })
    const assignmentDirectory = mkdtempSync(join(tmpdir(), 'gasteam-runtime-assignments-'))
    roots.push(assignmentDirectory)
    const assignments = await AssignmentStore.open(assignmentDirectory, { globalCapacity: 2, projectCapacities: { project: 2 } })
    try {
      const reserved = await assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: task.id, workerId: 'worker', runtimeId: 'assigned-session', provider: 'spawn', expectedGeneration: 0,
        checkpoint: { task: { subject: task.subject, description: task.description }, step: 'implement', artifacts: [], nextAction: 'Produce the result' } })
      const runtime = new DshAssignmentRuntime(ctx, assignments)
      const token = (record: AttemptRecord) => ({ attemptId: record.attemptId, generation: record.generation, expectedRevision: record.revision })
      const active = await runtime.start(lead, token(reserved))
      expect(active.phase).toBe('active')
      expect(await runtime.start(lead, token(active))).toEqual(active)
      expect(ctx.agentTeams.listMembers(lead).filter(member => member.id === reserved.runtimeId)).toHaveLength(1)
      await waitNoAgent(ctx, SessionId(reserved.runtimeId))
      const stored = await ctx.sessionPersistence.inspect(SessionId(reserved.runtimeId))
      const workerSession = Session.fromRestore(SessionId(reserved.runtimeId), stored.events, stored.meta, SessionLogOffset(0))
      const events = workerSession.snapshotEvents()
      const previous = events.findLast(event => event.type === 'turn/start')!
      if (previous.type !== 'turn/start') throw new Error('Expected real worker turn')
      workerSession.append('turn/start', { turn: previous.data.turn + 1 })
      await ctx.sessionPersistence.append(SessionId(reserved.runtimeId), workerSession.snapshotEvents().slice(stored.events.length))
      const terminal = await runtime.observe(lead, token(active))
      expect(terminal).toMatchObject({ phase: 'terminal', stopReason: expect.stringContaining('DSH worker requires recovery') })
      expect(terminal.result).toBeUndefined()
      expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('pending')
    } finally { await assignments.close() }
  })

  it('persists a custom interrupted-runtime deadline and wakes exactly once at that fake-clock deadline after reopen', async () => {
    const { ctx, lead } = await setupWorkers(['hang'], {})
    const task = await ctx.agentTeams.createTask(lead, { subject: 'Resume work', description: 'Prove bounded delayed continuation' })
    const assignmentDirectory = mkdtempSync(join(tmpdir(), 'gasteam-runtime-retry-clock-'))
    roots.push(assignmentDirectory)
    let assignments = await AssignmentStore.open(assignmentDirectory, { globalCapacity: 1, projectCapacities: { project: 1 } })
    try {
      const reserved = await assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: task.id, workerId: 'worker', runtimeId: 'retry-clock-session', provider: 'spawn', expectedGeneration: 0,
        retryPolicy: { maxAttempts: 2, initialDelayMs: 50, multiplier: 2, maxDelayMs: 80 },
        checkpoint: { task: { subject: task.subject, description: task.description }, step: 'implement', artifacts: [], nextAction: 'Continue after interruption' } })
      let now = 1_000
      const runtime = new DshAssignmentRuntime(ctx, assignments, 30_000, true, undefined, () => now)
      const token = (value: AttemptRecord) => ({ attemptId: value.attemptId, generation: value.generation, expectedRevision: value.revision })
      const active = await runtime.start(lead, token(reserved))
      await ctx.subagents.drainContinuableChildren(lead, [SessionId(reserved.runtimeId)])
      const delayed = await runtime.observe(lead, token(active))
      expect(delayed.recovery).toMatchObject({ count: 1, notBefore: 1_050 })
      expect(lead.session.snapshotEvents().filter(event => event.type === 'team/message/queued')).toHaveLength(0)
      await assignments.close()
      assignments = await AssignmentStore.open(assignmentDirectory, { globalCapacity: 1, projectCapacities: { project: 1 } })
      const reopened = new DshAssignmentRuntime(ctx, assignments, 30_000, true, undefined, () => now)
      const persisted = assignments.list()[0]!
      await reopened.observe(lead, token(persisted))
      expect(lead.session.snapshotEvents().filter(event => event.type === 'team/message/queued')).toHaveLength(0)
      now = 1_050
      await reopened.observe(lead, token(assignments.list()[0]!))
      expect(lead.session.snapshotEvents().filter(event => event.type === 'team/message/queued')).toHaveLength(1)
    } finally { await assignments.close() }
  })

  it('fences DSH cancellation with awaited runtime shutdown and rejects unrelated Lead authority', async () => {
    const { ctx, lead } = await setupWorkers(['hang'], {})
    const task = await ctx.agentTeams.createTask(lead, { subject: 'Cancel work', description: 'Must stop before retiring' })
    const assignmentDirectory = mkdtempSync(join(tmpdir(), 'gasteam-runtime-assignments-'))
    roots.push(assignmentDirectory)
    const assignments = await AssignmentStore.open(assignmentDirectory, { globalCapacity: 2, projectCapacities: { project: 2 } })
    try {
      const record = await assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: task.id, workerId: 'worker', runtimeId: 'cancel-session', provider: 'spawn', expectedGeneration: 0,
        checkpoint: { task: { subject: task.subject, description: task.description }, step: 'implement', artifacts: [], nextAction: 'Wait for cancellation' } })
      const runtime = new DshAssignmentRuntime(ctx, assignments)
      const token = (value: AttemptRecord) => ({ attemptId: value.attemptId, generation: value.generation, expectedRevision: value.revision })
      const other = ctx.agentLoop.create(SessionId('unrelated-runtime-lead'), { provider: 'mock', model: 'mock' })
      await expect(runtime.start(other, token(record))).rejects.toThrow(/authority/)
      const active = await runtime.start(lead, token(record))
      expect(ctx.agents.get(SessionId(record.runtimeId))).toBeDefined()
      const terminal = await runtime.cancel(lead, token(active), 'operator cancellation')
      expect(terminal).toMatchObject({ phase: 'terminal', stopReason: 'operator cancellation' })
      expect(ctx.agents.get(SessionId(record.runtimeId))).toBeUndefined()
      await expect(runtime.start(lead, token(record))).rejects.toThrow(/stale|terminal/i)
    } finally { await assignments.close() }
  })

  it('checkpoints a retained dirty predecessor worktree into one fenced DSH handoff', async () => {
    const fixture = await gitFixture((root) => { roots.push(root) })
    const { ctx, lead } = await setupWorkers(['hang', 'hang'], { worktreeProvider: 'git' }, fixture.repository)
    await ctx.plugin(GitWorktrees, fixture.config)
    const task = await ctx.agentTeams.createTask(lead, { subject: 'Handoff work', description: 'Preserve the prior dirty checkout' })
    const assignmentDirectory = mkdtempSync(join(tmpdir(), 'gasteam-runtime-handoff-'))
    roots.push(assignmentDirectory)
    const assignments = await AssignmentStore.open(assignmentDirectory, { globalCapacity: 1, projectCapacities: { project: 1 } })
    try {
      const initial = await assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: task.id, workerId: 'handoff-worker', runtimeId: 'handoff-original', provider: 'spawn', expectedGeneration: 0, handoffLimit: 1,
        checkpoint: { task: { subject: task.subject, description: task.description }, step: 'implement', artifacts: [{ kind: 'report', ref: 'checkpoint-evidence' }], nextAction: 'Keep the unfinished output.' } })
      const runtime = new DshAssignmentRuntime(ctx, assignments)
      const token = (value: AttemptRecord) => ({ attemptId: value.attemptId, generation: value.generation, expectedRevision: value.revision })
      const active = await runtime.start(lead, token(initial))
      const originalCheckpoint = structuredClone(active.checkpoint)
      const old = ctx.agentTeams.listMembers(lead).find(member => member.id === active.runtimeId)!
      await writeFile(join(old.worktree!.cwd, 'unfinished.txt'), 'dirty preserved output\n')
      const replacement = await runtime.handoff(lead, token(active))
      expect(replacement).toMatchObject({ phase: 'reserved', generation: 2, handoff: { previousAttemptId: active.attemptId }, checkpoint: { artifacts: expect.arrayContaining([{ kind: 'report', ref: 'checkpoint-evidence' }, { kind: 'file', ref: old.worktree!.cwd }]) } })
      expect(await readFile(join(old.worktree!.cwd, 'unfinished.txt'), 'utf8')).toBe('dirty preserved output\n')
      const replayed = await runtime.resumeHandoff(lead, assignments.list().find(record => record.attemptId === active.attemptId)!)
      expect(replayed.attemptId).toBe(replacement.attemptId)
      expect(assignments.list()).toHaveLength(2)
      expect(assignments.list().find(record => record.attemptId === active.attemptId)?.checkpoint).toEqual(originalCheckpoint)
      const started = await runtime.start(lead, token(replacement))
      const child = await ctx.sessionPersistence.inspect(SessionId(started.runtimeId))
      const prompt = child.events.filter(event => event.type === 'user/message').flatMap(event => event.type === 'user/message' ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []).join('\n')
      expect(prompt).toContain(old.worktree!.cwd)
      await expect(runtime.handoff(lead, token(active))).rejects.toThrow(/stale|terminal/i)
    } finally { await assignments.close() }
  })

  it('carries a live repair lineage through a DSH handoff without opening another repair round', async () => {
    const fixture = await gitFixture((root) => { roots.push(root) })
    const { ctx, lead } = await setupWorkers(['hang'], { worktreeProvider: 'git' }, fixture.repository)
    await ctx.plugin(GitWorktrees, fixture.config)
    const task = await ctx.agentTeams.createTask(lead, { subject: 'Repair handoff', description: 'Keep the repair lineage while replacing its worker' })
    const assignmentDirectory = mkdtempSync(join(tmpdir(), 'gasteam-runtime-repair-handoff-'))
    roots.push(assignmentDirectory)
    const assignments = await AssignmentStore.open(assignmentDirectory, { globalCapacity: 1, projectCapacities: { project: 1 } })
    try {
      const token = (value: AttemptRecord) => ({ attemptId: value.attemptId, generation: value.generation, expectedRevision: value.revision })
      const original = await assignments.activate(token(await assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: task.id, workerId: 'original-worker', runtimeId: 'original-runtime', provider: 'spawn', expectedGeneration: 0, repairLimit: 2, handoffLimit: 1,
        checkpoint: { task: { subject: task.subject, description: task.description }, step: 'implement', artifacts: [], nextAction: 'Prepare the candidate.' } })))
      const reported = await assignments.report(token(original), 'candidate ready')
      const terminal = await assignments.retire(token(reported), { runtimeId: reported.runtimeId, kind: 'stopped', receipt: 'candidate-ready' })
      const repair = { previousAttemptId: terminal.attemptId, submissionId: 'repair-submission', integrationId: 'repair-integration', sourceCommit: 'a'.repeat(40), candidateCwd: fixture.repository, diagnostic: 'verification failure', round: 1 }
      const repairAttempt = await assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: task.id, workerId: 'repair-worker', runtimeId: 'repair-runtime', provider: 'spawn', expectedGeneration: terminal.generation, repairLimit: 2, handoffLimit: 1, repair,
        checkpoint: { task: { subject: task.subject, description: task.description }, step: 'repair', artifacts: [], nextAction: 'Repair the retained candidate.' } })
      const runtime = new DshAssignmentRuntime(ctx, assignments)
      const active = await runtime.start(lead, token(repairAttempt))
      const replacement = await runtime.handoff(lead, token(active))
      expect(replacement).toMatchObject({ handoff: { previousAttemptId: active.attemptId, round: 1 }, repair })
    } finally { await assignments.close() }
  })

  it('retains capacity after drain timeout and rejoins shutdown of a resident stopping worker', async () => {
    const { ctx, lead } = await setupWorkers(['hang'], {})
    const task = await ctx.agentTeams.createTask(lead, { subject: 'Cancel work', description: 'Must stop before retiring' })
    const assignmentDirectory = mkdtempSync(join(tmpdir(), 'gasteam-runtime-assignments-'))
    roots.push(assignmentDirectory)
    const assignments = await AssignmentStore.open(assignmentDirectory, { globalCapacity: 1, projectCapacities: { project: 1 } })
    let releaseBarrier: (() => void) | undefined
    let drain: ReturnType<typeof vi.spyOn> | undefined
    try {
      const record = await assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: task.id, workerId: 'worker', runtimeId: 'cancel-session', provider: 'spawn', expectedGeneration: 0,
        checkpoint: { task: { subject: task.subject, description: task.description }, step: 'implement', artifacts: [], nextAction: 'Wait for cancellation' } })
      let expireFirst!: () => void
      let scheduled = 0
      const joined = Promise.withResolvers<void>()
      const drains = new RuntimeDrain(50, {
        set(callback) {
          scheduled++
          if (scheduled === 1) expireFirst = callback
          else if (scheduled === 2) joined.resolve()
          return scheduled as unknown as ReturnType<typeof setTimeout>
        },
        clear() {},
      })
      const runtime = new DshAssignmentRuntime(ctx, assignments, 50, false, drains)
      const token = (value: AttemptRecord) => ({ attemptId: value.attemptId, generation: value.generation, expectedRevision: value.revision })
      const other = ctx.agentLoop.create(SessionId('unrelated-runtime-lead'), { provider: 'mock', model: 'mock' })
      await expect(runtime.start(other, token(record))).rejects.toThrow(/authority/)
      const active = await runtime.start(lead, token(record))
      expect(ctx.agents.get(SessionId(record.runtimeId))).toBeDefined()
      const originalDrain = ctx.subagents.drainContinuableChildren.bind(ctx.subagents)
      const barrier = new Promise<void>(resolve => { releaseBarrier = resolve })
      drain = vi.spyOn(ctx.subagents, 'drainContinuableChildren').mockImplementation(async (...args) => {
        await barrier
        return originalDrain(...args)
      })
      const cancellation = runtime.cancel(lead, token(active), 'operator cancellation')
      const cancellationFailure = expect(cancellation).rejects.toThrow(/timed out/)
      await vi.waitFor(() => expect(expireFirst).toBeTypeOf('function'))
      expireFirst()
      await cancellationFailure
      const stopping = assignments.list()[0]!
      expect(stopping).toMatchObject({ phase: 'stopping', stopReason: 'operator cancellation' })
      expect(stopping.stopEvidence).toBeUndefined()
      expect(ctx.agents.get(SessionId(record.runtimeId))).toBeDefined()
      await expect(assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: 'another-task', workerId: 'another-worker', runtimeId: 'another-session', provider: 'spawn', expectedGeneration: 0,
        checkpoint: record.checkpoint })).rejects.toThrow(/capacity/)
      const reconciliation = runtime.observe(lead, token(stopping))
      // The second wait is explicitly known to have joined the same pending
      // provider drain before this test permits that real drain to finish.
      await joined.promise
      releaseBarrier()
      const terminal = await reconciliation
      expect(drain).toHaveBeenCalledTimes(1)
      drain.mockRestore()
      drain = undefined
      expect(terminal).toMatchObject({ phase: 'terminal', stopReason: 'operator cancellation' })
      expect(ctx.agents.get(SessionId(record.runtimeId))).toBeUndefined()
      await expect(runtime.start(lead, token(record))).rejects.toThrow(/stale|terminal/i)
    } finally {
      releaseBarrier?.()
      drain?.mockRestore()
      await assignments.close()
    }
  })

  it('flushes the accepted child prompt before committing the active roster edge', async () => {
    const { ctx, lead } = await setup([textResponse('checkpointed child answer')])
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const order: string[] = []
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session.id === lead.id && durable(lead).members[0]?.phase === 'active') {
        order.push('lead-active')
      } else if (session.id !== lead.id) {
        order.push('child')
      }
      return flush(session)
    })

    const started = await spawn(ctx, lead, 'checkpoint-worker')
    expect(order.indexOf('child')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('child')).toBeLessThan(order.indexOf('lead-active'))
    await waitNoAgent(ctx, started.member.id)
  })

  it('checkpoints live and detached inbox receipts and aborts an unresolved checkpoint', async () => {
    const { ctx, lead } = await setup([])
    const internal = teamInternals(ctx).roster
    let liveSession: Session | undefined
    const liveFiber = await ctx.plugin(Object.assign(function checkpointFixture(childCtx: Context) {
      liveSession = childCtx.sessions.create(SessionId('checkpoint-child'))
    }, { inject: ['sessions'] }))
    if (liveSession === undefined) throw new Error('checkpoint fixture did not create its Session')
    const initial = createUserMessage({ content: content('checkpoint me'), source: { kind: 'user' } })
    const checkpoint = internal.checkpointInitialPrompt(liveSession.id, initial.id, SIGNAL)
    await Promise.resolve()
    lead.inject(createUserMessage({ content: content('unrelated progress'), source: { kind: 'user' } }))
    const unrelatedFiber = await ctx.plugin(Object.assign(function unrelatedCheckpointFixture(childCtx: Context) {
      childCtx.sessions.create(SessionId('unrelated-checkpoint-child'))
    }, { inject: ['sessions'] }))
    await unrelatedFiber.dispose()
    liveSession.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0, inserted: [initial],
    })
    await checkpoint
    await liveFiber.dispose()

    await expect(internal.checkpointInitialPrompt(liveSession.id, initial.id, SIGNAL)).resolves.toBeUndefined()
    const missing = createUserMessage({ content: content('missing'), source: { kind: 'user' } })
    await expect(internal.checkpointInitialPrompt(liveSession.id, missing.id, SIGNAL))
      .rejects.toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })

    let disposedSession: Session | undefined
    const disposedFiber = await ctx.plugin(Object.assign(function disposedCheckpointFixture(childCtx: Context) {
      disposedSession = childCtx.sessions.create(SessionId('disposed-checkpoint-child'))
    }, { inject: ['sessions'] }))
    if (disposedSession === undefined) throw new Error('disposed checkpoint fixture did not create its Session')
    const disposed = internal.checkpointInitialPrompt(disposedSession.id, missing.id, SIGNAL)
    const disposedResult = expect(disposed).rejects.toThrow('not found')
    await Promise.resolve()
    await disposedFiber.dispose()
    await disposedResult

    let abortedSession: Session | undefined
    const abortedFiber = await ctx.plugin(Object.assign(function abortedCheckpointFixture(childCtx: Context) {
      abortedSession = childCtx.sessions.create(SessionId('aborted-checkpoint-child'))
    }, { inject: ['sessions'] }))
    if (abortedSession === undefined) throw new Error('aborted checkpoint fixture did not create its Session')
    const controller = new AbortController()
    const aborted = internal.checkpointInitialPrompt(abortedSession.id, missing.id, controller.signal)
    await Promise.resolve()
    controller.abort({ kind: 'test' })
    await expect(aborted).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })

    const errorController = new AbortController()
    const errorAborted = internal.checkpointInitialPrompt(abortedSession.id, missing.id, errorController.signal)
    const errorResult = expect(errorAborted).rejects.toThrow('checkpoint stopped')
    await Promise.resolve()
    errorController.abort(new Error('checkpoint stopped'))
    await errorResult
    await abortedFiber.dispose()
  })

  it('drains an accepted child when its initial durability checkpoint fails', async () => {
    const { ctx, lead } = await setup(['hang'])
    vi.spyOn(teamInternals(ctx).roster, 'checkpointInitialPrompt')
      .mockRejectedValueOnce(new Error('checkpoint failed'))

    await expect(spawn(ctx, lead, 'checkpoint-failure')).rejects.toThrow('checkpoint failed')
    const member = durable(lead).members[0]
    expect(member).toMatchObject({ phase: 'failed', error: 'checkpoint failed' })
    if (member !== undefined) await waitNoAgent(ctx, member.id)
  })

  it('records failed provisioning durably, reserves its name, and counts it against the limit', async () => {
    const { ctx, lead } = await setup([], { maxMembers: 1 })
    await expect(spawn(ctx, lead, 'failed-worker', { provider: 'missing' })).rejects.toThrow()

    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({
      name: 'failed-worker',
      status: 'failed',
      provider: 'missing',
    })
    await expect(spawn(ctx, lead, 'failed-worker')).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })
    await expect(spawn(ctx, lead, 'other-worker')).rejects.toMatchObject({ code: 'TEAM_MEMBER_LIMIT' })
  })

  it('records non-Error provider failures and contains a reversed provisioning settlement race', async () => {
    const first = await setup([])
    vi.spyOn(first.ctx.subagents, 'startContinuable').mockRejectedValueOnce('string provider failure')
    await expect(spawn(first.ctx, first.lead, 'string-failure')).rejects.toBe('string provider failure')
    expect(first.ctx.agentTeams.listMembers(first.lead)[1]).toMatchObject({
      status: 'failed',
      diagnostics: ['string provider failure'],
    })
    await expect(first.ctx.agentTeams.sendMessage(first.lead, {
      target: 'string-failure', content: content('cannot deliver'), delivery: 'quiet', signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })

    const second = await setup([])
    vi.spyOn(second.ctx.subagents, 'startContinuable').mockImplementationOnce(async () => {
      const provisioning = durable(second.lead).members[0]
      if (provisioning === undefined) throw new Error('missing provisioning edge')
      second.lead.session.append('team/member', {
        version: 1,
        teamId: TeamId(second.lead.id),
        member: { ...provisioning, phase: 'active' },
      })
      await second.ctx.sessions.flush(second.lead.session)
      throw new Error('creator failed after recovery settled active')
    })
    await expect(spawn(second.ctx, second.lead, 'reverse-race')).rejects.toBeInstanceOf(AggregateError)
    expect(durable(second.lead).members[0]?.phase).toBe('active')
  })

  it('cleans up a child when recovery settles its provisioning record first', async () => {
    const { ctx, lead } = await setup(['hang'])
    const start = ctx.subagents.startContinuable.bind(ctx.subagents)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let childId: SessionId | undefined
    vi.spyOn(ctx.subagents, 'startContinuable').mockImplementation(async (spec) => {
      childId = spec.childId
      entered.resolve(undefined)
      await release.promise
      return start(spec)
    })

    const spawning = spawn(ctx, lead, 'racing-worker')
    const rejected = expect(spawning).rejects.toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })
    await entered.promise
    await teamInternals(ctx).roster.reconcileProvisioning(lead, SIGNAL)
    expect(durable(lead).members[0]?.phase).toBe('failed')

    release.resolve(undefined)
    await rejected
    if (childId === undefined) throw new Error('reserved child id was not observed')
    await waitNoAgent(ctx, childId)
  })

  it('handles a continuation that settles before the active roster view or conflict cleanup lookup', async () => {
    const first = await setup([])
    vi.spyOn(teamInternals(first.ctx).roster, 'checkpointInitialPrompt').mockResolvedValueOnce()
    vi.spyOn(first.ctx.subagents, 'startContinuable').mockImplementationOnce(async spec => ({
      childId: spec.childId!,
      messageId: createUserMessage({ content: content('accepted'), source: { kind: 'user' } }).id,
    }))
    const inactive = await spawn(first.ctx, first.lead, 'instant-worker')
    expect(inactive.member).toMatchObject({ status: 'inactive', diagnostics: [] })
    expect(inactive.member).not.toHaveProperty('model')

    const second = await setup([])
    vi.spyOn(teamInternals(second.ctx).roster, 'checkpointInitialPrompt').mockResolvedValueOnce()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(second.ctx.subagents, 'startContinuable').mockImplementationOnce(async (spec) => {
      entered.resolve(undefined)
      await release.promise
      return {
        childId: spec.childId!,
        messageId: createUserMessage({ content: content('accepted'), source: { kind: 'user' } }).id,
      }
    })
    const spawning = spawn(second.ctx, second.lead, 'instant-conflict')
    const rejected = expect(spawning).rejects.toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })
    await entered.promise
    await teamInternals(second.ctx).roster.reconcileProvisioning(second.lead, SIGNAL)
    release.resolve(undefined)
    await rejected
  })

  it('validates names and permits only the Lead to create or interrupt teammates', async () => {
    const { ctx, lead } = await setup(['hang'])
    for (const name of ['Lead', 'lead', '-bad', 'bad-', 'bad_name', 'x'.repeat(65)]) {
      await expect(spawn(ctx, lead, name)).rejects.toMatchObject({ code: 'TEAM_INVALID_MEMBER_NAME' })
    }
    const started = await spawn(ctx, lead, 'worker')
    const worker = await waitRunning(ctx, started.member.id)
    await expect(spawn(ctx, worker, 'nested')).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    expect(() => ctx.agentTeams.interrupt(worker, 'worker')).toThrow(expect.objectContaining({ code: 'TEAM_LEAD_REQUIRED' }))
    expect(ctx.agentTeams.interrupt(lead, 'worker')).toEqual({ previousStatus: 'running' })
    await waitNoAgent(ctx, worker.id)
    expect(ctx.agentTeams.interrupt(lead, 'worker')).toEqual({ previousStatus: 'inactive' })
    expect(() => ctx.agentTeams.interrupt(lead, 'lead')).toThrow(expect.objectContaining({ code: 'TEAM_INVALID_TARGET' }))
  })

  it('validates teammate text fields and pre-provisioning cancellation', async () => {
    const { ctx, lead } = await setup([])
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'empty-description',
      description: ' ',
      prompt: content('unused'),
      context: 'fresh',
      provider: 'spawn',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'empty-provider',
      description: 'valid description',
      prompt: content('unused'),
      context: 'fresh',
      provider: ' ',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    const controller = new AbortController()
    controller.abort(new TeamError('cancelled before provisioning', 'TEST_CANCELLED'))
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'cancelled-worker',
      description: 'never provisioned',
      prompt: content('unused'),
      context: 'fresh',
      provider: 'spawn',
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'TEST_CANCELLED' })
    expect(durable(lead).members).toEqual([])
  })

  it('treats an ordinary fork as a new Root Team and filters inherited Team state', async () => {
    const { ctx, lead } = await setup([])
    await ctx.agentTeams.createTask(lead, { subject: 'parent task', description: 'belongs to parent' })
    const handle = await ctx.agents.create({
      sessionId: SessionId('ordinary-fork'),
      seed: lead.session.snapshotEvents(),
      meta: { parentSession: lead.id, isSeeded: true },
      inheritedEventCount: lead.session.seq,
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    expect(ctx.agentTeams.membership(handle.agent)).toMatchObject({
      id: TeamId(handle.agent.id),
      role: 'lead',
      name: 'lead',
    })
    expect(durable(handle.agent)).toMatchObject({ members: [], tasks: [], pendingMessages: [] })
    await handle.dispose()
  })

  it('rejects stale Agent identities and non-Team subagent children', async () => {
    const { ctx, lead } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'ordinary worker',
      request: { prompt: content('ordinary'), parent: lead },
      signal: SIGNAL,
    })
    const live = ctx.agents.get(started.childId)
    if (live !== undefined) expect(ctx.agentTeams.tryMembership(live)).toBeUndefined()
    await waitNoAgent(ctx, started.childId)
    expect(() => ctx.agentTeams.membership(lead)).not.toThrow()

    const impostor = { ...lead } as Agent
    expect(ctx.agentTeams.tryMembership(impostor)).toBeUndefined()
    expect(() => ctx.agentTeams.membership(impostor)).toThrow(expect.objectContaining({ code: 'TEAM_NOT_MEMBER' }))

    const orphanRoot = await ctx.agents.create({
      sessionId: SessionId('orphan-ordinary-root'),
      meta: { parentSession: SessionId('absent-parent') },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(ctx.agentTeams.membership(orphanRoot.agent)).toMatchObject({ role: 'lead', name: 'lead' })
    await orphanRoot.dispose()
  })

  it('does not reinterpret an orphaned provider child or malformed parent stream as a Team root', async () => {
    const first = await setup([textResponse('ordinary child done')])
    const parent = await first.ctx.agents.create({
      sessionId: SessionId('temporary-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await first.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'ordinary child',
      request: { prompt: content('finish'), parent: parent.agent },
      signal: SIGNAL,
    })
    await waitNoAgent(first.ctx, started.childId)
    await parent.dispose()
    const orphan = await first.ctx.agents.resume({
      resumeSessionId: started.childId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(first.ctx.agentTeams.tryMembership(orphan.agent)).toBeUndefined()
    expect(teamInternals(first.ctx).roster.liveChildrenByRoot()).toEqual(new Map())
    await orphan.dispose()

    const second = await setup([])
    const child = await second.ctx.agents.create({
      sessionId: SessionId('malformed-parent-child'),
      meta: { parentSession: second.lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const journal = teamInternals(second.ctx).journal
    const state = journal.state.bind(journal)
    journal.state = () => { throw new Error('malformed Team stream') }
    expect(second.ctx.agentTeams.tryMembership(child.agent)).toBeUndefined()
    journal.state = state
    await child.dispose()
  })
})

describe('Team shared task DAG', () => {
  it('rejects a durable task revision that relabels immutable non-code criteria', async () => {
    const { ctx, lead } = await setup([])
    const task = await ctx.agentTeams.createTask(lead, { subject: 'audit', description: 'write findings', nonCodeCriteria: 'cite evidence' })
    lead.session.append('team/task', {
      version: 1,
      teamId: TeamId(lead.id),
      task: { id: task.id, revision: 2, subject: task.subject, description: task.description, status: 'pending', blockedBy: [], writeScopes: [] },
    })
    expect(() => durable(lead)).toThrow(/immutable non-code criteria/)
  })

  it('fails loudly when the durable numeric task id space is exhausted', async () => {
    const { ctx, lead } = await setup([])
    const id = TeamTaskId(`task-${Number.MAX_SAFE_INTEGER}`)
    lead.session.append('team/task', {
      version: 1,
      teamId: TeamId(lead.id),
      task: {
        id,
        revision: 1,
        subject: 'last numeric task',
        description: 'occupies the final safe numeric task id',
        status: 'pending',
        blockedBy: [],
        writeScopes: [],
      },
    })
    await ctx.sessions.flush(lead.session)

    await expect(ctx.agentTeams.createTask(lead, {
      subject: 'cannot allocate',
      description: 'no safe numeric task id remains',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_LIMIT' })
  })

  it('bounds non-deleted tasks while retaining deleted task ids as tombstones', async () => {
    const { ctx, lead } = await setup([], { maxTasks: 1 })
    const first = await ctx.agentTeams.createTask(lead, { subject: 'first', description: 'first task' })
    await expect(ctx.agentTeams.createTask(lead, { subject: 'overflow', description: 'overflow task' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_LIMIT' })

    const deleted = await ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'delete',
    })
    const second = await ctx.agentTeams.createTask(lead, { subject: 'second', description: 'second task' })
    expect(deleted.status).toBe('deleted')
    expect(second.id).toBe(TeamTaskId('task-2'))
    expect(ctx.agentTeams.getTask(lead, first.id).status).toBe('deleted')
    expect(ctx.agentTeams.listTasks(lead).map(task => task.id)).toEqual([second.id])
  })

  it('enforces CAS, ownership, dependencies, transitions, and write-scope warnings', async () => {
    const { ctx, lead } = await setup(['hang', 'hang'])
    const firstMember = await spawn(ctx, lead, 'alpha')
    const alpha = await waitRunning(ctx, firstMember.member.id)
    const secondMember = await spawn(ctx, lead, 'beta')
    const beta = await waitRunning(ctx, secondMember.member.id)

    const first = await ctx.agentTeams.createTask(alpha, {
      subject: 'first',
      description: 'first task',
      writeScopes: ['src', './src/', 'src'],
    })
    const second = await ctx.agentTeams.createTask(beta, {
      subject: 'second',
      description: 'second task',
      blockedBy: [first.id],
      writeScopes: ['src/feature'],
    })
    expect(first.writeScopes).toEqual(['src'])
    await expect(ctx.agentTeams.updateTask(beta, {
      taskId: second.id,
      expectedRevision: second.revision,
      action: 'claim',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })

    const claimed = await ctx.agentTeams.updateTask(alpha, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'claim',
    })
    await expect(ctx.agentTeams.updateTask(beta, {
      taskId: first.id,
      expectedRevision: claimed.revision,
      action: 'claim',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_ALREADY_CLAIMED' })
    expect(ctx.agentTeams.getTask(beta, second.id)).toMatchObject({
      ready: false,
      writeScopeWarnings: [`write scopes overlap with ${first.id}`],
    })
    await expect(ctx.agentTeams.updateTask(beta, {
      taskId: first.id,
      expectedRevision: claimed.revision,
      action: 'edit',
      subject: 'stolen',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_UNAUTHORIZED' })
    await expect(ctx.agentTeams.updateTask(alpha, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'complete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_STALE_REVISION' })

    const completed = await ctx.agentTeams.updateTask(alpha, {
      taskId: first.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      result: 'Implemented first task; verified focused tests.',
    })
    expect(completed).toMatchObject({
      status: 'completed',
      result: 'Implemented first task; verified focused tests.',
    })
    expect(ctx.agentTeams.getTask(beta, second.id).ready).toBe(true)
    const secondClaim = await ctx.agentTeams.updateTask(beta, {
      taskId: second.id,
      expectedRevision: second.revision,
      action: 'claim',
    })
    const released = await ctx.agentTeams.updateTask(beta, {
      taskId: second.id,
      expectedRevision: secondClaim.revision,
      action: 'release',
    })
    expect(released).toMatchObject({ status: 'pending', ready: true })
    expect('ownerId' in released).toBe(false)

    ctx.agentTeams.interrupt(lead, 'alpha')
    ctx.agentTeams.interrupt(lead, 'beta')
    await Promise.all([waitNoAgent(ctx, alpha.id), waitNoAgent(ctx, beta.id)])
  })

  it('rejects malformed scopes and every invalid dependency relation', async () => {
    const { ctx, lead } = await setup([])
    const first = await ctx.agentTeams.createTask(lead, { subject: 'one', description: 'one' })
    const second = await ctx.agentTeams.createTask(lead, {
      subject: 'two', description: 'two', blockedBy: [first.id],
    })
    await expect(ctx.agentTeams.createTask(lead, {
      subject: 'bad', description: 'bad', blockedBy: [TeamTaskId('missing')],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'set_dependencies',
      blockedBy: [second.id],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_DEPENDENCY_CYCLE' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'set_dependencies',
      blockedBy: [first.id],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_DEPENDENCY_CYCLE' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'set_dependencies',
      blockedBy: [second.id, second.id],
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    for (const scope of ['', '.', '..', '/root', 'C:\\root', 'C:root', 'a//b', 'a/../b']) {
      await expect(ctx.agentTeams.createTask(lead, {
        subject: 'scope', description: 'scope', writeScopes: [scope],
      })).rejects.toMatchObject({ code: 'TEAM_INVALID_WRITE_SCOPE' })
    }
  })

  it('rejects incomplete mutations, invalid transitions, and deletion of a live blocker', async () => {
    const { ctx, lead } = await setup([])
    await expect(ctx.agentTeams.createTask(lead, { subject: ' ', description: 'invalid' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.createTask(lead, { subject: 'invalid', description: '' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.createTask(lead, { subject: 'x'.repeat(201), description: 'too long' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    const blocker = await ctx.agentTeams.createTask(lead, { subject: 'blocker', description: 'blocker' })
    await ctx.agentTeams.createTask(lead, {
      subject: 'dependent', description: 'dependent', blockedBy: [blocker.id],
    })
    expect(() => ctx.agentTeams.getTask(lead, TeamTaskId('missing')))
      .toThrow(expect.objectContaining({ code: 'TEAM_TASK_NOT_FOUND' }))
    for (const action of ['release', 'complete', 'reopen'] as const) {
      await expect(ctx.agentTeams.updateTask(lead, {
        taskId: blocker.id,
        expectedRevision: blocker.revision,
        action,
      })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    }
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id,
      expectedRevision: blocker.revision,
      action: 'edit',
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id,
      expectedRevision: blocker.revision,
      action: 'set_dependencies',
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id,
      expectedRevision: blocker.revision,
      action: 'delete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_HAS_DEPENDENTS' })
  })

  it('bounds normalized completion evidence without advancing rejected revisions', async () => {
    const { ctx, lead } = await setup([], { maxTaskResultLength: 2 })
    const created = await ctx.agentTeams.createTask(lead, { subject: 'bounded', description: 'evidence' })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: created.id, expectedRevision: 1, action: 'claim',
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: created.id, expectedRevision: claimed.revision, action: 'complete', result: 'abc',
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    expect(ctx.agentTeams.getTask(lead, created.id).revision).toBe(claimed.revision)
    expect(await ctx.agentTeams.updateTask(lead, {
      taskId: created.id, expectedRevision: claimed.revision, action: 'complete', result: ' 😀 ',
    })).toMatchObject({ status: 'completed', result: '😀' })
  })

  it('supports Lead reassignment, completion, reopen, and deletion permissions', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'owner')
    const owner = await waitRunning(ctx, started.member.id)
    const task = await ctx.agentTeams.createTask(owner, { subject: 'lifecycle', description: 'lifecycle' })
    const assigned = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'reassign',
      owner: 'owner',
    })
    await expect(ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: assigned.revision,
      action: 'reassign',
      owner: 'lead',
    })).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    await expect(ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: assigned.revision,
      action: 'complete',
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: assigned.revision,
      action: 'complete',
      result: ' ',
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    const complete = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: assigned.revision,
      action: 'complete',
      result: 'Lifecycle work completed and verified.',
    })
    expect(complete.result).toBe('Lifecycle work completed and verified.')
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: complete.revision,
      action: 'reassign',
      owner: 'lead',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    const reopened = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: complete.revision,
      action: 'reopen',
    })
    expect('result' in reopened).toBe(false)
    const claimed = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: reopened.revision,
      action: 'claim',
    })
    const recompleted = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'complete',
      result: 'Verified the reopened work.',
    })
    const deleted = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: recompleted.revision,
      action: 'delete',
    })
    expect(deleted.status).toBe('deleted')
    expect(deleted).not.toHaveProperty('result')
    expect(ctx.agentTeams.getTask(lead, task.id)).not.toHaveProperty('result')
    expect(ctx.agentTeams.listTasks(lead)).toEqual([])
    await expect(ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: deleted.revision,
      action: 'edit',
      subject: 'late',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_DELETED' })
    ctx.agentTeams.interrupt(lead, 'owner')
    await waitNoAgent(ctx, owner.id)
  })

  it('covers partial edits, Lead ownership, unassignment, and blocked reassignment', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'editor')
    const editor = await waitRunning(ctx, started.member.id)
    const blocker = await ctx.agentTeams.createTask(lead, { subject: 'blocker', description: 'blocker' })
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'draft',
      description: 'draft description',
      blockedBy: [blocker.id],
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: TeamTaskId('missing-update'), expectedRevision: 1, action: 'delete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: 'editor',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })

    const leadClaim = await ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id, expectedRevision: blocker.revision, action: 'claim',
    })
    expect(leadClaim.ownerName).toBe('lead')
    const completedBlocker = await ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id, expectedRevision: leadClaim.revision, action: 'complete',
      result: 'Blocker completed.',
    })
    expect(completedBlocker.status).toBe('completed')
    const assigned = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: 'editor',
    })
    const subject = await ctx.agentTeams.updateTask(editor, {
      taskId: task.id, expectedRevision: assigned.revision, action: 'edit', subject: 'edited subject',
    })
    const description = await ctx.agentTeams.updateTask(editor, {
      taskId: task.id,
      expectedRevision: subject.revision,
      action: 'edit',
      description: 'edited description',
    })
    const scopes = await ctx.agentTeams.updateTask(editor, {
      taskId: task.id,
      expectedRevision: description.revision,
      action: 'edit',
      writeScopes: ['src/nested'],
    })
    expect(scopes).toMatchObject({
      subject: 'edited subject',
      description: 'edited description',
      writeScopes: ['src/nested'],
    })
    const unassigned = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: scopes.revision, action: 'reassign', owner: ' ',
    })
    expect(unassigned).toMatchObject({ status: 'pending' })
    expect('ownerId' in unassigned).toBe(false)

    const broad = await ctx.agentTeams.createTask(lead, {
      subject: 'broad scope', description: 'broad scope', writeScopes: ['src'],
    })
    const narrow = await ctx.agentTeams.createTask(lead, {
      subject: 'narrow scope', description: 'narrow scope', writeScopes: ['src/nested'],
    })
    const disjoint = await ctx.agentTeams.createTask(lead, {
      subject: 'disjoint scope', description: 'disjoint scope', writeScopes: ['docs'],
    })
    await ctx.agentTeams.updateTask(lead, {
      taskId: broad.id, expectedRevision: broad.revision, action: 'claim',
    })
    await ctx.agentTeams.updateTask(lead, {
      taskId: narrow.id, expectedRevision: narrow.revision, action: 'claim',
    })
    await ctx.agentTeams.updateTask(lead, {
      taskId: disjoint.id, expectedRevision: disjoint.revision, action: 'claim',
    })
    expect(ctx.agentTeams.getTask(lead, broad.id).writeScopeWarnings)
      .toEqual([`write scopes overlap with ${narrow.id}`])

    ctx.agentTeams.interrupt(lead, 'editor')
    await waitNoAgent(ctx, editor.id)
  })
})

describe('Team Remote API', () => {
  it('exports Team views and task mutations from the owning service', async () => {
    const { ctx, lead } = await setup([])
    expect(ctx.agentTeams.typertRemote).toMatchObject({ serviceKey: 'agentTeams', namespace: 'agentTeams' })
    expect(ctx.agentTeams.remoteView(lead)).toEqual({
      members: [expect.objectContaining({ name: 'lead', role: 'lead', status: 'idle' })],
      tasks: [],
      batches: [],
      integrations: [],
    })

    const createdResult = await ctx.agentTeams.remoteCreateTask(lead, {
      subject: 'Remote task',
      description: 'Created through the generated API',
      blockedBy: [],
      writeScopes: ['packages/experimental/agent-team'],
    })
    expect(createdResult).toMatchObject({ ok: true, value: { revision: 1 } })
    if (!createdResult.ok) throw new Error('Remote task creation did not succeed')
    const created = createdResult.value
    await expect(ctx.agentTeams.remoteUpdateTask(lead, {
      taskId: created.id,
      expectedRevision: created.revision,
      action: 'claim',
    })).resolves.toMatchObject({
      ok: true,
      value: { id: created.id, revision: 2, ownerName: 'lead' },
    })
    expect(ctx.agentTeams.remoteView(lead).tasks).toHaveLength(1)
  })

  it('preserves Team task rejections and propagates unexpected failures', async () => {
    const { ctx, lead } = await setup([])
    const createRequest = {
      subject: 'Remote task', description: 'Rejected task', blockedBy: [], writeScopes: [],
    }
    const request = { taskId: TeamTaskId('task-1'), expectedRevision: 1, action: 'delete' as const }
    vi.spyOn(ctx.agentTeams, 'createTask')
      .mockRejectedValueOnce(new TeamError('invalid task', 'TEAM_TASK_INVALID'))
      .mockRejectedValueOnce(new Error('unexpected creation failure'))
    vi.spyOn(ctx.agentTeams, 'updateTask')
      .mockRejectedValueOnce(new TeamError('stale', 'TEAM_TASK_STALE_REVISION'))
      .mockRejectedValueOnce(new TeamError('denied', 'TEAM_TASK_FORBIDDEN'))
      .mockRejectedValueOnce(new Error('unexpected mutation failure'))

    await expect(ctx.agentTeams.remoteCreateTask(lead, createRequest)).resolves.toEqual({
      ok: false,
      error: { code: 'team-rejected', message: 'invalid task' },
    })
    await expect(ctx.agentTeams.remoteCreateTask(lead, createRequest))
      .rejects.toThrow('unexpected creation failure')
    await expect(ctx.agentTeams.remoteUpdateTask(lead, request)).resolves.toEqual({
      ok: false,
      error: { code: 'team-task-conflict', message: 'stale' },
    })
    await expect(ctx.agentTeams.remoteUpdateTask(lead, request)).resolves.toEqual({
      ok: false,
      error: { code: 'team-rejected', message: 'denied' },
    })
    await expect(ctx.agentTeams.remoteUpdateTask(lead, request)).rejects.toThrow('unexpected mutation failure')
  })
})

describe('Team mailbox and waiting', () => {
  it('injects a quiet message addressed to the Lead and checkpoints its receipt', async () => {
    const { ctx, lead } = await setup([])
    const message: TeamMessageSnapshot = {
      id: TeamMessageId('quiet-lead-message'),
      senderId: SessionId('team-worker'),
      senderName: 'worker',
      targetId: lead.id,
      delivery: 'quiet',
      content: content('quiet report'),
    }
    lead.session.append('team/message/queued', {
      version: 1,
      teamId: TeamId(lead.id),
      message,
    })

    await expect(teamInternals(ctx).mailbox.tryDispatch(lead, message, SIGNAL)).resolves.toBe(true)
    expect(lead.inbox.nextStep.some(input => input.source.kind === 'team-message'
      && input.source.messageId === message.id)).toBe(true)
    expect(durable(lead).pendingMessages).toEqual([])
  })

  it('acknowledges waking messages persisted by a busy Lead before model claim', async () => {
    const { ctx, lead, teamFiber } = await setup(['hang', 'hang'], { maxPendingMessagesPerMember: 1 })
    const started = await spawn(ctx, lead, 'lead-reporter')
    const reporter = await waitRunning(ctx, started.member.id)
    lead.followup(createUserMessage({ content: content('keep the Lead busy'), source: { kind: 'user' } }))
    await waitRunning(ctx, lead.id)

    const first = await ctx.agentTeams.sendMessage(reporter, {
      target: 'lead', content: content('first wakeup report'), delivery: 'wakeup', signal: SIGNAL,
    })
    const second = await ctx.agentTeams.sendMessage(reporter, {
      target: 'lead', content: content('second wakeup report'), delivery: 'wakeup', signal: SIGNAL,
    })
    expect([first.status, second.status]).toEqual(['accepted', 'accepted'])
    expect(lead.status).toBe('running')
    expect(durable(lead).pendingMessages).toEqual([])

    const messageIds = new Set([first.messageId, second.messageId])
    const persisted = await ctx.sessionPersistence.inspect(lead.id)
    const receiptOrder = persisted.events.flatMap((event) => {
      if (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message =>
        message.source.kind === 'team-message' && messageIds.has(message.source.messageId))) {
        return ['agent/inbox/spliced']
      }
      if (event.type === 'team/message/delivered' && messageIds.has(event.data.messageId)) {
        return ['team/message/delivered']
      }
      return []
    })
    expect(receiptOrder).toEqual([
      'agent/inbox/spliced',
      'team/message/delivered',
      'agent/inbox/spliced',
      'team/message/delivered',
    ])

    const receiptCount = lead.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'team-message'
        && messageIds.has(message.source.messageId))).length
    await teamFiber.dispose()
    await ctx.plugin(TeamService, { maxPendingMessagesPerMember: 1 })
    await vi.waitFor(() => { expect(durable(lead).pendingMessages).toEqual([]) })
    expect(lead.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'team-message'
        && messageIds.has(message.source.messageId)))).toHaveLength(receiptCount)

    lead.cancel({ kind: 'parent' })
    await lead.whenIdle()
  })

  it('flushes a live pending receipt before acknowledgement without inserting a duplicate', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'pending-target')
    const target = await waitRunning(ctx, started.member.id)
    const immediate = await ctx.agentTeams.sendMessage(lead, {
      target: 'pending-target',
      content: content('live quiet receipt'),
      delivery: 'quiet',
      signal: SIGNAL,
    })
    expect(immediate.status).toBe('accepted')
    expect(durable(lead).pendingMessages).toEqual([])
    expect(target.inbox.nextStep.some(item => item.source.kind === 'team-message'
      && item.source.messageId === immediate.messageId)).toBe(true)

    const message: TeamMessageSnapshot = {
      id: TeamMessageId('live-pending-message'),
      senderId: lead.id,
      senderName: 'lead',
      targetId: target.id,
      delivery: 'quiet',
      content: content('durable pending receipt'),
    }
    lead.session.append('team/message/queued', {
      version: 1,
      teamId: TeamId(lead.id),
      message,
    })
    await ctx.sessions.flush(lead.session)
    target.inject(createUserMessage({
      content: content('durable pending receipt'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: message.id,
        senderId: lead.id,
        senderName: 'lead',
      },
    }))

    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const flushed: SessionId[] = []
    const flushSpy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      flushed.push(session.id)
      return flush(session)
    })
    const delivered = await teamInternals(ctx).mailbox.tryDispatch(lead, message, SIGNAL)

    expect(delivered).toBe(true)
    expect(flushed.slice(0, 2)).toEqual([target.id, lead.id])
    expect(target.inbox.nextStep.filter(item => item.source.kind === 'team-message'
      && item.source.messageId === message.id)).toHaveLength(1)
    expect(durable(lead).pendingMessages).toEqual([])

    const disappearing: TeamMessageSnapshot = {
      ...message,
      id: TeamMessageId('disappearing-pending-message'),
      content: content('canceled before checkpoint'),
    }
    lead.session.append('team/message/queued', {
      version: 1,
      teamId: TeamId(lead.id),
      message: disappearing,
    })
    await flush(lead.session)
    const disappearingInput = createUserMessage({
      content: content('canceled before checkpoint'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: disappearing.id,
        senderId: lead.id,
        senderName: 'lead',
      },
    })
    target.inject(disappearingInput)
    flushSpy.mockImplementationOnce(async (session) => {
      target.inbox.remove(disappearingInput.id)
      return flush(session)
    })
    await expect(teamInternals(ctx).mailbox.tryDispatch(lead, disappearing, SIGNAL)).resolves.toBe(false)
    expect(durable(lead).pendingMessages.map(pending => pending.id)).toEqual([disappearing.id])

    ctx.agentTeams.interrupt(lead, 'pending-target')
    target.cancel({ kind: 'parent' })
    await waitNoAgent(ctx, target.id)
  })

  it('acknowledges waking messages accepted by a busy target inbox', async () => {
    const { ctx, lead } = await setup(['hang'], { maxPendingMessagesPerMember: 1 })
    const started = await spawn(ctx, lead, 'busy-target')
    const target = await waitRunning(ctx, started.member.id)
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const flushed: SessionId[] = []
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      flushed.push(session.id)
      return flush(session)
    })

    const first = await ctx.agentTeams.sendMessage(lead, {
      target: 'busy-target', content: content('first waking message'), delivery: 'wakeup', signal: SIGNAL,
    })

    expect(first.status).toBe('accepted')
    expect(flushed).toEqual([lead.id, target.id, lead.id])
    expect(durable(lead).pendingMessages).toEqual([])
    expect(target.inbox.nextTurn.some(message => message.source.kind === 'team-message'
      && message.source.messageId === first.messageId)).toBe(true)

    flushed.length = 0
    const second = await ctx.agentTeams.sendMessage(lead, {
      target: 'busy-target', content: content('second waking message'), delivery: 'wakeup', signal: SIGNAL,
    })

    expect(second.status).toBe('accepted')
    expect(flushed).toEqual([lead.id, target.id, lead.id])
    expect(durable(lead).pendingMessages).toEqual([])
    expect(target.inbox.nextTurn.filter(message => message.source.kind === 'team-message'
      && (message.source.messageId === first.messageId || message.source.messageId === second.messageId)))
      .toHaveLength(2)

    ctx.agentTeams.interrupt(lead, 'busy-target')
    target.cancel({ kind: 'parent' })
    await waitNoAgent(ctx, target.id)
  })

  it('serializes concurrent waking delivery admission for one target', async () => {
    const { ctx, lead } = await setup([textResponse('target initial')])
    const target = await spawn(ctx, lead, 'ordered-target')
    await waitNoAgent(ctx, target.member.id)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const admitted: string[] = []
    vi.spyOn(ctx.subagents as unknown as HostPromptQueue, queueSubagentPrompt).mockImplementation(async (_parent, _childId, blocks) => {
      const last = blocks.at(-1)
      const text = last?.type === 'text' ? last.text : ''
      admitted.push(text)
      if (text === 'first waking') {
        entered.resolve(undefined)
        await release.promise
      }
      return createUserMessage({ content: blocks, source: { kind: 'user' } }).id
    })

    const first = ctx.agentTeams.sendMessage(lead, {
      target: 'ordered-target', content: content('first waking'), delivery: 'wakeup', signal: SIGNAL,
    })
    await entered.promise
    let secondSettled = false
    const second = ctx.agentTeams.sendMessage(lead, {
      target: 'ordered-target', content: content('second waking'), delivery: 'wakeup', signal: SIGNAL,
    }).finally(() => { secondSettled = true })
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(admitted).toEqual(['first waking'])
    expect(secondSettled).toBe(false)

    release.resolve(undefined)
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: 'accepted' },
      { status: 'accepted' },
    ])
    expect(admitted).toEqual(['first waking', 'second waking'])
  })

  it('deduplicates live target history and contains inspection and delivery failures', async () => {
    const { ctx, lead } = await setup(['hang', textResponse('inactive target initial')])
    const liveStarted = await spawn(ctx, lead, 'live-target')
    const live = await waitRunning(ctx, liveStarted.member.id)
    const internal = teamInternals(ctx).mailbox
    const message: TeamMessageSnapshot = {
      id: TeamMessageId('live-recorded-message'),
      senderId: lead.id,
      senderName: 'lead',
      targetId: live.id,
      delivery: 'wakeup',
      content: content('already in live history'),
    }
    lead.session.append('team/message/queued', {
      version: 1, teamId: TeamId(lead.id), message,
    })
    await ctx.sessions.flush(lead.session)
    live.session.append('user/message', createUserMessage({
      content: content('different Team message first'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: TeamMessageId('other-message'),
        senderId: lead.id,
        senderName: 'lead',
      },
    }), { surfaceOp: 'append' })
    live.session.append('user/message', createUserMessage({
      content: content('already in live history'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: message.id,
        senderId: lead.id,
        senderName: 'lead',
      },
    }), { surfaceOp: 'append' })
    await expect(internal.tryDispatch(lead, message, SIGNAL)).resolves.toBe(true)
    await internal.markDelivered(lead, message.id, live.id)

    const wrongTarget: TeamMessageSnapshot = {
      ...message,
      id: TeamMessageId('wrong-target-message'),
    }
    lead.session.append('team/message/queued', {
      version: 1, teamId: TeamId(lead.id), message: wrongTarget,
    })
    await ctx.sessions.flush(lead.session)
    await internal.markDelivered(lead, wrongTarget.id, SessionId('wrong-target'))
    await expect(internal.serializeDispatch(wrongTarget, async () => true)).resolves.toBe(true)
    const serialEntered = Promise.withResolvers<undefined>()
    const releaseSerial = Promise.withResolvers<undefined>()
    const serialFirst = internal.serializeDispatch(wrongTarget, async () => {
      serialEntered.resolve(undefined)
      await releaseSerial.promise
      return true
    })
    await serialEntered.promise
    const serialSecond = internal.serializeDispatch({
      ...wrongTarget, id: TeamMessageId('second-serialized-message'),
    }, async () => true)
    releaseSerial.resolve(undefined)
    await expect(Promise.all([serialFirst, serialSecond])).resolves.toEqual([true, true])

    const warnings: string[] = []
    ctx.logger.warn = ((value: unknown) => { warnings.push(String(value)) }) as typeof ctx.logger.warn
    const failedAck = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('acknowledgement flush failed'))
    live.session.append('user/message', createUserMessage({
      content: content('acknowledgement failure'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: wrongTarget.id,
        senderId: lead.id,
        senderName: 'lead',
      },
    }), { surfaceOp: 'append' })
    await vi.waitFor(() => {
      expect(warnings.some(warning => warning.includes('acknowledgement flush failed'))).toBe(true)
    })
    failedAck.mockRestore()

    const inactiveStarted = await spawn(ctx, lead, 'inactive-target')
    await waitNoAgent(ctx, inactiveStarted.member.id)
    const inspect = vi.spyOn(ctx.sessionPersistence, 'inspect').mockRejectedValueOnce(new Error('inspect unavailable'))
    const uncertain = await ctx.agentTeams.sendMessage(lead, {
      target: 'inactive-target', content: content('inspection failure'), delivery: 'wakeup', signal: SIGNAL,
    })
    expect(uncertain.status).toBe('queued')
    inspect.mockRestore()

    vi.spyOn(ctx.subagents as unknown as HostPromptQueue, queueSubagentPrompt).mockRejectedValueOnce(new Error('delivery unavailable'))
    const failed = await ctx.agentTeams.sendMessage(lead, {
      target: 'inactive-target', content: content('delivery failure'), delivery: 'wakeup', signal: SIGNAL,
    })
    expect(failed.status).toBe('queued')
    expect(warnings.some(warning => warning.includes('inspect unavailable'))).toBe(true)
    expect(warnings.some(warning => warning.includes('delivery unavailable'))).toBe(true)

    ctx.agentTeams.interrupt(lead, 'live-target')
    await waitNoAgent(ctx, live.id)
  })

  it('keeps quiet mail dormant, wakes on follow-up, preserves FIFO, and de-duplicates delivery', async () => {
    const { ctx, lead } = await setup(['hang', textResponse('beta first'), textResponse('beta resumed')])
    const alphaStarted = await spawn(ctx, lead, 'alpha')
    const alpha = await waitRunning(ctx, alphaStarted.member.id)
    const betaStarted = await spawn(ctx, lead, 'beta')
    await waitNoAgent(ctx, betaStarted.member.id)

    const quiet = await ctx.agentTeams.sendMessage(alpha, {
      target: 'beta', content: content('quiet info'), delivery: 'quiet', signal: SIGNAL,
    })
    expect(quiet.status).toBe('queued')
    expect(ctx.agents.get(betaStarted.member.id)).toBeUndefined()
    const waking = await ctx.agentTeams.sendMessage(alpha, {
      target: 'beta', content: content('do another turn'), delivery: 'wakeup', signal: SIGNAL,
    })
    expect(waking.status).toBe('accepted')
    await waitNoAgent(ctx, betaStarted.member.id)
    await vi.waitFor(() => { expect(durable(lead).pendingMessages).toEqual([]) })

    const stored = await ctx.sessionPersistence.inspect(betaStarted.member.id)
    const peerMessages = stored.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'team-message')
    expect(peerMessages.map((event) => {
      if (event.type !== 'user/message') return undefined
      const block = event.data.content.at(-1)
      return block?.type === 'text' ? block.text : undefined
    })).toEqual(['quiet info', 'do another turn'])
    expect(peerMessages.map(event => event.type === 'user/message'
      ? event.data.content[0]?.type === 'text' && event.data.content[0].text
      : undefined)).toEqual([
      expect.stringMatching(/^Team message .* from alpha:$/u),
      expect.stringMatching(/^Team message .* from alpha:$/u),
    ])
    expect(peerMessages.map(event => event.type === 'user/message' && event.data.source.kind === 'team-message'
      ? [event.data.source.messageId, event.data.source.senderName]
      : undefined)).toEqual([
      [quiet.messageId, 'alpha'],
      [waking.messageId, 'alpha'],
    ])

    ctx.agentTeams.interrupt(lead, 'alpha')
    await waitNoAgent(ctx, alpha.id)
  })

  it('enforces message byte and pending-count limits without encouraging retry after enqueue', async () => {
    const { ctx, lead } = await setup([textResponse('idle')], {
      maxMessageBytes: 256,
      maxPendingMessagesPerMember: 1,
    })
    const target = await spawn(ctx, lead, 'target')
    await waitNoAgent(ctx, target.member.id)
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'target', content: content('x'.repeat(300)), delivery: 'quiet', signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_TOO_LARGE' })
    const queued = await ctx.agentTeams.sendMessage(lead, {
      target: 'target', content: content('one'), delivery: 'quiet', signal: SIGNAL,
    })
    expect(queued.status).toBe('queued')
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'target', content: content('two'), delivery: 'quiet', signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MAILBOX_FULL' })
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'lead', content: content('self'), delivery: 'quiet', signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_SELF_MESSAGE' })
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'missing', content: content('unknown target'), delivery: 'quiet', signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    const controller = new AbortController()
    controller.abort(new TeamError('cancelled before queue', 'TEST_CANCELLED'))
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'target', content: content('cancelled'), delivery: 'quiet', signal: controller.signal,
    })).rejects.toMatchObject({ code: 'TEST_CANCELLED' })
  })

  it('interrupts only the current turn and retains an already accepted follow-up', async () => {
    const { ctx, lead } = await setup(['hang', textResponse('after interrupt')])
    const started = await spawn(ctx, lead, 'worker')
    const worker = await waitRunning(ctx, started.member.id)
    const followup = await ctx.agentTeams.sendMessage(lead, {
      target: 'worker', content: content('retained follow-up'), delivery: 'wakeup', signal: SIGNAL,
    })
    expect(followup.status).toBe('accepted')
    expect(ctx.agentTeams.interrupt(lead, 'worker')).toEqual({ previousStatus: 'running' })
    await vi.waitFor(() => { expect(worker.status).toBe('idle') })
    expect(worker.inbox.nextTurn.some(message => message.source.kind === 'team-message'
      && message.source.messageId === followup.messageId)).toBe(true)
    worker.cancel({ kind: 'parent' })
    await waitNoAgent(ctx, worker.id)
  })

  it('waits for one change, supports cancellation, times out, and releases waiters on HMR disposal', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-wait-'))
    roots.push(storageRoot)
    await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    const fiber = await ctx.plugin(TeamService)
    const service = ctx.agentTeams
    const lead = ctx.agentLoop.create(SessionId('wait-lead'), {})

    await expect(service.waitForChange(lead, 9_999, SIGNAL))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_TIMEOUT' })
    const alreadyAborted = new AbortController()
    alreadyAborted.abort(new TeamError('cancelled before wait', 'TEST_CANCELLED'))
    await expect(service.waitForChange(lead, 10_000, alreadyAborted.signal))
      .rejects.toMatchObject({ code: 'TEST_CANCELLED' })

    const changed = service.waitForChange(lead, 10_000, SIGNAL)
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const flushEntered = Promise.withResolvers<undefined>()
    const releaseFlush = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      flushEntered.resolve(undefined)
      await releaseFlush.promise
      return await flush(session)
    })
    let waitSettled = false
    void changed.finally(() => { waitSettled = true })
    const creating = service.createTask(lead, { subject: 'wake', description: 'wake waiter' })
    await flushEntered.promise
    expect(waitSettled).toBe(false)
    releaseFlush.resolve(undefined)
    await creating
    await expect(changed).resolves.toEqual({ timedOut: false })

    const controller = new AbortController()
    const cancelled = service.waitForChange(lead, 10_000, controller.signal)
    controller.abort(new TeamError('cancelled', 'TEST_CANCELLED'))
    await expect(cancelled).rejects.toMatchObject({ code: 'TEST_CANCELLED' })

    const stringAbort = new AbortController()
    const firstWaiter = service.waitForChange(lead, 10_000, stringAbort.signal)
    const secondWaiter = service.waitForChange(lead, 10_000, SIGNAL)
    stringAbort.abort('string cancellation')
    await expect(firstWaiter).rejects.toMatchObject({
      code: 'TEAM_WAIT_ABORTED',
      message: 'wait_agent aborted: string cancellation',
    })
    await service.createTask(lead, { subject: 'second waiter', description: 'second waiter remains registered' })
    await expect(secondWaiter).resolves.toEqual({ timedOut: false })

    const objectAbort = new AbortController()
    const objectCancelled = service.waitForChange(lead, 10_000, objectAbort.signal)
    objectAbort.abort({ kind: 'user' })
    await expect(objectCancelled).rejects.toMatchObject({
      code: 'TEAM_WAIT_ABORTED',
      message: "wait_agent aborted: { kind: 'user' }",
    })

    await service.createTask(lead, { subject: 'already changed', description: 'edge-triggered wait' })
    vi.useFakeTimers()
    const timeout = service.waitForChange(lead, 10_000, SIGNAL)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(timeout).resolves.toEqual({ timedOut: true })
    vi.useRealTimers()

    const disposed = service.waitForChange(lead, 10_000, SIGNAL)
    await fiber.dispose()
    await expect(disposed).resolves.toEqual({ timedOut: false })
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('disposes live teammate Activations and their waits when the Team service unloads', async () => {
    const { ctx, lead, teamFiber } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'dispose-worker')
    await waitRunning(ctx, started.member.id)
    const waiting = ctx.agentTeams.waitForChange(lead, 10_000, SIGNAL)

    await teamFiber.dispose()

    await expect(waiting).resolves.toEqual({ timedOut: false })
    expect(ctx.agents.get(started.member.id)).toBeUndefined()
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('closes creation admission and drains an in-flight spawn before unload completes', async () => {
    const { ctx, lead, teamFiber } = await setup(['hang'])
    const service = ctx.agentTeams
    const start = ctx.subagents.startContinuable.bind(ctx.subagents)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let childId: SessionId | undefined
    vi.spyOn(ctx.subagents, 'startContinuable').mockImplementation(async (spec) => {
      childId = spec.childId
      entered.resolve(undefined)
      await release.promise
      return start(spec)
    })
    const spawning = spawn(ctx, lead, 'disposing-worker')
    const rejected = expect(spawning).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
    await entered.promise

    const disposal = teamFiber.dispose()
    await Promise.resolve()
    await expect(service.waitForChange(lead, 3_600_000, SIGNAL)).resolves.toEqual({ timedOut: false })
    await expect(service.spawnTeammate(lead, {
      name: 'late-worker',
      description: 'must not enter after disposal',
      prompt: content('late task'),
      context: 'fresh',
      provider: 'spawn',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
    release.resolve(undefined)

    await rejected
    await disposal
    if (childId !== undefined) expect(ctx.agents.get(childId)).toBeUndefined()
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('retains an in-flight creation cleanup failure during disposal', async () => {
    const { ctx } = await setup([])
    const internal = teamInternals(ctx)
    const cleanupFailure = new Error('creation cleanup failed')
    const rejected = Promise.reject(cleanupFailure)
    void rejected.catch(() => undefined)
    internal.roster.inFlightCreations.add(rejected)

    await expect(internal.disposeRuntime()).rejects.toMatchObject({ errors: [cleanupFailure] })
  })

  it('recognizes wrapped and coded runtime cancellation during disposal settlement', async () => {
    const open = new TeamRuntimeLifecycle(100)
    const ordinaryFailure = new Error('ordinary failure before disposal')
    const openFailures: unknown[] = []
    await open.settle([Promise.reject(ordinaryFailure)], openFailures)
    expect(openFailures).toEqual([ordinaryFailure])

    const lifecycle = new TeamRuntimeLifecycle(100)
    lifecycle.close()
    const failures: unknown[] = []
    await lifecycle.settle([
      Promise.reject(new Error('wrapped cancellation', { cause: lifecycle.reason })),
      Promise.reject(new TeamError('translated cancellation', 'TEAM_DISPOSED')),
    ], failures)
    expect(failures).toEqual([])

    const cyclic = new Error('unrelated cyclic failure')
    cyclic.cause = cyclic
    await lifecycle.settle([Promise.reject(cyclic)], failures)
    expect(failures).toEqual([cyclic])
  })

  it('disposes a live child even after its durable member edge becomes failed', async () => {
    const { ctx, lead } = await setup(['hang'])
    const childId = SessionId('failed-live-child')
    const member = {
      id: childId,
      name: 'failed-live-worker',
      description: 'failed-live-worker responsibility',
      provider: 'spawn',
      context: 'fresh' as const,
      phase: 'provisioning' as const,
    }
    lead.session.append('team/member', {
      version: 1,
      teamId: TeamId(lead.id),
      member,
    })
    await ctx.subagents.startContinuable({
      childId,
      provider: 'spawn',
      label: member.description,
      request: { prompt: content('failed child task'), parent: lead },
      signal: SIGNAL,
    })
    await waitRunning(ctx, childId)
    lead.session.append('team/member', {
      version: 1,
      teamId: TeamId(lead.id),
      member: {
        ...member,
        phase: 'failed',
        error: 'creation cleanup is pending',
      },
    })
    await ctx.sessions.flush(lead.session)
    expect(ctx.agentTeams.listMembers(lead)[1]?.status).toBe('failed')

    const internal = ctx.agentTeams as unknown as { disposeRuntime(): Promise<void> }
    await internal.disposeRuntime()
    expect(ctx.agents.get(childId)).toBeUndefined()
  })

  it('aborts and awaits an admitted cold mailbox dispatch during disposal', async () => {
    const { ctx, lead } = await setup([textResponse('worker done')])
    const started = await spawn(ctx, lead, 'mailbox-worker')
    await waitNoAgent(ctx, started.member.id)
    const entered = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.subagents as unknown as HostPromptQueue, queueSubagentPrompt).mockImplementation(async (_parent, _childId, _content, _source, signal) => {
      entered.resolve(undefined)
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted.resolve(undefined)
          void release.promise.then(() => {
            const reason: unknown = signal.reason
            reject(reason instanceof Error ? reason : new Error(String(reason)))
          })
        }, { once: true })
      })
    })

    const sending = ctx.agentTeams.sendMessage(lead, {
      target: 'mailbox-worker',
      content: content('resume during disposal'),
      delivery: 'wakeup',
      signal: SIGNAL,
    })
    await entered.promise
    const internal = ctx.agentTeams as unknown as { disposeRuntime(): Promise<void> }
    let disposed = false
    const disposal = internal.disposeRuntime().then(() => { disposed = true })
    await aborted.promise
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve(undefined)

    await expect(sending).resolves.toMatchObject({ status: 'queued' })
    await disposal
    expect(disposed).toBe(true)
    expect(ctx.agents.get(started.member.id)).toBeUndefined()
  })

  it('retains an abort-ignoring mailbox owner at the disposal deadline and joins it on a later close', async () => {
    const { ctx, lead } = await setup(['hang'], { disposalTimeoutMs: 25 })
    const started = await spawn(ctx, lead, 'deadline-mailbox-worker')
    await waitRunning(ctx, started.member.id)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let aborts = 0
    vi.spyOn(ctx.subagents as unknown as HostPromptQueue, queueSubagentPrompt).mockImplementation(async (_parent, _childId, _content, _source, signal) => {
      entered.resolve(undefined)
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => { aborts++; void release.promise.then(resolve) }, { once: true })
      })
    })
    const sending = ctx.agentTeams.sendMessage(lead, {
      target: 'deadline-mailbox-worker', content: content('wait through deadline'), delivery: 'wakeup', signal: SIGNAL,
    })
    await entered.promise
    const internal = teamInternals(ctx)
    vi.useFakeTimers()
    try {
      const first = internal.disposeRuntime()
      const timedOut = expect(first).rejects.toBeInstanceOf(AggregateError)
      await vi.advanceTimersByTimeAsync(25)
      await timedOut
      expect(aborts).toBe(1)
      expect(ctx.agents.get(started.member.id)).toBeDefined()
      release.resolve(undefined)
      await expect(sending).resolves.toMatchObject({ status: 'queued' })
      await internal.disposeRuntime()
      expect(aborts).toBe(1)
      expect(ctx.agents.get(started.member.id)).toBeUndefined()
    } finally { vi.useRealTimers() }
  })

  it('joins an unresolved child drain on a later close without repeating provider cancellation', async () => {
    const { ctx, lead } = await setup(['hang', 'hang'], { disposalTimeoutMs: 25 })
    const started = await spawn(ctx, lead, 'deadline-drain-worker')
    await waitRunning(ctx, started.member.id)
    const original = ctx.subagents.drainContinuableChildren.bind(ctx.subagents)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const drain = vi.spyOn(ctx.subagents, 'drainContinuableChildren').mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      await original(...args)
    })
    const internal = teamInternals(ctx)
    vi.useFakeTimers()
    try {
      const first = internal.disposeRuntime()
      void first.catch(() => undefined)
      await entered.promise
      await vi.advanceTimersByTimeAsync(25)
      await expect(first).rejects.toBeInstanceOf(AggregateError)
      expect(ctx.agents.get(started.member.id)).toBeDefined()
    } finally { vi.useRealTimers() }
    const second = internal.disposeRuntime()
    release.resolve(undefined)
    await second
    expect(drain).toHaveBeenCalledTimes(1)
    expect(ctx.agents.get(started.member.id)).toBeUndefined()
    drain.mockRestore()
  })

  it('joins an overlapping survivor drain after its sibling already stopped', async () => {
    const { ctx, lead } = await setup([], { disposalTimeoutMs: 25 })
    const firstId = SessionId('partial-drain-first')
    const secondId = SessionId('partial-drain-second')
    const internal = teamInternals(ctx)
    let observation = 0
    vi.spyOn(internal.roster, 'liveChildrenByRoot').mockImplementation(() => new Map([[
      lead,
      observation++ === 0 ? [firstId, secondId] : [secondId],
    ]]))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const drain = vi.spyOn(ctx.subagents, 'drainContinuableChildren').mockImplementation(async (_root, ids) => {
      expect(ids).toEqual([firstId, secondId])
      entered.resolve(undefined)
      await release.promise
    })
    vi.useFakeTimers()
    try {
      const closing = internal.disposeRuntime()
      void closing.catch(() => undefined)
      await entered.promise
      await vi.advanceTimersByTimeAsync(25)
      await expect(closing).rejects.toBeInstanceOf(AggregateError)
    } finally { vi.useRealTimers() }
    const retry = internal.disposeRuntime()
    expect(drain).toHaveBeenCalledTimes(1)
    release.resolve(undefined)
    await retry
    expect(drain).toHaveBeenCalledTimes(1)
    drain.mockRestore()
  })

  it('awaits a retained drain even after the next roster observation is empty', async () => {
    const { ctx, lead } = await setup(['hang'], { disposalTimeoutMs: 25 })
    const started = await spawn(ctx, lead, 'hidden-drain-worker')
    await waitRunning(ctx, started.member.id)
    const internal = teamInternals(ctx)
    let observation = 0
    vi.spyOn(internal.roster, 'liveChildrenByRoot').mockImplementation(() => observation++ === 0
      ? new Map([[lead, [started.member.id]]])
      : new Map())
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const drain = vi.spyOn(ctx.subagents, 'drainContinuableChildren').mockImplementation(async () => {
      entered.resolve(undefined)
      await release.promise
    })
    vi.useFakeTimers()
    try {
      const first = internal.disposeRuntime()
      void first.catch(() => undefined)
      await entered.promise
      await vi.advanceTimersByTimeAsync(25)
      await expect(first).rejects.toBeInstanceOf(AggregateError)
    } finally { vi.useRealTimers() }
    let finished = false
    const retry = internal.disposeRuntime().then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    release.resolve(undefined)
    await retry
    expect(drain).toHaveBeenCalledTimes(1)
    drain.mockRestore()
  })

  it('awaits a hidden retained drain while another Lead has a visible child', async () => {
    const { ctx, lead } = await setup(['hang'], { disposalTimeoutMs: 25 })
    const otherLead = ctx.agentLoop.create(SessionId('other-lead'), { provider: 'mock', model: 'mock' })
    const internal = teamInternals(ctx)
    let observation = 0
    vi.spyOn(internal.roster, 'liveChildrenByRoot').mockImplementation(() => observation++ === 0
      ? new Map([[lead, [SessionId('hidden-child')]]])
      : new Map([[otherLead, [SessionId('visible-child')]]]))
    const hiddenEntered = Promise.withResolvers<undefined>()
    const visibleEntered = Promise.withResolvers<undefined>()
    const hiddenRelease = Promise.withResolvers<undefined>()
    const drain = vi.spyOn(ctx.subagents, 'drainContinuableChildren').mockImplementation(async (_root, ids) => {
      if (ids[0] === SessionId('hidden-child')) {
        hiddenEntered.resolve(undefined)
        await hiddenRelease.promise
      } else visibleEntered.resolve(undefined)
    })
    vi.useFakeTimers()
    try {
      const first = internal.disposeRuntime()
      void first.catch(() => undefined)
      await hiddenEntered.promise
      await vi.advanceTimersByTimeAsync(25)
      await expect(first).rejects.toBeInstanceOf(AggregateError)
    } finally { vi.useRealTimers() }
    let finished = false
    const retry = internal.disposeRuntime().then(() => { finished = true })
    await visibleEntered.promise
    expect(finished).toBe(false)
    expect(drain).toHaveBeenCalledTimes(2)
    hiddenRelease.resolve(undefined)
    await retry
    expect(drain).toHaveBeenCalledTimes(2)
    drain.mockRestore()
  })

  it('awaits an admitted asynchronous acknowledgement before disposal completes', async () => {
    const { ctx, lead } = await setup([])
    const message: TeamMessageSnapshot = {
      id: TeamMessageId('dispose-ack-message'),
      senderId: SessionId('sender'),
      senderName: 'sender',
      targetId: lead.id,
      delivery: 'wakeup',
      content: content('acknowledge before disposal'),
    }
    lead.session.append('team/message/queued', {
      version: 1,
      teamId: TeamId(lead.id),
      message,
    })
    await ctx.sessions.flush(lead.session)

    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    let blockReceipt = true
    const flushSpy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (blockReceipt && session === lead.session) {
        blockReceipt = false
        entered.resolve(undefined)
        await release.promise
      }
      return flush(session)
    })
    lead.session.append('user/message', createUserMessage({
      content: content('acknowledge before disposal'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: message.id,
        senderId: message.senderId,
        senderName: message.senderName,
      },
    }), { surfaceOp: 'append' })

    const internal = ctx.agentTeams as unknown as { disposeRuntime(): Promise<void> }
    let disposed = false
    const disposal = internal.disposeRuntime().then(() => { disposed = true })
    await entered.promise
    await Promise.resolve()
    const disposedBeforeRelease = disposed
    release.resolve(undefined)
    await disposal

    expect(disposedBeforeRelease).toBe(false)
    expect(disposed).toBe(true)
    expect(durable(lead).pendingMessages).toEqual([])
    flushSpy.mockRestore()
  })

  it('bounds Team runtime disposal when a continuation drain never settles', async () => {
    const { ctx, lead, teamFiber } = await setup(['hang'], { disposalTimeoutMs: 25 })
    const started = await spawn(ctx, lead, 'stuck-worker')
    await waitRunning(ctx, started.member.id)
    const drain = vi.spyOn(ctx.subagents, 'drainContinuableChildren')
      .mockImplementation(() => new Promise(() => {}))

    const outcome = await Promise.race([
      teamFiber.dispose().then(() => 'disposed'),
      new Promise<'hung'>((resolve) => { setTimeout(() => { resolve('hung') }, 1_000) }),
    ])
    expect(outcome).toBe('disposed')
    expect(drain).toHaveBeenCalledWith(lead, [started.member.id])
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('bounds disposal while an admitted creation ignores cancellation', async () => {
    const { ctx, lead } = await setup([], { disposalTimeoutMs: 25 })
    const internal = teamInternals(ctx)
    internal.roster.inFlightCreations.add(new Promise(() => {}))

    await expect(internal.disposeRuntime()).rejects.toBeInstanceOf(AggregateError)
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'after-timeout',
      description: 'admission remains closed',
      prompt: content('must reject'),
      context: 'fresh',
      provider: 'spawn',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'nobody', content: content('must reject'), delivery: 'quiet', signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
    await expect(internal.mailbox.tryDispatch(lead, {
      id: TeamMessageId('post-disposal-message'),
      senderId: lead.id,
      senderName: 'lead',
      targetId: lead.id,
      delivery: 'quiet',
      content: content('must not dispatch'),
    }, SIGNAL)).resolves.toBe(false)
  })

  it('contains recovery callback failures and ignores work scheduled after disposal', async () => {
    const { ctx, lead, teamFiber } = await setup([])
    const warnings: string[] = []
    ctx.logger.warn = ((value: unknown) => { warnings.push(String(value)) }) as typeof ctx.logger.warn
    const internal = teamInternals(ctx)
    internal.recoverFor = async () => { throw new Error('forced recovery failure') }
    internal.scheduleRecovery(lead)
    await Promise.resolve()
    await Promise.resolve()
    expect(warnings.some(warning => warning.includes('forced recovery failure'))).toBe(true)

    lead.session.append('user/message', createUserMessage({
      content: content('orphan Team source'),
      source: {
        kind: 'team-message',
        teamId: TeamId('absent-team'),
        messageId: TeamMessageId('absent-team-message'),
        senderId: SessionId('absent-sender'),
        senderName: 'absent',
      },
    }), { surfaceOp: 'append' })
    await Promise.resolve()

    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    internal.recoverFor = async () => {
      entered.resolve(undefined)
      await release.promise
      throw new Error('failure after disposal')
    }
    internal.scheduleRecovery(lead)
    await entered.promise
    await teamFiber.dispose()
    release.resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()
    internal.scheduleRecovery(lead)
    await Promise.resolve()
  })

  it('reports contained teardown failures without retaining the Team service', async () => {
    const { ctx, lead, teamFiber } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'failing-drain')
    await waitRunning(ctx, started.member.id)
    vi.spyOn(ctx.subagents, 'drainContinuableDescendants').mockRejectedValueOnce(new Error('drain failure'))

    await teamFiber.dispose()
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('reconciles mismatched persisted children and ignores a concurrently settled member', async () => {
    const first = await setup([])
    const liveId = SessionId('live-provisioning-child')
    const live = await first.ctx.agents.create({
      sessionId: liveId,
      meta: { parentSession: first.lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const provisioning = {
      id: liveId,
      name: 'mismatched-child',
      description: 'mismatched persisted child',
      provider: 'spawn',
      context: 'fresh' as const,
      phase: 'provisioning' as const,
    }
    first.lead.session.append('team/member', {
      version: 1, teamId: TeamId(first.lead.id), member: provisioning,
    })
    const reconcileFirst = teamInternals(first.ctx).roster
    await reconcileFirst.reconcileProvisioning(first.lead, SIGNAL)
    expect(durable(first.lead).members[0]?.phase).toBe('provisioning')
    live.agent.session.append('user/message', createUserMessage({
      content: content('persist mismatched child'), source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await first.ctx.sessions.flush(live.agent.session)
    await live.dispose()
    await reconcileFirst.reconcileProvisioning(first.lead, SIGNAL)
    expect(durable(first.lead).members[0]).toMatchObject({
      phase: 'failed',
      error: 'persisted child Session does not match the provisioned continuation',
    })

    const second = await setup([])
    const childId = SessionId('concurrently-settled-child')
    const member = { ...provisioning, id: childId, name: 'concurrent-child' }
    second.lead.session.append('team/member', {
      version: 1, teamId: TeamId(second.lead.id), member,
    })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(second.ctx.sessionPersistence, 'inspect').mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      throw new Error('late inspection failure')
    })
    const reconcileSecond = teamInternals(second.ctx).roster
    const reconciling = reconcileSecond.reconcileProvisioning(second.lead, SIGNAL)
    await entered.promise
    second.lead.session.append('team/member', {
      version: 1,
      teamId: TeamId(second.lead.id),
      member: { ...member, phase: 'failed', error: 'settled elsewhere' },
    })
    release.resolve(undefined)
    await reconciling
    expect(durable(second.lead).members[0]).toMatchObject({
      phase: 'failed', error: 'settled elsewhere',
    })
  })
})


describe('Team worktree ownership', () => {
  it('persists worker cwd across cold follow-up and refuses messages after release', async () => {
    const fixture = await gitFixture((root) => { roots.push(root) })
    const { ctx, lead } = await setup([textResponse('first'), textResponse('second')], {
      worktreeProvider: 'git',
    }, fixture.repository)
    await ctx.plugin(GitWorktrees, fixture.config)
    const started = await spawn(ctx, lead, 'worker')
    const worktree = started.member.worktree!
    expect(worktree.phase).toBe('ready')
    expect(worktree.cwd).not.toBe(fixture.repository)
    await waitNoAgent(ctx, started.member.id)
    expect((await ctx.sessionPersistence.inspect(started.member.id, SIGNAL)).meta.cwd).toBe(worktree.cwd)
    await ctx.agentTeams.sendMessage(lead, {
      target: 'worker', content: content('follow-up'), delivery: 'wakeup', signal: SIGNAL,
    })
    await waitNoAgent(ctx, started.member.id)
    expect((await ctx.sessionPersistence.inspect(started.member.id, SIGNAL)).meta.cwd).toBe(worktree.cwd)
    await ctx.agentTeams.releaseWorktree(lead, 'worker', SIGNAL)
    expect(ctx.agentTeams.listMembers(lead).find(member => member.name === 'worker')?.worktree?.phase).toBe('released')
    expect((await fixture.git('branch', '--list', worktree.branch)).stdout).toBe('')
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'worker', content: content('late'), delivery: 'wakeup', signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_WORKTREE_UNAVAILABLE' })
  })

  it('records ownership before provisioning and rolls back a cancelled initial spawn', async () => {
    const fixture = await gitFixture((root) => { roots.push(root) })
    const { ctx, lead } = await setup([], { worktreeProvider: 'git' }, fixture.repository)
    const created = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    ctx.agentTeams.registerWorktreeProvider({
      name: 'git',
      resolve: (...args) => fixture.provider.resolve(...args),
      release: (...args) => fixture.provider.release(...args),
      async provision(spec, signal) {
        const event = lead.session.snapshotEvents().find(event => event.type === 'team/worktree')
        expect(event?.data).toMatchObject({ worktree: { phase: 'reserved', cwd: spec.cwd } })
        await fixture.provider.provision(spec, signal)
        created.resolve(undefined)
        await resume.promise
      },
    })
    const abort = new AbortController()
    const spawning = ctx.agentTeams.spawnTeammate(lead, {
      name: 'worker', description: 'worker', prompt: content('work'), context: 'fresh', provider: 'spawn', signal: abort.signal,
    })
    const rejected = expect(spawning).rejects.toThrow('cancelled')
    await created.promise
    abort.abort(new Error('cancelled'))
    resume.resolve(undefined)
    await rejected
    expect(ctx.agentTeams.listMembers(lead).find(member => member.name === 'worker')).toMatchObject({
      status: 'failed', worktree: { phase: 'released' },
    })
    expect(ctx.agents.list()).toHaveLength(1)
  })

  it('removes a provider with its plugin and rejects subsequent worktree creation', async () => {
    const fixture = await gitFixture((root) => { roots.push(root) })
    const { ctx, lead } = await setup([], { worktreeProvider: 'git' }, fixture.repository)
    const fiber = await ctx.plugin(GitWorktrees, fixture.config)
    await fiber.dispose()
    await expect(spawn(ctx, lead, 'worker')).rejects.toMatchObject({ code: 'TEAM_WORKTREE_UNAVAILABLE' })
  })
})


describe('Team durable task batches', () => {
  it('restores a batch after disposing and resuming its Lead Session', async () => {
    const { ctx } = await setup([])
    const first = await ctx.agents.create({
      sessionId: SessionId('durable-batch-lead'), agentOptions: { provider: 'mock', model: 'mock' },
    })
    const task = await ctx.agentTeams.createTask(first.agent, { subject: 'Persistent work', description: 'Survive Lead restoration' })
    const batch = await ctx.agentTeams.createBatch(first.agent, { name: 'Delivery', description: 'Persistent ledger', taskIds: [task.id] })
    await first.dispose()
    const restored = await ctx.agents.resume({
      resumeSessionId: first.agent.id, agentOptions: { provider: 'mock', model: 'mock' },
    })
    try {
      expect(restored.agent).not.toBe(first.agent)
      expect(ctx.agentTeams.listBatches(restored.agent)).toEqual([batch])
      expect(ctx.agentTeams.listTasks(restored.agent)).toMatchObject([{ id: task.id, status: 'pending' }])
    } finally { await restored.dispose() }
  })

  it('retains task membership across service reload and derives completion after reopen', async () => {
    const { ctx, lead, teamFiber } = await setup([])
    const task = await ctx.agentTeams.createTask(lead, { subject: 'work', description: 'work' })
    const batch = await ctx.agentTeams.createBatch(lead, { name: 'delivery', description: 'delivery scope', taskIds: [task.id] })
    await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: 1, action: 'claim' })
    await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: 2, action: 'complete', result: 'verified' })
    expect(ctx.agentTeams.listBatches(lead)).toMatchObject([{ status: 'completed', completedTasks: 1 }])
    await teamFiber.dispose()
    await ctx.plugin(TeamService)
    expect(ctx.agentTeams.listBatches(lead)).toMatchObject([{ id: batch.id, taskIds: [task.id], status: 'completed' }])
    await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: 3, action: 'reopen' })
    expect(ctx.agentTeams.listBatches(lead)).toMatchObject([{ status: 'active', completedTasks: 0 }])
    await expect(ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: 4, action: 'delete' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_IN_BATCH' })
    const archived = await ctx.agentTeams.updateBatch(lead, { batchId: batch.id, expectedRevision: 1, archive: true })
    expect(archived.status).toBe('archived')
    await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: 4, action: 'delete' })
    expect(ctx.agentTeams.listBatches(lead)[0]?.taskIds).toEqual([task.id])
  })

  it('rejects stale and invalid batch mutations without consuming revisions', async () => {
    const { ctx, lead } = await setup([], { maxBatches: 1, maxBatchTextLength: 8 })
    const task = await ctx.agentTeams.createTask(lead, { subject: 'work', description: 'work' })
    for (const taskIds of [[task.id, task.id], [TeamTaskId('missing')]]) {
      await expect(ctx.agentTeams.createBatch(lead, { name: 'batch', description: 'scope', taskIds })).rejects.toThrow()
    }
    await expect(ctx.agentTeams.createBatch(lead, { name: 'too long a name', description: 'scope', taskIds: [] })).rejects.toThrow()
    const batch = await ctx.agentTeams.createBatch(lead, { name: 'batch', description: 'scope', taskIds: [] })
    expect(batch.status).toBe('active')
    await expect(ctx.agentTeams.createBatch(lead, { name: 'other', description: 'scope', taskIds: [] }))
      .rejects.toMatchObject({ code: 'TEAM_BATCH_LIMIT' })
    await expect(ctx.agentTeams.updateBatch(lead, { batchId: batch.id, expectedRevision: 2, name: 'stale' }))
      .rejects.toMatchObject({ code: 'TEAM_BATCH_STALE_REVISION' })
    const updated = await ctx.agentTeams.updateBatch(lead, { batchId: batch.id, expectedRevision: 1, taskIds: [task.id] })
    expect(updated).toMatchObject({ revision: 2, taskIds: [task.id] })
    const archived = await ctx.agentTeams.updateBatch(lead, { batchId: batch.id, expectedRevision: 2, archive: true })
    await expect(ctx.agentTeams.updateBatch(lead, { batchId: batch.id, expectedRevision: archived.revision, name: 'changed' }))
      .rejects.toMatchObject({ code: 'TEAM_BATCH_ARCHIVED' })
    expect((await ctx.agentTeams.createBatch(lead, { name: 'next', description: 'scope', taskIds: [] })).id).not.toBe(batch.id)
  })
})


describe('Team supervisor recovery', () => {
  async function stalledWorker(maxRecoveryAttempts = 1) {
    const harness = await setup([textResponse('initial'), textResponse('recovered')], { maxRecoveryAttempts })
    const started = await spawn(harness.ctx, harness.lead, 'worker')
    await waitNoAgent(harness.ctx, started.member.id)
    const task = await harness.ctx.agentTeams.createTask(harness.lead, { subject: 'unfinished', description: 'unfinished' })
    await harness.ctx.agentTeams.updateTask(harness.lead, {
      taskId: task.id, expectedRevision: 1, action: 'reassign', owner: 'worker',
    })
    return { ...harness, started, task }
  }

  it('coalesces simultaneous recovery and retains its lifetime budget across reload', async () => {
    const { ctx, lead, teamFiber, started, task } = await stalledWorker()
    const request = { target: 'worker', observedEventCount: -1, reason: 'Continue unfinished work.' }
    const outcomes = await Promise.allSettled([
      ctx.agentTeams.recoverTeammate(lead, request, SIGNAL),
      ctx.agentTeams.recoverTeammate(lead, request, SIGNAL),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
    await waitNoAgent(ctx, started.member.id)
    expect(ctx.agentTeams.getTask(lead, task.id)).toMatchObject({ status: 'in_progress', ownerName: 'worker' })
    await teamFiber.dispose()
    await ctx.plugin(TeamService, { maxRecoveryAttempts: 1 })
    await expect(ctx.agentTeams.recoverTeammate(lead, request, SIGNAL)).rejects.toMatchObject({ code: 'TEAM_RECOVERY_LIMIT' })
    expect(ctx.agentTeams.listMembers(lead).find(member => member.name === 'worker')?.recoveryAttempts).toBe(1)
  })

  it('rejects a stale heartbeat observation and skips workers without unfinished tasks', async () => {
    const { ctx, lead, started, task } = await stalledWorker()
    await expect(ctx.agentTeams.recoverTeammate(lead, {
      target: 'worker', observedEventCount: 1, reason: 'Recover',
    }, SIGNAL)).rejects.toMatchObject({ code: 'TEAM_RECOVERY_STALE' })
    await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: 2, action: 'complete', result: 'verified' })
    await expect(ctx.agentTeams.recoverTeammate(lead, {
      target: 'worker', observedEventCount: -1, reason: 'Recover',
    }, SIGNAL)).rejects.toMatchObject({ code: 'TEAM_RECOVERY_NOT_NEEDED' })
    expect(ctx.agentTeams.listMembers(lead).find(member => member.id === started.member.id)?.recoveryAttempts).toBeUndefined()
  })

  it('patrols after the inactivity threshold and stops scheduling on disposal', async () => {
    const { ctx, lead, started } = await stalledWorker()
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const fiber = await ctx.plugin(Supervisor, {
      scanIntervalMs: 100, staleAfterMs: 1_000, recoveryMessage: 'Resume unfinished work.',
    })
    try {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(lead.session.snapshotEvents().filter(event => event.type === 'team/recovery')).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(100)
      await vi.waitFor(() => { expect(lead.session.snapshotEvents().filter(event => event.type === 'team/recovery')).toHaveLength(1) })
      await waitNoAgent(ctx, started.member.id)
    } finally {
      await fiber.dispose()
    }
    await vi.advanceTimersByTimeAsync(10_000)
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/recovery')).toHaveLength(1)
  })

  it('awaits an in-flight patrol and prevents wakeup after disposal', async () => {
    const { ctx, lead } = await stalledWorker()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === lead.session && session.snapshotEvents().at(-1)?.type === 'team/recovery') {
        entered.resolve(undefined)
        await release.promise
      }
      return flush(session)
    })
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const fiber = await ctx.plugin(Supervisor, {
      scanIntervalMs: 100, staleAfterMs: 100, recoveryMessage: 'Resume unfinished work.',
    })
    try {
      await vi.advanceTimersByTimeAsync(200)
      await entered.promise
      const disposing = fiber.dispose()
      release.resolve(undefined)
      await disposing
      expect(lead.session.snapshotEvents().filter(event => event.type === 'team/message/queued')).toHaveLength(0)
    } finally {
      release.resolve(undefined)
      await fiber.dispose()
    }
  })
})

describe('durable Team integration queue', () => {
  async function queuedWorker(pinned = false, realGit = false, reviewGate?: string) {
    const fixture = await gitFixture((root) => { roots.push(root) })
    const { ctx, lead, teamFiber } = await setup([textResponse('ready')], { worktreeProvider: 'git', integrationProvider: 'test', maxIntegrations: 1 }, fixture.repository)
    await ctx.plugin(GitWorktrees, fixture.config)
    const { member } = await spawn(ctx, lead, 'worker')
    await waitNoAgent(ctx, member.id)
    const worktree = ctx.agentTeams.listMembers(lead).find(row => row.id === member.id)!.worktree!
    const provider = {
      name: 'test',
      resolve: vi.fn(async (_worktree: unknown, id: string) => ({
        repository: worktree.repository, cwd: join(fixture.root, id), sourceBranch: worktree.branch,
        sourceCommit: worktree.baseCommit, targetBranch: 'main' as typeof worktree.branch,
        verification: [{ command: 'configured-check', args: [] }],
      })),
      target: vi.fn(async () => worktree.baseCommit),
      verify: vi.fn(async (_spec: TeamIntegrationSpec, _target: TeamCommitId, _signal: AbortSignal) => worktree.baseCommit),
      promote: vi.fn(async (_spec: TeamIntegrationSpec, _target: TeamCommitId, _candidate: TeamCommitId, _signal: AbortSignal) => {}),
    }
    if (realGit) {
      await writeFile(join(worktree.cwd, 'worker.txt'), 'submitted')
      await execa('git', ['-C', worktree.cwd, 'add', 'worker.txt'])
      await execa('git', ['-C', worktree.cwd, 'commit', '-m', 'worker artifact'])
      const gitProvider = new GitIntegrationProvider({ providerName: 'test', targetBranch: 'main',
        verification: [{ command: process.execPath, args: ['-e', "if(require('node:fs').readFileSync('worker.txt','utf8')!=='submitted')process.exit(1)"] }],
        commandTimeoutMs: 30_000, verificationTimeoutMs: 30_000 })
      provider.resolve.mockImplementation(async (_workspace, id) => await gitProvider.resolve(worktree, id as TeamIntegrationId, SIGNAL))
      provider.target.mockImplementation(async () => await gitProvider.target({ ...worktree, sourceBranch: worktree.branch, sourceCommit: worktree.baseCommit, targetBranch: 'main' as typeof worktree.branch, verification: [] }, SIGNAL))
      provider.verify.mockImplementation(async (spec, target, signal) => await gitProvider.verify(spec, target, signal))
      provider.promote.mockImplementation(async (spec, target, candidate, signal) => {
        await gitProvider.promote(spec, target, candidate, signal)
      })
    }
    ctx.agentTeams.registerIntegrationProvider(provider)
    const sourceCommit = realGit ? (await execa('git', ['-C', worktree.cwd, 'rev-parse', 'HEAD'])).stdout as TeamCommitId : worktree.baseCommit
    const admission = { id: 'submission-job' as TeamIntegrationId, repository: worktree.repository, sourceCommit, targetBranch: 'main' as typeof worktree.branch,
      verification: realGit ? [{ command: process.execPath, args: ['-e', "if(require('node:fs').readFileSync('worker.txt','utf8')!=='submitted')process.exit(1)"] }] : [{ command: 'configured-check', args: [] }],
      ...(reviewGate === undefined ? {} : { reviewGate }) }
    const job = pinned ? await ctx.agentTeams.enqueuePinnedIntegration(lead, 'worker', admission, SIGNAL) : await ctx.agentTeams.enqueueIntegration(lead, 'worker', SIGNAL)
    return { ctx, lead, teamFiber, provider, job, admission, fixture, worktree }
  }

  it('leaves the job queued when another owner holds its canonical repository target', async () => {
    const { ctx, lead, provider, job } = await queuedWorker()
    const release = await acquireIntegrationOwnership(job.repository, job.targetBranch, SIGNAL)
    try {
      await expect(ctx.agentTeams.runIntegration(lead, SIGNAL)).rejects.toMatchObject({ code: 'TEAM_INTEGRATION_BUSY' })
      expect(ctx.agentTeams.listIntegrations(lead)[0]!.phase).toBe('queued')
      expect(provider.verify).not.toHaveBeenCalled()
      await release()
      expect(await ctx.agentTeams.runIntegration(lead, SIGNAL)).toMatchObject({ phase: 'merged' })
      expect(provider.verify).toHaveBeenCalledTimes(1)
    } finally { await release(); await teamInternals(ctx).disposeRuntime() }
  })

  it('replays one pinned integration through concurrent calls, full capacity, and service reconstruction', async () => {
    const { ctx, lead, teamFiber, provider, job, admission } = await queuedWorker(true)
    const duplicates = await Promise.all([1, 2].map(() => ctx.agentTeams.enqueuePinnedIntegration(lead, 'worker', admission, SIGNAL)))
    expect(duplicates).toEqual([job, job])
    expect(provider.resolve).toHaveBeenCalledTimes(1)
    expect(ctx.agentTeams.listIntegrations(lead)).toHaveLength(1)
    await teamFiber.dispose()
    await ctx.plugin(TeamService, { integrationProvider: 'test', maxIntegrations: 1 })
    ctx.agentTeams.registerIntegrationProvider(provider)
    try {
      expect(await ctx.agentTeams.enqueuePinnedIntegration(lead, 'worker', admission, SIGNAL)).toEqual(job)
      expect(await ctx.agentTeams.runIntegration(lead, SIGNAL)).toMatchObject({ phase: 'merged' })
      expect(await ctx.agentTeams.enqueuePinnedIntegration(lead, 'worker', admission, SIGNAL)).toMatchObject({ id: job.id, phase: 'merged' })
      expect(provider.resolve).toHaveBeenCalledTimes(1)
    } finally { await teamInternals(ctx).disposeRuntime() }
  })

  it('does not acknowledge replay of a pinned integration while its durability checkpoint fails', async () => {
    const { ctx, lead, admission } = await queuedWorker(true)
    const flush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('checkpoint failed'))
    try {
      await expect(ctx.agentTeams.enqueuePinnedIntegration(lead, 'worker', admission, SIGNAL)).rejects.toThrow('checkpoint failed')
      flush.mockRestore()
      expect(await ctx.agentTeams.enqueuePinnedIntegration(lead, 'worker', admission, SIGNAL)).toMatchObject({ id: admission.id })
      expect(ctx.agentTeams.listIntegrations(lead)).toHaveLength(1)
    } finally { flush.mockRestore(); await teamInternals(ctx).disposeRuntime() }
  })

  it('rejects reused identity and changed commit or verification policy without queue admission', async () => {
    const { ctx, lead, provider, admission } = await queuedWorker(true)
    try {
      await expect(ctx.agentTeams.enqueuePinnedIntegration(lead, 'worker', { ...admission, verification: [{ command: 'different-check', args: [] }] }, SIGNAL)).rejects.toMatchObject({ code: 'TEAM_INTEGRATION_CONFLICT' })
      await ctx.agentTeams.runIntegration(lead, SIGNAL)
      for (const patch of [
        { sourceCommit: 'a'.repeat(40) as TeamCommitId },
        { targetBranch: 'other' as typeof admission.targetBranch },
        { verification: [{ command: 'different-check', args: [] }] },
        { repository: '/another-repository' },
      ]) await expect(ctx.agentTeams.enqueuePinnedIntegration(lead, 'worker', { ...admission, id: 'new-submission' as TeamIntegrationId, ...patch }, SIGNAL)).rejects.toMatchObject({ code: 'TEAM_INTEGRATION_CONFLICT' })
      await expect(ctx.agentTeams.enqueuePinnedIntegration(lead, 'worker', { ...admission, id: '../escape' as TeamIntegrationId }, SIGNAL)).rejects.toThrow()
      expect(ctx.agentTeams.listIntegrations(lead)).toHaveLength(1)
      expect(provider.promote).toHaveBeenCalledTimes(1)
    } finally { await teamInternals(ctx).disposeRuntime() }
  })

  it('aborts in-flight background verification and retains its failed queue record on disposal', async () => {
    const { ctx, lead, provider } = await queuedWorker()
    const entered = Promise.withResolvers<undefined>()
    provider.verify.mockImplementationOnce(async (_spec, _target, signal) => {
      entered.resolve(undefined)
      return await new Promise<TeamCommitId>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('verification cancelled', { cause: signal.reason })) }, { once: true })
      })
    })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const fiber = await ctx.plugin(IntegrationWorker, { scanIntervalMs: 100 })
    try {
      await vi.advanceTimersByTimeAsync(100)
      await entered.promise
      await fiber.dispose()
      expect(ctx.agentTeams.listIntegrations(lead)[0]?.phase).toBe('failed')
      expect(provider.promote).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(provider.verify).toHaveBeenCalledTimes(1)
    } finally {
      await fiber.dispose()
      await teamInternals(ctx).disposeRuntime()
    }
  })

  it('persists each verification phase and enforces queue capacity', async () => {
    const { ctx, lead, provider } = await queuedWorker()
    try {
      await expect(ctx.agentTeams.enqueueIntegration(lead, 'worker', SIGNAL)).rejects.toMatchObject({ code: 'TEAM_INTEGRATION_LIMIT' })
      provider.verify.mockImplementationOnce(async () => {
        expect(ctx.agentTeams.listIntegrations(lead)[0]?.phase).toBe('running')
        return await provider.target()
      })
      provider.promote.mockImplementationOnce(async () => {
        expect(ctx.agentTeams.listIntegrations(lead)[0]?.phase).toBe('verified')
      })
      expect(await ctx.agentTeams.runIntegration(lead, SIGNAL)).toMatchObject({ phase: 'merged' })
      expect(await ctx.agentTeams.runIntegration(lead, SIGNAL)).toBeUndefined()
      expect(lead.session.snapshotEvents().filter(event => event.type === 'team/integration').map(event => event.data.integration.phase))
        .toEqual(['queued', 'running', 'verified', 'merged'])
    } finally { await teamInternals(ctx).disposeRuntime() }
  })

  it('keeps a gated real Git candidate off the target until an exact policy-authorized review receipt is durable', async () => {
    const { ctx, lead, provider, job, fixture } = await queuedWorker(true, true, 'implementation-review')
    try {
      const verified = await ctx.agentTeams.runIntegration(lead, SIGNAL)
      expect(verified).toMatchObject({ phase: 'verified', reviewGate: 'implementation-review' })
      await expect(readFile(join(fixture.repository, 'worker.txt'), 'utf8')).rejects.toThrow()
      expect(provider.promote).not.toHaveBeenCalled()
      const receipt = { integrationId: job.id, sourceCommit: job.sourceCommit, targetCommit: verified!.targetCommit!,
        candidateCommit: verified!.candidateCommit!, reviewGate: 'implementation-review', reviewId: 'accepted-review-1' }
      await expect(ctx.agentTeams.approvePinnedIntegration(lead, receipt, SIGNAL)).rejects.toMatchObject({ code: 'TEAM_INTEGRATION_REVIEW_DENIED' })
      const removePolicy = ctx.agentTeams.registerExecutionPolicy({
        taskMutation: () => {}, wake: () => {}, integrationApproval: (_root, request) => request.reviewId === 'accepted-review-1',
      })
      try {
        await expect(ctx.agentTeams.approvePinnedIntegration(lead, { ...receipt, candidateCommit: 'a'.repeat(40) as TeamCommitId }, SIGNAL))
          .rejects.toMatchObject({ code: 'TEAM_INTEGRATION_CONFLICT' })
        expect(await ctx.agentTeams.approvePinnedIntegration(lead, receipt, SIGNAL)).toMatchObject({ reviewReceipt: receipt })
        expect(await ctx.agentTeams.runIntegration(lead, SIGNAL)).toMatchObject({ phase: 'merged', reviewReceipt: receipt })
        expect(await readFile(join(fixture.repository, 'worker.txt'), 'utf8')).toBe('submitted')
      } finally { removePolicy() }
    } finally { await teamInternals(ctx).disposeRuntime() }
  })

  it('invalidates a gated receipt on stale-target re-verification and retains it with the prior candidate', async () => {
    const { ctx, lead, provider, job } = await queuedWorker(true, false, 'implementation-review')
    const target2 = 'b'.repeat(40) as TeamCommitId
    const candidate2 = 'c'.repeat(40) as TeamCommitId
    const removePolicy = ctx.agentTeams.registerExecutionPolicy({ taskMutation: () => {}, wake: () => {}, integrationApproval: () => true })
    try {
      const first = await ctx.agentTeams.runIntegration(lead, SIGNAL)
      const firstReceipt = { integrationId: job.id, sourceCommit: job.sourceCommit, targetCommit: first!.targetCommit!,
        candidateCommit: first!.candidateCommit!, reviewGate: 'implementation-review', reviewId: 'accepted-review-1' }
      await ctx.agentTeams.approvePinnedIntegration(lead, firstReceipt, SIGNAL)
      provider.promote.mockRejectedValueOnce(new TeamError('target moved', 'TEAM_INTEGRATION_STALE'))
      expect(await ctx.agentTeams.runIntegration(lead, SIGNAL)).toMatchObject({ phase: 'queued',
        previousCandidates: [{ reviewReceipt: firstReceipt }] })
      provider.target.mockResolvedValueOnce(target2)
      provider.verify.mockResolvedValueOnce(candidate2)
      const second = await ctx.agentTeams.runIntegration(lead, SIGNAL)
      expect(second).toMatchObject({ phase: 'verified', targetCommit: target2, candidateCommit: candidate2 })
      expect(second!.reviewReceipt).toBeUndefined()
      await expect(ctx.agentTeams.approvePinnedIntegration(lead, firstReceipt, SIGNAL)).rejects.toMatchObject({ code: 'TEAM_INTEGRATION_CONFLICT' })
      expect(await ctx.agentTeams.runIntegration(lead, SIGNAL)).toMatchObject({ phase: 'verified' })
      const secondReceipt = { ...firstReceipt, targetCommit: target2, candidateCommit: candidate2, reviewId: 'accepted-review-2' }
      await ctx.agentTeams.approvePinnedIntegration(lead, secondReceipt, SIGNAL)
      expect(await ctx.agentTeams.runIntegration(lead, SIGNAL)).toMatchObject({ phase: 'merged', reviewReceipt: secondReceipt })
    } finally { removePolicy(); await teamInternals(ctx).disposeRuntime() }
  })

  it('replays an appended gated approval after its flush fails and after service reconstruction', async () => {
    const { ctx, lead, provider, job, teamFiber } = await queuedWorker(true, false, 'implementation-review')
    const removePolicy = ctx.agentTeams.registerExecutionPolicy({ taskMutation: () => {}, wake: () => {}, integrationApproval: () => true })
    const persistedFlush = ctx.sessions.flush.bind(ctx.sessions)
    let failReceiptFlush = true
    const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async session => {
      if (session === lead.session && ctx.agentTeams.listIntegrations(lead)[0]?.reviewReceipt !== undefined && failReceiptFlush) {
        failReceiptFlush = false
        throw new Error('review receipt checkpoint failed')
      }
      return await persistedFlush(session)
    })
    try {
      const verified = await ctx.agentTeams.runIntegration(lead, SIGNAL)
      const receipt = { integrationId: job.id, sourceCommit: job.sourceCommit, targetCommit: verified!.targetCommit!,
        candidateCommit: verified!.candidateCommit!, reviewGate: 'implementation-review', reviewId: 'accepted-review-1' }
      await expect(ctx.agentTeams.approvePinnedIntegration(lead, receipt, SIGNAL)).rejects.toThrow('review receipt checkpoint failed')
      flush.mockRestore()
      expect(await ctx.agentTeams.approvePinnedIntegration(lead, receipt, SIGNAL)).toMatchObject({ reviewReceipt: receipt })
      await teamFiber.dispose()
      await ctx.plugin(TeamService, { integrationProvider: 'test' })
      ctx.agentTeams.registerIntegrationProvider(provider)
      expect(await ctx.agentTeams.approvePinnedIntegration(lead, receipt, SIGNAL)).toMatchObject({ reviewReceipt: receipt })
      expect(await ctx.agentTeams.runIntegration(lead, SIGNAL)).toMatchObject({ phase: 'merged', reviewReceipt: receipt })
    } finally { flush.mockRestore(); removePolicy(); await teamInternals(ctx).disposeRuntime() }
  })

  it('does not let the generic integration worker bypass a gated verified candidate', async () => {
    const { ctx, lead, provider } = await queuedWorker(true, false, 'implementation-review')
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const fiber = await ctx.plugin(IntegrationWorker, { scanIntervalMs: 10 })
    try {
      await vi.advanceTimersByTimeAsync(10)
      await vi.waitFor(() => { expect(ctx.agentTeams.listIntegrations(lead)[0]).toMatchObject({ phase: 'verified' }) })
      await vi.advanceTimersByTimeAsync(50)
      expect(provider.promote).not.toHaveBeenCalled()
    } finally { await fiber.dispose(); await teamInternals(ctx).disposeRuntime() }
  })

  it('refuses promotion until an appended verified candidate is flushed successfully', async () => {
    const { ctx, lead, provider } = await queuedWorker()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    let failures = 2
    const spy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === lead.session && ctx.agentTeams.listIntegrations(lead)[0]?.phase === 'verified' && failures-- > 0) {
        throw new Error('verified checkpoint unavailable')
      }
      return await flush(session)
    })
    try {
      await expect(ctx.agentTeams.runIntegration(lead, SIGNAL)).rejects.toThrow('checkpoint unavailable')
      await expect(ctx.agentTeams.runIntegration(lead, SIGNAL)).rejects.toThrow('checkpoint unavailable')
      expect(provider.promote).not.toHaveBeenCalled()
      spy.mockRestore()
      expect(await ctx.agentTeams.runIntegration(lead, SIGNAL)).toMatchObject({ phase: 'merged' })
      expect(provider.verify).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
      await teamInternals(ctx).disposeRuntime()
    }
  })

  it('marks interrupted verification failed without rerunning the retained candidate checkout', async () => {
    const { ctx, lead, provider, job, teamFiber } = await queuedWorker()
    lead.session.append('team/integration', {
      version: 1, teamId: TeamId(lead.id), integration: { ...job, phase: 'running', targetCommit: job.sourceCommit },
    })
    await ctx.sessions.flush(lead.session)
    await teamFiber.dispose()
    await ctx.plugin(TeamService, { integrationProvider: 'test' })
    ctx.agentTeams.registerIntegrationProvider(provider)
    try {
      expect(await ctx.agentTeams.runIntegration(lead, SIGNAL)).toMatchObject({ phase: 'failed', cwd: job.cwd })
      expect(provider.verify).not.toHaveBeenCalled()
      expect(provider.promote).not.toHaveBeenCalled()
    } finally { await teamInternals(ctx).disposeRuntime() }
  })

  it('recovers a verified promotion after service reload without repeating verification', async () => {
    const { ctx, lead, provider, teamFiber } = await queuedWorker()
    try {
      provider.promote.mockRejectedValueOnce(new Error('promotion acknowledgement lost'))
      await expect(ctx.agentTeams.runIntegration(lead, SIGNAL)).rejects.toThrow('acknowledgement lost')
      expect(ctx.agentTeams.listIntegrations(lead)[0]?.phase).toBe('verified')
      await teamFiber.dispose()
      await ctx.plugin(TeamService, { integrationProvider: 'test' })
      ctx.agentTeams.registerIntegrationProvider(provider)
      expect(await ctx.agentTeams.runIntegration(lead, SIGNAL)).toMatchObject({ phase: 'merged' })
      expect(provider.verify).toHaveBeenCalledTimes(1)
      expect(provider.promote).toHaveBeenCalledTimes(2)
    } finally { await teamInternals(ctx).disposeRuntime() }
  })

  it('rebuilds against a real moved Git target and preserves old candidate output and source', async () => {
    const { ctx, lead, provider, job, fixture, worktree } = await queuedWorker(false, true)
    const verify = provider.verify.getMockImplementation()!
    provider.verify.mockImplementationOnce(async (spec, target, signal) => {
      const candidate = await verify(spec, target, signal)
      await writeFile(join(fixture.repository, 'external.txt'), 'target advanced')
      await fixture.git('add', 'external.txt')
      await fixture.git('commit', '-m', 'external target movement')
      await writeFile(join(spec.cwd, 'retained.txt'), 'untracked evidence')
      await writeFile(join(spec.cwd, '.gitignore'), 'ignored.txt\n')
      await writeFile(join(spec.cwd, 'ignored.txt'), 'ignored evidence')
      return candidate
    })
    try {
      const retry = await ctx.agentTeams.runIntegration(lead, SIGNAL)
      expect(retry).toMatchObject({ phase: 'queued', id: job.id })
      await writeFile(join(worktree.cwd, 'worker.txt'), 'later source')
      await execa('git', ['-C', worktree.cwd, 'commit', '-am', 'later source'])
      const merged = await ctx.agentTeams.runIntegration(lead, SIGNAL)
      expect(merged).toMatchObject({ phase: 'merged', id: job.id, sourceCommit: job.sourceCommit })
      expect(await readFile(join(fixture.repository, 'worker.txt'), 'utf8')).toBe('submitted')
      expect(await readFile(join(fixture.repository, 'external.txt'), 'utf8')).toBe('target advanced')
      expect(await readFile(join(job.cwd, 'retained.txt'), 'utf8')).toBe('untracked evidence')
      expect(await readFile(join(job.cwd, 'ignored.txt'), 'utf8')).toBe('ignored evidence')
      expect(provider.verify).toHaveBeenCalledTimes(2)
    } finally { await teamInternals(ctx).disposeRuntime() }
  })

  it('reverifies moved targets with bounded durable candidate history and pinned inputs', async () => {
    const { ctx, lead, provider, job, teamFiber } = await queuedWorker(true)
    provider.promote.mockRejectedValue(new TeamError('target moved', 'TEAM_INTEGRATION_STALE'))
    try {
      const retry = await ctx.agentTeams.runIntegration(lead, SIGNAL)
      expect(retry).toMatchObject({ id: job.id, phase: 'queued', sourceCommit: job.sourceCommit,
        previousCandidates: [{ cwd: job.cwd, targetCommit: job.sourceCommit, candidateCommit: job.sourceCommit, error: 'target moved' }] })
      expect(retry!.cwd).not.toBe(job.cwd)
      await teamFiber.dispose()
      await ctx.plugin(TeamService, { integrationProvider: 'test' })
      ctx.agentTeams.registerIntegrationProvider(provider)
      for (let round = 0; round < 3; round++) await ctx.agentTeams.runIntegration(lead, SIGNAL)
      const failed = ctx.agentTeams.listIntegrations(lead)[0]!
      expect(failed).toMatchObject({ id: job.id, phase: 'failed', sourceCommit: job.sourceCommit })
      expect(failed.error).toContain('retry limit')
      expect(provider.verify).toHaveBeenCalledTimes(4)
      expect(new Set(provider.verify.mock.calls.map(([spec]) => spec.cwd)).size).toBe(4)
      expect(provider.verify.mock.calls.every(([spec]) => spec.sourceCommit === job.sourceCommit)).toBe(true)
      expect(await ctx.agentTeams.runIntegration(lead, SIGNAL)).toBeUndefined()
    } finally { await teamInternals(ctx).disposeRuntime() }
  })

  it('retains failed verification and allows explicit abandonment of blocked promotion', async () => {
    const { ctx, lead, provider, job } = await queuedWorker()
    try {
      provider.promote.mockRejectedValueOnce(new Error('target moved'))
      await expect(ctx.agentTeams.runIntegration(lead, SIGNAL)).rejects.toThrow('target moved')
      expect(await ctx.agentTeams.abandonIntegration(lead, job.id, 'Reverify the new target', SIGNAL)).toMatchObject({ phase: 'failed', candidateCommit: job.sourceCommit })
      await ctx.agentTeams.enqueueIntegration(lead, 'worker', SIGNAL)
      provider.verify.mockRejectedValueOnce(new Error('verification failed'))
      expect(await ctx.agentTeams.runIntegration(lead, SIGNAL)).toMatchObject({ phase: 'failed', error: 'verification failed' })
    } finally { await teamInternals(ctx).disposeRuntime() }
  })
})
