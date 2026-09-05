/** Opt-in, exact-Agent scheduling tools; project grants remain coordinator-owned. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team/coordinator'
import type { SchedulingView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-team-coordinator'
export const inject = ['agents', 'agentTeams', 'workspaceCoordinator', 'tools']
const resultSchema = { type: 'object', additionalProperties: false, properties: {
  projectId: { type: 'string', required: true }, paused: { type: 'boolean', required: true }, controlRevision: { type: 'integer', required: true },
  requests: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    projectId: { type: 'string', required: true }, teamId: { type: 'string', required: true }, taskId: { type: 'string', required: true },
    order: { type: 'integer', required: true }, priority: { type: 'integer', required: true }, revision: { type: 'integer', required: true },
    state: { type: 'string', required: true, enum: ['ready', 'waiting', 'assigned', 'finished', 'cancelled', 'accepted'] },
    cancelReason: { type: 'string' }, attemptId: { type: 'string' }, nextDispatchAt: { type: 'number' },
    blockers: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      code: { type: 'string', required: true }, detail: { type: 'string', required: true },
    } } },
  } } },
} } as const
const output = { schema: resultSchema, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
function value(view: SchedulingView) {
  return { ...view, requests: view.requests.map(({ attemptId, nextDispatchAt, cancelReason, ...request }) => ({ ...request,
    ...(cancelReason === undefined ? {} : { cancelReason }),
    ...(attemptId === undefined ? {} : { attemptId }), ...(nextDispatchAt === undefined ? {} : { nextDispatchAt }),
  })) }
}
export function apply(ctx: Context): void {
  const installed = new Map<Agent, (() => unknown)[]>()
  const install = (agent: Agent) => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent)?.role !== 'lead') return
    const caller = (value: Agent | undefined) => {
      if (value !== agent) throw new Error('Scheduling tool requires its exact Agent scope')
      return agent
    }
    const disposers: (() => unknown)[] = []
    installed.set(agent, disposers)
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_dispatch_status', description: 'Read authorized project scheduling status and request revisions. Finished attempts still require task acceptance.',
      parameters: { project_id: { type: 'string', required: true } }, output,
      async execute(args, exec) { return value(ctx.workspaceCoordinator.scheduling(caller(exec.agent), { projectId: args.project_id })) },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_dispatch_pause', description: 'Pause or resume new project dispatch with its current control revision. Pause does not cancel active workers.',
      parameters: { project_id: { type: 'string', required: true }, expected_revision: { type: 'integer', required: true }, paused: { type: 'boolean', required: true } }, output,
      async execute(args, exec) { return value(await ctx.workspaceCoordinator.controlScheduling(caller(exec.agent), { action: 'pause', projectId: args.project_id, expectedRevision: args.expected_revision, paused: args.paused })) },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_dispatch_cancel', description: 'Durably cancel queued or active work using its dispatch request revision. Active capacity remains reserved until shutdown is confirmed; timeout does not undo cancellation.',
      parameters: { project_id: { type: 'string', required: true }, task_id: { type: 'string', required: true }, expected_revision: { type: 'integer', required: true }, reason: { type: 'string', required: true } }, output,
      async execute(args, exec) { return value(await ctx.workspaceCoordinator.controlScheduling(caller(exec.agent), { action: 'cancel', projectId: args.project_id, taskId: args.task_id, expectedRevision: args.expected_revision, reason: args.reason })) },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_dispatch_priority', description: 'Set queued task priority using the current request revision. Existing attempts cannot be reprioritized.',
      parameters: { project_id: { type: 'string', required: true }, task_id: { type: 'string', required: true }, expected_revision: { type: 'integer', required: true }, priority: { type: 'integer', required: true } }, output,
      async execute(args, exec) { return value(await ctx.workspaceCoordinator.controlScheduling(caller(exec.agent), { action: 'priority', projectId: args.project_id, taskId: args.task_id, expectedRevision: args.expected_revision, priority: args.priority })) },
    })))
  }
  const dispose = (agent: Agent) => { for (const remove of installed.get(agent) ?? []) remove(); installed.delete(agent) }
  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', ({ agent }) => dispose(agent))
  ctx.effect(() => () => { for (const agent of installed.keys()) dispose(agent) }, 'tool-team-coordinator.scopes()')
}
