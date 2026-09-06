import type { WorkspacePageSnapshotStore } from '../src/workspace-pagination.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as CoordinatorTools from '../../tool-agent-team/src/coordinator.ts'
import { schedulingViewSchema, schedulingControlSchema } from '../src/scheduling-schemas.ts'
import { workspaceDashboardPageSchema, workspaceDashboardViewSchema } from '../src/workspace-dashboard.ts'
import { createTaskSchema, remoteAcceptReportRequestSchema, reviewableReportSchema, reviewableReportsSchema, updateTaskSchema } from '../src/remote-schemas.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as GitIntegration from '../src/git-integration.ts'
import { runGit } from '../src/git-command.ts'
import * as GitWorktrees from '../src/git-worktrees.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../tests/support/mock-adapter.ts'
import TeamService from '../src/index.ts'
import { ProjectCatalog } from '../src/projects.ts'
import { WorkspaceCoordinator } from '../src/coordinator.ts'
import { CoordinatorExecution } from '../src/coordinator-execution.ts'
import { HealthStore } from '../src/health.ts'
import { HealthRecoveryStore } from '../src/health-recovery.ts'
import * as CoordinatorPlugin from '../src/coordinator.ts'
import { gitFixture } from './git-fixture.ts'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const dispose of cleanup.splice(0).reverse()) {
    try { await dispose() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Coordinator fixture cleanup')
})
async function stack(root: string, integration = false) {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'jsonl'), compression: 'none' })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService, { worktreeProvider: 'git', ...(integration ? { integrationProvider: 'test' } : {}) })
  await ctx.plugin(GitWorktrees, { directory: join(root, 'workers') })
  return ctx
}
async function fixture(integration = false) {
  const repo = await gitFixture(root => cleanup.push(() => rm(root, { recursive: true, force: true })))
  const ctx = await stack(repo.root, integration)
  const lead = ctx.agentLoop.create(SessionId('registered-team'), { provider: 'mock', model: 'mock' }, { cwd: repo.repository })
  const config = { directory: join(repo.root, 'coordinator') }
  const coordinator = await WorkspaceCoordinator.open(ctx, config)
  cleanup.push(() => coordinator.close())
  const request = {
    id: 'project', repository: repo.repository, teamIds: [lead.id], targetBranch: 'main', capacity: 2,
    verification: { revision: 1, commands: [{ command: 'node', args: ['--version'] }] },
  }
  return { ...repo, ctx, lead, config, coordinator, request }
}

it('returns ordered exact repair source lineage when replacement was already submitted before workflow reconciliation', async () => {
  const original = 'a'.repeat(40), repaired = 'b'.repeat(40)
  const taskId = 'workflow-intent'
  const originalSubmission = { id: 'submission-original', integrationId: 'integration-original', attemptId: 'attempt-original', generation: 1,
    projectId: 'project', teamId: 'lead', taskId, sourceCommit: original, reviewGate: 'workflow-gate' }
  const repair = { previousAttemptId: 'attempt-original', submissionId: 'submission-original', integrationId: 'integration-original', sourceCommit: original, round: 1 }
  const repairedSubmission = { id: 'submission-repaired', integrationId: 'integration-repaired', attemptId: 'attempt-repaired', generation: 2,
    projectId: 'project', teamId: 'lead', taskId, sourceCommit: repaired, reviewGate: 'workflow-gate' }
  const status = await (CoordinatorExecution.prototype as unknown as { workflowCodeStatus(this: unknown, input: unknown): Promise<unknown> }).workflowCodeStatus.call({
    assignments: { list: () => [
      { attemptId: 'attempt-original', generation: 1, projectId: 'project', teamId: 'lead', taskId },
      { attemptId: 'attempt-repaired', generation: 2, projectId: 'project', teamId: 'lead', taskId, repair, repairLimit: 1 },
    ] },
    submissions: { list: () => [originalSubmission, repairedSubmission] },
    projects: () => [{ id: 'project', teamIds: ['lead'] }],
    leadFor: async () => ({ id: 'lead' }),
    ctx: { agentTeams: { listIntegrations: () => [{ id: 'integration-repaired', phase: 'failed', reviewGate: 'workflow-gate' }] } },
  }, { intentId: 'intent', projectId: 'project', teamId: 'lead', executionId: 'execution', stepId: 'implement', subject: 'subject', description: 'description', reviewGate: 'workflow-gate' }) as { sourceCommit: string; sourceLineage: { sourceCommit: string; submissionId: string; repair?: { sourceCommit: string; submissionId: string; round: number } }[] }

  expect(status.sourceCommit).toBe(repaired)
  expect(status.sourceLineage).toEqual([
    { sourceCommit: original, submissionId: 'submission-original', integrationId: 'integration-original' },
    { sourceCommit: repaired, submissionId: 'submission-repaired', integrationId: 'integration-repaired',
      repair: { previousAttemptId: 'attempt-original', submissionId: 'submission-original', sourceCommit: original, round: 1, budget: 1 } },
  ])
})

it('fences paused release resume and authorization before the configured publisher can run', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture()
  await coordinator.close()
  let calls = 0
  const publisher = { identity: 'release-publisher', revision: 1, async publish(intent: import('../src/workflow-runtime.ts').WorkflowPublicationIntent) {
    calls++; return { publisher: 'release-publisher', publisherIdentity: 'release-publisher', publisherRevision: 1, idempotencyKey: intent.idempotencyKey, authorization: intent.authorization, evidence: intent.evidence, release: intent.release, reference: { kind: 'publication', ref: 'unused' } }
  } }
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution: { modelProvider: 'mock', model: 'mock', maxConcurrent: 1 }, publication: { grants: [{ projectId: 'project', teamId: lead.id, authorization: 'release-manager' }], publisher } })
  cleanup.push(() => running.close())
  await running.register(lead, request)
  await running.createWorkflow(lead, { projectId: 'project', teamId: lead.id, templateId: 'release-publication', templateVersion: 1, parameters: { release: 'v1' }, executionId: 'paused-release' })
  const store = (running as unknown as { workflowStore: import('../src/workflows.ts').WorkflowStore }).workflowStore
  const prepare = store.inspect('paused-release')!.steps[0]!
  await store.completeStep('paused-release', prepare.id, prepare.revision, { artifacts: { 'release-candidate': { kind: 'report', ref: 'manifest' } }, receipt: { kind: 'report-review', reviewer: lead.id, decision: 'approved', reference: { kind: 'report', ref: 'manifest' } } })
  await running.reconcile()
  const publish = store.inspect('paused-release')!.steps[1]!
  expect(running.inspectWorkflow(lead, 'paused-release').steps.find(step => step.stepId === publish.id)).toMatchObject({
    revision: publish.revision, attempts: publish.attempts, phase: 'running',
  })
  await running.pause(lead, 'project', 0, true)
  await expect(running.resumeWorkflow(lead, 'paused-release')).rejects.toThrow(/paused/i)
  await expect(running.authorizeWorkflowPublication(lead, { executionId: 'paused-release', stepId: publish.id, expectedRevision: publish.revision, evidence: { kind: 'ticket', ref: 'CAB-3' } })).rejects.toThrow(/paused/i)
  expect(calls).toBe(0)
})

it('fails closed when configured publication grants are removed on reopen', async () => {
  const repo = await gitFixture(root => cleanup.push(() => rm(root, { recursive: true, force: true })))
  const grants = [{ projectId: 'project', teamId: 'lead', authorization: 'release-manager' }]
  const catalog = await ProjectCatalog.open(join(repo.root, 'catalog'), grants)
  await catalog.register({ id: 'project', repository: repo.repository, targetBranch: 'main', teamIds: ['lead'], capacity: 1, verification: { revision: 1, commands: [{ command: 'node', args: ['--version'] }] } })
  await catalog.close()
  await expect(ProjectCatalog.open(join(repo.root, 'catalog'))).rejects.toThrow(/publication grants/i)
})

it('discovers admitted tasks and stable coordinator identity after fresh service construction with no live Lead', async () => {
  const { root, ctx, lead, config, coordinator, request } = await fixture()
  await coordinator.register(lead, request)
  const task = await coordinator.acceptTask(lead, 'project', { subject: 'Accepted work', description: 'Must survive closing the browser' })
  const id = coordinator.view().id
  expect(typeof id).toBe('string')
  await coordinator.close()
  await ctx.fiber.dispose()
  const restoredCtx = await stack(root)
  const restored = await WorkspaceCoordinator.open(restoredCtx, config)
  cleanup.push(() => restored.close())
  expect(restoredCtx.agents.list()).toHaveLength(0)
  expect(restored.view()).toMatchObject({ id, readyTasks: [{ projectId: 'project', teamId: lead.id, taskId: task.id }] })
})

