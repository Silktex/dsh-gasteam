/** Browser-safe, bounded workspace dashboard projection. Coordinator wiring remains host-owned. */
import { z } from 'zod'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const diagnostic = z.string().trim().min(1).max(16_384)

const projectSchema = z.object({ id, revision, paused: z.boolean(), capacity: revision, active: revision }).strip()
const attemptSchema = z.object({
  attemptId: id, generation: positive, revision: positive, projectId: id, teamId: id, taskId: id,
  phase: z.enum(['reserved', 'active', 'stopping', 'terminal']),
  progress: z.object({ classification: z.enum(['progressing', 'idle', 'dependency-wait', 'operator-wait', 'stale', 'unavailable', 'failed']), certainty: z.enum(['known', 'uncertain']), observedAt: timestamp }).strip().optional(),
}).strip()
const workflowStepSchema = z.object({ stepId: id, revision: positive, phase: z.enum(['pending', 'running', 'completed', 'failed']), taskId: id.optional() }).strip()
const workflowSchema = z.object({ executionId: id, projectId: id, teamId: id, steps: z.array(workflowStepSchema) }).strip()
const batchSchema = z.object({ id, phase: z.enum(['active', 'blocked', 'failed', 'completed']), required: positive, completedRequired: revision, completionEpoch: revision }).strip()
const queueBlockerSchema = z.object({ code: z.enum(['execution-disabled', 'shutdown', 'project-unavailable', 'paused', 'team-unavailable', 'task-unavailable', 'task-not-pending', 'task-owned', 'dependencies', 'global-capacity', 'project-capacity', 'pacing', 'cancelled', 'execution-failure', 'awaiting-acceptance', 'recovery-required', 'workspace-batch-dependency', 'provider-admission']) }).strip()
const queueSchema = z.object({ projectId: id, teamId: id, taskId: id, revision: positive, state: z.enum(['ready', 'waiting', 'assigned', 'finished', 'cancelled', 'accepted']), blockers: z.array(queueBlockerSchema) }).strip()
const integrationSchema = z.object({
  integrationId: id, projectId: id, teamId: id, phase: z.enum(['queued', 'running', 'verified', 'merged', 'failed']), sourceCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  failureKind: z.literal('verification').optional(), diagnostic: diagnostic.optional(),
}).strip()
const escalationSchema = z.object({
  id, revision: positive, projectId: id, teamId: id, taskId: id, attemptId: id, generation: positive,
  severity: z.enum(['warning', 'critical']), condition: z.enum(['stale', 'failed']), diagnostics: diagnostic,
}).strip()

/** Deliberately small host input: prompts, paths, credentials, and raw histories are not part of this contract. */
export const workspaceDashboardInputSchema = z.object({
  projects: z.array(projectSchema), attempts: z.array(attemptSchema), workflows: z.array(workflowSchema),
  batches: z.array(batchSchema), queue: z.array(queueSchema), integrations: z.array(integrationSchema), escalations: z.array(escalationSchema),
}).strip()
export type WorkspaceDashboardInput = z.input<typeof workspaceDashboardInputSchema>
export const workspaceDashboardRequestSchema = z.object({}).strict()
export type WorkspaceDashboardRequest = z.output<typeof workspaceDashboardRequestSchema>

const limitsSchema = z.object({
  projects: z.number().int().min(0).max(256).optional(), attempts: z.number().int().min(0).max(512).optional(),
  workflows: z.number().int().min(0).max(256).optional(), workflowSteps: z.number().int().min(0).max(64).optional(),
  batches: z.number().int().min(0).max(256).optional(), queue: z.number().int().min(0).max(512).optional(), queueBlockers: z.number().int().min(0).max(64).optional(), integrations: z.number().int().min(0).max(256).optional(), escalations: z.number().int().min(0).max(256).optional(),
}).strict()
export type WorkspaceDashboardLimits = z.input<typeof limitsSchema>
const defaults = { projects: 64, attempts: 128, workflows: 64, workflowSteps: 32, batches: 64, queue: 128, queueBlockers: 32, integrations: 64, escalations: 64 } as const

