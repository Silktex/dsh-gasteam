import { afterEach, expect, it } from 'vitest'
import { readFile, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TeamService from '../src/index.ts'
import * as GitWorktrees from '../src/git-worktrees.ts'
import { GitIntegrationProvider } from '../src/git-integration-provider.ts'
import { WorkspaceCoordinator } from '../src/coordinator.ts'
import { AssignmentStore } from '../src/assignments.ts'
import { gitFixture } from './git-fixture.ts'
import { TestSessionQuery } from './test-session-query.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const dispose of cleanup.splice(0).reverse()) {
    try { await dispose() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'External coordinator fixture cleanup')
})

async function setup(Coordinator: typeof WorkspaceCoordinator = WorkspaceCoordinator) {
  const repo = await gitFixture(root => cleanup.push(() => rm(root, { recursive: true, force: true })))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(repo.root, 'jsonl'), compression: 'none' })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService, { worktreeProvider: 'git', integrationProvider: 'git' })
  await ctx.plugin(GitWorktrees, { directory: join(repo.root, 'workers') })
  ctx.agentTeams.registerIntegrationProvider(new GitIntegrationProvider({ providerName: 'git', targetBranch: 'main', verification: [{ command: 'node', args: ['--version'] }], commandTimeoutMs: 5_000, verificationTimeoutMs: 5_000 }))
  const lead = ctx.agentLoop.create(SessionId('external-team'), { provider: 'mock', model: 'mock' }, { cwd: repo.repository })
  const config = { directory: join(repo.root, 'coordinator') }
  const coordinator = await Coordinator.open(ctx, config)
  cleanup.push(() => coordinator.close())
  const project = { id: 'project', repository: repo.repository, teamIds: [lead.id], targetBranch: 'main', capacity: 1, verification: { revision: 1, commands: [{ command: 'node', args: ['--version'] }] } }
  await coordinator.register(lead, project)
  return { repo, ctx, lead, config, coordinator, project }
}

function execution(root: string, cwd: string, projectId = 'project') {
  return { modelProvider: 'mock', model: 'mock', maxConcurrent: 1, health: { dshDeadlineMs: 1_000, externalDeadlineMs: 2_000, escalationCooldownMs: 1_000, maxEscalationsPerCondition: 2 }, externalCodex: {
    projectId, directory: join(root, 'external-runtime'), cwd, executable: resolve('packages/agent-team/tests/fixtures/external-runtime-fixture.mjs'), version: '0.153.4', model: 'gpt-5.6-codex', sandbox: 'workspace-write' as const,
    maxSpoolBytes: 65_536, terminateGraceMs: 50,
  } }
}

function codeExecution(root: string, cwd: string) {
  return { ...execution(root, cwd), externalCodex: { ...execution(root, cwd).externalCodex, codeWorktreeDirectory: join(root, 'external-code-worktrees') } }
}

