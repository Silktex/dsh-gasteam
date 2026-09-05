import { afterEach, expect, it } from 'vitest'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter } from '../../../tests/support/mock-adapter.ts'
import TeamService from '../src/index.ts'
import { AssignmentStore, type AttemptRecord } from '../src/assignments.ts'
import { HealthRecoveryExecutor, HealthRecoveryStore } from '../src/health-recovery.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const content = (text: string) => [{ type: 'text' as const, text }]
const token = (record: AttemptRecord) => ({ attemptId: record.attemptId, generation: record.generation, expectedRevision: record.revision })

async function fixture(): Promise<{ ctx: Context; lead: Agent; root: string }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const root = await mkdtemp(join(tmpdir(), 'gasteam-health-recovery-real-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TeamService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  const lead = ctx.agentLoop.create(SessionId('health-lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead, root }
}

it('reopens an assignment recovery after a post-delivery crash without duplicating its Team message', async () => {
  const { ctx, lead, root } = await fixture()
  const teammate = await ctx.agentTeams.spawnTeammate(lead, {
    name: 'health-worker', description: 'retain a queued recovery nudge', prompt: content('wait for recovery'),
    context: 'fresh', provider: 'spawn', signal: new AbortController().signal,
  })
  const task = await ctx.agentTeams.createTask(lead, { subject: 'Recover health', description: 'keep exact assignment ownership' })
  const assignmentDirectory = join(root, 'assignments')
  let assignments = await AssignmentStore.open(assignmentDirectory, { globalCapacity: 1, projectCapacities: { project: 1 } })
  let active = await assignments.reserve({
    projectId: 'project', teamId: lead.id, taskId: task.id, workerId: 'health-worker', runtimeId: teammate.member.id,
    provider: 'spawn', expectedGeneration: 0,
    checkpoint: { task: { subject: task.subject, description: task.description }, step: 'implement', artifacts: [], nextAction: 'Wait for health recovery' },
  })
  active = await assignments.activate(token(active))
  const recoveryDirectory = join(root, 'health')
  let recovery = await HealthRecoveryStore.open(recoveryDirectory)
  let deliveries = 0
  let crashAfterDelivery = true
  const capabilities = () => ({
    current: async ({ attemptId, generation }: { attemptId: string; generation: number }) => {
      const record = assignments.list().find(candidate => candidate.attemptId === attemptId)
      // This is the authoritative health/operator acknowledgement, not mailbox
      // delivery acknowledgement. The latter is intentionally replayed through
      // TeamService's reserved message identity after the simulated crash.
      const acknowledged = false
      return {
        attemptId: record?.attemptId ?? 'missing', generation: record?.generation ?? 0,
        healthRevision: 1, condition: 'stale' as const,
        actionable: record?.phase === 'active' && ctx.agents.get(SessionId(record.runtimeId)) !== undefined,
        acknowledged, assignmentRevision: record?.revision ?? 0, observedSequence: 1, active: record?.phase === 'active',
      }
    },
    reserve: async ({ attemptId, generation, assignmentRevision, observedSequence, notBefore, messageId }: { attemptId: string; generation: number; assignmentRevision: number; observedSequence: number; notBefore: number; messageId: string }) => {
      await assignments.recoverHealth({ attemptId, generation, expectedRevision: assignmentRevision }, observedSequence, notBefore, messageId)
    },
    deliver: async ({ attemptId, generation, messageId }: { attemptId: string; generation: number; messageId: string }) => {
      const record = assignments.list().find(candidate => candidate.attemptId === attemptId && candidate.generation === generation)
      if (record === undefined) throw new Error('assignment disappeared')
      deliveries++
      const receipt = await ctx.agentTeams.sendReservedMessage(lead, {
        target: 'health-worker', delivery: 'quiet', content: content('Durable recovery nudge'), signal: new AbortController().signal,
      }, messageId)
      if (crashAfterDelivery) throw new Error('simulated crash after Team delivery')
      return receipt.messageId
    },
  })
  const input = { attemptId: active.attemptId, generation: active.generation, healthRevision: 1, condition: 'stale' as const, maxNudges: 1 }
  await expect(new HealthRecoveryExecutor(recovery, capabilities()).nudge(input)).rejects.toThrow('simulated crash')
  const messageId = recovery.list()[0]!.messageId
  expect(assignments.list()[0]!.healthRecovery).toMatchObject({ count: 1, messageId })
  expect(assignments.list()[0]!.recovery).toBeUndefined()
  expect(lead.session.snapshotEvents().filter(event => event.type === 'team/message/queued' && event.data.message.id === messageId)).toHaveLength(1)

  await assignments.close(); await recovery.close()
  assignments = await AssignmentStore.open(assignmentDirectory, { globalCapacity: 1, projectCapacities: { project: 1 } })
  recovery = await HealthRecoveryStore.open(recoveryDirectory)
  crashAfterDelivery = false
  const completed = await new HealthRecoveryExecutor(recovery, capabilities()).nudge(input)
  expect(completed).toMatchObject({ phase: 'receipt', messageId })
  expect(deliveries).toBe(2)
  expect(assignments.list()).toHaveLength(1)
  expect(assignments.list()[0]!.healthRecovery).toMatchObject({ count: 1, messageId })
  expect(assignments.list()[0]!.recovery).toBeUndefined()
  expect(lead.session.snapshotEvents().filter(event => event.type === 'team/message/queued' && event.data.message.id === messageId)).toHaveLength(1)
  await assignments.close(); await recovery.close()
})