const workspaceDashboardWorkflowSchema = z.object({
  executionId: id, projectId: id, teamId: id, steps: z.array(workflowStepSchema).max(64), stepsTruncated: z.boolean(),
}).strict()
/** Wire schema for the read-only dashboard Remote endpoint. */
export const workspaceDashboardViewSchema = z.object({
  projects: z.array(projectSchema).max(256), projectsTruncated: z.boolean(),
  attempts: z.array(attemptSchema).max(512), attemptsTruncated: z.boolean(),
  workflows: z.array(workspaceDashboardWorkflowSchema).max(256), workflowsTruncated: z.boolean(),
  batches: z.array(batchSchema).max(256), batchesTruncated: z.boolean(),
  queue: z.array(queueSchema.extend({ blockers: z.array(queueBlockerSchema).max(64), blockersTruncated: z.boolean() }).strict()).max(512), queueTruncated: z.boolean(),
  integrations: z.array(integrationSchema).max(256), integrationsTruncated: z.boolean(),
  escalations: z.array(escalationSchema).max(256), escalationsTruncated: z.boolean(),
}).strict()
export type WorkspaceDashboardView = z.output<typeof workspaceDashboardViewSchema>
export const workspaceDashboardCollectionSchema = z.enum(['projects', 'attempts', 'workflows', 'batches', 'queue', 'integrations', 'escalations'])
export type WorkspaceDashboardCollection = z.output<typeof workspaceDashboardCollectionSchema>
export const workspaceDashboardPageRequestSchema = z.object({
  collection: workspaceDashboardCollectionSchema,
  pageSize: z.number().int().min(1).max(256).optional(),
  cursor: z.string().min(1).max(8_192).optional(),
}).strict()
export type WorkspaceDashboardPageRequest = z.output<typeof workspaceDashboardPageRequestSchema>
const pageItemSchema = z.union([
  projectSchema, attemptSchema, workspaceDashboardWorkflowSchema,
  batchSchema, queueSchema.extend({ blockers: z.array(queueBlockerSchema).max(64), blockersTruncated: z.boolean() }).strict(), integrationSchema, escalationSchema,
])
export const workspaceDashboardPageSchema = z.object({
  collection: workspaceDashboardCollectionSchema, snapshotRevision: z.string().regex(/^[0-9a-f]{64}$/),
  items: z.array(pageItemSchema).max(256), nextCursor: z.string().min(1).max(8_192).optional(), truncated: z.boolean(),
}).strict()
export type WorkspaceDashboardPage = z.output<typeof workspaceDashboardPageSchema>

function bound<T>(values: readonly T[], limit: number): { readonly values: readonly T[]; readonly truncated: boolean } {
  return { values: values.slice(0, limit), truncated: values.length > limit }
}

/**
 * Convert a host-supplied minimal snapshot into a safe, bounded browser projection.
 * Uncertain health is intentionally preserved instead of inferred as activity.
 */
export function projectWorkspaceDashboard(input: unknown, configured: WorkspaceDashboardLimits = {}, wire = true): WorkspaceDashboardView {
  const source = workspaceDashboardInputSchema.parse(input)
  const configuredLimits = wire ? limitsSchema.parse(configured) : configured
  const limits = {
    projects: configuredLimits.projects ?? defaults.projects,
    attempts: configuredLimits.attempts ?? defaults.attempts,
    workflows: configuredLimits.workflows ?? defaults.workflows,
    workflowSteps: configuredLimits.workflowSteps ?? defaults.workflowSteps,
    batches: configuredLimits.batches ?? defaults.batches,
    queue: configuredLimits.queue ?? defaults.queue,
    queueBlockers: configuredLimits.queueBlockers ?? defaults.queueBlockers,
    integrations: configuredLimits.integrations ?? defaults.integrations,
    escalations: configuredLimits.escalations ?? defaults.escalations,
  }
  const projects = bound(source.projects, limits.projects)
  const attempts = bound(source.attempts, limits.attempts)
  const workflows = bound(source.workflows, limits.workflows)
  const batches = bound(source.batches, limits.batches)
  const queue = bound(source.queue, limits.queue)
  const integrations = bound(source.integrations, limits.integrations)
  const escalations = bound(source.escalations, limits.escalations)
  const result = {
    projects: projects.values, projectsTruncated: projects.truncated,
    attempts: attempts.values, attemptsTruncated: attempts.truncated,
    workflows: workflows.values.map(workflow => {
      const steps = bound(workflow.steps, limits.workflowSteps)
      return { executionId: workflow.executionId, projectId: workflow.projectId, teamId: workflow.teamId, steps: steps.values, stepsTruncated: steps.truncated }
    }), workflowsTruncated: workflows.truncated,
    batches: batches.values, batchesTruncated: batches.truncated,
    queue: queue.values.map(request => {
      const blockers = bound(request.blockers, limits.queueBlockers)
      return { projectId: request.projectId, teamId: request.teamId, taskId: request.taskId, revision: request.revision, state: request.state, blockers: blockers.values, blockersTruncated: blockers.truncated }
    }), queueTruncated: queue.truncated,
    integrations: integrations.values, integrationsTruncated: integrations.truncated,
    escalations: escalations.values, escalationsTruncated: escalations.truncated,
  }
  return (wire ? workspaceDashboardViewSchema.parse(result) : result) as WorkspaceDashboardView
}

/** A larger but still browser-safe capture used only by the host's retained page snapshots. */
export function projectWorkspaceDashboardSnapshot(input: unknown): WorkspaceDashboardView {
  return projectWorkspaceDashboard(input, {
    projects: 1_000_000, attempts: 1_000_000, workflows: 1_000_000, workflowSteps: 64,
    batches: 1_000_000, queue: 1_000_000, queueBlockers: 64, integrations: 1_000_000, escalations: 1_000_000,
  }, false)
}