it('restores a two-project batch between controlled-worker report and acceptance without bypassing its dependency fence', async () => {
  const { root, ctx, lead, config, coordinator, request } = await fixture(true)
  const other = await gitFixture(root => cleanup.push(() => rm(root, { recursive: true, force: true })))
  const otherLead = ctx.agentLoop.create(SessionId('batch-team-b'), { provider: 'mock', model: 'mock' }, { cwd: other.repository })
  await coordinator.register(lead, request)
  await coordinator.register(otherLead, { ...request, id: 'project-batch-b', repository: other.repository, teamIds: [otherLead.id] })
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 8 }, () => textResponse('Controlled batch report with evidence.'))))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, health: { dshDeadlineMs: 1_000, externalDeadlineMs: 1_000, escalationCooldownMs: 1_000, maxEscalationsPerCondition: 2 } }, workspaceOperatorId: lead.id })
  cleanup.push(() => running.close())
  ctx.provide('workspaceCoordinator', running)
  await expect(ctx.agentTeams.remotePlanWorkspaceBatch(otherLead, { id: 'denied-batch', name: 'denied', items: [{ id: 'one', projectId: 'project', teamId: lead.id, subject: 'one', description: 'one' }] })).rejects.toThrow(/operator/i)
  await expect(ctx.agentTeams.remotePlanWorkspaceBatch(lead, { id: 'cycle-batch', name: 'cycle', items: [
    { id: 'a', projectId: 'project', teamId: lead.id, subject: 'a', description: 'a', dependsOn: ['b'] },
    { id: 'b', projectId: 'project-batch-b', teamId: otherLead.id, subject: 'b', description: 'b', dependsOn: ['a'] },
  ] })).rejects.toThrow(/cycle/i)
  const batch = await ctx.agentTeams.remotePlanWorkspaceBatch(lead, { id: 'two-repositories', name: 'two repositories', items: [
    { id: 'first', projectId: 'project', teamId: lead.id, subject: 'First repository', description: 'First controlled task', nonCodeCriteria: 'Report first evidence.' },
    { id: 'second', projectId: 'project-batch-b', teamId: otherLead.id, subject: 'Second repository', description: 'Must wait for the first acceptance', nonCodeCriteria: 'Report second evidence.', dependsOn: ['first'] },
  ] })
  expect(workspaceDashboardViewSchema.parse(ctx.agentTeams.remoteWorkspaceDashboard(lead, {}))).toMatchObject({
    projects: expect.arrayContaining([expect.objectContaining({ id: 'project', capacity: request.capacity })]),
    batches: [expect.objectContaining({ id: 'two-repositories', required: 2, completedRequired: 0 })],
  })
  expect(() => ctx.agentTeams.remoteWorkspaceDashboard(otherLead, {})).toThrow(/operator/i)
  expect(ctx.agentTeams.remoteInspectWorkspaceBatch(lead, { batchId: 'two-repositories' })).toMatchObject({ id: 'two-repositories', required: 2 })
  await ctx.agentTeams.remoteSubscribeWorkspaceBatch(lead, { batchId: 'two-repositories', subscriptionId: 'operator' })
  expect(batch.readyWithoutActiveAssignment).toEqual([])
  expect(ctx.agentTeams.listTasks(lead).some(task => task.subject === 'First repository')).toBe(true)
  expect(ctx.agentTeams.listTasks(otherLead).some(task => task.subject === 'Second repository')).toBe(true)
  expect(running.view().dispatchStatus.find(item => item.projectId === 'project-batch-b')?.blockers).toContainEqual(expect.objectContaining({ code: 'workspace-batch-dependency' }))
  expect(running.view().readyTasks).not.toContainEqual(expect.objectContaining({ projectId: 'project-batch-b', teamId: otherLead.id }))
  const firstTask = ctx.agentTeams.listTasks(lead).find(task => task.subject === 'First repository')!
  let firstAttempt = running.view().attempts.find(attempt => attempt.taskId === firstTask.id)!
  await vi.waitFor(() => expect(ctx.agents.get(SessionId(firstAttempt.runtimeId))).toBeUndefined(), { timeout: 5_000 })
  await running.reconcile()
  // Reconstruct the coordinator and both registered Leads before any report
  // acceptance. The second repository remains dependency-fenced across this
  // fresh process boundary.
  await running.close()
  await ctx.fiber.dispose()
  const restoredCtx = await stack(root, true)
  const restoredLead = (await restoredCtx.agents.resume({ resumeSessionId: SessionId(lead.id), agentOptions: { provider: 'mock', model: 'mock' } })).agent
  const restoredOtherLead = (await restoredCtx.agents.resume({ resumeSessionId: SessionId(otherLead.id), agentOptions: { provider: 'mock', model: 'mock' } })).agent
  restoredCtx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 8 }, () => textResponse('Controlled batch report with evidence.'))))
  const restored = await WorkspaceCoordinator.open(restoredCtx, { ...config, execution, workspaceOperatorId: lead.id })
  cleanup.push(() => restored.close())
  restoredCtx.provide('workspaceCoordinator', restored)
  await restored.reconcile()
  firstAttempt = restored.view().attempts.find(attempt => attempt.taskId === firstTask.id)!
  await restored.acceptReport(restoredLead, 'project', { attemptId: firstAttempt.attemptId, generation: firstAttempt.generation, expectedRevision: firstAttempt.revision, expectedTaskRevision: firstTask.revision, rationale: 'First accepted.' })
  const secondTask = restoredCtx.agentTeams.listTasks(restoredOtherLead).find(task => task.subject === 'Second repository')!
  await vi.waitFor(() => expect(restored.view().attempts.find(attempt => attempt.taskId === secondTask.id)).toBeDefined())
  let secondAttempt = restored.view().attempts.find(attempt => attempt.taskId === secondTask.id)!
  await vi.waitFor(() => expect(restoredCtx.agents.get(SessionId(secondAttempt.runtimeId))).toBeUndefined(), { timeout: 5_000 })
  await restored.reconcile()
  secondAttempt = restored.view().attempts.find(attempt => attempt.taskId === secondTask.id)!
  await restored.acceptReport(restoredOtherLead, 'project-batch-b', { attemptId: secondAttempt.attemptId, generation: secondAttempt.generation, expectedRevision: secondAttempt.revision, expectedTaskRevision: secondTask.revision, rationale: 'Second accepted.' })
  await vi.waitFor(() => expect(restored.inspectWorkspaceBatch(restoredLead, 'two-repositories').phase).toBe('completed'))
  const inbox = await restoredCtx.agentTeams.remoteWorkspaceBatchInbox(restoredLead, {})
  expect(inbox).toMatchObject([{ batchId: 'two-repositories', completionEpoch: 1, destination: `in-app:${lead.id}` }])
  expect(await restoredCtx.agentTeams.remoteAcknowledgeWorkspaceBatchNotification(restoredLead, { intentId: inbox[0]!.intentId })).toEqual([])
  expect(restored.inspectWorkspaceBatch(restoredLead, 'two-repositories')).toMatchObject({ required: 2, completedRequired: 2, phase: 'completed', completionEpoch: 1 })
  expect(restoredCtx.agentTeams.listTasks(restoredLead).filter(task => task.subject === 'First repository')).toHaveLength(1)
  expect(restoredCtx.agentTeams.listTasks(restoredOtherLead).filter(task => task.subject === 'Second repository')).toHaveLength(1)
})

it('authorizes and pages a retained workspace snapshot through the actual dashboard Remote', async () => {
  const { root, ctx, lead, config, coordinator, request } = await fixture()
  const other = await gitFixture(value => cleanup.push(() => rm(value, { recursive: true, force: true })))
  const otherLead = ctx.agentLoop.create(SessionId('paged-team-b'), { provider: 'mock', model: 'mock' }, { cwd: other.repository })
  await coordinator.close()
  const running = await WorkspaceCoordinator.open(ctx, { ...config, workspaceOperatorId: lead.id })
  cleanup.push(() => running.close())
  ctx.provide('workspaceCoordinator', running)
  await running.register(lead, request)
  await running.register(otherLead, { ...request, id: 'paged-project-b', repository: other.repository, teamIds: [otherLead.id] })
  const first = workspaceDashboardPageSchema.parse(ctx.agentTeams.remoteWorkspaceDashboardPage(lead, { collection: 'projects', pageSize: 1 }))
  expect(first.items).toHaveLength(1)
  await running.pause(lead, 'project', 0, true)
  const second = workspaceDashboardPageSchema.parse(ctx.agentTeams.remoteWorkspaceDashboardPage(lead, { collection: 'projects', pageSize: 1, cursor: first.nextCursor }))
  expect(second.items.map(item => item.id)).not.toEqual(first.items.map(item => item.id))
  expect(() => ctx.agentTeams.remoteWorkspaceDashboardPage(otherLead, { collection: 'projects' })).toThrow(/operator/i)
})

it('pages beyond the overview attempt bound through the actual Remote', async () => {
  const { ctx, lead, config, coordinator, request } = await fixture()
  await coordinator.close()
  const running = await WorkspaceCoordinator.open(ctx, { ...config, workspaceOperatorId: lead.id })
  cleanup.push(() => running.close()); ctx.provide('workspaceCoordinator', running)
  await running.register(lead, request)
  await running.acceptTask(lead, 'project', { subject: 'Many dashboard attempts', description: 'Provides a host projection base' })
  const actual = running.view()
  vi.spyOn(running, 'view').mockReturnValue({ ...actual, attempts: Array.from({ length: 513 }, (_, index) => ({ attemptId: `page-attempt-${index}`, generation: 1, revision: 1, projectId: 'project', teamId: lead.id, taskId: `page-task-${index}`, phase: 'active' })) as typeof actual.attempts })
  const first = ctx.agentTeams.remoteWorkspaceDashboardPage(lead, { collection: 'attempts', pageSize: 256 })
  const second = ctx.agentTeams.remoteWorkspaceDashboardPage(lead, { collection: 'attempts', pageSize: 256, cursor: first.nextCursor! })
  const last = ctx.agentTeams.remoteWorkspaceDashboardPage(lead, { collection: 'attempts', pageSize: 256, cursor: second.nextCursor! })
  expect(last.items.map(item => item.attemptId)).toEqual(['page-attempt-512'])
})

it('admits a workspace batch code item only through verified integration and retains it across restart', async () => {
  const { ctx, lead, coordinator, request, config, git } = await fixture(true)
  const commands = [{ command: 'node', args: ["-e", "if(require('node:fs').readFileSync('shared.txt','utf8').trim()!=='batch')process.exit(1)"] }]
  await coordinator.register(lead, { ...request, verification: { revision: 1, commands } })
  await coordinator.close()
  await ctx.plugin(GitIntegration, { providerName: 'test', targetBranch: 'main', verification: commands, commandTimeoutMs: 30_000, verificationTimeoutMs: 30_000 })
  let wrote = false
  ctx.llm.registerAdapter(['mock'], new class extends MockAdapter {
    override async *stream(options: Parameters<MockAdapter['stream']>[0]) {
      if (!wrote) {
        const worker = ctx.agents.list().find(agent => ctx.agentTeams.tryMembership(agent)?.role === 'teammate')!
        const cwd = worker.session.header.cwd!
        await writeFile(join(cwd, 'shared.txt'), 'batch\n')
        await runGit(cwd, ['add', 'shared.txt'], new AbortController().signal, 30_000)
        await runGit(cwd, ['commit', '-m', 'batch artifact'], new AbortController().signal, 30_000)
        wrote = true
      }
      yield* super.stream(options)
    }
  }([textResponse('Committed batch artifact and verified it.'), textResponse('Lead acknowledgement')]))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, workspaceOperatorId: lead.id,
    execution: { ...execution, maxRepairAttempts: 0, health: { dshDeadlineMs: 1_000, externalDeadlineMs: 1_000, escalationCooldownMs: 1_000, maxEscalationsPerCondition: 2 } } })
  cleanup.push(() => running.close())
  await running.planWorkspaceBatch(lead, { id: 'code-batch', name: 'verified code', items: [{ id: 'code', projectId: 'project', teamId: lead.id, subject: 'Batch code', description: 'Commit the batch artifact' }] })
  const task = ctx.agentTeams.listTasks(lead).find(candidate => candidate.subject === 'Batch code')!
  expect(task.workflowBinding).toMatchObject({ executionId: 'code-batch', stepId: 'code' })
  expect(task.nonCodeCriteria).toBeUndefined()
  expect(task.reviewGate).toBeUndefined()
  const attempt = running.view().attempts.find(candidate => candidate.taskId === task.id)!
  await vi.waitFor(() => expect(ctx.agents.get(SessionId(attempt.runtimeId))).toBeUndefined(), { timeout: 5_000 })
  await running.reconcile()
  const submission = running.view().submissions.find(candidate => candidate.taskId === task.id)!
  expect(submission.phase).toBe('accepted')
  expect(ctx.agentTeams.listIntegrations(lead)).toContainEqual(expect.objectContaining({ id: submission.integrationId, phase: 'merged' }))
  expect(running.workspaceDashboard(lead).integrations).toContainEqual(expect.objectContaining({
    integrationId: submission.integrationId, projectId: 'project', teamId: lead.id, phase: 'merged', sourceCommit: submission.sourceCommit,
  }))
  expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('completed')
  expect(running.inspectWorkspaceBatch(lead, 'code-batch')).toMatchObject({ phase: 'completed', completedRequired: 1 })
  expect((await git('show', 'main:shared.txt')).stdout).toBe('batch')
  await running.close()
  const restored = await WorkspaceCoordinator.open(ctx, { ...config, workspaceOperatorId: lead.id, execution })
  cleanup.push(() => restored.close())
  expect(restored.inspectWorkspaceBatch(lead, 'code-batch')).toMatchObject({ phase: 'completed', completedRequired: 1 })
})

it('requires registered exact Lead authority before admission and prevents cross-project grants', async () => {
  const { ctx, lead, coordinator, request } = await fixture()
  await expect(coordinator.acceptTask(lead, 'project', { subject: 'No grant', description: 'Reject' })).rejects.toThrow(/registered/)
  const other = ctx.agentLoop.create(SessionId('unrelated'), { provider: 'mock', model: 'mock' })
  await expect(coordinator.register(lead, { ...request, teamIds: [other.id] })).rejects.toThrow(/own.*team/i)
  await coordinator.register(lead, request)
  await expect(coordinator.acceptTask(other, 'project', { subject: 'Wrong team', description: 'Reject' })).rejects.toThrow(/authorized/)
  await expect(coordinator.acceptTask({ ...lead } as typeof lead, 'project', { subject: 'Fabricated', description: 'Reject' })).rejects.toThrow(/exact.*Lead/)
  expect(ctx.agentTeams.listTasks(lead)).toEqual([])
})

