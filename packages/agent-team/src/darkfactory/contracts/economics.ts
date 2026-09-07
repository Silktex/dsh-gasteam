import z from 'zod'
import { artifactRefSchema, counterSchema, digestSchema, idSchema, recordFields, revisionSchema, timestampSchema, uniqueIds } from './common.ts'

export const emergencyPurposeSchema = z.enum(['canary-recovery', 'verified-p0-security', 'production-invariant-recovery'])
export const pricingSnapshotSchema = z.strictObject({
  ...recordFields, provider: idSchema, accountId: idSchema, modelVersion: idSchema,
  currency: z.literal('USD'), revision: revisionSchema, observedAt: timestampSchema, expiresAt: timestampSchema,
  inputMicrosPerMillion: counterSchema, cachedInputMicrosPerMillion: counterSchema,
  outputMicrosPerMillion: counterSchema, reasoningMicrosPerMillion: counterSchema,
  subscriptionFeeMicros: counterSchema, source: artifactRefSchema,
})
export const reservationSchema = z.strictObject({
  ...recordFields, fleetId: idSchema, hostId: idSchema, accountId: idSchema, attemptId: idSchema, generation: revisionSchema,
  requestId: idSchema, authorityEpoch: idSchema, fencingToken: revisionSchema, pricingRevision: revisionSchema,
  currency: z.literal('USD'), maxCostMicros: counterSchema, maxTokens: counterSchema, maxRequests: revisionSchema,
  quotaPoolIds: uniqueIds(64), purpose: z.enum(['routine', ...emergencyPurposeSchema.options]),
  purposeEvidence: z.array(artifactRefSchema).max(32), createdAt: timestampSchema, reconcileBy: timestampSchema,
  accountingDay: z.iso.date(), accountingMonth: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  state: z.enum(['reserved', 'started', 'reconciling', 'settled', 'withheld']),
})
export const usageEventPayloadSchema = z.strictObject({
  ...recordFields, fleetId: idSchema, hostId: idSchema, attemptId: idSchema, generation: revisionSchema,
  provider: idSchema, accountId: idSchema, modelVersion: idSchema, requestId: idSchema,
  streamSequence: revisionSchema, pricingRevision: revisionSchema, usageAt: timestampSchema,
  inputTokens: counterSchema, cacheTokens: counterSchema, outputTokens: counterSchema, reasoningTokens: counterSchema,
  countingSemantics: z.enum(['exclusive-categories', 'cache-in-input-reasoning-in-output']),
  billedCostMicros: counterSchema, currency: z.literal('USD'), reservationId: idSchema,
  correctionOf: idSchema.optional(),
  compression: z.strictObject({ compressed: z.boolean(), estimatedInputTokens: counterSchema.nullable(), estimatedSavedTokens: counterSchema.nullable(), retrievalCostMicros: counterSchema.nullable() }).optional(),
})
export const usageEventSchema = usageEventPayloadSchema.extend({ eventDigest: digestSchema })
export const providerQuotaSchema = z.strictObject({
  ...recordFields, fleetId: idSchema, accountId: idSchema, poolId: idSchema,
  unit: z.enum(['tokens', 'requests', 'credits']), total: counterSchema, observedRemaining: counterSchema,
  windowStart: timestampSchema, windowEnd: timestampSchema, resetAt: timestampSchema,
  observedAt: timestampSchema, expiresAt: timestampSchema, adapter: idSchema, adapterVersion: idSchema,
  source: artifactRefSchema, authority: z.enum(['provider', 'manual-fixture']), watermark: idSchema,
})
export const modelIdentitySchema = z.strictObject({ provider: idSchema, deploymentId: idSchema, modelVersion: idSchema })
export const modelRoleAssignmentSchema = z.strictObject({
  ...recordFields, attemptId: idSchema, generation: revisionSchema,
  role: z.enum(['fast-loops', 'core-coding', 'deep-reasoning', 'long-context']), ...modelIdentitySchema.shape,
  catalogRevision: revisionSchema, catalogDigest: digestSchema,
  capabilities: z.strictObject({ tools: z.boolean(), structuredOutput: z.boolean(), reasoning: z.boolean(), inputLimit: revisionSchema, outputLimit: revisionSchema }),
  benchmark: z.strictObject({ revision: revisionSchema, score: z.number().min(0).max(1), evidence: artifactRefSchema }),
  health: z.strictObject({ observedAt: timestampSchema, expiresAt: timestampSchema, p95LatencyMs: counterSchema, evidence: artifactRefSchema }),
  pricingRevision: revisionSchema, fallbackChain: z.array(modelIdentitySchema).max(32),
  quotaDecisionId: idSchema, reservationId: idSchema, assignedAt: timestampSchema,
})
export type UsageEventV1 = z.output<typeof usageEventSchema>
export type ProviderQuotaV1 = z.output<typeof providerQuotaSchema>
export type ModelRoleAssignmentV1 = z.output<typeof modelRoleAssignmentSchema>

export type PricingSnapshotV1 = z.output<typeof pricingSnapshotSchema>
export type ReservationV1 = z.output<typeof reservationSchema>
