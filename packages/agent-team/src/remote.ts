/** Team browser namespace and shared, carrier-independent RPC contribution. */
import type {
  RemoteResult,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import type { CreateTeamTaskRequest, TeamTaskMutationResult, TeamView, UpdateTeamTaskRequest } from './client.ts'
import type { SchedulingQuery, SchedulingControl, SchedulingView, RemoteAcceptReportRequest, ReviewReportsRequest, ReviewableReport, AcknowledgeHealthRequest, HealthInboxRequest, OperatorEscalation } from './client.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CreateWorkflowRequest, WorkflowRuntimeView } from './workflow-runtime.ts'

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
    'agent:agentTeams/healthInbox': (request: HealthInboxRequest) => Promise<RemoteResult<OperatorEscalation[]>>
    'agent:agentTeams/acknowledgeHealth': (request: AcknowledgeHealthRequest) => Promise<RemoteResult<OperatorEscalation>>
    'agent:agentTeams/view': () => Promise<RemoteResult<TeamView>>
  }
}


import { descriptors, TEAM_PACKAGE } from './remote-descriptors.ts'
export const TYPERT_REMOTE: TypertRemoteContribution = { package: TEAM_PACKAGE, descriptors }
export default TYPERT_REMOTE
