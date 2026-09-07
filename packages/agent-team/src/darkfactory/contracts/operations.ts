import z from 'zod'
import { artifactRefSchema, counterSchema, idSchema, recordFields, revisionSchema, timestampSchema } from './common.ts'

/** Structured host events reference restricted artifacts instead of persisting arbitrary log text. */
export const operationalEventSchema = z.strictObject({
  ...recordFields, version: z.literal(1), sequence: revisionSchema, expectedRecordRevision: counterSchema,
  recordId: idSchema, eventKind: idSchema, occurredAt: timestampSchema,
  severity: z.enum(['info', 'warning', 'error']), reasonCode: idSchema,
  workflowId: idSchema.optional(), attemptId: idSchema.optional(), releaseId: idSchema.optional(),
  healthEscalationId: idSchema.optional(), artifacts: z.array(artifactRefSchema).max(32),
})
export type OperationalEventV1 = z.output<typeof operationalEventSchema>