async function exerciseRoute(Coordinator: typeof WorkspaceCoordinator): Promise<void> {
  const { repo, ctx, lead, config, coordinator } = await setup(Coordinator)
  const task = await coordinator.acceptTask(lead, 'project', { subject: 'descendant', description: 'Keep an owned descendant alive until cancellation', nonCodeCriteria: 'Return a report only if completed' })
  await coordinator.close()
  const first = await Coordinator.open(ctx, { ...config, execution: execution(repo.root, repo.repository) })
  let closedFirst = false
  cleanup.push(async () => { if (!closedFirst) await first.close() })
  await waitFor(async () => {
    await first.reconcile()
    const view = first.view()
    const block = view.executionBlocks.find(item => item.taskId === task.id)
    if (block !== undefined) throw new Error(block.diagnostic)
    return view.attempts.find(item => item.taskId === task.id)?.phase === 'active'
  })
  const launched = first.view().attempts.find(item => item.taskId === task.id)!
  expect(launched).toMatchObject({ provider: 'external', phase: 'active', externalPolicy: { projectId: 'project', admission: { cwd: repo.repository, model: 'gpt-5.6-codex', executableVerification: 'verified' }, maxSpoolBytes: 65_536, terminateGraceMs: 50 }, checkpoint: { task: { nonCodeCriteria: 'Return a report only if completed' } } })
  expect(ctx.agents.get(SessionId(launched.runtimeId))).toBeUndefined()
  // A coincident DSH session must not supply liveness or sequence progress to
  // an external assignment: only its external supervisor/store can do that.
  ctx.agentLoop.create(SessionId(launched.runtimeId), { provider: 'mock', model: 'mock' }, { cwd: repo.repository })
  await first.reconcile()
  const supervisor = JSON.parse(await readFile(join(repo.root, 'external-runtime', launched.attemptId, 'supervisor.json'), 'utf8'))
  const helperCommand = (await readFile(`/proc/${supervisor.supervisor.pid}/cmdline`)).toString('utf8')
  expect(helperCommand).toContain('/packages/agent-team/lib/external-runtime-supervisor.js')
  expect(helperCommand).not.toContain('tsx')
  expect(first.view().health).toContainEqual(expect.objectContaining({
    attemptId: launched.attemptId, provider: 'external', classification: 'progressing', deadlineMs: 2_000,
  }))
  expect(first.view().health.find(item => item.attemptId === launched.attemptId)?.lastProgress).toBeUndefined()
  await first.close()
  closedFirst = true

  const restored = await Coordinator.open(ctx, { ...config, execution: execution(repo.root, repo.repository) })
  cleanup.push(() => restored.close())
  await restored.reconcile()
  const interrupted = restored.view().attempts.find(item => item.attemptId === launched.attemptId)!
  expect(interrupted).toMatchObject({ attemptId: launched.attemptId, provider: 'external', phase: 'terminal', interruption: { reason: 'coordinator-shutdown' }, stopEvidence: { kind: 'stopped' } })
  expect(interrupted.stopReason).toBeUndefined()
  expect(interrupted.result).toBeUndefined()
  expect(JSON.parse(await readFile(join(repo.root, 'external-runtime', launched.attemptId, 'stop-proof.json'), 'utf8'))).toMatchObject({ containment: 'pid-namespace', signals: expect.arrayContaining(['SIGTERM']) })
  await waitFor(async () => {
    await restored.reconcile()
    return restored.view().attempts.some(item => item.taskId === task.id && item.generation === launched.generation + 1 && item.phase === 'active')
  })
}

it('pins external non-code ownership, stops an owned descendant on close, and retains the positive terminal receipt after reopen', async () => {
  await exerciseRoute(WorkspaceCoordinator)
})


it('rejects an external policy that does not select the registered project repository', async () => {
  const { repo, ctx, config, coordinator } = await setup()
  await coordinator.close()
  await expect(WorkspaceCoordinator.open(ctx, { ...config, execution: execution(repo.root, repo.repository, 'other-project') })).rejects.toThrow(/unregistered project/i)
})

it('blocks new selected-project non-code work during recovery-only admission without falling back to DSH', async () => {
  const { repo, ctx, lead, config, coordinator } = await setup()
  const retainedTask = await coordinator.acceptTask(lead, 'project', { subject: 'retained', description: 'Durably reserved external work', nonCodeCriteria: 'Return a report' })
  const queuedTask = await coordinator.acceptTask(lead, 'project', { subject: 'queued', description: 'Must wait for provider admission', nonCodeCriteria: 'Return a report' })
  await coordinator.close()
  const providerDirectory = join(repo.root, 'external-runtime')
  const configuredExecutable = resolve('packages/agent-team/tests/fixtures/external-runtime-fixture.mjs')
  const assignments = await AssignmentStore.open(config.directory, { globalCapacity: 1, projectCapacities: { project: 1 } })
  await assignments.reserve({ projectId: 'project', teamId: lead.id, taskId: retainedTask.id, workerId: 'retained-worker', runtimeId: 'retained-runtime', provider: 'external', expectedGeneration: 0,
    checkpoint: { task: { subject: 'retained', description: 'Durably reserved external work', nonCodeCriteria: 'Return a report' }, step: 'report', artifacts: [], nextAction: 'Return a report' },
    externalPolicy: { projectId: 'project', directory: providerDirectory, admission: { executable: await realpath(configuredExecutable), configuredExecutable, version: '0.153.4', executableVerification: 'verified', cwd: repo.repository, model: 'gpt-5.6-codex', sandbox: 'workspace-write', authStatus: 'authenticated' }, maxSpoolBytes: 65_536, terminateGraceMs: 50 },
  })
  await assignments.close()
  const unavailableAdmission = execution(repo.root, repo.repository)
  unavailableAdmission.externalCodex.executable = join(repo.root, 'missing-codex')
  const restored = await WorkspaceCoordinator.open(ctx, { ...config, execution: unavailableAdmission })
  cleanup.push(() => restored.close())
  await restored.reconcile()
  const status = restored.view().dispatchStatus.find(item => item.taskId === queuedTask.id)
  expect(status).toMatchObject({ state: 'waiting', blockers: expect.arrayContaining([expect.objectContaining({ code: 'provider-admission' })]) })
  expect(restored.view().attempts).toHaveLength(1)
  expect(restored.view().attempts[0]).toMatchObject({ attemptId: 'attempt-1', provider: 'external', taskId: retainedTask.id })
  expect(ctx.agents.get(SessionId('retained-runtime'))).toBeUndefined()
  await expect(readFile(join(providerDirectory, 'attempt-1', 'manifest.json'), 'utf8')).rejects.toThrow()
})

