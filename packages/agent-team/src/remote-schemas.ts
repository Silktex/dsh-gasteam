/** Strict JSON schemas shared by the Team Host and browser Remote descriptors. */
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CreateTeamTaskRequest, UpdateTeamTaskRequest, TeamTaskMutationResult, TeamView } from './types.ts'
import type { RemoteAcceptReportRequest, ReviewReportsRequest, ReviewableReport } from './reports.ts'
import type { CreateWorkflowRequest, WorkflowRuntimeView } from './workflow-runtime.ts'

/** Branded strings retain their ordinary JSON string representation. */
type Wire<T> = T extends Branded<string> ? string : T extends readonly (infer Item)[] ? readonly Wire<Item>[] : T extends object ? { [Key in keyof T]: Wire<T[Key]> | ({} extends Pick<T, Key> ? undefined : never) } : T

/** Apply compile-time brands after validating every serialized field. */
function wireSchema<T>(schema: z.ZodType<Wire<T>>): z.ZodType<T> {
  return schema as unknown as z.ZodType<T>
}

export const sessionIdSchema = wireSchema<SessionId>(z.intersection(z.string(), z.unknown()))

export const createTaskSchema = wireSchema<CreateTeamTaskRequest>(z.object({
  'subject': z.string().readonly(),
  'description': z.string().readonly(),
  'nonCodeCriteria': z.string().readonly().optional(),
  'blockedBy': z.array(z.intersection(z.string(), z.unknown())).readonly().optional(),
  'writeScopes': z.array(z.string()).readonly().optional(),
}))

export const reviewReportsRequestSchema = wireSchema<ReviewReportsRequest>(z.object({ 'projectId': z.string().readonly() }).strict())
export const remoteAcceptReportRequestSchema = wireSchema<RemoteAcceptReportRequest>(z.object({
  'projectId': z.string().readonly(), 'attemptId': z.string().readonly(), 'generation': z.number().int().positive().readonly(),
  'expectedRevision': z.number().int().positive().readonly(), 'expectedTaskRevision': z.number().int().positive().readonly(),
  'rationale': z.string().trim().min(1).max(16_384).readonly(),
}).strict())
export const reviewableReportSchema = wireSchema<ReviewableReport>(z.object({
  'projectId': z.string().readonly(), 'teamId': z.string().readonly(), 'taskId': z.string().readonly(), 'attemptId': z.string().readonly(),
  'generation': z.number().readonly(), 'expectedRevision': z.number().readonly(), 'expectedTaskRevision': z.number().readonly(),
  'report': z.string().readonly(), 'criteria': z.string().readonly(), 'phase': z.union([z.literal('awaiting-review'), z.literal('pending'), z.literal('accepted')]).readonly(),
  'id': z.string().readonly().optional(), 'reviewerId': z.string().readonly().optional(), 'rationale': z.string().readonly().optional(),
}).strict().readonly())
export const reviewableReportsSchema = wireSchema<ReviewableReport[]>(z.array(reviewableReportSchema))
export const createWorkflowSchema = wireSchema<CreateWorkflowRequest>(z.object({
  projectId: z.string().readonly(), teamId: z.string().readonly(), templateId: z.string().readonly(), templateVersion: z.number().int().positive().readonly(),
  parameters: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])).readonly(), executionId: z.string().readonly().optional(),
}).strict())
export const workflowQuerySchema = wireSchema<{ executionId: string }>(z.object({ executionId: z.string().readonly() }).strict())
export const workflowViewSchema = wireSchema<WorkflowRuntimeView>(z.object({
  executionId: z.string().readonly(), projectId: z.string().readonly(), teamId: z.string().readonly(), templateId: z.string().readonly(), templateVersion: z.number().readonly(),
  steps: z.array(z.object({ stepId: z.string().readonly(), taskId: z.string().readonly().optional(), intentId: z.string().readonly().optional(), reportId: z.string().readonly().optional(),
    phase: z.union([z.literal('pending'), z.literal('running'), z.literal('completed'), z.literal('failed')]).readonly() }).strict().readonly()).readonly(),
}).strict().readonly())
export const nullableWorkflowViewSchema = wireSchema<WorkflowRuntimeView | undefined>(z.union([workflowViewSchema, z.undefined()]))

export const taskResultSchema = wireSchema<TeamTaskMutationResult>(z.union([z.object({
  'ok': z.literal(true).readonly(),
  'value': z.object({
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
  'subject': z.string().readonly(),
  'description': z.string().readonly(),
  'nonCodeCriteria': z.string().readonly().optional(),
  'status': z.union([z.literal("pending"), z.literal("in_progress"), z.literal("completed"), z.literal("deleted")]).readonly(),
  'blockedBy': z.array(z.intersection(z.string(), z.unknown())).readonly(),
  'writeScopes': z.array(z.string()).readonly(),
  'result': z.string().readonly().optional(),
  'ownerName': z.string().readonly().optional(),
  'ready': z.boolean().readonly(),
  'writeScopeWarnings': z.array(z.string()).readonly(),
}).readonly(),
}), z.object({
  'ok': z.literal(false).readonly(),
  'error': z.object({
  'code': z.union([z.literal("team-task-conflict"), z.literal("team-rejected")]).readonly(),
  'message': z.string().readonly(),
}).readonly(),
})]))