it('persists pause across restart, excludes paused ready work, and rejects stale operator revisions', async () => {
  const { root, ctx, lead, config, coordinator, request } = await fixture()
  await coordinator.register(lead, request)
  await coordinator.acceptTask(lead, 'project', { subject: 'Paused', description: 'Must remain visible' })
  await coordinator.pause(lead, 'project', 0, true)
  await expect(coordinator.pause(lead, 'project', 0, false)).rejects.toThrow(/revision/)
  await coordinator.close()
  await ctx.fiber.dispose()
  const restored = await WorkspaceCoordinator.open(await stack(root), config)
  cleanup.push(() => restored.close())
  expect(restored.view().readyTasks).toEqual([])
  expect(restored.view().dispatchStatus[0]).toMatchObject({ state: 'waiting', blockers: expect.arrayContaining([
    { code: 'paused', detail: expect.any(String) }, { code: 'execution-disabled', detail: expect.any(String) },
  ]) })
  expect(restored.view().projects[0]).toMatchObject({ paused: true, controlRevision: 1, teams: [{ tasks: [{ subject: 'Paused' }] }] })
})

it('records missing registered sessions as durable deduplicated reconciliation failures', async () => {
  const { config, coordinator, request, ctx } = await fixture()
  await coordinator.close()
  const catalog = await ProjectCatalog.open(config.directory)
  await catalog.register({ ...request, teamIds: ['missing-session'] })
  await catalog.close()
  const restored = await WorkspaceCoordinator.open(ctx, config)
  cleanup.push(() => restored.close())
  expect(restored.view().projects[0].teams[0]).toMatchObject({ teamId: 'missing-session', status: 'unavailable' })
  const before = await readFile(join(config.directory, 'coordinator.jsonl'), 'utf8')
  expect(before).toContain('team/reconciliation')
  await restored.reconcile()
  expect(await readFile(join(config.directory, 'coordinator.jsonl'), 'utf8')).toBe(before)
})

it('rejects two coordinator owners, releases on close, and refuses subsequent admission', async () => {
  const { ctx, lead, config, coordinator } = await fixture()
  const duplicate = WorkspaceCoordinator.open(ctx, config).then(value => { cleanup.push(() => value.close()); return value })
  await expect(duplicate).rejects.toThrow(/already owned/)
  await coordinator.close()
  await expect(coordinator.acceptTask(lead, 'project', { subject: 'Closed', description: 'Reject' })).rejects.toThrow(/closed/)
  const reopened = await WorkspaceCoordinator.open(ctx, config)
  cleanup.push(() => reopened.close())
  expect(reopened.view().projects).toEqual([])
})

it('rejects an unclampable shutdown deadline before acquiring coordinator ownership', async () => {
  const { ctx, config, coordinator } = await fixture()
  await coordinator.close()
  await expect(WorkspaceCoordinator.open(ctx, { ...config, shutdownDeadlineMs: 2_147_483_648 })).rejects.toThrow(/maximum timer delay/)
  const reopened = await WorkspaceCoordinator.open(ctx, config)
  cleanup.push(() => reopened.close())
})

it('mounts the server plugin with awaited startup and releases its service and ownership on disposal', async () => {
  const { ctx, config, coordinator } = await fixture()
  await coordinator.close()
  const fiber = await ctx.plugin(CoordinatorPlugin, { ...config, scanIntervalMs: 60_000 })
  expect(ctx.workspaceCoordinator.view().projects).toEqual([])
  const id = ctx.workspaceCoordinator.view().id
  await fiber.dispose()
  expect(ctx.workspaceCoordinator).toBeUndefined()
  const reopened = await WorkspaceCoordinator.open(ctx, config)
  cleanup.push(() => reopened.close())
  expect(reopened.view().id).toBe(id)
})

const execution = { modelProvider: 'mock', model: 'mock', maxConcurrent: 2 }
it('restores a Lead-scoped health inbox and acknowledges it with a durable revision fence', async () => {
  const { config, coordinator, lead, request, ctx } = await fixture()
  await coordinator.register(lead, request)
  await coordinator.close()
  const healthConfig = { dshDeadlineMs: 1, externalDeadlineMs: 1, escalationCooldownMs: 10, maxEscalationsPerCondition: 2 }
  const health = await HealthStore.open(config.directory, healthConfig)
  await health.assess({ attemptId: 'health-attempt', generation: 1, provider: 'dsh', work: { projectId: 'project', teamId: lead.id, taskId: 'task-health', state: 'active' }, runtime: { availability: 'available', execution: 'known-active-operation' } }, 0)
  const escalation = (await health.assess({ attemptId: 'health-attempt', generation: 1, provider: 'dsh', work: { projectId: 'project', teamId: lead.id, taskId: 'task-health', state: 'active' }, runtime: { availability: 'available', execution: 'known-active-operation' } }, 1)).escalation!
  await health.close()
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, health: healthConfig } })
  cleanup.push(() => running.close())
  expect(running.healthInbox(lead, 'project')[0]?.id).toBe(escalation.id)
  expect(running.healthInbox(lead, 'project')[0]?.acknowledgement).toBeUndefined()
  await expect(running.acknowledgeHealth(lead, 'project', escalation.id, escalation.revision + 1)).rejects.toThrow(/revision/i)
  expect(await running.acknowledgeHealth(lead, 'project', escalation.id, escalation.revision)).toMatchObject({ acknowledgement: { actor: lead.id } })
  await running.close()
  const restored = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, health: healthConfig } })
  cleanup.push(() => restored.close())
  expect(restored.healthInbox(lead, 'project')[0]).toMatchObject({ id: escalation.id, acknowledgement: { actor: lead.id } })
})

it('nudges one exact stale live tool only after its durable provider deadline', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture()
  await coordinator.register(lead, request)
  await coordinator.acceptTask(lead, 'project', { subject: 'Live long tool', description: 'Retain one host-owned operation' })
  await coordinator.close()
  let started!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  ctx.tools.register(defineContentToolFixture({ name: 'coordinator_health_long_tool', description: 'controlled operation', parameters: {},
    async execute() { started(); await blocked; return [{ type: 'text', text: 'released' }] },
  }))
  ctx.llm.registerAdapter(['mock'], new MockAdapter([toolCallResponse('coordinator-health-live', 'coordinator_health_long_tool', {})]))
  let now = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    const health = { dshDeadlineMs: 5, externalDeadlineMs: 5, escalationCooldownMs: 1_000, maxEscalationsPerCondition: 2, recovery: { maxNudges: 1 } }
    const running = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, health } })
    cleanup.push(() => running.close())
    await entered
    const active = running.view().attempts[0]!
    await running.reconcile()
    expect(running.view().health[0]).toMatchObject({ classification: 'progressing', lastProgress: { source: 'provider', cursor: 'operation:coordinator-health-live' } })
    expect(running.view().attempts[0]?.recovery).toBeUndefined()
    now = 6
    await running.pause(lead, 'project', 0, true)
    await running.reconcile()
    expect(running.view().attempts[0]?.recovery).toBeUndefined()
    await running.pause(lead, 'project', 1, false)
    await running.reconcile()
    await vi.waitFor(() => expect(running.view().attempts[0]?.healthRecovery).toMatchObject({ count: 1, messageId: expect.stringMatching(/^health-nudge-/) }))
    const recovered = running.view().attempts[0]!
    const messages = lead.session.snapshotEvents().filter(event => event.type === 'team/message/queued' && event.data.message.id === recovered.healthRecovery!.messageId)
    expect(messages).toHaveLength(1)
    await running.reconcile()
    expect(running.view().attempts[0]?.healthRecovery).toEqual(recovered.healthRecovery)
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/message/queued' && event.data.message.id === recovered.healthRecovery!.messageId)).toHaveLength(1)
  } finally { clock.mockRestore(); release?.() }
})

it('keeps scanning independent projects when a later stale revision exhausts the health nudge budget', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture()
  const other = await gitFixture(root => cleanup.push(() => rm(root, { recursive: true, force: true })))
  const otherLead = ctx.agentLoop.create(SessionId('independent-team'), { provider: 'mock', model: 'mock' }, { cwd: other.repository })
  await coordinator.register(lead, request)
  await coordinator.register(otherLead, { ...request, id: 'independent-project', repository: other.repository, teamIds: [otherLead.id] })
  await coordinator.acceptTask(lead, 'project', { subject: 'Live long tool', description: 'Retain one host-owned operation' })
  await coordinator.close()
  let started!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  ctx.tools.register(defineContentToolFixture({ name: 'coordinator_health_budget_tool', description: 'controlled operation', parameters: {},
    async execute() { started(); await blocked; return [{ type: 'text', text: 'released' }] },
  }))
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    toolCallResponse('coordinator-health-budget', 'coordinator_health_budget_tool', {}), 'hang',
  ]))
  let now = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    const health = { dshDeadlineMs: 5, externalDeadlineMs: 5, escalationCooldownMs: 1_000, maxEscalationsPerCondition: 2, recovery: { maxNudges: 1 } }
    const running = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, health } })
    cleanup.push(() => running.close())
    await entered
    now = 6
    await running.reconcile()
    await vi.waitFor(() => expect(running.view().attempts.find(attempt => attempt.projectId === 'project')?.healthRecovery).toMatchObject({
      count: 1, messageId: expect.stringMatching(/^health-nudge-/),
    }))
    const first = running.view().attempts.find(attempt => attempt.projectId === 'project')!
    const nudgeMessages = () => lead.session.snapshotEvents().filter(event => event.type === 'team/message/queued' && event.data.message.id.startsWith('health-nudge-'))
    const recoveryStore = (running as unknown as { execution: { healthRecovery: HealthRecoveryStore } }).execution.healthRecovery
    expect(nudgeMessages()).toHaveLength(1)
    expect(recoveryStore.list()).toHaveLength(1)
    const initialEscalation = running.healthInbox(lead, 'project').find(item => item.attemptId === first.attemptId && item.condition === 'stale')
    expect(initialEscalation).toBeDefined()
    expect(initialEscalation?.resolution).toBeUndefined()

    // A distinct diagnostic is a new authoritative stale health revision for the
    // same live operation. It must consume no second mailbox delivery once the
    // generation's one-nudge budget has been durably reserved.
    now = 7
    const healthStore = (running as unknown as { execution: { health: HealthStore } }).execution.health
    await healthStore.assess({ attemptId: first.attemptId, generation: first.generation, provider: 'dsh',
      work: { projectId: 'project', teamId: lead.id, taskId: first.taskId, state: 'active' },
      runtime: { availability: 'available', execution: 'known-active-operation' },
      progress: { source: 'provider', cursor: 'operation:coordinator-health-budget' }, diagnostic: 'fixture observed unchanged stale tool with a later health revision',
    }, now)
    const revised = running.view().health.find(item => item.attemptId === first.attemptId)!
    expect(revised).toMatchObject({ classification: 'stale' })
    expect(revised.revision).toBeGreaterThan(2)

    // Admit this task directly to the other Lead log so it first becomes ready
    // in the same coordinator scan that sees the exhausted nudge budget.
    const independent = await ctx.agentTeams.createTask(otherLead, { subject: 'Independent work', description: 'Must not be starved by another project health incident' })
    const intent = vi.spyOn(recoveryStore, 'intent')
    await running.reconcile()
    expect(intent).toHaveBeenCalledWith(expect.objectContaining({ attemptId: first.attemptId, generation: first.generation, healthRevision: revised.revision, condition: 'stale', maxNudges: 1 }))
    expect(recoveryStore.list()).toHaveLength(1)
    expect(running.view().attempts).toContainEqual(expect.objectContaining({ projectId: 'independent-project', teamId: otherLead.id, taskId: independent.id, phase: 'active' }))
    expect(running.healthInbox(lead, 'project').find(item => item.id === initialEscalation!.id)?.resolution).toBeUndefined()
    expect(nudgeMessages()).toHaveLength(1)
  } finally { clock.mockRestore(); release?.() }
})

it('does not nudge an unavailable runtime even when host health recovery is enabled', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture()
  await coordinator.register(lead, request)
  await coordinator.acceptTask(lead, 'project', { subject: 'Stale worker', description: 'Requires a bounded host recovery nudge' })
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang', 'hang']))
  let now = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    const health = { dshDeadlineMs: 5, externalDeadlineMs: 5, escalationCooldownMs: 1_000, maxEscalationsPerCondition: 2, recovery: { maxNudges: 1 } }
    const running = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, health } })
    cleanup.push(() => running.close())
    const active = running.view().attempts[0]!
    expect(active.phase).toBe('active')
    now = 6
    await running.reconcile()
    expect(running.view().health[0]).toMatchObject({ classification: 'unavailable', certainty: 'uncertain' })
    expect(running.view().attempts[0]?.recovery).toBeUndefined()
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/message/queued' && event.data.message.id.startsWith('health-nudge-'))).toHaveLength(0)
  } finally { clock.mockRestore() }
})

