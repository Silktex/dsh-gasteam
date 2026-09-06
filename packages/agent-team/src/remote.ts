/** Team browser namespace and shared, carrier-independent RPC contribution. */
import type {
  RemoteResult,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import type { CreateTeamTaskRequest, TeamTaskMutationResult, TeamView, UpdateTeamTaskRequest } from './client.ts'
import type { SchedulingQuery, SchedulingControl, SchedulingView, RemoteAcceptReportRequest, ReviewReportsRequest, ReviewableReport, AcknowledgeHealthRequest, HealthInboxRequest, OperatorEscalation } from './client.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CreateWorkflowRequest, WorkflowRuntimeView } from './workflow-runtime.ts'
import type { WorkspaceBatchPlanRequestWire, WorkspaceBatchQuery, WorkspaceBatchSubscriptionRequest, WorkspaceBatchInboxRequest, WorkspaceBatchAcknowledgementRequest } from './workspace-batch-remote.ts'
import type { WorkspaceBatchNotification, WorkspaceBatchView } from './coordinator-batches.ts'
import type { WorkspaceDashboardPageRequest, WorkspaceDashboardPage, WorkspaceDashboardRequest, WorkspaceDashboardView } from './workspace-dashboard.ts'
import type { WorkspaceActivityRequest, WorkspaceActivityPage } from './workspace-activity.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$6167656e745465616d73 {
    scheduling: (agentId: SessionId, request: SchedulingQuery) => Promise<RemoteResult<SchedulingView>>
    controlScheduling: (agentId: SessionId, request: SchedulingControl) => Promise<RemoteResult<SchedulingView>>
    reviewReports: (agentId: SessionId, request: ReviewReportsRequest) => Promise<RemoteResult<ReviewableReport[]>>
    acceptReport: (agentId: SessionId, request: RemoteAcceptReportRequest) => Promise<RemoteResult<ReviewableReport>>
    createTask: (agentId: SessionId, request: CreateTeamTaskRequest) => Promise<RemoteResult<TeamTaskMutationResult>>
    updateTask: (agentId: SessionId, request: UpdateTeamTaskRequest) => Promise<RemoteResult<TeamTaskMutationResult>>
    createWorkflow: (agentId: SessionId, request: CreateWorkflowRequest) => Promise<RemoteResult<WorkflowRuntimeView>>
    inspectWorkflow: (agentId: SessionId, request: { executionId: string }) => Promise<RemoteResult<WorkflowRuntimeView>>
    resumeWorkflow: (agentId: SessionId, request: { executionId: string }) => Promise<RemoteResult<WorkflowRuntimeView | undefined>>
    planWorkspaceBatch: (agentId: SessionId, request: WorkspaceBatchPlanRequestWire) => Promise<RemoteResult<WorkspaceBatchView>>
    inspectWorkspaceBatch: (agentId: SessionId, request: WorkspaceBatchQuery) => Promise<RemoteResult<WorkspaceBatchView>>
    subscribeWorkspaceBatch: (agentId: SessionId, request: WorkspaceBatchSubscriptionRequest) => Promise<RemoteResult<WorkspaceBatchView>>
    workspaceBatchInbox: (agentId: SessionId, request: WorkspaceBatchInboxRequest) => Promise<RemoteResult<WorkspaceBatchNotification[]>>
    acknowledgeWorkspaceBatchNotification: (agentId: SessionId, request: WorkspaceBatchAcknowledgementRequest) => Promise<RemoteResult<WorkspaceBatchNotification[]>>
    workspaceDashboard: (agentId: SessionId, request: WorkspaceDashboardRequest) => Promise<RemoteResult<WorkspaceDashboardView>>
    workspaceDashboardPage: (agentId: SessionId, request: WorkspaceDashboardPageRequest) => Promise<RemoteResult<WorkspaceDashboardPage>>
    workspaceActivityPage: (agentId: SessionId, request: WorkspaceActivityRequest) => Promise<RemoteResult<WorkspaceActivityPage>>
    healthInbox: (agentId: SessionId, request: HealthInboxRequest) => Promise<RemoteResult<OperatorEscalation[]>>
    acknowledgeHealth: (agentId: SessionId, request: AcknowledgeHealthRequest) => Promise<RemoteResult<OperatorEscalation>>
    view: (agentId: SessionId) => Promise<RemoteResult<TeamView>>
  }
  interface TypertRemoteMap {
    'agentTeams/scheduling': (agentId: SessionId, request: SchedulingQuery) => Promise<RemoteResult<SchedulingView>>
    'agentTeams/controlScheduling': (agentId: SessionId, request: SchedulingControl) => Promise<RemoteResult<SchedulingView>>
    'agentTeams/reviewReports': (agentId: SessionId, request: ReviewReportsRequest) => Promise<RemoteResult<ReviewableReport[]>>
    'agentTeams/acceptReport': (agentId: SessionId, request: RemoteAcceptReportRequest) => Promise<RemoteResult<ReviewableReport>>
    'agentTeams/createTask': (agentId: SessionId, request: CreateTeamTaskRequest) => Promise<RemoteResult<TeamTaskMutationResult>>
    'agentTeams/updateTask': (agentId: SessionId, request: UpdateTeamTaskRequest) => Promise<RemoteResult<TeamTaskMutationResult>>
    'agentTeams/createWorkflow': (agentId: SessionId, request: CreateWorkflowRequest) => Promise<RemoteResult<WorkflowRuntimeView>>
    'agentTeams/inspectWorkflow': (agentId: SessionId, request: { executionId: string }) => Promise<RemoteResult<WorkflowRuntimeView>>
    'agentTeams/resumeWorkflow': (agentId: SessionId, request: { executionId: string }) => Promise<RemoteResult<WorkflowRuntimeView | undefined>>
    'agentTeams/planWorkspaceBatch': (agentId: SessionId, request: WorkspaceBatchPlanRequestWire) => Promise<RemoteResult<WorkspaceBatchView>>
    'agentTeams/inspectWorkspaceBatch': (agentId: SessionId, request: WorkspaceBatchQuery) => Promise<RemoteResult<WorkspaceBatchView>>
    'agentTeams/subscribeWorkspaceBatch': (agentId: SessionId, request: WorkspaceBatchSubscriptionRequest) => Promise<RemoteResult<WorkspaceBatchView>>
    'agentTeams/workspaceBatchInbox': (agentId: SessionId, request: WorkspaceBatchInboxRequest) => Promise<RemoteResult<WorkspaceBatchNotification[]>>
    'agentTeams/acknowledgeWorkspaceBatchNotification': (agentId: SessionId, request: WorkspaceBatchAcknowledgementRequest) => Promise<RemoteResult<WorkspaceBatchNotification[]>>
    'agentTeams/workspaceDashboard': (agentId: SessionId, request: WorkspaceDashboardRequest) => Promise<RemoteResult<WorkspaceDashboardView>>
    'agentTeams/workspaceDashboardPage': (agentId: SessionId, request: WorkspaceDashboardPageRequest) => Promise<RemoteResult<WorkspaceDashboardPage>>
    'agentTeams/workspaceActivityPage': (agentId: SessionId, request: WorkspaceActivityRequest) => Promise<RemoteResult<WorkspaceActivityPage>>
    'agentTeams/healthInbox': (agentId: SessionId, request: HealthInboxRequest) => Promise<RemoteResult<OperatorEscalation[]>>
    'agentTeams/acknowledgeHealth': (agentId: SessionId, request: AcknowledgeHealthRequest) => Promise<RemoteResult<OperatorEscalation>>
    'agentTeams/view': (agentId: SessionId) => Promise<RemoteResult<TeamView>>
  }
  interface TypertRemoteNamespaceMap {
    'agentTeams': TypertRemoteNamespace$6167656e745465616d73
  }
  interface TypertRemoteScopeMap {
    'agent:agentTeams/scheduling': (request: SchedulingQuery) => Promise<RemoteResult<SchedulingView>>
    'agent:agentTeams/controlScheduling': (request: SchedulingControl) => Promise<RemoteResult<SchedulingView>>
    'agent:agentTeams/reviewReports': (request: ReviewReportsRequest) => Promise<RemoteResult<ReviewableReport[]>>
    'agent:agentTeams/acceptReport': (request: RemoteAcceptReportRequest) => Promise<RemoteResult<ReviewableReport>>
    'agent:agentTeams/createTask': (request: CreateTeamTaskRequest) => Promise<RemoteResult<TeamTaskMutationResult>>
    'agent:agentTeams/updateTask': (request: UpdateTeamTaskRequest) => Promise<RemoteResult<TeamTaskMutationResult>>
    'agent:agentTeams/createWorkflow': (request: CreateWorkflowRequest) => Promise<RemoteResult<WorkflowRuntimeView>>
    'agent:agentTeams/inspectWorkflow': (request: { executionId: string }) => Promise<RemoteResult<WorkflowRuntimeView>>
    'agent:agentTeams/resumeWorkflow': (request: { executionId: string }) => Promise<RemoteResult<WorkflowRuntimeView | undefined>>
    'agent:agentTeams/planWorkspaceBatch': (request: WorkspaceBatchPlanRequestWire) => Promise<RemoteResult<WorkspaceBatchView>>
    'agent:agentTeams/inspectWorkspaceBatch': (request: WorkspaceBatchQuery) => Promise<RemoteResult<WorkspaceBatchView>>
    'agent:agentTeams/subscribeWorkspaceBatch': (request: WorkspaceBatchSubscriptionRequest) => Promise<RemoteResult<WorkspaceBatchView>>
    'agent:agentTeams/workspaceBatchInbox': (request: WorkspaceBatchInboxRequest) => Promise<RemoteResult<WorkspaceBatchNotification[]>>
    'agent:agentTeams/acknowledgeWorkspaceBatchNotification': (request: WorkspaceBatchAcknowledgementRequest) => Promise<RemoteResult<WorkspaceBatchNotification[]>>
    'agent:agentTeams/workspaceDashboard': (request: WorkspaceDashboardRequest) => Promise<RemoteResult<WorkspaceDashboardView>>
    'agent:agentTeams/workspaceDashboardPage': (request: WorkspaceDashboardPageRequest) => Promise<RemoteResult<WorkspaceDashboardPage>>
    'agent:agentTeams/workspaceActivityPage': (request: WorkspaceActivityRequest) => Promise<RemoteResult<WorkspaceActivityPage>>
    'agent:agentTeams/healthInbox': (request: HealthInboxRequest) => Promise<RemoteResult<OperatorEscalation[]>>
    'agent:agentTeams/acknowledgeHealth': (request: AcknowledgeHealthRequest) => Promise<RemoteResult<OperatorEscalation>>
    'agent:agentTeams/view': () => Promise<RemoteResult<TeamView>>
  }
}


import { descriptors, TEAM_PACKAGE } from './remote-descriptors.ts'
export const TYPERT_REMOTE: TypertRemoteContribution = { package: TEAM_PACKAGE, descriptors }
export default TYPERT_REMOTE
