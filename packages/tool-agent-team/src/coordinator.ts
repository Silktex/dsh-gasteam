/** Opt-in, exact-Agent scheduling tools; project grants remain coordinator-owned. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team/coordinator'
import type { OperatorEscalation, ReviewableReport, SchedulingView, WorkflowRuntimeView, WorkspaceBatchView, WorkspaceBatchNotification } from '@deepseek-ai/dsh-experimental-agent-team/client'
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
  report: { type: 'string', required: true }, criteria: { type: 'string', required: true }, reviewerId: { type: 'string' }, rationale: { type: 'string' }, decision: { type: 'string', enum: ['approved', 'rejected'] }, phase: { type: 'string', required: true, enum: ['awaiting-review', 'pending', 'accepted'] },
  reviewBinding: { type: 'object', additionalProperties: false, properties: { projectId: { type: 'string', required: true }, teamId: { type: 'string', required: true }, executionId: { type: 'string', required: true }, candidateRound: { type: 'integer', required: true }, integrationId: { type: 'string', required: true }, sourceCommit: { type: 'string', required: true }, targetCommit: { type: 'string', required: true }, candidateCommit: { type: 'string', required: true }, reviewGate: { type: 'string', required: true } } },
} } } as const
const reportsOutput = { schema: reportsSchema, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const workflowSchema = { type: 'object', additionalProperties: false, properties: {
  executionId: { type: 'string', required: true }, projectId: { type: 'string', required: true }, teamId: { type: 'string', required: true }, templateId: { type: 'string', required: true }, templateVersion: { type: 'integer', required: true },
  steps: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    stepId: { type: 'string', required: true }, taskId: { type: 'string' }, intentId: { type: 'string' }, reportId: { type: 'string' }, phase: { type: 'string', required: true, enum: ['pending', 'running', 'completed', 'failed'] }, revision: { type: 'integer', required: true }, attempts: { type: 'integer', required: true },
    failure: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', required: true }, evidence: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true }, ref: { type: 'string', required: true } } } } }, retryNotBefore: { type: 'number' },
  } } },
} } as const
const workflowOutput = { schema: workflowSchema, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const escalationSchema = { type: 'object', additionalProperties: false, properties: {
  id: { type: 'string', required: true }, attemptId: { type: 'string', required: true }, generation: { type: 'integer', required: true }, condition: { type: 'string', required: true, enum: ['stale', 'failed'] }, severity: { type: 'string', required: true, enum: ['warning', 'critical'] }, source: { type: 'string', required: true, enum: ['health'] }, diagnostics: { type: 'string', required: true }, revision: { type: 'integer', required: true }, cooldownUntil: { type: 'number', required: true },
  work: { type: 'object', additionalProperties: false, required: true, properties: { projectId: { type: 'string', required: true }, teamId: { type: 'string', required: true }, taskId: { type: 'string', required: true }, state: { type: 'string', required: true, enum: ['active', 'dependency-wait', 'operator-wait', 'failed', 'unavailable'] } } },
  acknowledgement: { type: 'object', additionalProperties: false, properties: { actor: { type: 'string', required: true }, at: { type: 'number', required: true } } },
  resolution: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', required: true, enum: ['condition-cleared', 'accepted-terminal', 'handoff-replaced'] }, source: { type: 'string', required: true, enum: ['health-observation', 'accepted-report', 'accepted-submission', 'accepted-integration', 'operator-handoff'] }, at: { type: 'number', required: true }, replacementAttemptId: { type: 'string' } } },
} } as const
const healthInboxOutput = { schema: { type: 'array', items: escalationSchema } as const, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const healthOutput = { schema: escalationSchema, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const batchRefSchema = { type: 'object', additionalProperties: false, properties: { projectId: { type: 'string', required: true }, teamId: { type: 'string', required: true }, taskId: { type: 'string', required: true } } } as const
const batchItemHistorySchema = { type: 'object', additionalProperties: false, properties: { state: { type: 'string', required: true }, activeAssignment: { type: 'boolean', required: true }, at: { type: 'number', required: true } } } as const
const batchHistorySchema = { type: 'object', additionalProperties: false, properties: { phase: { type: 'string', required: true }, at: { type: 'number', required: true } } } as const
const batchSchema = { type: 'object', additionalProperties: false, properties: {
  id: { type: 'string', required: true }, name: { type: 'string', required: true }, phase: { type: 'string', required: true }, completionEpoch: { type: 'integer', required: true }, completedRequired: { type: 'integer', required: true }, required: { type: 'integer', required: true },
  readyWithoutActiveAssignment: { type: 'array', required: true, items: batchRefSchema },
  items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { ref: { ...batchRefSchema, required: true }, state: { type: 'string', required: true }, activeAssignment: { type: 'boolean', required: true }, dependsOn: { type: 'array', required: true, items: batchRefSchema }, history: { type: 'array', required: true, items: batchItemHistorySchema }, historyTruncated: { type: 'boolean', required: true } } } },
  itemsTruncated: { type: 'boolean', required: true }, history: { type: 'array', required: true, items: batchHistorySchema }, historyTruncated: { type: 'boolean', required: true },
} } as const
const batchOutput = { schema: batchSchema, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const batch = (value: WorkspaceBatchView) => {
  const itemLimit = 64, historyLimit = 32
  const history = value.history.slice(-historyLimit).map(entry => ({ ...entry }))
  return { id: value.id, name: value.name, phase: value.phase, completionEpoch: value.completionEpoch, completedRequired: value.completedRequired, required: value.required,
    readyWithoutActiveAssignment: value.readyWithoutActiveAssignment.map(ref => ({ ...ref })),
    items: value.items.slice(0, itemLimit).map(item => ({ ref: { ...item.ref }, state: item.state, activeAssignment: item.activeAssignment, dependsOn: item.dependsOn.map(ref => ({ ...ref })), history: item.history.slice(-historyLimit).map(entry => ({ ...entry })), historyTruncated: item.history.length > historyLimit })),
    itemsTruncated: value.items.length > itemLimit, history, historyTruncated: value.history.length > historyLimit }
}
const batchInboxOutput = { schema: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { intentId: { type: 'string', required: true }, batchId: { type: 'string', required: true }, subscriptionId: { type: 'string', required: true }, destination: { type: 'string', required: true }, completionEpoch: { type: 'integer', required: true } } } } as const, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const notifications = (value: readonly WorkspaceBatchNotification[]) => value.map(item => ({ ...item }))
function value(view: SchedulingView) {
  return { ...view, requests: view.requests.map(({ attemptId, nextDispatchAt, cancelReason, ...request }) => ({ ...request,
    ...(cancelReason === undefined ? {} : { cancelReason }),
    ...(attemptId === undefined ? {} : { attemptId }), ...(nextDispatchAt === undefined ? {} : { nextDispatchAt }),
  })) }
}
function reports(value: readonly ReviewableReport[]) {
  return value.map(({ decision, reviewBinding, ...report }) => ({ ...report,
    ...(decision === undefined ? {} : { decision }), ...(reviewBinding === undefined ? {} : { reviewBinding }),
  }))
}
function workflow(value: WorkflowRuntimeView) { return { ...value, steps: value.steps.map(({ failure, retryNotBefore, ...step }) => ({ ...step,
  ...(failure === undefined ? {} : { failure: { reason: failure.reason, evidence: { ...failure.evidence } } }),
  ...(retryNotBefore === undefined ? {} : { retryNotBefore }),
})) } }
function escalation(item: OperatorEscalation) { const { acknowledgement, resolution, ...rest } = item; return { ...rest, work: { ...item.work },
  ...(acknowledgement === undefined ? {} : { acknowledgement }), ...(resolution === undefined ? {} : { resolution: { reason: resolution.reason, source: resolution.source, at: resolution.at,
    ...(resolution.replacementAttemptId === undefined ? {} : { replacementAttemptId: resolution.replacementAttemptId }) } }) } }
function escalations(value: readonly OperatorEscalation[]) { return value.map(escalation) }
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
      name: 'team_health_inbox', description: 'Read this registered Lead’s durable health escalations. Health observation never stops or reassigns work.',
      parameters: { project_id: { type: 'string', required: true } }, output: healthInboxOutput,
      async execute(args, exec) { return escalations(ctx.workspaceCoordinator.healthInbox(caller(exec.agent), args.project_id)) },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_health_ack', description: 'Acknowledge one health escalation using its current revision. Acknowledgement does not change task ownership.',
      parameters: { project_id: { type: 'string', required: true }, escalation_id: { type: 'string', required: true }, expected_revision: { type: 'integer', required: true } }, output: healthOutput,
      async execute(args, exec) { return escalation(await ctx.workspaceCoordinator.acknowledgeHealth(caller(exec.agent), args.project_id, args.escalation_id, args.expected_revision)) },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_report_accept', description: 'Accept a terminal non-code worker report after reviewing its evidence against the task criteria. This records an immutable rationale. Pinned candidate-review tasks additionally require approved or rejected; rejected preserves the audited report while preventing that candidate from merging.',
      parameters: { project_id: { type: 'string', required: true }, attempt_id: { type: 'string', required: true }, generation: { type: 'integer', required: true }, expected_revision: { type: 'integer', required: true }, expected_task_revision: { type: 'integer', required: true }, rationale: { type: 'string', required: true }, decision: { type: 'string', enum: ['approved', 'rejected'] } }, output: reportsOutput,
      async execute(args, exec) { return reports([await ctx.workspaceCoordinator.acceptReport(caller(exec.agent), args.project_id, { attemptId: args.attempt_id, generation: args.generation, expectedRevision: args.expected_revision, expectedTaskRevision: args.expected_task_revision, rationale: args.rationale, ...(args.decision === undefined ? {} : { decision: args.decision }) })]) },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_workflow_create', description: 'Create one built-in pinned workflow for a registered project. investigation-report requires question; implementation-test-review-integration requires subject and routes implementation through verified Git review and host approval.',
      parameters: { project_id: { type: 'string', required: true }, workflow_kind: { type: 'string', enum: ['investigation-report', 'implementation-test-review-integration'] }, question: { type: 'string' }, subject: { type: 'string' }, execution_id: { type: 'string' } }, output: workflowOutput,
      async execute(args, exec) {
        const workflowKind = args.workflow_kind ?? 'investigation-report'
        const selected = workflowKind === 'investigation-report'
          ? args.question === undefined ? undefined : { templateId: 'investigation-report' as const, parameters: { question: args.question } }
          : args.subject === undefined ? undefined : { templateId: 'implementation-test-review-integration' as const, parameters: { subject: args.subject } }
        if (!selected) throw new Error(workflowKind === 'investigation-report'
          ? 'investigation-report workflow requires question'
          : 'implementation-test-review-integration workflow requires subject')
        return workflow(await ctx.workspaceCoordinator.createWorkflow(caller(exec.agent), { projectId: args.project_id, teamId: agent.id,
          templateId: selected.templateId, templateVersion: 1, parameters: selected.parameters,
          ...(args.execution_id === undefined ? {} : { executionId: args.execution_id }) }))
      },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_workflow_inspect', description: 'Inspect pinned workflow steps, task bindings, optimistic revisions, and bounded failure or retry diagnostics.',
      parameters: { execution_id: { type: 'string', required: true } }, output: workflowOutput,
      async execute(args, exec) { return workflow(ctx.workspaceCoordinator.inspectWorkflow(caller(exec.agent), args.execution_id)) },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_workspace_batch_plan', description: 'Plan coordinator-owned work across registered projects. Only the configured workspace operator can create the durable plan; item actor identity is always derived by the server.',
      parameters: { batch_id: { type: 'string' }, name: { type: 'string', required: true }, items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, project_id: { type: 'string', required: true }, team_id: { type: 'string', required: true }, subject: { type: 'string', required: true }, description: { type: 'string', required: true }, non_code_criteria: { type: 'string' }, depends_on: { type: 'array', items: { type: 'string' } } } } }, subscribe: { type: 'boolean' } }, output: batchOutput,
      async execute(args, exec) { return batch(await ctx.workspaceCoordinator.planWorkspaceBatch(caller(exec.agent), { ...(args.batch_id === undefined ? {} : { id: args.batch_id }), name: args.name,
        items: args.items.map(item => ({ id: item.id, projectId: item.project_id, teamId: item.team_id, subject: item.subject, description: item.description,
          ...(item.non_code_criteria === undefined ? {} : { nonCodeCriteria: item.non_code_criteria }), ...(item.depends_on === undefined ? {} : { dependsOn: item.depends_on }) })),
        ...(args.subscribe ? { subscriptions: [{ id: `operator-${agent.id}`, destination: `in-app:${agent.id}` }] } : {}) })) },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_workspace_batch_inspect', description: 'Inspect a coordinator-owned cross-project batch. Access requires the configured workspace operator.',
      parameters: { batch_id: { type: 'string', required: true } }, output: batchOutput,
      async execute(args, exec) { return batch(ctx.workspaceCoordinator.inspectWorkspaceBatch(caller(exec.agent), args.batch_id)) },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_workspace_batch_subscribe', description: 'Subscribe the configured operator to durable in-app completion delivery for one workspace batch.',
      parameters: { batch_id: { type: 'string', required: true }, subscription_id: { type: 'string', required: true } }, output: batchOutput,
      async execute(args, exec) { return batch(await ctx.workspaceCoordinator.subscribeWorkspaceBatch(caller(exec.agent), args.batch_id, args.subscription_id)) },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_workspace_batch_inbox', description: 'Read durable in-app workspace-batch completion notices. It sends no external notification.',
      parameters: {}, output: batchInboxOutput,
      async execute(_args, exec) { return notifications(await ctx.workspaceCoordinator.workspaceBatchInbox(caller(exec.agent))) },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_workspace_batch_ack', description: 'Acknowledge one durable in-app batch completion notice after reading it.',
      parameters: { intent_id: { type: 'string', required: true } }, output: batchInboxOutput,
      async execute(args, exec) { await ctx.workspaceCoordinator.acknowledgeWorkspaceBatchNotification(caller(exec.agent), args.intent_id); return notifications(await ctx.workspaceCoordinator.workspaceBatchInbox(caller(exec.agent))) },
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
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'team_dispatch_handoff', description: 'After authorized health nudges are exhausted, checkpoint, stop, and replace one exact active DSH attempt. The old worktree remains retained for the replacement.',
      parameters: { project_id: { type: 'string', required: true }, task_id: { type: 'string', required: true }, expected_revision: { type: 'integer', required: true }, attempt_id: { type: 'string', required: true }, generation: { type: 'integer', required: true }, expected_attempt_revision: { type: 'integer', required: true } }, output,
      async execute(args, exec) { return value(await ctx.workspaceCoordinator.controlScheduling(caller(exec.agent), { action: 'handoff', projectId: args.project_id, taskId: args.task_id, expectedRevision: args.expected_revision, attemptId: args.attempt_id, generation: args.generation, expectedAttemptRevision: args.expected_attempt_revision })) },
    })))
  }
  const dispose = (agent: Agent) => { for (const remove of installed.get(agent) ?? []) remove(); installed.delete(agent) }
  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', ({ agent }) => dispose(agent))
  ctx.effect(() => () => { for (const agent of installed.keys()) dispose(agent) }, 'tool-team-coordinator.scopes()')
}
