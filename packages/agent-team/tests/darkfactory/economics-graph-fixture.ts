import { economicsReferenceGraphSchema, type EconomicsReferenceGraph } from '../../src/darkfactory/contracts/economics-reference-graph.ts'
import { digestBytes, digestJson } from '../../src/darkfactory/json.ts'
import { examples } from './fixtures.ts'
const at = '2026-09-06T12:00:00Z', until = '2026-09-06T13:00:00Z'
const base = { schemaVersion: 1 as const, projectId: 'project-1', policyRevision: 1 }
/** Complete deterministic offline facts, not authenticated provider or Redis receipts. */
export function economicsGraphFixture(): EconomicsReferenceGraph {
  const artifacts = ['pricing-source', 'quota-source', 'benchmark-evidence', 'health-evidence'].map(id => {
    const bytes = Buffer.from(`fixture:${id}`)
    return { reference: { projectId: base.projectId, id, mediaType: 'text/plain', sizeBytes: bytes.length, digest: digestBytes(bytes) }, bytesBase64: bytes.toString('base64') }
  })
  const pricing = { ...examples.PricingSnapshotV1, id: 'pricing-1', source: artifacts[0]!.reference }
  const reservation = { ...examples.ReservationV1, id: 'reservation-1', state: 'started' }
  const quota = { ...examples.ProviderQuotaV1, id: 'quota-1', source: artifacts[1]!.reference, watermark: 'watermark-1' }
  const assignment = { ...examples.ModelRoleAssignmentV1, id: 'assignment-1', quotaDecisionId: 'quota-decision-1', benchmark: { ...examples.ModelRoleAssignmentV1.benchmark, evidence: artifacts[2]!.reference }, health: { ...examples.ModelRoleAssignmentV1.health, evidence: artifacts[3]!.reference } }
  const { eventDigest, ...usagePayload } = { ...examples.UsageEventV1, id: 'usage-1' }
  const usage = { ...usagePayload, eventDigest: digestJson(usagePayload) }
  const seal = <T extends object>(payload: T) => ({ ...base, revision: 1, ...payload, digest: digestJson({ ...base, revision: 1, ...payload }) })
  const catalog = seal({ kind: 'model-catalog', id: 'catalog-1', observedAt: at, expiresAt: until, models: [{ provider: assignment.provider, deploymentId: assignment.deploymentId, modelVersion: assignment.modelVersion, accountId: reservation.accountId,
    capabilities: assignment.capabilities, benchmark: assignment.benchmark, health: assignment.health, pricingSnapshotId: pricing.id, pricingSnapshotDigest: digestJson(pricing) }] })
  assignment.catalogDigest = catalog.digest
  return economicsReferenceGraphSchema.parse({ ...base, lane: 'fleet-economics', records: [
    { kind: 'PricingSnapshotV1', value: pricing }, { kind: 'ReservationV1', value: reservation }, { kind: 'UsageEventV1', value: usage },
    { kind: 'ProviderQuotaV1', value: quota }, { kind: 'ModelRoleAssignmentV1', value: assignment },
  ], definitions: [
    seal({ kind: 'fleet', id: 'fleet-1', authorityEpoch: 'epoch-1', currency: 'USD', hostIds: ['host-1'], accountIds: ['account-1'], emergencyPurposes: [] }),
    seal({ kind: 'host', id: 'host-1', fleetId: 'fleet-1' }),
    seal({ kind: 'account', id: 'account-1', fleetId: 'fleet-1', provider: 'fixture', quotaPoolIds: ['pool-1'] }),
    seal({ kind: 'attempt', id: 'attempt-1', fleetId: 'fleet-1', hostId: 'host-1', accountId: 'account-1', generation: 1, modelAssignmentId: assignment.id, requestIds: ['request-1'] }),
    catalog,
    seal({ kind: 'request', id: 'request-1', fleetId: 'fleet-1', hostId: 'host-1', accountId: 'account-1', attemptId: 'attempt-1', generation: 1,
      provider: assignment.provider, deploymentId: assignment.deploymentId, modelVersion: assignment.modelVersion, assignmentId: assignment.id, assignmentDigest: digestJson(assignment),
      reservationId: reservation.id, reservationDigest: digestJson(reservation), pricingSnapshotId: pricing.id, pricingSnapshotDigest: digestJson(pricing), quotaDecisionId: 'quota-decision-1', createdAt: at, usageEventIds: [usage.id], usageEventDigests: [usage.eventDigest], lastStreamSequence: 1 }),
    seal({ kind: 'quota-pool', id: 'pool-1', fleetId: 'fleet-1', accountId: 'account-1', unit: quota.unit, adapter: quota.adapter, adapterVersion: quota.adapterVersion, quotaSnapshotId: quota.id }),
    seal({ kind: 'quota-decision', id: 'quota-decision-1', fleetId: 'fleet-1', hostId: 'host-1', accountId: 'account-1', attemptId: 'attempt-1', generation: 1,
      requestId: 'request-1', reservationId: reservation.id, reservationDigest: digestJson(reservation), decision: 'allow', observedAt: at, snapshots: [{ poolId: 'pool-1', quotaId: quota.id, quotaDigest: digestJson(quota) }] }),
    seal({ kind: 'quota-watermark', id: 'watermark-1', fleetId: 'fleet-1', accountId: 'account-1', poolId: 'pool-1', quotaSnapshotId: quota.id, reflectedUsageIds: [] }),
  ], artifacts })
}
