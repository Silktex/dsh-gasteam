import { describe, expect, it } from 'vitest'
import { descriptors } from '../packages/agent-team/src/remote-descriptors.ts'
import {
  createTaskSchema,
  updateTaskSchema,
  teamViewSchema,
  taskResultSchema,
  remoteAcceptReportRequestSchema,
  reviewableReportSchema,
  reviewableReportsSchema,
  createWorkflowSchema,
  workflowQuerySchema,
  workflowViewSchema,
  healthInboxRequestSchema,
  acknowledgeHealthRequestSchema,
  operatorEscalationSchema,
} from '../packages/agent-team/src/remote-schemas.ts'
import { workspaceBatchPlanRequestSchema, workspaceBatchQuerySchema, workspaceBatchSubscriptionRequestSchema, workspaceBatchInboxRequestSchema, workspaceBatchAcknowledgementRequestSchema, workspaceBatchViewSchema, workspaceBatchNotificationsSchema } from '../packages/agent-team/src/workspace-batch-remote.ts'
import { schedulingQuerySchema, schedulingControlSchema, schedulingViewSchema } from '../packages/agent-team/src/scheduling-schemas.ts'
import { workspaceDashboardPageRequestSchema, workspaceDashboardRequestSchema } from '../packages/agent-team/src/workspace-dashboard.ts'
import { TYPERT } from '../packages/agent-team/src/typert.ts'
import { TYPERT_REMOTE } from '../packages/agent-team/src/remote.ts'

