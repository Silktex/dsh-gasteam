/** Host lookup and JSON codecs for Team task and scoped scheduling operations. */
import type { InvocationDescriptor, InvocationParameterDescriptor, TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import { sessionIdSchema, createTaskSchema, updateTaskSchema, taskResultSchema, teamViewSchema, remoteAcceptReportRequestSchema, reviewableReportSchema, reviewableReportsSchema, reviewReportsRequestSchema, createWorkflowSchema, workflowQuerySchema, workflowViewSchema, nullableWorkflowViewSchema, healthInboxRequestSchema, acknowledgeHealthRequestSchema, operatorEscalationSchema, operatorEscalationsSchema } from './remote-schemas.ts'
import { schedulingQuerySchema, schedulingControlSchema, schedulingViewSchema } from './scheduling-schemas.ts'
import { workspaceBatchPlanRequestSchema, workspaceBatchQuerySchema, workspaceBatchSubscriptionRequestSchema, workspaceBatchInboxRequestSchema, workspaceBatchAcknowledgementRequestSchema, workspaceBatchViewSchema, workspaceBatchNotificationsSchema } from './workspace-batch-remote.ts'
import { workspaceDashboardPageRequestSchema, workspaceDashboardPageSchema, workspaceDashboardRequestSchema, workspaceDashboardViewSchema } from './workspace-dashboard.ts'
import type { TeamService } from './index.ts'

export const TEAM_PACKAGE = '@deepseek-ai/dsh-experimental-agent-team'
const agent: InvocationParameterDescriptor = {
  name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent',
  codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', schema: sessionIdSchema },
}
function codec(type: string, schema: { parse(value: unknown): unknown }): TypertCodec {
  return { mode: 'strict', typeSymbol: `${TEAM_PACKAGE}/client#${type}`, schema }
}
function invocation(method: string, implementation: keyof TeamService & string, result: TypertCodec, request?: TypertCodec): InvocationDescriptor {
  return {
    id: `${TEAM_PACKAGE}#agentTeams/${method}`, service: 'agentTeams', namespace: 'agentTeams', method, implementation,
    invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' },
    parameters: [agent, ...request === undefined ? [] : [{ name: 'request', wire: 'request', source: 'json' as const, codec: request }]],
    result,
  }
}
export const descriptors: readonly InvocationDescriptor[] = [
  invocation('scheduling', 'remoteScheduling', codec('SchedulingView', schedulingViewSchema), codec('SchedulingQuery', schedulingQuerySchema)),
  invocation('controlScheduling', 'remoteControlScheduling', codec('SchedulingView', schedulingViewSchema), codec('SchedulingControl', schedulingControlSchema)),
  invocation('reviewReports', 'remoteReviewReports', codec('ReviewableReport[]', reviewableReportsSchema), codec('ReviewReportsRequest', reviewReportsRequestSchema)),
  invocation('acceptReport', 'remoteAcceptReport', codec('ReviewableReport', reviewableReportSchema), codec('RemoteAcceptReportRequest', remoteAcceptReportRequestSchema)),
  invocation('createTask', 'remoteCreateTask', codec('TeamTaskMutationResult', taskResultSchema), codec('CreateTeamTaskRequest', createTaskSchema)),
  invocation('updateTask', 'remoteUpdateTask', codec('TeamTaskMutationResult', taskResultSchema), codec('UpdateTeamTaskRequest', updateTaskSchema)),
  invocation('createWorkflow', 'remoteCreateWorkflow', codec('WorkflowRuntimeView', workflowViewSchema), codec('CreateWorkflowRequest', createWorkflowSchema)),
  invocation('inspectWorkflow', 'remoteInspectWorkflow', codec('WorkflowRuntimeView', workflowViewSchema), codec('WorkflowQuery', workflowQuerySchema)),
  invocation('resumeWorkflow', 'remoteResumeWorkflow', codec('WorkflowRuntimeView | undefined', nullableWorkflowViewSchema), codec('WorkflowQuery', workflowQuerySchema)),
  invocation('planWorkspaceBatch', 'remotePlanWorkspaceBatch', codec('WorkspaceBatchView', workspaceBatchViewSchema), codec('WorkspaceBatchPlanRequest', workspaceBatchPlanRequestSchema)),
  invocation('inspectWorkspaceBatch', 'remoteInspectWorkspaceBatch', codec('WorkspaceBatchView', workspaceBatchViewSchema), codec('WorkspaceBatchQuery', workspaceBatchQuerySchema)),
  invocation('subscribeWorkspaceBatch', 'remoteSubscribeWorkspaceBatch', codec('WorkspaceBatchView', workspaceBatchViewSchema), codec('WorkspaceBatchSubscriptionRequest', workspaceBatchSubscriptionRequestSchema)),
  invocation('workspaceBatchInbox', 'remoteWorkspaceBatchInbox', codec('WorkspaceBatchNotification[]', workspaceBatchNotificationsSchema), codec('WorkspaceBatchInboxRequest', workspaceBatchInboxRequestSchema)),
  invocation('acknowledgeWorkspaceBatchNotification', 'remoteAcknowledgeWorkspaceBatchNotification', codec('WorkspaceBatchNotification[]', workspaceBatchNotificationsSchema), codec('WorkspaceBatchAcknowledgementRequest', workspaceBatchAcknowledgementRequestSchema)),
  invocation('workspaceDashboard', 'remoteWorkspaceDashboard', codec('WorkspaceDashboardView', workspaceDashboardViewSchema), codec('WorkspaceDashboardRequest', workspaceDashboardRequestSchema)),
  invocation('workspaceDashboardPage', 'remoteWorkspaceDashboardPage', codec('WorkspaceDashboardPage', workspaceDashboardPageSchema), codec('WorkspaceDashboardPageRequest', workspaceDashboardPageRequestSchema)),
  invocation('healthInbox', 'remoteHealthInbox', codec('OperatorEscalation[]', operatorEscalationsSchema), codec('HealthInboxRequest', healthInboxRequestSchema)),
  invocation('acknowledgeHealth', 'remoteAcknowledgeHealth', codec('OperatorEscalation', operatorEscalationSchema), codec('AcknowledgeHealthRequest', acknowledgeHealthRequestSchema)),
  invocation('view', 'remoteView', codec('TeamView', teamViewSchema)),
]