export const updateTaskSchema = wireSchema<UpdateTeamTaskRequest>(z.object({
  'taskId': z.intersection(z.string(), z.unknown()).readonly(),
  'expectedRevision': z.number().readonly(),
  'action': z.union([z.literal("complete"), z.literal("edit"), z.literal("claim"), z.literal("release"), z.literal("set_dependencies"), z.literal("reopen"), z.literal("reassign"), z.literal("delete")]).readonly(),
  'subject': z.string().readonly().optional(),
  'description': z.string().readonly().optional(),
  'blockedBy': z.array(z.intersection(z.string(), z.unknown())).readonly().optional(),
  'writeScopes': z.array(z.string()).readonly().optional(),
  'owner': z.string().readonly().optional(),
  'result': z.string().readonly().optional(),
}))

export const teamViewSchema = wireSchema<TeamView>(z.object({
  'members': z.array(z.object({
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'name': z.string().readonly(),
  'role': z.union([z.literal("lead"), z.literal("teammate")]).readonly(),
  'status': z.union([z.literal("running"), z.literal("failed"), z.literal("idle"), z.literal("inactive"), z.literal("provisioning")]).readonly(),
  'description': z.string().readonly().optional(),
  'provider': z.string().readonly().optional(),
  'context': z.union([z.literal("fresh"), z.literal("fork")]).readonly().optional(),
  'model': z.string().readonly().optional(),
  'diagnostics': z.array(z.string()).readonly(),
  'worktree': z.object({
  'memberId': z.intersection(z.string(), z.unknown()).readonly(),
  'provider': z.string().readonly(),
  'phase': z.union([z.literal("reserved"), z.literal("ready"), z.literal("released")]).readonly(),
  'repository': z.string().readonly(),
  'cwd': z.string().readonly(),
  'branch': z.intersection(z.string(), z.unknown()).readonly(),
  'baseCommit': z.intersection(z.string(), z.unknown()).readonly(),
}).readonly().optional(),
  'recoveryAttempts': z.number().readonly().optional(),
})).readonly(),
  'tasks': z.array(z.object({
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
  'subject': z.string().readonly(),
  'description': z.string().readonly(),
  'nonCodeCriteria': z.string().readonly().optional(),
  'status': z.union([z.literal("pending"), z.literal("in_progress"), z.literal("completed"), z.literal("deleted")]).readonly(),
  'blockedBy': z.array(z.intersection(z.string(), z.unknown())).readonly(),
  'writeScopes': z.array(z.string()).readonly(),
  'result': z.string().readonly().optional(),
  'ownerName': z.string().readonly().optional(),
  'ready': z.boolean().readonly(),
  'writeScopeWarnings': z.array(z.string()).readonly(),
})).readonly(),
  'batches': z.array(z.object({
  'completedTasks': z.number().readonly(),
  'status': z.union([z.literal("completed"), z.literal("active"), z.literal("archived")]).readonly(),
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'revision': z.number().readonly(),
  'name': z.string().readonly(),
  'description': z.string().readonly(),
  'taskIds': z.array(z.intersection(z.string(), z.unknown())).readonly(),
  'archived': z.boolean().readonly(),
})).readonly(),
  'integrations': z.array(z.object({
  'failureKind': z.literal('verification').optional(),
  'reviewGate': z.string().readonly().optional(),
  'reviewReceipt': z.object({
  'integrationId': z.intersection(z.string(), z.unknown()).readonly(),
  'sourceCommit': z.intersection(z.string(), z.unknown()).readonly(),
  'targetCommit': z.intersection(z.string(), z.unknown()).readonly(),
  'candidateCommit': z.intersection(z.string(), z.unknown()).readonly(),
  'reviewGate': z.string().readonly(),
  'reviewId': z.string().readonly(),
}).readonly().optional(),
  'previousCandidates': z.array(z.object({ cwd: z.string(), targetCommit: z.intersection(z.string(), z.unknown()), candidateCommit: z.intersection(z.string(), z.unknown()), error: z.string(), reviewReceipt: z.object({
  'integrationId': z.intersection(z.string(), z.unknown()).readonly(),
  'sourceCommit': z.intersection(z.string(), z.unknown()).readonly(),
  'targetCommit': z.intersection(z.string(), z.unknown()).readonly(),
  'candidateCommit': z.intersection(z.string(), z.unknown()).readonly(),
  'reviewGate': z.string().readonly(),
  'reviewId': z.string().readonly(),
}).readonly().optional() })).optional(),
  'id': z.intersection(z.string(), z.unknown()).readonly(),
  'memberId': z.intersection(z.string(), z.unknown()).readonly(),
  'provider': z.string().readonly(),
  'phase': z.union([z.literal("queued"), z.literal("running"), z.literal("failed"), z.literal("verified"), z.literal("merged")]).readonly(),
  'targetCommit': z.intersection(z.string(), z.unknown()).readonly().optional(),
  'candidateCommit': z.intersection(z.string(), z.unknown()).readonly().optional(),
  'error': z.string().readonly().optional(),
  'repository': z.string().readonly(),
  'cwd': z.string().readonly(),
  'sourceBranch': z.intersection(z.string(), z.unknown()).readonly(),
  'sourceCommit': z.intersection(z.string(), z.unknown()).readonly(),
  'targetBranch': z.intersection(z.string(), z.unknown()).readonly(),
  'verification': z.array(z.object({
  'command': z.string().readonly(),
  'args': z.array(z.string()).readonly(),
})).readonly(),
})).readonly(),
}))