describe('Team RPC codecs', () => {
  it('shares the exact Host and browser invocation definitions', () => {
    expect(TYPERT.invocations).toBe(TYPERT_REMOTE.descriptors)
    expect(descriptors.map(value => [value.method, value.implementation, value.parameters.map(parameter => parameter.wire)]))
      .toEqual([
        ['scheduling', 'remoteScheduling', ['agentId', 'request']],
        ['controlScheduling', 'remoteControlScheduling', ['agentId', 'request']],
        ['reviewReports', 'remoteReviewReports', ['agentId', 'request']],
        ['acceptReport', 'remoteAcceptReport', ['agentId', 'request']],
        ['createTask', 'remoteCreateTask', ['agentId', 'request']],
        ['updateTask', 'remoteUpdateTask', ['agentId', 'request']],
        ['createWorkflow', 'remoteCreateWorkflow', ['agentId', 'request']],
        ['inspectWorkflow', 'remoteInspectWorkflow', ['agentId', 'request']],
        ['resumeWorkflow', 'remoteResumeWorkflow', ['agentId', 'request']],
        ['planWorkspaceBatch', 'remotePlanWorkspaceBatch', ['agentId', 'request']],
        ['inspectWorkspaceBatch', 'remoteInspectWorkspaceBatch', ['agentId', 'request']],
        ['subscribeWorkspaceBatch', 'remoteSubscribeWorkspaceBatch', ['agentId', 'request']],
        ['workspaceBatchInbox', 'remoteWorkspaceBatchInbox', ['agentId', 'request']],
        ['acknowledgeWorkspaceBatchNotification', 'remoteAcknowledgeWorkspaceBatchNotification', ['agentId', 'request']],
        ['workspaceDashboard', 'remoteWorkspaceDashboard', ['agentId', 'request']],
        ['workspaceDashboardPage', 'remoteWorkspaceDashboardPage', ['agentId', 'request']],
        ['healthInbox', 'remoteHealthInbox', ['agentId', 'request']],
        ['acknowledgeHealth', 'remoteAcknowledgeHealth', ['agentId', 'request']],
        ['view', 'remoteView', ['agentId']],
      ])
    expect(descriptors.every(value => value.parameters[0]?.source === 'lookup')).toBe(true)
  })

  it('validates scoped investigation workflow controls', () => {
    const request = { projectId: 'project', teamId: 'lead', templateId: 'investigation-report', templateVersion: 1, parameters: { question: 'Why?' } }
    expect(createWorkflowSchema.parse(request)).toEqual(request)
    expect(() => createWorkflowSchema.parse({ ...request, templateVersion: 0 })).toThrow()
    expect(workflowQuerySchema.parse({ executionId: 'workflow-1' })).toEqual({ executionId: 'workflow-1' })
    expect(workflowViewSchema.parse({ executionId: 'workflow-1', projectId: 'project', teamId: 'lead', templateId: 'investigation-report', templateVersion: 1,
      steps: [{ stepId: 'investigate', phase: 'running', taskId: 'workflow-intent', revision: 1, attempts: 0 }] })).toMatchObject({ executionId: 'workflow-1' })
  })

  it('validates strict workspace-batch RPC requests and actionable durable views', () => {
    const plan = { id: 'batch', name: 'two repositories', items: [{ id: 'first', projectId: 'project-a', teamId: 'lead-a', subject: 'First', description: 'Complete first' }], subscriptions: [{ id: 'operator', destination: 'in-app:lead-a' }] }
    expect(workspaceBatchPlanRequestSchema.parse(plan)).toEqual({ ...plan, items: [{ ...plan.items[0], dependsOn: [] }] })
    expect(() => workspaceBatchPlanRequestSchema.parse({ ...plan, unexpected: true })).toThrow()
    expect(workspaceBatchQuerySchema.parse({ batchId: 'batch' })).toEqual({ batchId: 'batch' })
    expect(workspaceBatchSubscriptionRequestSchema.parse({ batchId: 'batch', subscriptionId: 'operator' })).toEqual({ batchId: 'batch', subscriptionId: 'operator' })
    expect(workspaceBatchInboxRequestSchema.parse({})).toEqual({})
    expect(workspaceBatchAcknowledgementRequestSchema.parse({ intentId: 'notice' })).toEqual({ intentId: 'notice' })
    const view = { id: 'batch', name: 'two repositories', phase: 'blocked' as const, completionEpoch: 0, completedRequired: 1, required: 2, readyWithoutActiveAssignment: [],
      items: [{ ref: { projectId: 'project-a', teamId: 'lead-a', taskId: 'task-a' }, state: 'accepted' as const, activeAssignment: false, dependsOn: [], history: [{ state: 'accepted' as const, activeAssignment: false, at: 1 }] },
        { ref: { projectId: 'project-b', teamId: 'lead-b', taskId: 'task-b' }, state: 'blocked' as const, activeAssignment: false, dependsOn: [{ projectId: 'project-a', teamId: 'lead-a', taskId: 'task-a' }], history: [{ state: 'blocked' as const, activeAssignment: false, at: 2 }] }], history: [] }
    expect(workspaceBatchViewSchema.parse(view)).toEqual(view)
    expect(workspaceBatchNotificationsSchema.parse([{ intentId: 'notice', batchId: 'batch', subscriptionId: 'operator', destination: 'in-app:lead-a', completionEpoch: 1 }])).toHaveLength(1)
  })

  it('validates the strict read-only workspace dashboard request', () => {
    expect(workspaceDashboardRequestSchema.parse({})).toEqual({})
    expect(() => workspaceDashboardRequestSchema.parse({ projectId: 'project' })).toThrow()
    expect(workspaceDashboardPageRequestSchema.parse({ collection: 'projects', pageSize: 1 })).toEqual({ collection: 'projects', pageSize: 1 })
    expect(() => workspaceDashboardPageRequestSchema.parse({ collection: 'projects', pageSize: 257 })).toThrow()
    expect(() => workspaceDashboardPageRequestSchema.parse({ collection: 'projects', snapshotRevision: 'browser-controlled' })).toThrow()
  })

  it('validates revision-fenced health inbox controls', () => {
    expect(healthInboxRequestSchema.parse({ projectId: 'project' })).toEqual({ projectId: 'project' })
    expect(acknowledgeHealthRequestSchema.parse({ projectId: 'project', escalationId: 'escalation-1', expectedRevision: 1 })).toMatchObject({ escalationId: 'escalation-1' })
    expect(() => acknowledgeHealthRequestSchema.parse({ projectId: 'project', escalationId: 'escalation-1', expectedRevision: 0 })).toThrow()
    expect(operatorEscalationSchema.parse({ id: 'escalation-1', attemptId: 'attempt-1', generation: 1, condition: 'failed', severity: 'critical', source: 'health', diagnostics: 'provider failed',
      work: { projectId: 'project', teamId: 'lead', taskId: 'task', state: 'failed' }, revision: 1, cooldownUntil: 10 })).toMatchObject({ condition: 'failed' })
  })

  it('validates scheduling controls and preserves typed blocker responses', () => {
    expect(schedulingQuerySchema.parse({ projectId: 'project' })).toEqual({ projectId: 'project' })
    expect(() => schedulingControlSchema.parse({ action: 'pause', projectId: 'project', expectedRevision: -1, paused: true })).toThrow()
    expect(() => schedulingControlSchema.parse({ action: 'priority', projectId: 'project', taskId: 'task', expectedRevision: 1, priority: 1.5 })).toThrow()
    const view = { projectId: 'project', paused: false, controlRevision: 0, requests: [{ projectId: 'project', teamId: 'team', taskId: 'task', order: 1, revision: 1, priority: 0, state: 'waiting', blockers: [{ code: 'dependencies', detail: 'prerequisite' }] }] }
    expect(schedulingViewSchema.parse(view)).toEqual(view)
    expect(() => schedulingViewSchema.parse({ ...view, requests: [{ ...view.requests[0], blockers: [{ code: 'invented', detail: '' }] }] })).toThrow()
  })

  it('rejects malformed task requests before service invocation', () => {
    expect(createTaskSchema.parse({ subject: 'Check', description: 'Review the diff' })).toEqual({ subject: 'Check', description: 'Review the diff' })
    expect(() => createTaskSchema.parse({ subject: 'Check' })).toThrow()
    expect(() => createTaskSchema.parse({ subject: 'Check', description: '', blockedBy: [2] })).toThrow()
    expect(updateTaskSchema.parse({ taskId: 'task-1', expectedRevision: 1, action: 'complete', result: 'Tests passed' }).action).toBe('complete')
    expect(() => updateTaskSchema.parse({ taskId: 'task-1', action: 'complete' })).toThrow()
    expect(() => updateTaskSchema.parse({ taskId: 'task-1', expectedRevision: 1, action: 'invented' })).toThrow()
  })

  it('round-trips terminal reports and rejects malformed acceptance requests', () => {
    const report = {
      projectId: 'project', teamId: 'team', taskId: 'task', attemptId: 'attempt',
      generation: 2, expectedRevision: 7, expectedTaskRevision: 3,
      report: 'The worker completed the requested change.',
      criteria: 'State the observed evidence and verification.', phase: 'awaiting-review' as const,
    }
    expect(reviewableReportSchema.parse(report)).toEqual(report)
    expect(reviewableReportsSchema.parse([report])).toEqual([report])

    const request = {
      projectId: 'project', attemptId: 'attempt', generation: 2,
      expectedRevision: 7, expectedTaskRevision: 3,
      rationale: 'The report satisfies the stated criteria.',
    }
    expect(remoteAcceptReportRequestSchema.parse(request)).toEqual(request)
    expect(remoteAcceptReportRequestSchema.parse({ ...request, decision: 'rejected' })).toEqual({ ...request, decision: 'rejected' })
    expect(() => remoteAcceptReportRequestSchema.parse({ ...request, decision: 'defer' })).toThrow()
    expect(() => remoteAcceptReportRequestSchema.parse({ ...request, rationale: '   ' })).toThrow()
    expect(() => remoteAcceptReportRequestSchema.parse({ ...request, expectedRevision: 0 })).toThrow()
    expect(() => remoteAcceptReportRequestSchema.parse({ ...request, expectedTaskRevision: -1 })).toThrow()
    expect(() => remoteAcceptReportRequestSchema.parse({ ...request, expectedTaskRevision: undefined })).toThrow()
    expect(() => remoteAcceptReportRequestSchema.parse({ ...request, stale: true })).toThrow()
  })

  it('preserves batch and integration fields and rejects incomplete views', () => {
    const empty = { members: [], tasks: [], batches: [], integrations: [] }
    expect(teamViewSchema.parse(empty)).toEqual(empty)
    expect(() => teamViewSchema.parse({ members: [], tasks: [] })).toThrow()
    expect(() => teamViewSchema.parse({ ...empty, integrations: [{ phase: 'merged' }] })).toThrow()
    expect(() => taskResultSchema.parse({ ok: true, value: { id: 'task-1' } })).toThrow()
  })
})