it('automatically dispatches durable independent work and keeps the worker report separate from task acceptance', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture()
  await coordinator.register(lead, request)
  const task = await coordinator.acceptTask(lead, 'project', { subject: 'Automatic worker', description: 'Report after isolated execution' })
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Worker report'), textResponse('Lead acknowledgement')]))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution })
  cleanup.push(() => running.close())
  expect(running.view().attempts).toHaveLength(1)
  const attempt = running.view().attempts[0]!
  expect(attempt.phase).toBe('active')
  await expect(ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'complete', result: 'text is not integration' })).rejects.toMatchObject({ code: 'TEAM_MANAGED_TASK' })
  await vi.waitFor(() => { expect(ctx.agents.get(SessionId(attempt.runtimeId))).toBeUndefined() })
  await running.reconcile()
  expect(running.view().attempts[0]).toMatchObject({ phase: 'terminal', result: 'Worker report' })
  expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('pending')
  expect(running.view().dispatchStatus[0]).toMatchObject({ state: 'finished', attemptId: attempt.attemptId, blockers: [{ code: 'awaiting-acceptance', detail: expect.any(String) }] })
  await expect(ctx.agentTeams.sendMessage(lead, { target: attempt.attemptId, content: [{ type: 'text', text: 'stale wakeup' }], delivery: 'wakeup', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_FENCED' })
  await running.reconcile()
  expect(running.view().attempts).toHaveLength(1)
  await running.close()
  const discoveryOnly = await WorkspaceCoordinator.open(ctx, config)
  cleanup.push(() => discoveryOnly.close())
  await expect(ctx.agentTeams.sendMessage(lead, { target: attempt.attemptId, content: [{ type: 'text', text: 'disabled execution must retain fencing' }], delivery: 'wakeup', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_FENCED' })
})

it('restores an unopened registered Lead under execution policy and automatically admits its ready task', async () => {
  const { root, ctx, lead, coordinator, request, config } = await fixture()
  await coordinator.register(lead, request)
  await coordinator.acceptTask(lead, 'project', { subject: 'Cold dispatch', description: 'No browser resumes this Lead' })
  await coordinator.close()
  await ctx.fiber.dispose()
  const restored = await stack(root)
  restored.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  expect(restored.agents.list()).toHaveLength(0)
  const running = await WorkspaceCoordinator.open(restored, { ...config, execution })
  cleanup.push(() => running.close())
  expect(running.view().attempts).toHaveLength(1)
  expect(restored.agents.get(SessionId(running.view().attempts[0]!.runtimeId))).toBeDefined()
  expect(restored.agentTeams.listMembers(restored.agents.get(lead.id)!)).toHaveLength(2)
})

it('replays a workflow task creation crash through its Team-log admission key without duplicating the task or worker', async () => {
  const { root, ctx, lead, coordinator, request, config } = await fixture()
  await coordinator.register(lead, request)
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution })
  cleanup.push(() => running.close())
  const original = ctx.agentTeams.createPinnedTask.bind(ctx.agentTeams)
  const sideEffect = vi.spyOn(ctx.agentTeams, 'createPinnedTask').mockImplementationOnce(async (caller, input) => {
    await original(caller, input)
    throw new Error('crash after Team task side effect')
  })
  await expect(running.createWorkflow(lead, { projectId: 'project', teamId: lead.id, templateId: 'investigation-report', templateVersion: 1,
    parameters: { question: 'Why is restart safe?' }, executionId: 'workflow-crash-window' })).rejects.toThrow(/crash after Team task side effect/)
  const task = ctx.agentTeams.listTasks(lead).find(task => task.subject === 'Investigate Why is restart safe?')!
  expect(task).toBeDefined()
  expect(task.workflowBinding).toEqual({ executionId: 'workflow-crash-window', stepId: 'investigate', inputs: [] })
  expect(running.inspectWorkflow(lead, 'workflow-crash-window').steps[0]).toMatchObject({ stepId: 'investigate', phase: 'pending' })
  sideEffect.mockRestore()
  await running.close()
  await ctx.fiber.dispose()

  const restoredCtx = await stack(root)
  restoredCtx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  const restored = await WorkspaceCoordinator.open(restoredCtx, { ...config, execution })
  cleanup.push(() => restored.close())
  const restoredLead = restoredCtx.agents.get(SessionId(lead.id))!
  await restored.resumeWorkflow(restoredLead, 'workflow-crash-window')
  const restoredTask = restoredCtx.agentTeams.listTasks(restoredLead).filter(value => value.id === task.id)
  expect(restoredTask).toHaveLength(1)
  expect(restoredTask[0]?.workflowBinding).toEqual(task.workflowBinding)
  expect(restored.view().workflows[0]!.steps).toContainEqual(expect.objectContaining({ stepId: 'investigate', taskId: task.id, phase: 'running' }))
  const attempts = restored.view().attempts.filter(attempt => attempt.taskId === task.id)
  expect(attempts).toHaveLength(1)
  expect(attempts[0]?.checkpoint).toMatchObject({ workflowId: 'workflow-crash-window', workflowStep: 'investigate', step: 'implement', artifacts: [] })
})

it('rejects model-facing attempts to forge or mutate a host-only workflow binding', async () => {
  const { ctx, lead } = await fixture()
  const binding = { executionId: 'forged-execution', stepId: 'forged-step', inputs: [] }
  expect(() => createTaskSchema.parse({ subject: 'Forged', description: 'Must be rejected', workflowBinding: binding })).toThrow()
  expect(() => updateTaskSchema.parse({ taskId: 'task-1', expectedRevision: 1, action: 'edit', workflowBinding: binding })).toThrow()
  await expect(ctx.agentTeams.createTask(lead, { subject: 'Forged', description: 'Must be rejected', workflowBinding: binding } as never)).rejects.toThrow(/host-only/i)
  const task = await ctx.agentTeams.createTask(lead, { subject: 'Ordinary', description: 'No workflow authority' })
  await expect(ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'edit', subject: 'Still ordinary', workflowBinding: binding } as never)).rejects.toThrow(/host-only/i)
  expect(ctx.agentTeams.getTask(lead, task.id).workflowBinding).toBeUndefined()
})

it('pins the code review gate in the Team task before the workflow can acknowledge task creation', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture()
  await coordinator.register(lead, request)
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution })
  cleanup.push(() => running.close())
  const original = ctx.agentTeams.createPinnedTask.bind(ctx.agentTeams)
  const sideEffect = vi.spyOn(ctx.agentTeams, 'createPinnedTask').mockImplementationOnce(async (caller, input) => {
    await original(caller, input)
    throw new Error('crash after gated Team task side effect')
  })
  await expect(running.createWorkflow(lead, { projectId: 'project', teamId: lead.id, templateId: 'implementation-test-review-integration', templateVersion: 1,
    parameters: { subject: 'gate crash fence' }, executionId: 'gated-crash-window' })).rejects.toThrow(/gated Team task side effect/)
  const task = ctx.agentTeams.listTasks(lead).find(value => value.subject === 'Implement gate crash fence')!
  expect(task).toMatchObject({ reviewGate: 'workflow-gated-crash-window-implement', status: 'pending' })
  expect(task.workflowBinding).toEqual({ executionId: 'gated-crash-window', stepId: 'implement', inputs: [] })
  expect(task.nonCodeCriteria).toBeUndefined()
  expect(running.inspectWorkflow(lead, 'gated-crash-window').steps[0]).toMatchObject({ stepId: 'implement', phase: 'pending' })
  sideEffect.mockRestore()
  await running.resumeWorkflow(lead, 'gated-crash-window')
  expect(ctx.agentTeams.listTasks(lead).filter(value => value.id === task.id)).toHaveLength(1)
  expect(running.inspectWorkflow(lead, 'gated-crash-window').steps[0]).toMatchObject({ taskId: task.id, phase: 'running' })
  expect(running.view().attempts.find(attempt => attempt.taskId === task.id)?.checkpoint).toMatchObject({ workflowId: 'gated-crash-window', workflowStep: 'implement', step: 'implement', artifacts: [] })
})

it('carries the exact candidate inputs from a host-pinned reviewer task into its assignment checkpoint', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture()
  await coordinator.register(lead, request)
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution })
  cleanup.push(() => running.close())
  const source = 'a'.repeat(40), candidate = 'b'.repeat(40)
  const host = (running as unknown as { execution: CoordinatorExecution }).execution
  const created = await host.createPinnedWorkflowTask({ intentId: 'reviewer-binding', projectId: 'project', teamId: lead.id, executionId: 'review-workflow', stepId: 'review',
    subject: 'Review candidate', description: 'Review the exact verified candidate.', nonCodeCriteria: 'Review candidate evidence.',
    inputs: [{ name: 'source', artifact: { kind: 'commit', ref: source } }, { name: 'candidate', artifact: { kind: 'commit', ref: candidate } }],
    review: { integrationId: 'integration-review', sourceCommit: source, targetCommit: source, candidateCommit: candidate, reviewGate: 'review-gate' } })
  await running.reconcile()
  const task = ctx.agentTeams.getTask(lead, created.taskId as never)
  expect(task.workflowBinding).toEqual({ executionId: 'review-workflow', stepId: 'review', inputs: [{ name: 'source', artifact: { kind: 'commit', ref: source } }, { name: 'candidate', artifact: { kind: 'commit', ref: candidate } }] })
  expect(task.reviewBinding).toMatchObject({ executionId: 'review-workflow', sourceCommit: source, candidateCommit: candidate, reviewGate: 'review-gate' })
  await vi.waitFor(() => expect(running.view().attempts.find(attempt => attempt.taskId === created.taskId)).toBeDefined())
  expect(running.view().attempts.find(attempt => attempt.taskId === created.taskId)?.checkpoint).toMatchObject({ workflowId: 'review-workflow', workflowStep: 'review', step: 'implement', artifacts: [{ kind: 'commit', ref: source }, { kind: 'commit', ref: candidate }] })
})

