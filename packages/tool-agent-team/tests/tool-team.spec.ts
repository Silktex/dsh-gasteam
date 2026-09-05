import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../../tests/support/mock-adapter.ts'
import TeamService from '../../agent-team/src/index.ts'
import { gitFixture } from '../../agent-team/tests/git-fixture.ts'
import * as GitWorktrees from '../../agent-team/src/git-worktrees.ts'
import * as GitIntegration from '../../agent-team/src/git-integration.ts'
import * as toolTeam from '../src/index.ts'
import * as coordinatorTools from '../src/coordinator.ts'

const SIGNAL = new AbortController().signal
const TOOL_NAMES = [
  'spawn_teammate',
  'send_message',
  'followup_task',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  'team_batch_create',
  'team_batch_list',
  'team_batch_update',
].sort()

const roots: string[] = []
let callNumber = 0

/** Session query implementation whose search faces are outside these tests. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(
  script: ConstructorParameters<typeof MockAdapter>[0], legacyControl = false,
  serviceConfig: ConstructorParameters<typeof TeamService>[1] = {}, cwd?: string,
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-tool-team-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  if (legacyControl) await ctx.plugin(ToolSubagentControl)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TeamService, serviceConfig)
  const fiber = await ctx.plugin(toolTeam)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(SessionId('tool-team-lead'), { provider: 'mock', model: 'mock' }, cwd === undefined ? {} : { cwd })
  return { ctx, lead, fiber }
}

function execute(
  ctx: Context,
  agent: Agent | undefined,
  name: string,
  args: unknown,
  signal: AbortSignal = SIGNAL,
) {
  return ctx.tools.execute({
    callId: ToolCallId(`team-call-${++callNumber}`),
    name,
    arguments: args,
    signal,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function spawnedChildId(result: Awaited<ReturnType<typeof execute>>): SessionId {
  const parsed: unknown = JSON.parse(text(result))
  if (typeof parsed !== 'object' || parsed === null || !('member' in parsed)) {
    throw new Error('spawn_teammate result has no member')
  }
  const member = parsed.member
  if (typeof member !== 'object' || member === null || !('id' in member) || typeof member.id !== 'string') {
    throw new Error('spawn_teammate result has no member id')
  }
  return SessionId(member.id)
}

async function assembly(ctx: Context, agent: Agent) {
  const scope = scopeOf(agent.ctx)
  if (scope === undefined) throw new Error('expected Agent scope')
  return ctx.systemPrompt.assemble({ scope })
}

async function waitRunning(ctx: Context, id: SessionId): Promise<Agent> {
  return vi.waitFor(() => {
    const child = ctx.agents.get(id)
    expect(child?.status).toBe('running')
    return child!
  }, { timeout: 5_000 })
}

async function waitNoAgent(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 5_000 })
}

describe('dsh-tool-team', () => {
  it('selects only the built-in code workflow through the coordinator tool while preserving report workflow calls', async () => {
    const { ctx, lead } = await setup([])
    const requests: unknown[] = []
    const coordinator = {
      async createWorkflow(_caller: Agent, request: { projectId: string; teamId: string; templateId: string; templateVersion: number; parameters: Record<string, string>; executionId?: string }) {
        requests.push(request)
        return { executionId: request.executionId ?? 'generated', projectId: request.projectId, teamId: request.teamId,
          templateId: request.templateId, templateVersion: request.templateVersion, steps: [{ stepId: request.templateId === 'implementation-test-review-integration' ? 'implement' : 'investigate', phase: 'pending' as const, revision: 0, attempts: 0 }] }
      },
    }
    ctx.provide('workspaceCoordinator', coordinator as never)
    const tools = await ctx.plugin(coordinatorTools)
    try {
      const code = await execute(ctx, lead, 'team_workflow_create', {
        project_id: 'project', workflow_kind: 'implementation-test-review-integration', subject: 'Add the code path', execution_id: 'tool-code',
      })
      expect(code.isError, text(code)).not.toBe(true)
      expect(JSON.parse(text(code))).toMatchObject({ executionId: 'tool-code', templateId: 'implementation-test-review-integration', steps: [{ stepId: 'implement' }] })
      const report = await execute(ctx, lead, 'team_workflow_create', { project_id: 'project', question: 'Why did it fail?', execution_id: 'tool-report' })
      expect(report.isError).not.toBe(true)
      expect(JSON.parse(text(report))).toMatchObject({ executionId: 'tool-report', templateId: 'investigation-report' })
      expect(requests).toEqual([
        { projectId: 'project', teamId: lead.id, templateId: 'implementation-test-review-integration', templateVersion: 1, parameters: { subject: 'Add the code path' }, executionId: 'tool-code' },
        { projectId: 'project', teamId: lead.id, templateId: 'investigation-report', templateVersion: 1, parameters: { question: 'Why did it fail?' }, executionId: 'tool-report' },
      ])
      const missingSubject = await execute(ctx, lead, 'team_workflow_create', { project_id: 'project', workflow_kind: 'implementation-test-review-integration' })
      expect(missingSubject.isError).toBe(true)
      expect(text(missingSubject)).toContain('requires subject')
    } finally { await tools.dispose() }
  })

  it('renders actionable bounded workspace-batch item and history transcripts', async () => {
    const { ctx, lead } = await setup([])
    const batch = {
      id: 'batch-view', name: 'cross-project release', phase: 'blocked' as const, completionEpoch: 1, completedRequired: 1, required: 2,
      readyWithoutActiveAssignment: [],
      items: [{ ref: { projectId: 'project-a', teamId: 'team-a', taskId: 'first' }, state: 'accepted' as const, activeAssignment: false, dependsOn: [], history: [{ state: 'accepted' as const, activeAssignment: false, at: 10 }] },
        { ref: { projectId: 'project-b', teamId: 'team-b', taskId: 'second' }, state: 'blocked' as const, activeAssignment: false, dependsOn: [{ projectId: 'project-a', teamId: 'team-a', taskId: 'first' }], history: [{ state: 'waiting' as const, activeAssignment: false, at: 5 }, { state: 'blocked' as const, activeAssignment: false, at: 11 }] }],
      history: [{ phase: 'completed' as const, at: 9 }, { phase: 'reopened' as const, at: 10 }],
    }
    ctx.provide('workspaceCoordinator', { inspectWorkspaceBatch: (_caller: Agent, id: string) => { expect(id).toBe('batch-view'); return batch } } as never)
    const tools = await ctx.plugin(coordinatorTools)
    try {
      const result = await execute(ctx, lead, 'team_workspace_batch_inspect', { batch_id: 'batch-view' })
      expect(result.isError, text(result)).not.toBe(true)
      expect(JSON.parse(text(result))).toEqual(expect.objectContaining({ id: 'batch-view', phase: 'blocked', itemsTruncated: false, historyTruncated: false,
        items: [expect.objectContaining({ ref: { projectId: 'project-a', teamId: 'team-a', taskId: 'first' }, state: 'accepted', dependsOn: [], historyTruncated: false }),
          expect.objectContaining({ ref: { projectId: 'project-b', teamId: 'team-b', taskId: 'second' }, state: 'blocked', dependsOn: [{ projectId: 'project-a', teamId: 'team-a', taskId: 'first' }], history: [{ state: 'waiting', activeAssignment: false, at: 5 }, { state: 'blocked', activeAssignment: false, at: 11 }], historyTruncated: false })],
        history: [{ phase: 'completed', at: 9 }, { phase: 'reopened', at: 10 }] }))
    } finally { await tools.dispose() }
  })

  it('renders batch mutations and pagination through the declared tool schemas', async () => {
    const { ctx, lead } = await setup([])
    await execute(ctx, lead, 'team_task_create', { subject: 'work', description: 'verify' })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_batch_create', {
      name: 'Delivery', description: 'Scope', task_ids: ['task-1'],
    })))).toMatchObject({ id: 'batch-1', completedTasks: 0, status: 'active' })
    await execute(ctx, lead, 'team_batch_create', { name: 'Next', description: 'Next scope', task_ids: [] })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_batch_list', { limit: 1 })))).toMatchObject({ nextCursor: 1 })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_batch_update', {
      batch_id: 'batch-1', expected_revision: 1, name: 'Revised', description: 'Revised scope', task_ids: [], archive: true,
    })))).toMatchObject({ revision: 2, name: 'Revised', status: 'archived' })
    expect((await execute(ctx, lead, 'team_batch_update', { batch_id: 'batch-1', expected_revision: 1, archive: true })).isError).toBe(true)
    expect(JSON.parse(text(await execute(ctx, lead, 'team_batch_list', { cursor: 1 })))).toMatchObject({ batches: [{ id: 'batch-2' }] })
  })

  it('creates a Lead-selected non-code task through the model tool', async () => {
    const { ctx, lead } = await setup([])
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_create', { subject: 'investigate', description: 'Report the finding', non_code_criteria: 'Cite observed evidence' })))).toMatchObject({ nonCodeCriteria: 'Cite observed evidence' })
  })

  it('exposes opt-in worktree and integration operations with complete result schemas', async () => {
    const fixture = await gitFixture((root) => { roots.push(root) })
    const { ctx, lead } = await setup([textResponse('worker ready')], false, {
      worktreeProvider: 'git', integrationProvider: 'git',
    }, fixture.repository)
    await ctx.plugin(GitWorktrees, fixture.config)
    await ctx.plugin(GitIntegration, {
      providerName: 'git', targetBranch: 'main', commandTimeoutMs: 30_000, verificationTimeoutMs: 30_000,
      verification: [{ command: process.execPath, args: ['-e', "if(require('node:fs').readFileSync('shared.txt','utf8')!=='base\\n')process.exit(1)"] }],
    })
    expect(renderPrompt(await assembly(ctx, lead))).toContain('isolated Git worktrees')
    const child = spawnedChildId(await execute(ctx, lead, 'spawn_teammate', {
      name: 'worker', description: 'Commit output', prompt: 'finish',
    }))
    await waitNoAgent(ctx, child)
    expect((await execute(ctx, lead, 'team_integration_enqueue', { target: 'worker' })).isError).toBe(false)
    await execute(ctx, lead, 'team_integration_enqueue', { target: 'worker' })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_integration_list', { limit: 1 })))).toMatchObject({ nextCursor: 1 })
    const first = ctx.agentTeams.listIntegrations(lead)[0]
    if (first === undefined) throw new Error('integration tool did not enqueue its request')
    expect(JSON.parse(text(await execute(ctx, lead, 'team_integration_abandon', { id: first.id, reason: 'duplicate request' })))).toMatchObject({ phase: 'failed' })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_integration_run', {})))).toMatchObject({ integration: { phase: 'merged' } })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_integration_run', {})))).toEqual({})
    expect(JSON.parse(text(await execute(ctx, lead, 'team_worktree_release', { target: 'worker' })))).toEqual({ released: true })
  })

  it('installs the complete scoped schema and shared-checkout policy for roots and teammates', async () => {
    const { ctx, lead } = await setup(['hang'])
    const leadAssembly = await assembly(ctx, lead)
    expect(leadAssembly.tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    const leadPrompt = renderPrompt(leadAssembly)
    expect(leadPrompt).toContain('create teammates only when the user explicitly asks')
    expect(leadPrompt).toContain('FS_STALE_VERSION')
    expect(leadPrompt).toContain('Bash, formatters, code generators, and scripts are not fully protected')
    expect(leadPrompt).toContain('Task readiness never starts an owner')
    expect(leadPrompt).toContain('returns noProgress immediately')
    expect(leadPrompt).toContain('Your Team role is lead')

    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'tool-worker',
      description: 'exercise scoped tools',
      prompt: 'stay available',
    })
    expect(spawned.isError).toBe(false)
    const childId = spawnedChildId(spawned)
    const child = await waitRunning(ctx, childId)
    const childAssembly = await assembly(ctx, child)
    expect(childAssembly.tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    expect(renderPrompt(childAssembly)).toContain('Your Team role is teammate; your Team name is tool-worker')

    const denied = await execute(ctx, child, 'spawn_teammate', {
      name: 'nested', description: 'not allowed', prompt: 'no',
    })
    expect(denied.isError).toBe(true)
    expect(text(denied)).toContain('only the Team Lead')
    await execute(ctx, lead, 'interrupt_agent', { target: 'tool-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('returns actionable no-progress output and renders structured wait cancellation', async () => {
    const inactiveSetup = await setup([textResponse('worker done')])
    const inactiveSpawn = await execute(inactiveSetup.ctx, inactiveSetup.lead, 'spawn_teammate', {
      name: 'inactive-worker', description: 'finish immediately', prompt: 'finish',
    })
    const inactiveId = spawnedChildId(inactiveSpawn)
    await waitNoAgent(inactiveSetup.ctx, inactiveId)
    const noProgress = await execute(inactiveSetup.ctx, inactiveSetup.lead, 'wait_agent', { timeout_ms: 3_600_000 })
    expect(noProgress.isError).toBe(false)
    expect(JSON.parse(text(noProgress))).toEqual({
      timedOut: false,
      noProgress: {
        reason: 'no-active-peer',
        message: 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use followup_task to wake each required inactive teammate before waiting again.',
      },
    })
    for (const timeout_ms of [9_999, 3_600_001, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = await execute(inactiveSetup.ctx, inactiveSetup.lead, 'wait_agent', { timeout_ms })
      expect(invalid.isError).toBe(true)
      expect(text(invalid)).toContain('timeoutMs must be an integer from 10000 through 3600000')
    }

    const activeSetup = await setup(['hang'])
    const activeSpawn = await execute(activeSetup.ctx, activeSetup.lead, 'spawn_teammate', {
      name: 'active-worker', description: 'stay active', prompt: 'wait',
    })
    const activeId = spawnedChildId(activeSpawn)
    await waitRunning(activeSetup.ctx, activeId)
    const controller = new AbortController()
    const waiting = execute(activeSetup.ctx, activeSetup.lead, 'wait_agent', { timeout_ms: 10_000 }, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort({ kind: 'user' })
    const aborted = await waiting
    expect(aborted.isError).toBe(true)
    expect(text(aborted)).toBe("Error: wait_agent aborted: { kind: 'user' }")
    await execute(activeSetup.ctx, activeSetup.lead, 'interrupt_agent', { target: 'active-worker' })
    await waitNoAgent(activeSetup.ctx, activeId)
  })

  it('adapts roster, mailbox, wait, and task CAS operations to canonical JSON', async () => {
    const { ctx, lead } = await setup(['hang', textResponse('lead received wakeup')])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'json-worker', description: 'json worker', prompt: 'wait', context: 'fresh',
    })
    const childId = spawnedChildId(spawned)
    const child = await waitRunning(ctx, childId)

    const roster = await execute(ctx, child, 'list_agents', {})
    expect(JSON.parse(text(roster))).toMatchObject([
      { name: 'lead', role: 'lead' },
      { name: 'json-worker', role: 'teammate' },
    ])
    // Every Team result reaches the model as compact JSON: indentation would
    // spend tokens on every roster, task, and receipt without adding meaning.
    expect(text(roster)).toBe(JSON.stringify(JSON.parse(text(roster))))
    const peer = await execute(ctx, child, 'send_message', { target: 'lead', message: 'quiet report' })
    expect(peer.isError).toBe(false)
    expect(JSON.parse(text(peer))).toMatchObject({ status: 'accepted' })
    const waking = await execute(ctx, child, 'followup_task', { target: 'lead', message: 'review the report' })
    expect(waking.isError).toBe(false)
    expect(JSON.parse(text(waking))).toMatchObject({ status: 'accepted' })
    await lead.whenIdle()

    const created = await execute(ctx, lead, 'team_task_create', {
      subject: 'tool task',
      description: 'created through tool',
      blocked_by: [],
      write_scopes: ['src/team'],
    })
    const task = JSON.parse(text(created)) as { id: string; revision: number }
    const listed = await execute(ctx, child, 'team_task_list', { ready: true, limit: 1 })
    expect(JSON.parse(text(listed))).toMatchObject({ tasks: [{ id: task.id, ready: true }] })
    const read = await execute(ctx, child, 'team_task_get', { task_id: task.id })
    expect(JSON.parse(text(read))).toMatchObject({ id: task.id, revision: 1 })
    const claimed = await execute(ctx, child, 'team_task_update', {
      task_id: task.id,
      expected_revision: task.revision,
      action: 'claim',
    })
    expect(JSON.parse(text(claimed))).toMatchObject({ status: 'in_progress', ownerName: 'json-worker' })
    const stale = await execute(ctx, lead, 'team_task_update', {
      task_id: task.id,
      expected_revision: task.revision,
      action: 'delete',
    })
    expect(stale.isError).toBe(true)
    expect(text(stale)).toContain('stale team task')

    const wait = execute(ctx, lead, 'wait_agent', { timeout_ms: 10_000 })
    const completedCall = new Promise<Awaited<ReturnType<typeof execute>>>((resolve, reject) => {
      setTimeout(() => {
        void execute(ctx, child, 'team_task_update', {
          task_id: task.id,
          expected_revision: 2,
          action: 'complete',
          result: 'Completed through tool test.',
        }).then(resolve, reject)
      }, 0)
    })
    await expect(wait).resolves.toMatchObject({ isError: false })
    expect((await completedCall).isError).toBe(false)

    const childInterrupt = await execute(ctx, child, 'interrupt_agent', { target: 'json-worker' })
    expect(childInterrupt.isError).toBe(true)
    await execute(ctx, lead, 'interrupt_agent', { target: 'json-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('adapts optional task filters, mutations, pagination, and default waiting', async () => {
    const { ctx, lead } = await setup(['hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'fork-worker', description: 'fork worker', prompt: 'stay active', context: 'fork',
    })
    const childId = spawnedChildId(spawned)
    await waitRunning(ctx, childId)

    const firstResult = await execute(ctx, lead, 'team_task_create', {
      subject: 'first', description: 'first task',
    })
    const secondResult = await execute(ctx, lead, 'team_task_create', {
      subject: 'second', description: 'second task',
    })
    const first = JSON.parse(text(firstResult)) as { id: string; revision: number }
    const second = JSON.parse(text(secondResult)) as { id: string; revision: number }
    const claimed = await execute(ctx, lead, 'team_task_update', {
      task_id: first.id, expected_revision: first.revision, action: 'claim',
    })
    const claim = JSON.parse(text(claimed)) as { revision: number }

    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      status: 'in_progress', owner: 'lead', cursor: 0, limit: 1,
    })))).toMatchObject({ tasks: [{ id: first.id }] })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      owner: 'unowned', limit: 1,
    })))).toMatchObject({ tasks: [{ id: second.id }] })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      cursor: 0, limit: 1,
    })))).toMatchObject({ nextCursor: 1 })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      cursor: 1,
    })))).not.toHaveProperty('nextCursor')
    expect((await execute(ctx, lead, 'team_task_list', { cursor: -1 })).isError).toBe(true)
    expect((await execute(ctx, lead, 'team_task_list', { limit: 101 })).isError).toBe(true)

    const edited = await execute(ctx, lead, 'team_task_update', {
      task_id: first.id,
      expected_revision: claim.revision,
      action: 'edit',
      subject: 'edited',
      description: 'edited description',
      write_scopes: ['src/team'],
    })
    const edit = JSON.parse(text(edited)) as { revision: number }
    const dependencies = await execute(ctx, lead, 'team_task_update', {
      task_id: first.id,
      expected_revision: edit.revision,
      action: 'set_dependencies',
      blocked_by: [second.id],
    })
    expect(dependencies.isError).toBe(false)
    const dependency = JSON.parse(text(dependencies)) as { revision: number }
    expect((await execute(ctx, lead, 'team_task_update', {
      task_id: first.id,
      expected_revision: dependency.revision,
      action: 'reassign',
      owner: 'fork-worker',
    })).isError).toBe(true)

    const wait = execute(ctx, lead, 'wait_agent', {})
    const wake = new Promise<Awaited<ReturnType<typeof execute>>>((resolve, reject) => {
      setTimeout(() => {
        void execute(ctx, lead, 'team_task_create', {
          subject: 'wake', description: 'wake default wait',
        }).then(resolve, reject)
      }, 0)
    })
    expect((await wait).isError).toBe(false)
    expect((await wake).isError).toBe(false)

    await execute(ctx, lead, 'interrupt_agent', { target: 'fork-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('removes and reinstalls every scoped registration across plugin HMR without stopping the child', async () => {
    const { ctx, lead, fiber } = await setup(['hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'hmr-worker', description: 'hmr worker', prompt: 'wait',
    })
    const childId = spawnedChildId(spawned)
    const child = await waitRunning(ctx, childId)

    await fiber.dispose()
    expect((await assembly(ctx, lead)).tools.map(schema => schema.name).some(name => TOOL_NAMES.includes(name))).toBe(false)
    expect((await assembly(ctx, child)).tools.map(schema => schema.name).some(name => TOOL_NAMES.includes(name))).toBe(false)
    expect(ctx.agents.get(childId)).toBe(child)

    const replacement = await ctx.plugin(toolTeam)
    expect((await assembly(ctx, lead)).tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    expect((await assembly(ctx, child)).tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    await execute(ctx, lead, 'interrupt_agent', { target: 'hmr-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
    await replacement.dispose()
  })

  it('shadows legacy global control names only inside Team member scopes', async () => {
    const { ctx, lead, fiber } = await setup([], true)
    const teamSchema = (await assembly(ctx, lead)).tools.find(schema => schema.name === 'send_message')
    expect(JSON.stringify(teamSchema)).toContain('target')
    expect(JSON.stringify(teamSchema)).not.toContain('agent_id')

    await fiber.dispose()
    const legacySchema = (await assembly(ctx, lead)).tools.find(schema => schema.name === 'send_message')
    expect(JSON.stringify(legacySchema)).toContain('agent_id')
  })

  it('rolls back partial scoped installation after a same-scope collision', async () => {
    const { ctx, lead, fiber } = await setup([])
    await fiber.dispose()
    lead.ctx.tools.register(defineContentToolFixture({
      name: 'spawn_teammate',
      description: 'intentional collision',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'collision' }] },
    }))

    await expect(ctx.plugin(toolTeam)).rejects.toThrow(/already registered/u)
    const assembled = await assembly(ctx, lead)
    expect(assembled.tools.filter(schema => TOOL_NAMES.includes(schema.name)).map(schema => schema.name))
      .toEqual(['spawn_teammate'])
    expect(renderPrompt(assembled)).not.toContain('Your Team role is lead')
  })

  it('resolves direct-apply defaults without Loader schema normalization', async () => {
    const { ctx, lead, fiber } = await setup([textResponse('ordinary child')])
    await fiber.dispose()
    toolTeam.apply(ctx, {})
    expect((await assembly(ctx, lead)).tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    const ordinary = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'ordinary child',
      request: { prompt: [{ type: 'text', text: 'finish' }], parent: lead },
      signal: SIGNAL,
    })
    await vi.waitFor(() => { expect(ctx.agents.get(ordinary.childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('reinstalls Team scope before a cold-resumed teammate request', async () => {
    const { ctx, lead } = await setup([textResponse('first'), 'hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'cold-worker', description: 'cold worker', prompt: 'finish once',
    })
    const childId = spawnedChildId(spawned)
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })

    await ctx.agentTeams.sendMessage(lead, {
      target: 'cold-worker',
      content: [{ type: 'text', text: 'resume with Team scope' }],
      delivery: 'wakeup',
      signal: SIGNAL,
    })
    const resumed = await waitRunning(ctx, childId)
    expect((await assembly(ctx, resumed)).tools.map(schema => schema.name)
      .filter(name => TOOL_NAMES.includes(name)).sort()).toEqual(TOOL_NAMES)
    expect(renderPrompt(await assembly(ctx, resumed))).toContain('Your Team role is teammate; your Team name is cold-worker')
    await execute(ctx, lead, 'interrupt_agent', { target: 'cold-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('fails safely without a calling Agent and has the function-plugin export shape', async () => {
    const { ctx } = await setup([])
    const result = await execute(ctx, undefined, 'list_agents', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unknown tool "list_agents"')
    expect('default' in toolTeam).toBe(false)
    expect(toolTeam.name).toBe('tool-agent-team')
    expect(toolTeam.inject).toEqual(['agents', 'agentTeams', 'tools', 'systemPrompt'])
  })

  it('uses configured fresh and fork provider names', async () => {
    const { ctx, lead, fiber } = await setup([textResponse('custom')])
    await fiber.dispose()
    await ctx.plugin(SubagentSpawn, { providerName: 'team-fresh' })
    await ctx.plugin(toolTeam, { freshProvider: 'team-fresh', forkProvider: 'fork' })
    const result = await execute(ctx, lead, 'spawn_teammate', {
      name: 'custom-provider', description: 'custom provider', prompt: 'go',
    })
    expect(result.isError).toBe(false)
    const childId = spawnedChildId(result)
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ provider: 'team-fresh' })
  })
})
