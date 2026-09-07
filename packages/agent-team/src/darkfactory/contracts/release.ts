import z from 'zod'
import { artifactRefSchema, commitSchema, counterSchema, digestSchema, idSchema, recordFields, repositorySchema, revisionSchema, signatureSchema, timestampSchema, uniqueIds } from './common.ts'
import { canonicalJson } from '../json.ts'
import { assertContractSemantics } from './semantics.ts'

const deploymentIdentity = {
  ...recordFields, environment: idSchema, releaseId: idSchema, operationId: idSchema,
  fencingToken: revisionSchema, commit: commitSchema, artifactDigest: digestSchema,
}
export const deploymentRequestSchema = z.strictObject({
  ...deploymentIdentity, protocolVersion: z.literal(1), keyId: idSchema, timestamp: timestampSchema,
  operation: z.enum(['deployCanary', 'promote', 'withdrawCanary', 'deployRollback']),
  expectedPriorDeployment: idSchema, policyDigest: digestSchema,
})
export const deploymentStatusSchema = z.strictObject({
  ...deploymentIdentity, protocolVersion: z.literal(1), providerRevision: revisionSchema,
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'unknown']),
  deploymentId: idSchema.optional(), requestDigest: digestSchema, observedAt: timestampSchema,
})
export const deploymentCallbackSchema = z.strictObject({
  ...recordFields, protocolVersion: z.literal(1), keyId: idSchema, timestamp: timestampSchema,
  status: deploymentStatusSchema,
})
const sampleWindow = z.strictObject({
  start: timestampSchema, end: timestampSchema, requests: counterSchema, errors: counterSchema,
  histogram: artifactRefSchema.optional(), p99Ms: z.number().min(0).nullable(),
})
export const telemetryVerdictPayloadSchema = z.strictObject({
  ...recordFields, releaseId: idSchema, deploymentId: idSchema, artifactDigest: digestSchema,
  policyDigest: digestSchema, queryRevision: revisionSchema, baseline: sampleWindow, sample: sampleWindow,
  newestSampleAt: timestampSchema, collectedAt: timestampSchema, expiresAt: timestampSchema,
  breachCount: counterSchema, result: z.enum(['HEALTHY', 'ANOMALY_DETECTED', 'INSUFFICIENT_DATA']),
  reasons: uniqueIds(32), queryArtifacts: z.array(artifactRefSchema).min(1).max(32), signerKeyId: idSchema,
})
export const telemetryVerdictSchema = telemetryVerdictPayloadSchema.extend({ attestationHash: digestSchema, signature: signatureSchema })
export const releaseRecordSchema = z.strictObject({
  ...recordFields, repository: repositorySchema, environment: idSchema, componentId: idSchema,
  workflowId: idSchema, integrationReceiptId: idSchema, attemptIds: uniqueIds(64).min(1),
  specDigests: z.array(digestSchema).min(1).max(64), evidenceHashes: z.array(digestSchema).min(1).max(64),
  commit: commitSchema, artifact: artifactRefSchema,
  priorAcceptedReleaseId: idSchema, priorArtifact: artifactRefSchema, policyDigest: digestSchema, policySnapshot: artifactRefSchema,
  state: z.enum(['queued', 'deploying', 'observing', 'accepted', 'rollback_queued', 'rolled_back', 'failed', 'quarantined']),
  revision: revisionSchema, fencingToken: revisionSchema,
  operationIntents: z.array(deploymentRequestSchema).max(16), operationReceipts: z.array(deploymentStatusSchema).max(128),
  canaryStartedAt: timestampSchema.optional(), canaryDeadline: timestampSchema.optional(), promotionDeadline: timestampSchema.optional(),
  telemetryIds: uniqueIds(256), rollbackIntegrationId: idSchema.optional(), diagnosticTaskId: idSchema.optional(),
  healthEscalationId: idSchema.optional(),
})
export type ReleaseRecordV1 = z.output<typeof releaseRecordSchema>
export type TelemetryVerdictV1 = z.output<typeof telemetryVerdictSchema>

export const releaseTransitions = {
  queued: ['deploying', 'failed', 'quarantined'],
  deploying: ['observing', 'rollback_queued', 'failed', 'quarantined'],
  observing: ['accepted', 'rollback_queued', 'failed', 'quarantined'],
  rollback_queued: ['rolled_back', 'failed', 'quarantined'],
  accepted: [], rolled_back: [], failed: [], quarantined: [],
} as const

/** State owners must persist this comparison atomically with the expected revision. */
export function assertReleaseTransition(from: ReleaseRecordV1, to: ReleaseRecordV1): void {
  releaseRecordSchema.parse(from)
  releaseRecordSchema.parse(to)
  assertContractSemantics('ReleaseRecordV1', from)
  assertContractSemantics('ReleaseRecordV1', to)
  if (to.revision !== from.revision + 1 || to.fencingToken < from.fencingToken) throw new Error('Stale release revision or fencing token')
  const transitions: readonly string[] = releaseTransitions[from.state]
  if (!transitions.length || (from.state !== to.state && !transitions.includes(to.state))) throw new Error('Illegal release lifecycle transition')
  for (const key of ['schemaVersion', 'id', 'projectId', 'policyRevision', 'repository', 'environment', 'componentId', 'workflowId', 'integrationReceiptId', 'attemptIds', 'specDigests', 'evidenceHashes', 'commit', 'artifact', 'priorAcceptedReleaseId', 'priorArtifact', 'policyDigest', 'policySnapshot'] as const) {
    if (canonicalJson(from[key]) !== canonicalJson(to[key])) throw new Error('Release identity and pinned inputs are immutable')
  }
  for (const key of ['operationIntents', 'operationReceipts', 'telemetryIds'] as const) {
    if (canonicalJson(from[key]) !== canonicalJson(to[key].slice(0, from[key].length))) throw new Error('Release operation and telemetry history is append-only')
  }
  for (const key of ['canaryStartedAt', 'canaryDeadline', 'promotionDeadline', 'rollbackIntegrationId', 'diagnosticTaskId', 'healthEscalationId'] as const) {
    if (from[key] !== undefined && from[key] !== to[key]) throw new Error('Recorded release deadlines and recovery references are immutable')
  }
}

export type DeploymentRequestV1 = z.output<typeof deploymentRequestSchema>
export type DeploymentStatusV1 = z.output<typeof deploymentStatusSchema>
export type DeploymentCallbackV1 = z.output<typeof deploymentCallbackSchema>