it('accepts the first workflow report, hands its evidence to a fresh second-step worker, and keeps both concrete task bindings', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture()
  await coordinator.register(lead, request)
  await coordinator.close()
  const adapter = new MockAdapter([
    textResponse('The credential expired at 10:42 UTC.'), textResponse('The credential expired at 10:42 UTC.'),
    textResponse('The review confirms the expiry evidence.'), textResponse('The review confirms the expiry evidence.'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution })
  cleanup.push(() => running.close())
  const workflow = await running.createWorkflow(lead, { projectId: 'project', teamId: lead.id, templateId: 'investigation-report', templateVersion: 1,
    parameters: { question: 'Why did access fail?' }, executionId: 'workflow-handoff' })
  const firstTask = workflow.steps[0]!.taskId!
  const activeFirst = running.view().attempts.find(attempt => attempt.taskId === firstTask)!
  await vi.waitFor(() => expect(ctx.agents.get(SessionId(activeFirst.runtimeId))).toBeUndefined())
  await running.reconcile()
  await vi.waitFor(() => expect(running.view().attempts.find(attempt => attempt.taskId === firstTask)).toMatchObject({ phase: 'terminal', result: 'The credential expired at 10:42 UTC.' }))
  const first = running.view().attempts.find(attempt => attempt.taskId === firstTask)!
  await running.acceptReport(lead, 'project', { attemptId: first.attemptId, generation: first.generation, expectedRevision: first.revision,
    expectedTaskRevision: ctx.agentTeams.getTask(lead, firstTask).revision, rationale: 'The report identifies a specific expiry time.' })
  await vi.waitFor(() => expect(running.inspectWorkflow(lead, 'workflow-handoff').steps).toContainEqual(expect.objectContaining({ stepId: 'report', phase: 'running', taskId: expect.any(String) })))
  const restored = running.inspectWorkflow(lead, 'workflow-handoff')
  const secondTask = restored.steps.find(step => step.stepId === 'report')!.taskId!
  await vi.waitFor(() => expect(running.view().attempts.filter(attempt => attempt.taskId === secondTask)).toHaveLength(1))
  const second = running.view().attempts.find(attempt => attempt.taskId === secondTask)!
  expect(second.runtimeId).not.toBe(first.runtimeId)
  const secondBinding = ctx.agentTeams.getTask(lead, secondTask).workflowBinding
  expect(secondBinding).toMatchObject({ executionId: 'workflow-handoff', stepId: 'report', inputs: [{ name: 'findings', artifact: { kind: 'report' } }] })
  expect(second.checkpoint).toMatchObject({ workflowId: 'workflow-handoff', workflowStep: 'report', step: 'implement', artifacts: [secondBinding!.inputs[0]!.artifact] })
  expect(restored.steps).toMatchObject([{ stepId: 'investigate', taskId: firstTask, phase: 'completed' }, { stepId: 'report', taskId: secondTask, phase: 'running' }])
  const prompts = adapter.requests.map(request => request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n'))
  expect(prompts.some(prompt => prompt.includes('The credential expired at 10:42 UTC.') && prompt.includes('The report identifies a specific expiry time.'))).toBe(true)
  await vi.waitFor(() => expect(ctx.agents.get(SessionId(second.runtimeId))).toBeUndefined())
  await running.reconcile()
  const terminalSecond = running.view().attempts.find(attempt => attempt.taskId === secondTask)!
  expect(terminalSecond).toMatchObject({ phase: 'terminal', result: 'The review confirms the expiry evidence.' })
  await running.acceptReport(lead, 'project', { attemptId: terminalSecond.attemptId, generation: terminalSecond.generation, expectedRevision: terminalSecond.revision,
    expectedTaskRevision: ctx.agentTeams.getTask(lead, secondTask).revision, rationale: 'The final review confirms the accepted investigation evidence.' })
  await vi.waitFor(() => expect(running.inspectWorkflow(lead, 'workflow-handoff').steps.every(step => step.phase === 'completed')).toBe(true))
  await running.reconcile()
  expect(await running.resumeWorkflow(lead, 'workflow-handoff')).toBeUndefined()
  expect(ctx.agentTeams.listTasks(lead).filter(task => task.subject.includes('access fail'))).toHaveLength(2)
  expect(running.view().attempts).toHaveLength(2)
})

it('releases a reservation when policy validation fails before runtime start and lets unrelated work run', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture()
  await coordinator.register(lead, request)
  await coordinator.acceptTask(lead, 'project', { subject: 'Wrong model', description: 'Must fail before creating a worker' })
  const other = await gitFixture(root => cleanup.push(() => rm(root, { recursive: true, force: true })))
  const healthy = ctx.agentLoop.create(SessionId('healthy-team'), { provider: 'mock', model: 'healthy' }, { cwd: other.repository })
  await coordinator.register(healthy, { ...request, id: 'healthy', teamIds: [healthy.id], repository: other.repository })
  await coordinator.acceptTask(healthy, 'healthy', { subject: 'Healthy task', description: 'Should not be starved by failed policy validation' })
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, model: 'healthy', maxConcurrent: 1 } })
  cleanup.push(() => running.close())
  expect(running.view().attempts).toEqual([
    expect.objectContaining({ projectId: 'project', phase: 'terminal', stopEvidence: expect.objectContaining({ kind: 'never-started' }) }),
    expect.objectContaining({ projectId: 'healthy', phase: 'active' }),
  ])
  expect(running.view().executionBlocks).toEqual([expect.objectContaining({ projectId: 'project', diagnostic: expect.stringContaining('model') })])
  expect(running.view().dispatchStatus.find(status => status.projectId === 'project')).toMatchObject({ state: 'finished', blockers: expect.arrayContaining([{ code: 'execution-failure', detail: expect.any(String) }, { code: 'recovery-required', detail: expect.any(String) }]) })
  const before = await readFile(join(config.directory, 'execution.jsonl'), 'utf8')
  await running.reconcile()
  expect(await readFile(join(config.directory, 'execution.jsonl'), 'utf8')).toBe(before)
})

it('persists authorized priority while execution is disabled and paces concurrent reconciliation', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture()
  await coordinator.register(lead, request)
  const first = await coordinator.acceptTask(lead, 'project', { subject: 'First', description: 'Normal priority' })
  const urgent = await coordinator.acceptTask(lead, 'project', { subject: 'Urgent', description: 'Selected first' })
  const outsider = ctx.agentLoop.create(SessionId('outside-priority'), { provider: 'mock', model: 'mock' })
  await expect(coordinator.reprioritize(outsider, 'project', urgent.id, 1, 100)).rejects.toThrow(/authorized/)
  await coordinator.reprioritize(lead, 'project', urgent.id, 1, 100)
  await expect(coordinator.reprioritize(lead, 'project', urgent.id, 1, 10)).rejects.toThrow(/Stale/)
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, dispatchIntervalMs: 60_000 } })
  cleanup.push(() => running.close())
  expect(running.view().attempts).toEqual([expect.objectContaining({ taskId: urgent.id, phase: 'active' })])
  expect(running.view().dispatchRequests.map(request => request.taskId)).toEqual([first.id, urgent.id])
  await Promise.all([running.reconcile(), running.reconcile(), running.reconcile()])
  expect(running.view().attempts).toHaveLength(1)
  expect(running.view().dispatchStatus.find(status => status.taskId === first.id)).toMatchObject({ state: 'waiting', nextDispatchAt: expect.any(Number), blockers: [{ code: 'pacing', detail: expect.any(String) }] })
  await expect(running.reprioritize(lead, 'project', urgent.id, 2, 0)).rejects.toThrow(/Attempt already exists/)
})

it('retains ownership and fences admission after failed shutdown, then releases ownership on a later close', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture()
  await coordinator.register(lead, request)
  await coordinator.acceptTask(lead, 'project', { subject: 'Shutdown recovery', description: 'Keep ownership until the worker stops' })
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution })
  cleanup.push(() => running.close())
  const attempt = running.view().attempts[0]!
  const originalDrain = ctx.subagents.drainContinuableChildren.bind(ctx.subagents)
  const drain = vi.spyOn(ctx.subagents, 'drainContinuableChildren')
    .mockRejectedValueOnce(new Error('provider shutdown observation failed'))
    .mockImplementation(originalDrain)
  await expect(running.close()).rejects.toThrow('provider shutdown observation failed')
  expect(ctx.agents.get(SessionId(attempt.runtimeId))).toBeDefined()
  await expect(WorkspaceCoordinator.open(ctx, config)).rejects.toThrow(/already owned/)
  await expect(running.reconcile()).rejects.toThrow(/closed/)
  await expect(running.acceptTask(lead, 'project', { subject: 'Late admission', description: 'Reject during shutdown' })).rejects.toThrow(/closed/)
  await expect(ctx.agentTeams.sendMessage(lead, { target: attempt.attemptId, content: [{ type: 'text', text: 'late wakeup' }], delivery: 'wakeup', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_FENCED' })
  await Promise.all([running.close(), running.close()])
  expect(drain).toHaveBeenCalledTimes(2)
  expect(ctx.agents.get(SessionId(attempt.runtimeId))).toBeUndefined()
  drain.mockRestore()
  const reopened = await WorkspaceCoordinator.open(ctx, config)
  cleanup.push(() => reopened.close())
  expect(reopened.view().id).toBe(running.view().id)
})

it('bounds one whole coordinator close across two retained drains without releasing its lock', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture()
  const other = await gitFixture(root => cleanup.push(() => rm(root, { recursive: true, force: true })))
  const otherLead = ctx.agentLoop.create(SessionId('second-shutdown-team'), { provider: 'mock', model: 'mock' }, { cwd: other.repository })
  await coordinator.register(lead, request)
  await coordinator.register(otherLead, { ...request, id: 'second-shutdown-project', repository: other.repository, teamIds: [otherLead.id] })
  await coordinator.acceptTask(lead, 'project', { subject: 'First close drain', description: 'The first retained provider drain' })
  await coordinator.acceptTask(otherLead, 'second-shutdown-project', { subject: 'Second close drain', description: 'The second retained provider drain' })
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang', 'hang']))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, shutdownDeadlineMs: 50, execution: { ...execution, maxConcurrent: 2 } })
  cleanup.push(() => running.close())
  expect(running.view().attempts).toHaveLength(2)

  const firstEntered = Promise.withResolvers<void>(), secondEntered = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>(), releaseSecond = Promise.withResolvers<void>()
  let calls = 0
  const drain = vi.spyOn(ctx.subagents, 'drainContinuableChildren').mockImplementation(async () => {
    calls++
    if (calls === 1) { firstEntered.resolve(); await releaseFirst.promise }
    else { secondEntered.resolve(); await releaseSecond.promise }
  })
  vi.useFakeTimers()
  try {
    const timedOut = running.close()
    await firstEntered.promise
    await vi.advanceTimersByTimeAsync(50)
    await expect(timedOut).rejects.toThrow(/shutdown is unconfirmed/)
    await expect(WorkspaceCoordinator.open(ctx, config)).rejects.toThrow(/already owned/)

    const joined = running.close()
    expect(drain).toHaveBeenCalledTimes(1)
    releaseFirst.resolve()
    await secondEntered.promise
    expect(drain).toHaveBeenCalledTimes(2)
    releaseSecond.resolve()
    await joined
    const reopened = await WorkspaceCoordinator.open(ctx, config)
    cleanup.push(() => reopened.close())
  } finally {
    releaseFirst.resolve(); releaseSecond.resolve()
    vi.useRealTimers()
    drain.mockRestore()
  }
})

it('explains dependencies and both capacity limits using the same eligibility decision as dispatch', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture()
  await coordinator.register(lead, { ...request, capacity: 1 })
  const first = await coordinator.acceptTask(lead, 'project', { subject: 'Prerequisite', description: 'Occupies capacity' })
  const dependent = await coordinator.acceptTask(lead, 'project', { subject: 'Dependent', description: 'Requires acceptance', blockedBy: [first.id] })
  const queued = await coordinator.acceptTask(lead, 'project', { subject: 'Independent', description: 'Waits for capacity' })
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, maxConcurrent: 1 } })
  cleanup.push(() => running.close())
  const status = running.view().dispatchStatus
  expect(status.find(status => status.taskId === first.id)).toMatchObject({ state: 'assigned', blockers: [] })
  expect(status.find(status => status.taskId === dependent.id)).toMatchObject({ state: 'waiting', blockers: [
    { code: 'dependencies', detail: expect.stringContaining(first.id) },
    { code: 'global-capacity', detail: expect.any(String) },
    { code: 'project-capacity', detail: expect.any(String) },
  ] })
  expect(status.find(status => status.taskId === queued.id)).toMatchObject({ state: 'waiting', blockers: [
    { code: 'global-capacity', detail: expect.any(String) },
    { code: 'project-capacity', detail: expect.any(String) },
  ] })
  status[0]!.blockers.push({ code: 'paused', detail: 'Caller mutation' })
  expect(running.view().dispatchStatus[0]!.blockers).toEqual([])
  await running.reconcile()
  expect(running.view().attempts).toHaveLength(1)
})


