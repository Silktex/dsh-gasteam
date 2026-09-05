/** Opt-in, exact-Agent scheduling tools; project grants remain coordinator-owned. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team/coordinator'
import type { ReviewableReport, SchedulingView, WorkflowRuntimeView } from '@deepseek-ai/dsh-experimental-agent-team/client'
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
const reportsSchema = { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
  id: { type: 'string' }, projectId: { type: 'string', required: true }, teamId: { type: 'string', required: true }, taskId: { type: 'string', required: true },
  attemptId: { type: 'string', required: true }, generation: { type: 'integer', required: true }, expectedRevision: { type: 'integer', required: true }, expectedTaskRevision: { type: 'integer', required: true },
  report: { type: 'string', required: true }, criteria: { type: 'string', required: true }, reviewerId: { type: 'string' }, rationale: { type: 'string' }, phase: { type: 'string', required: true, enum: ['awaiting-review', 'pending', 'accepted'] },
} } } as const
const reportsOutput = { schema: reportsSchema, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const workflowSchema = { type: 'object', additionalProperties: false, properties: {
  executionId: { type: 'string', required: true }, projectId: { type: 'string', required: true }, teamId: { type: 'string', required: true }, templateId: { type: 'string', required: true }, templateVersion: { type: 'integer', required: true },
  steps: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    stepId: { type: 'string', required: true }, taskId: { type: 'string' }, intentId: { type: 'string' }, reportId: { type: 'string' }, phase: { type: 'string', required: true, enum: ['pending', 'running', 'completed', 'failed'] },
  } } },
} } as const
const workflowOutput = { schema: workflowSchema, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
function value(view: SchedulingView) {
  return { ...view, requests: view.requests.map(({ attemptId, nextDispatchAt, cancelReason, ...request }) => ({ ...request,
    ...(cancelReason === undefined ? {} : { cancelReason }),
    ...(attemptId === undefined ? {} : { attemptId }), ...(nextDispatchAt === undefined ? {} : { nextDispatchAt }),
  })) }
}
function reports(value: readonly ReviewableReport[]) { return value.map(report => ({ ...report })) }
function workflow(value: WorkflowRuntimeView) { return { ...value, steps: value.steps.map(step => ({ ...step })) } }
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
      name: 'team_report_status', description: 'Read audited non-code reports, criteria, pinned revisions, and acceptance rationale for this project.',
      parameters: { project_id: { type: 'string', required: true } }, output: reportsOutput,
      async execute(args, exec) { return reports(ctx.workspaceCoordinator.reviewReports(caller(exec.agent), args.project_id)) },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_report_accept', description: 'Accept a terminal non-code worker report after reviewing its evidence against the task criteria. This records an immutable rationale.',
      parameters: { project_id: { type: 'string', required: true }, attempt_id: { type: 'string', required: true }, generation: { type: 'integer', required: true }, expected_revision: { type: 'integer', required: true }, expected_task_revision: { type: 'integer', required: true }, rationale: { type: 'string', required: true } }, output: reportsOutput,
      async execute(args, exec) { return reports([await ctx.workspaceCoordinator.acceptReport(caller(exec.agent), args.project_id, { attemptId: args.attempt_id, generation: args.generation, expectedRevision: args.expected_revision, expectedTaskRevision: args.expected_task_revision, rationale: args.rationale })]) },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_workflow_create', description: 'Create the pinned investigation/report workflow for a registered project. The question and template version are durably pinned before task dispatch.',
      parameters: { project_id: { type: 'string', required: true }, question: { type: 'string', required: true }, execution_id: { type: 'string' } }, output: workflowOutput,
      async execute(args, exec) { return workflow(await ctx.workspaceCoordinator.createWorkflow(caller(exec.agent), { projectId: args.project_id, teamId: agent.id, templateId: 'investigation-report', templateVersion: 1, parameters: { question: args.question }, ...(args.execution_id === undefined ? {} : { executionId: args.execution_id }) })) },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_workflow_inspect', description: 'Inspect pinned workflow steps, their concrete managed tasks, and accepted report receipts.',
      parameters: { execution_id: { type: 'string', required: true } }, output: workflowOutput,
      async execute(args, exec) { return workflow(ctx.workspaceCoordinator.inspectWorkflow(caller(exec.agent), args.execution_id)) },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_workflow_resume', description: 'Resume durable workflow task admission after an interruption. Existing task bindings are reused.',
      parameters: { execution_id: { type: 'string', required: true } }, output: workflowOutput,
      async execute(args, exec) {
        const resumed = await ctx.workspaceCoordinator.resumeWorkflow(caller(exec.agent), args.execution_id)
        if (resumed === undefined) return workflow(ctx.workspaceCoordinator.inspectWorkflow(caller(exec.agent), args.execution_id))
        return workflow(resumed)
      },
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