it('routes an explicit external code worktree through quiescent commit and verified integration acceptance', async () => {
  const { repo, ctx, lead, config, coordinator } = await setup()
  const task = await coordinator.acceptTask(lead, 'project', { subject: 'codex-code-commit', description: 'Commit the controlled external fixture change' })
  await coordinator.close()
  const routed = await WorkspaceCoordinator.open(ctx, { ...config, execution: codeExecution(repo.root, repo.repository) })
  cleanup.push(() => routed.close())
  await waitFor(async () => {
    await routed.reconcile()
    const view = routed.view()
    const block = view.executionBlocks.find(item => item.taskId === task.id)
    if (block !== undefined) throw new Error(block.diagnostic)
    return view.attempts.some(item => item.taskId === task.id && item.provider === 'external' && item.phase === 'terminal' && !!item.result)
  }, 12_000)
  const attempt = routed.view().attempts.find(item => item.taskId === task.id)!
  expect(attempt).toMatchObject({ provider: 'external', phase: 'terminal', externalPolicy: { codeWorktreeDirectory: join(repo.root, 'external-code-worktrees') } })
  const manifest = JSON.parse(await readFile(join(repo.root, 'external-runtime', attempt.attemptId, 'supervisor-request.json'), 'utf8')) as { request: { writableDirectories?: string[], args?: string[] } }
  const commonDirectory = await realpath(join(repo.repository, '.git'))
  expect(manifest.request.writableDirectories).toEqual([commonDirectory])
  expect(manifest.request.args).toEqual(expect.arrayContaining(['--add-dir', commonDirectory]))
  expect(ctx.agents.get(SessionId(attempt.runtimeId))).toBeUndefined()
  await expect(routed.submit(lead, 'project', { attemptId: attempt.attemptId, generation: attempt.generation + 1, expectedRevision: attempt.revision, sourceCommit: 'a'.repeat(40), evidence: 'stale external receipt' })).rejects.toThrow(/stale|unauthorized/i)
  await waitFor(async () => {
    await routed.reconcile()
    const view = routed.view()
    return view.submissions.some(item => item.attemptId === attempt.attemptId && item.phase === 'accepted')
  }, 12_000)
  const submission = routed.view().submissions.find(item => item.attemptId === attempt.attemptId)!
  const integration = ctx.agentTeams.listIntegrations(lead).find(item => item.id === submission.integrationId)!
  expect(integration).toMatchObject({ phase: 'merged', externalOwner: { runtimeId: attempt.runtimeId, cwd: join(repo.root, 'external-code-worktrees', attempt.attemptId) } })
  expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('completed')
})

it.runIf((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.GASTEAM_COMPILED_ROUTE === '1')('runs the same route through the plain-Node compiled coordinator bundle', async () => {
  const { WorkspaceCoordinator: CompiledCoordinator } = await import('../lib/coordinator.js')
  await exerciseRoute(CompiledCoordinator)
})

async function waitFor(condition: () => Promise<boolean>, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for external coordinator route')
}