it('exposes scoped model controls and strict Remote scheduling contracts with project authority', async () => {
  const { ctx, lead, coordinator, request } = await fixture()
  await coordinator.register(lead, request)
  const task = await coordinator.acceptTask(lead, 'project', { subject: 'Tool controlled', description: 'Persist priority and pause' })
  ctx.provide('workspaceCoordinator', coordinator)
  const plugin = await ctx.plugin(CoordinatorTools)
  let calls = 0
  const call = (name: string, args: unknown, agent = lead) => ctx.tools.execute({
    callId: ToolCallId(`scheduling-${++calls}`), name, arguments: args, agent, signal: new AbortController().signal,
  })
  const status = await call('team_dispatch_status', { project_id: 'project' })
  expect(status.isError).not.toBe(true)
  expect(JSON.parse(status.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')))
    .toMatchObject({ projectId: 'project', requests: [{ taskId: task.id, revision: 1 }] })
  const reports = await call('team_report_status', { project_id: 'project' })
  expect(reports.isError).not.toBe(true)
  expect(JSON.parse(reports.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toEqual([])
  expect((await call('team_dispatch_priority', { project_id: 'project', task_id: task.id, expected_revision: 1, priority: 50 })).isError).not.toBe(true)
  expect((await call('team_dispatch_priority', { project_id: 'project', task_id: task.id, expected_revision: 1, priority: 60 })).isError).toBe(true)
  expect((await call('team_dispatch_pause', { project_id: 'project', expected_revision: 0, paused: true })).isError).not.toBe(true)
  const remote = ctx.agentTeams.remoteScheduling(lead, { projectId: 'project' })
  expect(schedulingViewSchema.parse(remote)).toMatchObject({ paused: true, controlRevision: 1, requests: [{ priority: 50, revision: 2 }] })
  await expect(ctx.agentTeams.remoteControlScheduling(lead, { action: 'pause', projectId: 'project', expectedRevision: 0, paused: false })).rejects.toThrow(/revision/)
  await ctx.agentTeams.remoteControlScheduling(lead, { action: 'pause', projectId: 'project', expectedRevision: 1, paused: false })
  const outsider = ctx.agentLoop.create(SessionId('scheduling-outsider'), { provider: 'mock', model: 'mock' })
  expect(() => ctx.agentTeams.remoteScheduling(outsider, { projectId: 'project' })).toThrow(/authorized/)
  expect((await call('team_dispatch_status', { project_id: 'project' }, outsider)).isError).toBe(true)
  expect((await call('team_report_status', { project_id: 'project' }, outsider)).isError).toBe(true)
  expect(() => schedulingControlSchema.parse({ action: 'priority', projectId: 'project', taskId: task.id, expectedRevision: 2, priority: 0, injected: true })).toThrow()
  expect((await call('team_dispatch_cancel', { project_id: 'project', task_id: task.id, expected_revision: 2, reason: 'Tool cancellation' })).isError).not.toBe(true)
  expect(ctx.agentTeams.remoteScheduling(lead, { projectId: 'project' }).requests[0]!.cancelReason).toBe('Tool cancellation')
  await plugin.dispose()
})

it('persists queued cancellation across restart and never admits the cancelled work', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture()
  await coordinator.register(lead, request)
  const task = await coordinator.acceptTask(lead, 'project', { subject: 'Cancelled queue', description: 'Never start' })
  await coordinator.controlScheduling(lead, { action: 'cancel', projectId: 'project', taskId: task.id, expectedRevision: 1, reason: 'No longer needed' })
  await coordinator.close()
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution })
  cleanup.push(() => running.close())
  await running.reconcile()
  expect(running.view().attempts).toEqual([])
  expect(running.view().readyTasks).toEqual([])
  expect(running.view().dispatchStatus[0]).toMatchObject({ revision: 2, cancelReason: 'No longer needed', state: 'cancelled', blockers: [{ code: 'cancelled', detail: 'No longer needed' }] })
  await expect(running.reprioritize(lead, 'project', task.id, 2, 100)).rejects.toThrow(/cancelled/)
  expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('pending')
})

it('persists active cancellation before draining and reconciles failed shutdown even while paused', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture()
  await coordinator.register(lead, request)
  const task = await coordinator.acceptTask(lead, 'project', { subject: 'Active cancel', description: 'Preserve the stop intent' })
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, health: { dshDeadlineMs: 1_000, externalDeadlineMs: 2, escalationCooldownMs: 1_000, maxEscalationsPerCondition: 2 } } })
  cleanup.push(() => running.close())
  const attempt = running.view().attempts[0]!
  await running.pause(lead, 'project', 0, true)
  const original = ctx.subagents.drainContinuableChildren.bind(ctx.subagents)
  const drain = vi.spyOn(ctx.subagents, 'drainContinuableChildren').mockImplementationOnce(async () => {
    expect(running.view().dispatchRequests[0]!.cancelReason).toBe('Operator stop')
    throw new Error('Transient drain failure')
  }).mockImplementation(original)
  await expect(running.controlScheduling(lead, { action: 'cancel', projectId: 'project', taskId: task.id, expectedRevision: 1, reason: 'Operator stop' })).rejects.toThrow('Transient drain failure')
  expect(running.view().attempts[0]).toMatchObject({ phase: 'stopping' })
  expect(ctx.agents.get(SessionId(attempt.runtimeId))).toBeDefined()
  await expect(ctx.agentTeams.sendMessage(lead, { target: attempt.attemptId, content: [{ type: 'text', text: 'late wake' }], delivery: 'wakeup', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_FENCED' })
  await running.reconcile()
  expect(running.view().attempts[0]).toMatchObject({ phase: 'terminal', stopReason: 'Operator stop', stopEvidence: { kind: 'stopped' } })
  expect(running.view().health).toContainEqual(expect.objectContaining({ attemptId: attempt.attemptId, provider: 'dsh', deadlineMs: 1_000, classification: 'operator-wait' }))
  expect(running.healthInbox(lead, 'project')).toEqual([])
  expect(ctx.agents.get(SessionId(attempt.runtimeId))).toBeUndefined()
  drain.mockRestore()
  await running.pause(lead, 'project', 1, false)
  expect(running.view().attempts).toHaveLength(1)
})


it('replays a durable submission after failed integration admission without changing identity or policy', async () => {
  const { ctx, lead, coordinator, request, config, root } = await fixture(true)
  await coordinator.register(lead, request)
  await coordinator.acceptTask(lead, 'project', { subject: 'Submit artifact', description: 'Queue exact committed output' })
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Artifact ready'), textResponse('Lead acknowledgement')]))
  let unavailable = true
  const admitted: string[] = []
  ctx.agentTeams.registerIntegrationProvider({
    name: 'test',
    async resolve(worktree, id) {
      admitted.push(id)
      if (unavailable) throw new Error('Integration temporarily unavailable')
      return { repository: worktree.repository, cwd: join(root, id), sourceBranch: worktree.branch, sourceCommit: worktree.baseCommit,
        targetBranch: 'main' as typeof worktree.branch, verification: request.verification.commands }
    },
    async target(spec) { return spec.sourceCommit },
    async verify(spec) { return spec.sourceCommit },
    async promote() {},
  })
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution })
  cleanup.push(() => running.close())
  const active = running.view().attempts[0]!
  await vi.waitFor(() => { expect(ctx.agents.get(SessionId(active.runtimeId))).toBeUndefined() })
  await running.reconcile()
  const attempt = running.view().attempts[0]!
  const worktree = ctx.agentTeams.listMembers(lead).find(member => member.id === attempt.runtimeId)!.worktree!
  const submission = { attemptId: attempt.attemptId, generation: attempt.generation, expectedRevision: attempt.revision, sourceCommit: worktree.baseCommit, evidence: 'Artifact ready' }
  await expect(running.submit(lead, 'project', { ...submission, expectedRevision: 1 })).rejects.toThrow(/Stale/)
  const pending = running.view().submissions[0]!
  expect(pending).toMatchObject({ phase: 'pending', sourceCommit: worktree.baseCommit, verification: request.verification, evidence: submission.evidence })
  expect(ctx.agentTeams.listIntegrations(lead)).toEqual([])
  await running.close()
  unavailable = false
  const restored = await WorkspaceCoordinator.open(ctx, { ...config, execution })
  cleanup.push(() => restored.close())
  expect(restored.view().submissions).toEqual([{ ...pending, phase: 'accepted' }])
  expect(ctx.agentTeams.listIntegrations(lead)).toEqual([expect.objectContaining({ id: pending.integrationId, sourceCommit: pending.sourceCommit })])
  expect(admitted).toEqual([pending.integrationId, pending.integrationId])
  expect(await restored.submit(lead, 'project', submission)).toMatchObject({ id: pending.id, phase: 'accepted' })
  expect(ctx.agentTeams.listIntegrations(lead)).toHaveLength(1)
  await expect(restored.submit(lead, 'project', { ...submission, evidence: 'Changed evidence' })).rejects.toThrow(/immutable inputs/)
  await expect(restored.controlScheduling(lead, { action: 'cancel', projectId: 'project', taskId: attempt.taskId, expectedRevision: 1, reason: 'Too late for runtime cancellation' })).rejects.toThrow(/entered integration/)
  expect(ctx.agentTeams.getTask(lead, attempt.taskId).status).toBe('completed')
})


it.each([true, false])('automatically submits real worker output and protects acceptance/target on verification result %s', async (passes) => {
  const { ctx, lead, coordinator, request, config, git } = await fixture(true)
  const commands = [{ command: 'node', args: ['-e', passes ? "if(require('node:fs').readFileSync('shared.txt','utf8').trim()!=='worker')process.exit(1)" : 'process.exit(1)'] }]
  await coordinator.register(lead, { ...request, verification: { revision: 1, commands } })
  const task = await coordinator.acceptTask(lead, 'project', { subject: 'Actual artifact', description: 'Commit and verify worker output' })
  await coordinator.close()
  await ctx.plugin(GitIntegration, { providerName: 'test', targetBranch: 'main', verification: commands, commandTimeoutMs: 30_000, verificationTimeoutMs: 30_000 })
  let wrote = false
  ctx.llm.registerAdapter(['mock'], new class extends MockAdapter {
    override async *stream(options: Parameters<MockAdapter['stream']>[0]) {
      if (!wrote) {
        const worker = ctx.agents.list().find(agent => ctx.agentTeams.tryMembership(agent)?.role === 'teammate')!
        const cwd = worker.session.header.cwd!
        await writeFile(join(cwd, 'shared.txt'), 'worker\n')
        await runGit(cwd, ['add', 'shared.txt'], new AbortController().signal, 30_000)
        await runGit(cwd, ['commit', '-m', 'worker artifact'], new AbortController().signal, 30_000)
        wrote = true
      }
      yield* super.stream(options)
    }
  }([textResponse('Committed shared.txt and ready for verification'), textResponse('Lead acknowledgement')]))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, maxRepairAttempts: 0, health: { dshDeadlineMs: 1_000, externalDeadlineMs: 1_000, escalationCooldownMs: 1_000, maxEscalationsPerCondition: 2 } } })
  cleanup.push(() => running.close())
  const active = running.view().attempts[0]!
  await vi.waitFor(() => { expect(ctx.agents.get(SessionId(active.runtimeId))).toBeUndefined() })
  await running.reconcile()
  const submitted = running.view().submissions[0]!
  expect(submitted).toMatchObject({ phase: passes ? 'accepted' : 'queued', evidence: 'Committed shared.txt and ready for verification', verification: { revision: 1, commands } })
  expect(ctx.agentTeams.listIntegrations(lead)).toEqual([expect.objectContaining({ id: submitted.integrationId, sourceCommit: submitted.sourceCommit, phase: passes ? 'merged' : 'failed' })])
  expect((await git('show', 'main:shared.txt')).stdout).toBe(passes ? 'worker' : 'base')
  expect(ctx.agentTeams.getTask(lead, task.id).status).toBe(passes ? 'completed' : 'pending')
  expect(running.view().dispatchStatus[0]!.state).toBe(passes ? 'accepted' : 'finished')
  if (!passes) {
    expect(running.view().health).toContainEqual(expect.objectContaining({ attemptId: active.attemptId, classification: 'failed' }))
    expect(running.healthInbox(lead, 'project')).toContainEqual(expect.objectContaining({ attemptId: active.attemptId, condition: 'failed', severity: 'critical', diagnostics: expect.stringContaining('Integration ') }))
  }
  if (passes) {
    const accepted = ctx.agentTeams.getTask(lead, task.id)
    const job = ctx.agentTeams.listIntegrations(lead)[0]!
    expect(await ctx.agentTeams.acceptIntegratedTask(lead, { taskId: task.id, expectedRevision: 1, submissionId: submitted.id, integrationId: job.id })).toMatchObject({ revision: accepted.revision, status: 'completed' })
    await expect(ctx.agentTeams.acceptIntegratedTask(lead, { taskId: task.id, expectedRevision: accepted.revision, submissionId: 'unrelated-submission', integrationId: job.id })).rejects.toMatchObject({ code: 'TEAM_MANAGED_TASK' })
  }

  await running.reconcile()
  expect(running.view().submissions).toHaveLength(1)
  expect(ctx.agentTeams.listIntegrations(lead)).toHaveLength(1)
})