it('upgrades a pending published health ledger recovery without duplicating its already delivered Team mailbox message', async () => {
  const { ctx, lead, root } = await fixture()
  const teammate = await ctx.agentTeams.spawnTeammate(lead, { name: 'upgrade-worker', description: 'published M6 worker', prompt: content('wait'), context: 'fresh', provider: 'spawn', signal: new AbortController().signal })
  const task = await ctx.agentTeams.createTask(lead, { subject: 'Upgrade health', description: 'preserve durable delivery identity' })
  const recoveryDirectory = join(root, 'pending-health')
  const recovery = await HealthRecoveryStore.open(recoveryDirectory)
  const intent = await recovery.intent({ attemptId: 'attempt-1', generation: 1, healthRevision: 7, condition: 'stale', maxNudges: 2 })
  await recovery.revalidate({ attemptId: 'attempt-1', generation: 1, healthRevision: 7, condition: 'stale' })
  await recovery.request({ attemptId: 'attempt-1', generation: 1, healthRevision: 7, condition: 'stale' })
  const assignmentDirectory = join(root, 'published-assignments')
  const legacyEvents = [
    { version: 1, sequence: 1, type: 'assignment/reserved', request: { projectId: 'project', teamId: lead.id, taskId: task.id, workerId: 'upgrade-worker', runtimeId: teammate.member.id, provider: 'spawn', expectedGeneration: 0, checkpoint: { task: { subject: task.subject, description: task.description }, step: 'implement', artifacts: [], nextAction: 'resume' } } },
    { version: 1, sequence: 2, type: 'attempt/activated', token: { attemptId: 'attempt-1', generation: 1, expectedRevision: 1 } },
    { version: 1, sequence: 3, type: 'attempt/recovery', token: { attemptId: 'attempt-1', generation: 1, expectedRevision: 2 }, observedSequence: 11, notBefore: 12, messageId: intent.messageId },
  ]
  await appendFile(join(assignmentDirectory, '..', 'published-assignments', 'assignments.jsonl'), legacyEvents.map(event => JSON.stringify(event)).join('\n') + '\n').catch(async () => {
    // AssignmentStore normally creates this directory; create its journal first without adding evidence.
    const bootstrap = await AssignmentStore.open(assignmentDirectory, { globalCapacity: 1, projectCapacities: { project: 1 } }); await bootstrap.close()
    await appendFile(join(assignmentDirectory, 'assignments.jsonl'), legacyEvents.map(event => JSON.stringify(event)).join('\n') + '\n')
  })
  const old = await ctx.agentTeams.sendReservedMessage(lead, { target: 'upgrade-worker', delivery: 'quiet', content: content('Published health nudge'), signal: new AbortController().signal }, intent.messageId)
  let assignments = await AssignmentStore.open(assignmentDirectory, { globalCapacity: 1, projectCapacities: { project: 1 } })
  await assignments.attributeLegacyHealthRecoveries(recovery.list())
  const attributed = assignments.list()[0]!
  expect(attributed).toMatchObject({ healthRecovery: { count: 1, messageId: intent.messageId } })
  await assignments.recoverHealth(token(attributed), 11, 12, intent.messageId)
  const replay = await ctx.agentTeams.sendReservedMessage(lead, { target: 'upgrade-worker', delivery: 'quiet', content: content('Published health nudge'), signal: new AbortController().signal }, intent.messageId)
  expect(replay.messageId).toBe(old.messageId)
  expect(lead.session.snapshotEvents().filter(event => event.type === 'team/message/queued' && event.data.message.id === intent.messageId)).toHaveLength(1)
  await assignments.close(); await recovery.close()
})
