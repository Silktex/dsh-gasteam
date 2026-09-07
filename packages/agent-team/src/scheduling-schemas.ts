/** Browser-safe scheduling request and response contracts. */
import z from 'zod'
const id = z.string().min(1).max(128)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const schedulingQuerySchema = z.object({ projectId: id }).strict()
const cancelControlSchema = z.object({ action: z.literal('cancel'), projectId: id, taskId: id, expectedRevision: revision.min(1), reason: z.string().trim().min(1).max(16_384), attemptId: id.optional(), generation: revision.min(1).optional(), expectedAttemptRevision: revision.min(1).optional() }).strict().superRefine((value, ctx) => {
  const count = Number(value.attemptId !== undefined) + Number(value.generation !== undefined) + Number(value.expectedAttemptRevision !== undefined)
  if (count !== 0 && count !== 3) ctx.addIssue({ code: 'custom', message: 'Cancellation attempt token must be complete when provided' })
})
const retryControlSchema = z.object({ action: z.literal('retry'), projectId: id, taskId: id, expectedRevision: revision.min(1), attemptId: id, generation: revision.min(1), expectedAttemptRevision: revision.min(1) }).strict()
export const schedulingControlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause'), projectId: id, expectedRevision: revision, paused: z.boolean() }).strict(),
  cancelControlSchema,
  retryControlSchema,
  z.object({ action: z.literal('priority'), projectId: id, taskId: id, expectedRevision: revision.min(1), priority: z.number().int().min(-1_000_000).max(1_000_000) }).strict(),
  z.object({ action: z.literal('handoff'), projectId: id, taskId: id, expectedRevision: revision.min(1), attemptId: id, generation: revision.min(1), expectedAttemptRevision: revision.min(1) }).strict(),
])
/** Browser-safe model input for a coordinator-owned cross-project batch. */
export const workspaceBatchTaskSchema = z.object({
  id, projectId: id, teamId: id, subject: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(16_384),
  nonCodeCriteria: z.string().trim().min(1).max(16_384).optional(), dependsOn: z.array(id).max(256).default([]),
}).strict()
export const workspaceBatchPlanSchema = z.object({
  id: id.optional(), name: z.string().trim().min(1).max(16_384), items: z.array(workspaceBatchTaskSchema).min(1).max(256),
  subscriptions: z.array(z.object({ id, destination: z.string().trim().min(1).max(16_384) }).strict()).max(256).default([]),
}).strict()
export const schedulingViewSchema = z.object({
  projectId: id, paused: z.boolean(), controlRevision: revision,
  requests: z.array(z.object({
    projectId: id, teamId: id, taskId: id, order: revision.min(1), priority: z.number().int(), revision: revision.min(1),
    state: z.enum(['ready', 'waiting', 'assigned', 'finished', 'cancelled', 'accepted']),
    blockers: z.array(z.object({ code: z.enum(['execution-disabled', 'shutdown', 'project-unavailable', 'paused', 'team-unavailable',
      'task-unavailable', 'task-not-pending', 'task-owned', 'dependencies', 'global-capacity', 'project-capacity', 'pacing',
      'cancelled', 'execution-failure', 'awaiting-acceptance', 'recovery-required', 'workspace-batch-dependency', 'provider-admission', 'factory-admission-held']), detail: z.string() }).strict()),
    cancelReason: z.string().optional(), attemptId: id.optional(), enqueuedAt: z.number().int().nonnegative().optional(), nextDispatchAt: z.number().optional(),
  }).strict()),
}).strict()
export type SchedulingQuery = z.infer<typeof schedulingQuerySchema>
export type SchedulingControl = z.infer<typeof schedulingControlSchema>
export type SchedulingView = z.infer<typeof schedulingViewSchema>
export type WorkspaceBatchPlanRequest = z.input<typeof workspaceBatchPlanSchema>