it('pins opt-in final-candidate retention across restart and removes the clean merged Git worktree only after its deadline', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture(true)
  const commands = [{ command: 'node', args: ['-e', "if(require('node:fs').readFileSync('shared.txt','utf8').trim()!=='retained')process.exit(1)"] }]
  await coordinator.register(lead, { ...request, verification: { revision: 1, commands } })
  await coordinator.acceptTask(lead, 'project', { subject: 'Retention artifact', description: 'Commit and clean after the configured delay' })
  await coordinator.close()
  await ctx.plugin(GitIntegration, { providerName: 'test', targetBranch: 'main', verification: commands, commandTimeoutMs: 30_000, verificationTimeoutMs: 30_000 })
  let wrote = false
  ctx.llm.registerAdapter(['mock'], new class extends MockAdapter {
    override async *stream(options: Parameters<MockAdapter['stream']>[0]) {
      if (!wrote) {
        const worker = ctx.agents.list().find(agent => ctx.agentTeams.tryMembership(agent)?.role === 'teammate')!
        const cwd = worker.session.header.cwd!
        await writeFile(join(cwd, 'shared.txt'), 'retained\n')
        await runGit(cwd, ['add', 'shared.txt'], new AbortController().signal, 30_000)
        await runGit(cwd, ['commit', '-m', 'retention artifact'], new AbortController().signal, 30_000)
        wrote = true
      }
      yield* super.stream(options)
    }
  }([textResponse('Committed retention artifact'), textResponse('Lead acknowledgement')]))
  const delayMs = 60_000
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, maxRepairAttempts: 0, candidateRetention: { delayMs, commandTimeoutMs: 30_000 } } })
  cleanup.push(() => running.close())
  const active = running.view().attempts[0]!
  await vi.waitFor(() => { expect(ctx.agents.get(SessionId(active.runtimeId))).toBeUndefined() })
  await running.reconcile()
  const queued = running.view().candidateRetention[0]!
  const candidate = ctx.agentTeams.listIntegrations(lead)[0]!
  expect(queued).toMatchObject({ phase: 'queued', cwd: candidate.cwd, candidateCommit: candidate.candidateCommit, deadline: queued.eligibleAt + delayMs })
  expect(await readFile(join(candidate.cwd, 'shared.txt'), 'utf8')).toBe('retained\n')
  await running.close()

  // Disabled retention and a paused project leave a due intent and its worktree untouched.
  const disabled = await WorkspaceCoordinator.open(ctx, { ...config, execution })
  cleanup.push(() => disabled.close())
  const disabledClock = vi.spyOn(Date, 'now').mockReturnValue(queued.deadline)
  try { await disabled.reconcile() } finally { disabledClock.mockRestore() }
  expect(disabled.view().candidateRetention).toEqual([expect.objectContaining({ phase: 'queued' })])
  expect(await readFile(join(candidate.cwd, 'shared.txt'), 'utf8')).toBe('retained\n')
  await disabled.close()

  // A changed deployment delay cannot change a durable eligibility deadline.
  const restored = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, candidateRetention: { delayMs: 0, commandTimeoutMs: 1 } } })
  cleanup.push(() => restored.close())
  expect(restored.view().candidateRetention).toEqual([expect.objectContaining({ submissionId: queued.submissionId, phase: 'queued', deadline: queued.deadline, commandTimeoutMs: 30_000 })])
  const clock = vi.spyOn(Date, 'now').mockReturnValue(queued.deadline)
  try {
    await restored.pause(lead, 'project', 0, true)
    await restored.reconcile()
    expect(restored.view().candidateRetention).toEqual([expect.objectContaining({ submissionId: queued.submissionId, phase: 'queued' })])
    expect(await readFile(join(candidate.cwd, 'shared.txt'), 'utf8')).toBe('retained\n')
    await restored.pause(lead, 'project', 1, false)
    await restored.reconcile()
  } finally { clock.mockRestore() }
  expect(restored.view().candidateRetention).toEqual([expect.objectContaining({ submissionId: queued.submissionId, phase: 'released' })])
  await expect(readFile(join(candidate.cwd, 'shared.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  await restored.close()
  const replayed = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, candidateRetention: { delayMs: 0 } } })
  cleanup.push(() => replayed.close())
  expect(replayed.view().candidateRetention).toEqual([expect.objectContaining({ submissionId: queued.submissionId, phase: 'released' })])
})


it('runs a diamond dependency graph to verified acceptance without manual dispatch or completion', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture(true)
  await coordinator.register(lead, request)
  const first = await coordinator.acceptTask(lead, 'project', { subject: 'Root', description: 'First change' })
  const left = await coordinator.acceptTask(lead, 'project', { subject: 'Left', description: 'Independent left', blockedBy: [first.id] })
  const right = await coordinator.acceptTask(lead, 'project', { subject: 'Right', description: 'Independent right', blockedBy: [first.id] })
  const last = await coordinator.acceptTask(lead, 'project', { subject: 'Join', description: 'Requires both branches', blockedBy: [left.id, right.id] })
  await coordinator.close()
  await ctx.plugin(GitIntegration, { providerName: 'test', targetBranch: 'main', verification: request.verification.commands, commandTimeoutMs: 30_000, verificationTimeoutMs: 30_000 })
  const written = new Set<string>()
  ctx.llm.registerAdapter(['mock'], new class extends MockAdapter {
    override async *stream(options: Parameters<MockAdapter['stream']>[0]) {
      const text = options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
      const member = ctx.agentTeams.listMembers(lead).find(member => member.role === 'teammate' && text.includes(`"attemptId":"${member.name}"`))
      if (member && !written.has(member.id)) {
        written.add(member.id)
        const cwd = member.worktree!.cwd
        await writeFile(join(cwd, `${member.name}.txt`), 'verified artifact\n')
        await runGit(cwd, ['add', `${member.name}.txt`], new AbortController().signal, 30_000)
        await runGit(cwd, ['commit', '-m', member.name], new AbortController().signal, 30_000)
      }
      yield* super.stream(options)
    }
  }(Array.from({ length: 16 }, () => textResponse('Committed task artifact'))))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution })
  cleanup.push(() => running.close())
  for (let tick = 0; tick < 30 && ctx.agentTeams.getTask(lead, last.id).status !== 'completed'; tick++) {
    for (const attempt of running.view().attempts.filter(attempt => attempt.phase === 'active')) {
      await vi.waitFor(() => { expect(ctx.agents.get(SessionId(attempt.runtimeId))).toBeUndefined() })
    }
    await running.reconcile()
    expect(running.view().attempts.filter(attempt => attempt.phase !== 'terminal').length).toBeLessThanOrEqual(2)
    for (const attempt of running.view().attempts) {
      const task = ctx.agentTeams.getTask(lead, attempt.taskId)
      for (const dependency of task.blockedBy) expect(ctx.agentTeams.getTask(lead, dependency).status).toBe('completed')
    }
  }
  expect(ctx.agentTeams.listTasks(lead).every(task => task.status === 'completed')).toBe(true)
  expect(running.view().attempts).toHaveLength(4)
  expect(written.size).toBe(4)
  expect(running.view().submissions.every(submission => submission.phase === 'accepted')).toBe(true)
  expect(ctx.agentTeams.listIntegrations(lead).every(job => job.phase === 'merged')).toBe(true)
  await running.reconcile()
  expect(running.view().attempts).toHaveLength(4)
})


it.each([true, false, 'conflict', 'cancel'] as const)('automatically repairs failed verification with bounded distinct attempts: success=%s', async (repairSucceeds) => {
  const { ctx, lead, coordinator, request, config, git } = await fixture(true)
  const commands = [{ command: 'node', args: ['-e', "if(require('node:fs').readFileSync('shared.txt','utf8').trim()!=='repaired')process.exit(1)"] }]
  await coordinator.register(lead, { ...request, verification: { revision: 1, commands } })
  const task = await coordinator.acceptTask(lead, 'project', { subject: 'Repair artifact', description: 'Preserve original evidence and repair verification' })
  await coordinator.close()
  await ctx.plugin(GitIntegration, { providerName: 'test', targetBranch: 'main', verification: commands, commandTimeoutMs: 30_000, verificationTimeoutMs: 30_000 })
  const written = new Set<string>()
  const prompts: string[] = []
  ctx.llm.registerAdapter(['mock'], new class extends MockAdapter {
    override async *stream(options: Parameters<MockAdapter['stream']>[0]) {
      const text = options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
      const member = ctx.agentTeams.listMembers(lead).find(member => member.role === 'teammate' && text.includes(`"attemptId":"${member.name}"`))
      if (member && !written.has(member.id)) {
        written.add(member.id)
        prompts.push(text)
        const cwd = member.worktree!.cwd
        await writeFile(join(cwd, 'shared.txt'), written.size > 1 && repairSucceeds ? 'repaired\n' : 'broken\n')
        await runGit(cwd, ['add', 'shared.txt'], new AbortController().signal, 30_000)
        await runGit(cwd, ['commit', '-m', member.name], new AbortController().signal, 30_000)
      }
      yield* super.stream(options)
    }
  }(Array.from({ length: 12 }, () => textResponse('Committed artifact'))))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, maxConcurrent: 1 } })
  cleanup.push(() => running.close())
  for (let tick = 0; tick < 14; tick++) {
    for (const attempt of running.view().attempts.filter(attempt => attempt.phase === 'active')) {
      await vi.waitFor(() => { expect(ctx.agents.get(SessionId(attempt.runtimeId))).toBeUndefined() })
    }
    if (tick === 0 && repairSucceeds === 'conflict') {
      await writeFile(join(request.repository, 'shared.txt'), 'external target edit\n')
      await git('commit', '-am', 'conflicting target')
    }
    await running.reconcile()
    if (tick === 0 && repairSucceeds === 'cancel') {
      expect(running.view().attempts).toHaveLength(2)
      await running.pause(lead, 'project', 0, true)
      await running.controlScheduling(lead, { action: 'cancel', projectId: 'project', taskId: task.id, expectedRevision: 1, reason: 'Stop repair' })
      await running.reconcile()
      await running.pause(lead, 'project', 1, false)
      await running.reconcile()
      expect(running.view().attempts).toHaveLength(2)
      expect(running.view().attempts[1]).toMatchObject({ phase: 'terminal', stopReason: 'Stop repair' })
      expect(running.view().submissions).toHaveLength(1)
      expect(running.view().dispatchStatus[0]!.state).toBe('cancelled')
      expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('pending')
      expect((await git('show', 'main:shared.txt')).stdout).toBe('base')
      return
    }
    expect(running.view().attempts.filter(attempt => attempt.phase !== 'terminal').length).toBeLessThanOrEqual(1)
  }
  const view = running.view()
  expect(view.attempts).toHaveLength(repairSucceeds ? 2 : 4)
  expect(new Set(view.attempts.map(attempt => attempt.runtimeId)).size).toBe(view.attempts.length)
  expect(view.submissions).toHaveLength(view.attempts.length)
  expect(view.submissions[0]!.phase).toBe('queued')
  expect(ctx.agentTeams.listIntegrations(lead)[0]!.phase).toBe('failed')
  if (repairSucceeds === 'conflict') expect(ctx.agentTeams.listIntegrations(lead)[0]!.error).toContain('CONFLICT')
  expect(prompts[1]).toContain(view.submissions[0]!.sourceCommit)
  expect(prompts[1]).toContain(view.submissions[0]!.integrationId)
  expect((await git('show', 'main:shared.txt')).stdout).toBe(repairSucceeds ? 'repaired' : 'base')
  expect(ctx.agentTeams.getTask(lead, task.id).status).toBe(repairSucceeds ? 'completed' : 'pending')
  if (!repairSucceeds) expect(view.dispatchStatus[0]!.blockers.some(block => block.detail.includes('repair budget exhausted'))).toBe(true)
  const original = view.attempts[0]!
  await expect(running.submit(lead, 'project', { attemptId: original.attemptId, generation: original.generation, expectedRevision: original.revision, sourceCommit: view.submissions[0]!.sourceCommit, evidence: original.result! })).rejects.toThrow(/Superseded/)
})

