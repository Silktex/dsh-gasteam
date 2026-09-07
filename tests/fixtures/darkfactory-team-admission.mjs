/** Actual built Team/coordinator owners; IPC follows flushed native Team task events. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TeamService from '../../packages/agent-team/lib/index.js'
import * as GitWorktrees from '../../packages/agent-team/lib/git-worktrees.js'
import { WorkspaceCoordinator } from '../../packages/agent-team/lib/coordinator.js'
import { DarkFactoryAdmissionStore, DarkFactoryAdmissionController, DarkFactoryIngestionStore } from '../../packages/agent-team/lib/darkfactory.js'

class FixtureSessionQuery extends SessionQueryEngine {
  searchSessions() { throw new Error('Unexpected fixture search') }
  searchEvents() { throw new Error('Unexpected fixture search') }
}
class NoModelCalls extends LlmAdapter {
  calls = 0
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream() { this.calls++; throw new Error('Held factory task attempted model dispatch') }
}
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()))
// A deterministic kill barrier must keep IPC referenced even without pending timers.
process.on('message', () => {})
process.once('message', async ({ directory, mode, intent, initial, envelope }) => {
  const ctx = new Context(), adapter = new NoModelCalls(), workspace = join(directory, 'workspace')
  let coordinator, admissions, ingestion, controller, lead, materializations = 0, persistedTasks = 0
  const close = async () => {
    await controller?.settled(); await admissions?.close(); await ingestion?.close(); await coordinator?.close(); await ctx.fiber.dispose()
  }
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: join(directory, 'sessions'), compression: 'none' })
    await ctx.plugin(FixtureSessionQuery)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(TeamService, { worktreeProvider: 'git' })
    await ctx.plugin(GitWorktrees, { directory: join(directory, 'workers') })
    ctx.llm.registerAdapter(['mock'], adapter)
    const rootId = SessionId(intent.registeredLeadId)
    lead = mode === 'partial'
      ? ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' }, { cwd: join(directory, 'repository') })
      : (await ctx.agentLoop.resume(ctx, { resumeSessionId: rootId, agentOptions: { provider: 'mock', model: 'mock' } })).agent
    const project = { id: intent.spec.projectId, repository: join(directory, 'repository'), teamIds: [rootId], targetBranch: 'main', capacity: 2,
      verification: { revision: 1, commands: [{ command: process.execPath, args: ['--version'] }] } }
    coordinator = await WorkspaceCoordinator.open(ctx, { directory: workspace, execution: { modelProvider: 'mock', model: 'mock', maxConcurrent: 2 } })
    if (mode === 'partial') {
      await coordinator.register(lead, project)
      await ctx.sessionPersistence.ensureMaterialized(lead.session)
      await ctx.sessions.flush(lead.session)
    }
    admissions = await DarkFactoryAdmissionStore.open(workspace, { projectId: project.id, registeredLeadId: rootId, workflowTemplates: [intent.workflow.template] })
    ingestion = await DarkFactoryIngestionStore.open(workspace, { projectId: project.id })
    if (mode === 'partial') {
      await ingestion.recordReceived({ envelope, item: initial, bodySizeBytes: 100 })
      await ingestion.transition({ projectId: project.id, expectedRevision: initial.revision,
        item: { ...initial, revision: initial.revision + 1, state: 'trusted', trust: { ...initial.trust, decision: 'trusted' } } })
    }
    const snapshot = async barrier => {
      await ctx.sessions.flush(lead.session)
      const stored = await ctx.sessionPersistence.inspect(rootId), view = coordinator.view()
      const record = admissions.snapshot().admissions[0]
      return { barrier, pid: process.pid, admissions: admissions.snapshot(), ingestion: ingestion.snapshot(), materializations, modelCalls: adapter.calls,
        tasks: ctx.agentTeams.listTasks(lead), taskEvents: stored.events.filter(event => event.type === 'team/task'),
        workflow: record ? coordinator.inspectWorkflow(lead, record.intent.workflowId) : null,
        attempts: view.attempts, readyTasks: view.readyTasks, dispatchStatus: view.dispatchStatus }
    }
    if (mode === 'partial') {
      // Wrap the real host transactions, never substitute their durable task implementation.
      for (const method of ['createPinnedWorkflowTask', 'createPinnedWorkflowCodeTask']) {
        const create = coordinator.execution[method].bind(coordinator.execution)
        coordinator.execution[method] = async input => {
          const result = await create(input)
          if (++persistedTasks === 2) {
            await send(await snapshot('two-team-tasks-durable'))
            await new Promise(() => {})
          }
          return result
        }
      }
    }
    controller = new DarkFactoryAdmissionController({ admissions, ingestion, authorize: async () => true,
      quarantine: async () => { throw new Error('Unexpected fixture quarantine') },
      materialize: async record => { materializations++; return coordinator.workflows.materializeFactoryAdmission(record, project) },
    })
    if (mode === 'partial') await controller.admit({ projectId: project.id, itemId: initial.id, intent })
    else await controller.resume({ projectId: project.id, limit: 1 })
    const record = admissions.snapshot().admissions[0]
    await coordinator.reconcile()
    await coordinator.resumeWorkflow(lead, record.intent.workflowId)
    assert.deepEqual(await coordinator.workflows.scan(project), [])
    const result = await snapshot('recovered')
    assert.equal(adapter.calls, 0)
    await close(); await send(result); process.disconnect()
  } catch (error) {
    try { await close() } catch { /* Preserve the original fixture error. */ }
    await send({ barrier: 'error', message: String(error), stack: error?.stack }); process.exitCode = 1; process.disconnect()
  }
})
