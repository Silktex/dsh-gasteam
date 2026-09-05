/** Team browser namespace and shared, carrier-independent RPC contribution. */
import type {
  RemoteResult,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import type { CreateTeamTaskRequest, TeamTaskMutationResult, TeamView, UpdateTeamTaskRequest } from './client.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$6167656e745465616d73 {
    createTask: (agentId: SessionId, request: CreateTeamTaskRequest) => Promise<RemoteResult<TeamTaskMutationResult>>
    updateTask: (agentId: SessionId, request: UpdateTeamTaskRequest) => Promise<RemoteResult<TeamTaskMutationResult>>
    view: (agentId: SessionId) => Promise<RemoteResult<TeamView>>
  }
  interface TypertRemoteMap {
    'agentTeams/createTask': (agentId: SessionId, request: CreateTeamTaskRequest) => Promise<RemoteResult<TeamTaskMutationResult>>
    'agentTeams/updateTask': (agentId: SessionId, request: UpdateTeamTaskRequest) => Promise<RemoteResult<TeamTaskMutationResult>>
    'agentTeams/view': (agentId: SessionId) => Promise<RemoteResult<TeamView>>
  }
  interface TypertRemoteNamespaceMap {
    'agentTeams': TypertRemoteNamespace$6167656e745465616d73
  }
  interface TypertRemoteScopeMap {
    'agent:agentTeams/createTask': (request: CreateTeamTaskRequest) => Promise<RemoteResult<TeamTaskMutationResult>>
    'agent:agentTeams/updateTask': (request: UpdateTeamTaskRequest) => Promise<RemoteResult<TeamTaskMutationResult>>
    'agent:agentTeams/view': () => Promise<RemoteResult<TeamView>>
  }
}


import { descriptors, TEAM_PACKAGE } from './remote-descriptors.ts'
export const TYPERT_REMOTE: TypertRemoteContribution = { package: TEAM_PACKAGE, descriptors }
export default TYPERT_REMOTE
