/** Built DSH plugins only. IPC snapshots follow fsynced HTTP custody and inbox writes. */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TeamService from '../../packages/agent-team/lib/index.js'
import * as CoordinatorPlugin from '../../packages/agent-team/lib/coordinator.js'

class FixtureSessionQuery extends SessionQueryEngine {
  searchSessions() { throw new Error('Search is outside the observer fixture') }
  searchEvents() { throw new Error('Search is outside the observer fixture') }
}
const [mode, directory] = process.argv.slice(2)
if (!directory || !['seed', 'restore'].includes(mode)) throw new Error('Expected observer fixture mode and directory')
const ctx = new Context(), rootId = SessionId('observer-restart-lead'), workspace = join(directory, 'workspace')
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()))
let coordinator
async function journal(path) {
  const text = await readFile(path, 'utf8')
  if (!text.endsWith('\n')) throw new Error('Incomplete durable fixture journal')
  return text.trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
try {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(directory, 'sessions'), compression: 'none' })
  await ctx.plugin(FixtureSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService, {})
  let lead
  if (mode === 'seed') {
    lead = ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' }, { cwd: join(directory, 'repository') })
    const disabled = await CoordinatorPlugin.WorkspaceCoordinator.open(ctx, { directory: workspace })
    try {
      await disabled.register(lead, { id: 'project', repository: join(directory, 'repository'), teamIds: [rootId], targetBranch: 'main', capacity: 1,
        verification: { revision: 1, commands: [{ command: process.execPath, args: ['--version'] }] } })
      await ctx.sessionPersistence.ensureMaterialized(lead.session)
      await ctx.sessions.flush(lead.session)
    } finally { await disabled.close() }
  } else {
    lead = (await ctx.agentLoop.resume(ctx, { resumeSessionId: rootId, agentOptions: { provider: 'mock', model: 'mock' } })).agent
  }
  const darkFactory = JSON.parse(await readFile(join(directory, 'policy.json'), 'utf8'))
  await ctx.plugin(CoordinatorPlugin, { directory: workspace, scanIntervalMs: 25, darkFactory })
  coordinator = ctx.workspaceCoordinator
  await send({ barrier: 'listening', pid: process.pid, status: coordinator.darkFactoryStatus(), coordinatorId: coordinator.view().id })
  let pending = Promise.resolve()
  await new Promise((resolve, reject) => {
    process.on('message', message => {
      pending = pending.then(async () => {
        if (message === 'stop') { resolve(); return }
        if (message !== 'snapshot' && message !== 'acknowledge') throw new Error('Unexpected observer IPC message')
        if (message === 'acknowledge') {
          const escalation = coordinator.healthInbox(lead, 'project')[0]
          if (!escalation) throw new Error('Expected quarantine before acknowledgement barrier')
          await coordinator.acknowledgeHealth(lead, 'project', escalation.id, escalation.revision)
        }
        await ctx.sessions.flush(lead.session)
        const view = coordinator.view(), stored = await ctx.sessionPersistence.inspect(rootId)
        const ingress = await journal(join(workspace, 'darkfactory', 'project', 'ingestion.jsonl'))
        const health = await journal(join(workspace, 'health.jsonl'))
        await send({ barrier: 'durable-snapshot', inbox: coordinator.healthInbox(lead, 'project'),
          taskEvents: stored.events.filter(event => event.type === 'team/task').length,
          tasks: view.projects.flatMap(project => project.teams.flatMap(team => team.tasks)), attempts: view.attempts, workflows: view.workflows, readyTasks: view.readyTasks,
          ingress: ingress.map(event => ({ type: event.type, receipt: event.result?.receipt, duplicate: event.result?.duplicate, healthEscalationId: event.result?.healthEscalationId })),
          healthEventTypes: health.map(event => event.type),
        })
      }).catch(reject)
    })
  })
  await pending
} finally {
  try { await coordinator?.close() } finally { await ctx.fiber.dispose(); process.disconnect?.() }
}