it('requires explicit audited review for non-code work and releases dependents only after acceptance', async () => {
  const { ctx, lead, coordinator, request, config } = await fixture(true)
  await coordinator.register(lead, request)
  const report = await coordinator.acceptTask(lead, 'project', { subject: 'Investigation', description: 'Explain the findings', nonCodeCriteria: 'Identify the cause and cite evidence' })
  const dependent = await coordinator.acceptTask(lead, 'project', { subject: 'Follow up', description: 'Use accepted findings', blockedBy: [report.id] })
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 8 }, () => textResponse('Cause identified with evidence in the report'))))
  const healthConfig = { dshDeadlineMs: 1_000, externalDeadlineMs: 1_000, escalationCooldownMs: 1_000, maxEscalationsPerCondition: 2 }
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution: { ...execution, health: healthConfig } })
  cleanup.push(() => running.close())
  let attempt = running.view().attempts[0]!
  await vi.waitFor(() => expect(ctx.agents.get(SessionId(attempt.runtimeId))).toBeUndefined())
  await running.reconcile()
  attempt = running.view().attempts[0]!
  expect(running.view().submissions).toEqual([])
  expect(ctx.agentTeams.getTask(lead, report.id).status).toBe('pending')
  expect(running.view().attempts).toHaveLength(1)
  expect(running.view().health).toContainEqual(expect.objectContaining({ attemptId: attempt.attemptId, classification: 'operator-wait' }))
  const review = { attemptId: attempt.attemptId, generation: attempt.generation, expectedRevision: attempt.revision,
    expectedTaskRevision: report.revision, rationale: 'The report identifies the cause and supporting evidence.' }
  const unrelated = ctx.agentLoop.create(SessionId('unrelated-reviewer'), { provider: 'mock', model: 'mock' })
  await expect(running.acceptReport(unrelated, 'project', review)).rejects.toThrow(/authorized/)
  await expect(running.acceptReport(lead, 'project', { ...review, expectedRevision: 1 })).rejects.toThrow(/Stale/)
  await expect(running.acceptReport(lead, 'project', { ...review, rationale: '' })).rejects.toThrow()
  expect(running.reviewReports(lead, 'project')).toMatchObject([{ phase: 'awaiting-review', report: attempt.result, criteria: 'Identify the cause and cite evidence', expectedRevision: attempt.revision, expectedTaskRevision: report.revision }])
  ctx.provide('workspaceCoordinator', running)
  const tools = await ctx.plugin(CoordinatorTools)
  const remoteQueue = ctx.agentTeams.remoteReviewReports(lead, { projectId: 'project' })
  expect(reviewableReportsSchema.parse(remoteQueue)).toMatchObject([{ phase: 'awaiting-review', attemptId: attempt.attemptId }])
  expect(() => remoteAcceptReportRequestSchema.parse({ projectId: 'project', ...review, injected: true })).toThrow()
  const accepted = await ctx.agentTeams.remoteAcceptReport(lead, { projectId: 'project', ...review })
  expect(reviewableReportSchema.parse(accepted)).toMatchObject({ phase: 'accepted', reviewerId: lead.id })
  const toolStatus = await ctx.tools.execute({ callId: ToolCallId('report-status'), name: 'team_report_status', arguments: { project_id: 'project' }, agent: lead, signal: new AbortController().signal })
  expect(toolStatus.isError).not.toBe(true)
  expect(JSON.parse(toolStatus.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))).toMatchObject([{ phase: 'accepted', rationale: review.rationale }])
  const toolReplay = await ctx.tools.execute({ callId: ToolCallId('report-accept'), name: 'team_report_accept', arguments: { project_id: 'project', attempt_id: attempt.attemptId, generation: attempt.generation, expected_revision: attempt.revision, expected_task_revision: report.revision, rationale: review.rationale }, agent: lead, signal: new AbortController().signal })
  expect(toolReplay.isError).not.toBe(true)
  await tools.dispose()
  expect(accepted).toMatchObject({ phase: 'accepted', report: attempt.result, criteria: 'Identify the cause and cite evidence', reviewerId: lead.id })
  expect(ctx.agentTeams.getTask(lead, report.id).status).toBe('completed')
  expect(await running.acceptReport(lead, 'project', review)).toEqual(accepted)
  expect(ctx.agentTeams.getTask(lead, report.id).revision).toBe(2)
  await expect(running.acceptReport(lead, 'project', { ...review, rationale: 'Different acceptance' })).rejects.toThrow(/immutable|different/)
  await running.reconcile()
  expect(running.view().attempts.map(attempt => attempt.taskId)).toEqual([report.id, dependent.id])
  expect(running.view().dispatchStatus.find(row => row.taskId === report.id)!.state).toBe('accepted')
  await expect(running.submit(lead, 'project', { attemptId: attempt.attemptId, generation: attempt.generation, expectedRevision: attempt.revision, sourceCommit: 'a'.repeat(40), evidence: attempt.result! })).rejects.toThrow(/non-code/)
})

it('replays a pending non-code report intent after a fresh-context crash boundary and fences cancellation', async () => {
  const { root, ctx, lead, coordinator, request, config } = await fixture(true)
  await coordinator.register(lead, request)
  const task = await coordinator.acceptTask(lead, 'project', { subject: 'Audit', description: 'Write a report', nonCodeCriteria: 'State the observed fact' })
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 4 }, () => textResponse('Observed fact with evidence'))))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution })
  cleanup.push(() => running.close())
  let attempt = running.view().attempts[0]!
  await vi.waitFor(() => expect(ctx.agents.get(SessionId(attempt.runtimeId))).toBeUndefined())
  await running.reconcile()
  attempt = running.view().attempts[0]!
  const review = { attemptId: attempt.attemptId, generation: attempt.generation, expectedRevision: attempt.revision,
    expectedTaskRevision: task.revision, rationale: 'The report explicitly states the observed fact.' }
  const receipt = vi.spyOn(ctx.agentTeams, 'acceptReportedTask').mockRejectedValueOnce(new Error('simulated crash after intent'))
  await expect(running.acceptReport(lead, 'project', review)).rejects.toThrow(/simulated crash/)
  expect(running.view().reports).toMatchObject([{ phase: 'pending', report: 'Observed fact with evidence' }])
  await expect(running.controlScheduling(lead, { action: 'cancel', projectId: 'project', taskId: task.id, expectedRevision: 1, reason: 'Too late after review intent' })).rejects.toThrow(/entered report acceptance/)
  receipt.mockRestore()
  await running.close()
  await ctx.fiber.dispose()
  const restoredCtx = await stack(root, true)
  restoredCtx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 4 }, () => textResponse('follow-up report'))))
  const restored = await WorkspaceCoordinator.open(restoredCtx, { ...config, execution })
  cleanup.push(() => restored.close())
  const restoredLead = restoredCtx.agents.get(SessionId(lead.id))!
  expect(restored.view().reports).toMatchObject([{ phase: 'accepted', rationale: review.rationale }])
  expect(restoredCtx.agentTeams.getTask(restoredLead, task.id)).toMatchObject({ status: 'completed', revision: 2 })

  const later = await restored.acceptTask(restoredLead, 'project', { subject: 'Cancelled report', description: 'Do not accept', nonCodeCriteria: 'Never accept after cancellation' })
  await restored.reconcile()
  const active = restored.view().attempts.find(item => item.taskId === later.id)!
  await restored.controlScheduling(restoredLead, { action: 'cancel', projectId: 'project', taskId: later.id, expectedRevision: 1, reason: 'Operator cancelled review' })
  expect(restored.reviewReports(restoredLead, 'project').filter(item => item.taskId === later.id)).toEqual([])
  await expect(restored.acceptReport(restoredLead, 'project', { attemptId: active.attemptId, generation: active.generation, expectedRevision: active.revision,
    expectedTaskRevision: later.revision, rationale: 'Too late' })).rejects.toThrow(/Cancelled|quiescent/)
})

it('replays the exact Team report receipt after its durable acknowledgement crashes in a fresh context', async () => {
  const { root, ctx, lead, coordinator, request, config } = await fixture(true)
  await coordinator.register(lead, request)
  const task = await coordinator.acceptTask(lead, 'project', { subject: 'Receipt boundary', description: 'Persist receipt first', nonCodeCriteria: 'State the durable observation' })
  await coordinator.close()
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 4 }, () => textResponse('Durable observation'))))
  const running = await WorkspaceCoordinator.open(ctx, { ...config, execution })
  cleanup.push(() => running.close())
  let attempt = running.view().attempts[0]!
  await vi.waitFor(() => expect(ctx.agents.get(SessionId(attempt.runtimeId))).toBeUndefined())
  await running.reconcile()
  attempt = running.view().attempts[0]!
  const review = { attemptId: attempt.attemptId, generation: attempt.generation, expectedRevision: attempt.revision,
    expectedTaskRevision: task.revision, rationale: 'The durable observation satisfies the criteria.' }
  const acknowledgement = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('first receipt flush failed')).mockRejectedValueOnce(new Error('second receipt flush failed'))
  await expect(running.acceptReport(lead, 'project', review)).rejects.toThrow(/first receipt flush failed/)
  expect(ctx.agentTeams.getTask(lead, task.id)).toMatchObject({ status: 'completed', revision: 2 })
  expect(running.view().reports).toMatchObject([{ phase: 'pending' }])
  await expect(running.acceptReport(lead, 'project', review)).rejects.toThrow(/second receipt flush failed/)
  expect(running.view().reports).toMatchObject([{ phase: 'pending' }])
  acknowledgement.mockRestore()
  await running.close()
  await ctx.fiber.dispose()
  const restoredCtx = await stack(root, true)
  const restored = await WorkspaceCoordinator.open(restoredCtx, { ...config, execution })
  cleanup.push(() => restored.close())
  const restoredLead = restoredCtx.agents.get(SessionId(lead.id))!
  expect(restored.view().reports).toMatchObject([{ phase: 'accepted', attemptId: attempt.attemptId }])
  expect(restoredCtx.agentTeams.getTask(restoredLead, task.id)).toMatchObject({ status: 'completed', revision: 2 })
})


it('keeps snapshot cleanup inside the retained aggregate shutdown deadline', async () => {
  const { ctx, config, coordinator } = await fixture()
  await coordinator.close()
  const running = await WorkspaceCoordinator.open(ctx, { ...config, shutdownDeadlineMs: 20 })
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const pages = (running as unknown as { workspacePages: WorkspacePageSnapshotStore }).workspacePages
  const closePages = vi.spyOn(pages, 'close').mockImplementation(() => blocked)
  try {
    await expect(running.close()).rejects.toThrow(/shutdown timed out/)
    await expect(WorkspaceCoordinator.open(ctx, config)).rejects.toThrow(/already owned/)
    release()
    await running.close()
    expect(closePages).toHaveBeenCalledTimes(1)
    const reopened = await WorkspaceCoordinator.open(ctx, config)
    await reopened.close()
  } finally { release(); closePages.mockRestore(); await running.close() }
})
