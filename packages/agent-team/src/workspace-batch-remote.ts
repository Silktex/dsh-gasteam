/** Strict browser-safe codecs for coordinator-owned cross-project batch operations. */
import { z } from 'zod'
import { workspaceBatchPlanSchema } from './scheduling-schemas.ts'
import type { WorkspaceBatchPlanRequest } from './scheduling-schemas.ts'
import type { WorkspaceBatchNotification, WorkspaceBatchView } from './coordinator-batches.ts'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const taskRefSchema = z.object({ projectId: id, teamId: id, taskId: id }).strict()
const itemHistorySchema = z.object({ state: z.enum(['waiting', 'active', 'blocked', 'failed', 'accepted']), activeAssignment: z.boolean(), at: positive }).strict()
const batchHistorySchema = z.object({ phase: z.enum(['completed', 'reopened', 'failed']), at: positive }).strict()

export const workspaceBatchPlanRequestSchema = workspaceBatchPlanSchema
export type WorkspaceBatchPlanRequestWire = WorkspaceBatchPlanRequest
export const workspaceBatchQuerySchema = z.object({ batchId: id }).strict()
export type WorkspaceBatchQuery = z.output<typeof workspaceBatchQuerySchema>
export const workspaceBatchSubscriptionRequestSchema = z.object({ batchId: id, subscriptionId: id }).strict()
export type WorkspaceBatchSubscriptionRequest = z.output<typeof workspaceBatchSubscriptionRequestSchema>
export const workspaceBatchInboxRequestSchema = z.object({}).strict()
export type WorkspaceBatchInboxRequest = z.output<typeof workspaceBatchInboxRequestSchema>
export const workspaceBatchAcknowledgementRequestSchema = z.object({ intentId: id }).strict()
export type WorkspaceBatchAcknowledgementRequest = z.output<typeof workspaceBatchAcknowledgementRequestSchema>

export const workspaceBatchViewSchema: z.ZodType<WorkspaceBatchView> = z.object({
  id, name: z.string().trim().min(1).max(16_384), phase: z.enum(['active', 'blocked', 'failed', 'completed']), completionEpoch: nonnegative,
  completedRequired: nonnegative, required: positive, readyWithoutActiveAssignment: z.array(taskRefSchema),
  items: z.array(z.object({ ref: taskRefSchema, state: z.enum(['waiting', 'active', 'blocked', 'failed', 'accepted']), activeAssignment: z.boolean(), dependsOn: z.array(taskRefSchema), history: z.array(itemHistorySchema) }).strict()),
  history: z.array(batchHistorySchema),
}).strict()
export const workspaceBatchNotificationSchema: z.ZodType<WorkspaceBatchNotification> = z.object({
  intentId: id, batchId: id, subscriptionId: id, destination: z.string().trim().min(1).max(16_384), completionEpoch: positive,
}).strict()
export const workspaceBatchNotificationsSchema: z.ZodType<WorkspaceBatchNotification[]> = z.array(workspaceBatchNotificationSchema)
