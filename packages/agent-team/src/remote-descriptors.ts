/** Host lookup and JSON codecs for the three Team UI operations. */
import type { InvocationDescriptor, InvocationParameterDescriptor, TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import { sessionIdSchema, createTaskSchema, updateTaskSchema, taskResultSchema, teamViewSchema } from './remote-schemas.ts'
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
  invocation('createTask', 'remoteCreateTask', codec('TeamTaskMutationResult', taskResultSchema), codec('CreateTeamTaskRequest', createTaskSchema)),
  invocation('updateTask', 'remoteUpdateTask', codec('TeamTaskMutationResult', taskResultSchema), codec('UpdateTeamTaskRequest', updateTaskSchema)),
  invocation('view', 'remoteView', codec('TeamView', teamViewSchema)),
]
