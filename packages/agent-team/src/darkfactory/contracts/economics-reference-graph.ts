/** Offline closure of pinned economic facts. No ledger, provider, or spending authority is established. */
import z from 'zod'
import { artifactRefSchema, counterSchema, digestSchema, idSchema, recordFields, revisionSchema, timestampSchema, uniqueIds } from './common.ts'
import { emergencyPurposeSchema, modelIdentitySchema, modelRoleAssignmentSchema, pricingSnapshotSchema, providerQuotaSchema, reservationSchema, usageEventSchema } from './economics.ts'
import { assertContractSemantics } from './semantics.ts'
import { graphArtifactDescriptorSchema, graphArtifactLimits, validateGraphArtifacts } from './graph-core.ts'
import { canonicalJson, digestJson, parseStrictJson } from '../json.ts'

export const economicsGraphLimits = { records: 128, definitions: 128, bundleBytes: 12_582_912 } as const
const registration = { ...recordFields, revision: revisionSchema, digest: digestSchema }
const modelSchema = z.strictObject({ ...modelIdentitySchema.shape, accountId: idSchema,
  capabilities: modelRoleAssignmentSchema.shape.capabilities, benchmark: modelRoleAssignmentSchema.shape.benchmark,
  health: modelRoleAssignmentSchema.shape.health, pricingSnapshotId: idSchema, pricingSnapshotDigest: digestSchema,
})
export const economicsGraphRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('PricingSnapshotV1'), value: pricingSnapshotSchema }),
  z.strictObject({ kind: z.literal('ReservationV1'), value: reservationSchema }),
  z.strictObject({ kind: z.literal('UsageEventV1'), value: usageEventSchema }),
  z.strictObject({ kind: z.literal('ProviderQuotaV1'), value: providerQuotaSchema }),
  z.strictObject({ kind: z.literal('ModelRoleAssignmentV1'), value: modelRoleAssignmentSchema }),
])
export const economicsGraphDefinitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...registration, kind: z.literal('fleet'), authorityEpoch: idSchema, currency: z.literal('USD'), hostIds: uniqueIds().min(1), accountIds: uniqueIds().min(1), emergencyPurposes: z.array(emergencyPurposeSchema).max(3) }),
  z.strictObject({ ...registration, kind: z.literal('host'), fleetId: idSchema }),
  z.strictObject({ ...registration, kind: z.literal('account'), fleetId: idSchema, provider: idSchema, quotaPoolIds: uniqueIds(64) }),
  z.strictObject({ ...registration, kind: z.literal('attempt'), fleetId: idSchema, hostId: idSchema, accountId: idSchema, generation: revisionSchema, modelAssignmentId: idSchema, requestIds: uniqueIds(128).min(1) }),
  z.strictObject({ ...registration, kind: z.literal('model-catalog'), observedAt: timestampSchema, expiresAt: timestampSchema, models: z.array(modelSchema).min(1).max(128) }),
  z.strictObject({ ...registration, kind: z.literal('request'), fleetId: idSchema, hostId: idSchema, accountId: idSchema, attemptId: idSchema, generation: revisionSchema,
    ...modelIdentitySchema.shape, assignmentId: idSchema, assignmentDigest: digestSchema, reservationId: idSchema, reservationDigest: digestSchema,
    pricingSnapshotId: idSchema, pricingSnapshotDigest: digestSchema, quotaDecisionId: idSchema, createdAt: timestampSchema,
    usageEventIds: uniqueIds(128), usageEventDigests: z.array(digestSchema).max(128), lastStreamSequence: counterSchema.max(128),
  }),
  z.strictObject({ ...registration, kind: z.literal('quota-pool'), fleetId: idSchema, accountId: idSchema, unit: providerQuotaSchema.shape.unit,
    adapter: idSchema, adapterVersion: idSchema, quotaSnapshotId: idSchema }),
  z.strictObject({ ...registration, kind: z.literal('quota-decision'), fleetId: idSchema, hostId: idSchema, accountId: idSchema, attemptId: idSchema, generation: revisionSchema,
    requestId: idSchema, reservationId: idSchema, reservationDigest: digestSchema, decision: z.literal('allow'), observedAt: timestampSchema,
    snapshots: z.array(z.strictObject({ poolId: idSchema, quotaId: idSchema, quotaDigest: digestSchema })).max(64),
  }),
  z.strictObject({ ...registration, kind: z.literal('quota-watermark'), fleetId: idSchema, accountId: idSchema, poolId: idSchema, quotaSnapshotId: idSchema, reflectedUsageIds: uniqueIds(128) }),
  z.strictObject({ ...registration, kind: z.literal('emergency-purpose-grant'), fleetId: idSchema, reservationId: idSchema, purpose: emergencyPurposeSchema, evidence: z.array(artifactRefSchema).min(1).max(32) }),
])
export const economicsReferenceGraphSchema = z.strictObject({ schemaVersion: z.literal(1), lane: z.literal('fleet-economics'), projectId: idSchema, policyRevision: revisionSchema,
  records: z.array(economicsGraphRecordSchema).min(1).max(economicsGraphLimits.records),
  definitions: z.array(economicsGraphDefinitionSchema).min(1).max(economicsGraphLimits.definitions),
  artifacts: z.array(graphArtifactDescriptorSchema).max(graphArtifactLimits.count),
})
export type EconomicsReferenceGraph = z.input<typeof economicsReferenceGraphSchema>
type Record = z.output<typeof economicsGraphRecordSchema>
type Values = { [R in Record as R['kind']]: R['value'] }
type Definition = z.output<typeof economicsGraphDefinitionSchema>
function require(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(`Economics graph rejected: ${reason}`) }
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b) }
function identity(model: z.output<typeof modelIdentitySchema>): string { return canonicalJson([model.provider, model.deploymentId, model.modelVersion]) }
function between(at: string, start: string, end: string): boolean { return Date.parse(start) <= Date.parse(at) && Date.parse(at) < Date.parse(end) }
function unique(values: string[], reason: string): void { require(new Set(values).size === values.length, reason) }

/** Complete supplied request streams are required; incremental/gapped streams belong to a live ledger.
 * Every registered definition's digest covers its entire payload except its own digest field.
 */
export function validateEconomicsReferenceGraph(raw: unknown): {
  lane: 'fleet-economics'; records: number; registeredDefinitions: number; artifacts: number;
  authorityVerified: false; accountingReconciled: false; providerBillingVerified: false
} {
  let input: z.output<typeof economicsReferenceGraphSchema>
  try { input = economicsReferenceGraphSchema.parse(parseStrictJson(typeof raw === 'string' || raw instanceof Uint8Array ? raw : canonicalJson(raw, economicsGraphLimits.bundleBytes), economicsGraphLimits.bundleBytes)) }
  catch { throw new Error('Economics graph rejected: strict bounded JSON required') }
  const artifacts = validateGraphArtifacts(input.projectId, input.artifacts)
  unique(input.records.map(record => `${record.kind}:${record.value.id}`), 'duplicate record identity')
  unique(input.definitions.map(definition => `${definition.kind}:${definition.id}`), 'duplicate definition identity')
  for (const record of input.records) {
    require(record.value.projectId === input.projectId && record.value.policyRevision === input.policyRevision, 'record project/policy mismatch')
    switch (record.kind) {
      case 'PricingSnapshotV1': assertContractSemantics(record.kind, record.value); break
      case 'ReservationV1': assertContractSemantics(record.kind, record.value); break
      case 'UsageEventV1': assertContractSemantics(record.kind, record.value); break
      case 'ProviderQuotaV1': assertContractSemantics(record.kind, record.value); break
      case 'ModelRoleAssignmentV1': assertContractSemantics(record.kind, record.value); break
    }
  }
  for (const definition of input.definitions) {
    const { digest, ...payload } = definition
    require(definition.projectId === input.projectId && definition.policyRevision === input.policyRevision, 'definition project/policy mismatch')
    require(digestJson(payload) === digest, 'registered definition digest mismatch')
  }
  function record<K extends Record['kind']>(kind: K, id: string): Values[K] {
    const found = input.records.find(value => value.kind === kind && value.value.id === id)
    require(found, 'dangling economic record')
    return found.value as Values[K]
  }
  function definition<K extends Definition['kind']>(kind: K, id: string): Extract<Definition, { kind: K }> {
    const found = input.definitions.find((value): value is Extract<Definition, { kind: K }> => value.kind === kind && value.id === id)
    require(found, 'dangling registered definition')
    return found
  }
  function bindOwnership(value: { fleetId: string; hostId?: string; accountId: string }): void {
    const fleet = definition('fleet', value.fleetId), account = definition('account', value.accountId)
    require(account.fleetId === fleet.id && fleet.accountIds.includes(account.id), 'fleet/account membership mismatch')
    if (value.hostId) {
      const host = definition('host', value.hostId)
      require(host.fleetId === fleet.id && fleet.hostIds.includes(host.id), 'fleet/host membership mismatch')
    }
  }
  function bindRequest(value: { fleetId: string; hostId: string; accountId: string; attemptId: string; generation: number; requestId: string }): Extract<Definition, { kind: 'request' }> {
    bindOwnership(value)
    const request = definition('request', value.requestId), attempt = definition('attempt', value.attemptId)
    require(['fleetId', 'hostId', 'accountId', 'attemptId', 'generation'].every(key => value[key as keyof typeof value] === request[key as keyof typeof request]), 'request ownership/generation mismatch')
    require(attempt.generation === value.generation && attempt.requestIds.includes(request.id) && attempt.fleetId === value.fleetId && attempt.hostId === value.hostId && attempt.accountId === value.accountId, 'attempt ownership/request mismatch')
    return request
  }
  unique(input.records.filter(value => value.kind === 'PricingSnapshotV1').map(value => canonicalJson([value.value.provider, value.value.accountId, value.value.modelVersion, value.value.revision])), 'ambiguous pricing revision')
  unique(input.definitions.filter(value => value.kind === 'model-catalog').map(value => String(value.revision)), 'ambiguous catalog revision')

  for (const value of input.definitions) {
    if (value.kind === 'fleet') {
      unique(value.emergencyPurposes, 'duplicate emergency purpose')
      for (const id of value.hostIds) require(definition('host', id).fleetId === value.id, 'fleet host backlink mismatch')
      for (const id of value.accountIds) require(definition('account', id).fleetId === value.id, 'fleet account backlink mismatch')
    } else if (value.kind === 'host') {
      require(definition('fleet', value.fleetId).hostIds.includes(value.id), 'host fleet backlink mismatch')
    } else if (value.kind === 'account') {
      bindOwnership({ ...value, accountId: value.id })
      for (const id of value.quotaPoolIds) { const pool = definition('quota-pool', id); require(pool.accountId === value.id && pool.fleetId === value.fleetId, 'account quota pool mismatch') }
    } else if (value.kind === 'attempt') {
      bindOwnership(value)
      const assignment = record('ModelRoleAssignmentV1', value.modelAssignmentId)
      require(assignment.attemptId === value.id && assignment.generation === value.generation, 'attempt model assignment mismatch')
      for (const id of value.requestIds) { const request = definition('request', id); require(request.attemptId === value.id && request.generation === value.generation && request.assignmentId === assignment.id, 'attempt request backlink mismatch') }
    } else if (value.kind === 'model-catalog') {
      require(Date.parse(value.observedAt) < Date.parse(value.expiresAt), 'catalog timestamp mismatch')
      unique(value.models.map(identity), 'duplicate catalog deployment')
      for (const model of value.models) {
        const account = definition('account', model.accountId), pricing = record('PricingSnapshotV1', model.pricingSnapshotId)
        require(account.provider === model.provider && pricing.provider === model.provider && pricing.modelVersion === model.modelVersion && pricing.accountId === account.id && digestJson(pricing) === model.pricingSnapshotDigest, 'catalog pricing/account payload mismatch')
        artifacts.assertArtifact(model.benchmark.evidence); artifacts.assertArtifact(model.health.evidence)
        require(Date.parse(model.health.observedAt) < Date.parse(model.health.expiresAt), 'catalog health timestamp mismatch')
      }
    } else if (value.kind === 'request') {
      bindRequest({ ...value, requestId: value.id })
      const assignment = record('ModelRoleAssignmentV1', value.assignmentId), reservation = record('ReservationV1', value.reservationId), pricing = record('PricingSnapshotV1', value.pricingSnapshotId)
      require(digestJson(assignment) === value.assignmentDigest && digestJson(reservation) === value.reservationDigest && digestJson(pricing) === value.pricingSnapshotDigest, 'request pinned payload digest mismatch')
      require(identity(assignment) === identity(value) && assignment.attemptId === value.attemptId && assignment.generation === value.generation && reservation.requestId === value.id, 'request assignment/reservation mismatch')
      require(definition('quota-decision', value.quotaDecisionId).requestId === value.id, 'request quota decision mismatch')
      require(pricing.provider === value.provider && pricing.accountId === value.accountId && pricing.modelVersion === value.modelVersion && pricing.revision === reservation.pricingRevision && pricing.revision === assignment.pricingRevision, 'request pricing identity/revision mismatch')
      require(Date.parse(assignment.assignedAt) <= Date.parse(value.createdAt) && Date.parse(reservation.createdAt) <= Date.parse(value.createdAt) && between(value.createdAt, pricing.observedAt, pricing.expiresAt), 'request precedes authority or pricing is stale')
      const usage = value.usageEventIds.map(id => record('UsageEventV1', id))
      require(usage.length === value.lastStreamSequence && usage.length === value.usageEventDigests.length, 'incomplete usage stream declaration')
      require(usage.every((event, index) => event.eventDigest === value.usageEventDigests[index]), 'usage event pinned payload digest mismatch')
      unique(usage.map(event => String(event.streamSequence)), 'duplicate usage stream sequence')
      require(usage.every(event => event.requestId === value.id && event.streamSequence <= value.lastStreamSequence), 'usage stream request/sequence mismatch')
    } else if (value.kind === 'quota-pool') {
      bindOwnership(value)
      const quota = record('ProviderQuotaV1', value.quotaSnapshotId)
      require(definition('account', value.accountId).quotaPoolIds.includes(value.id), 'quota pool account backlink mismatch')
      require(quota.poolId === value.id && quota.fleetId === value.fleetId && quota.accountId === value.accountId && quota.unit === value.unit && quota.adapter === value.adapter && quota.adapterVersion === value.adapterVersion, 'quota pool snapshot mismatch')
    } else if (value.kind === 'quota-decision') {
      const request = bindRequest(value), reservation = record('ReservationV1', value.reservationId)
      require(request.reservationId === reservation.id && digestJson(reservation) === value.reservationDigest, 'quota decision reservation mismatch')
      require(same(value.snapshots.map(snapshot => snapshot.poolId).sort(), [...reservation.quotaPoolIds].sort()), 'quota decision incomplete limiting pools')
      unique(value.snapshots.map(snapshot => snapshot.poolId), 'duplicate quota decision pool')
      require(Date.parse(value.observedAt) <= Date.parse(request.createdAt), 'quota decision postdates request')
      for (const reference of value.snapshots) {
        const snapshot = record('ProviderQuotaV1', reference.quotaId)
        require(snapshot.poolId === reference.poolId && snapshot.fleetId === value.fleetId && snapshot.accountId === value.accountId && digestJson(snapshot) === reference.quotaDigest, 'quota decision snapshot payload mismatch')
        require(between(value.observedAt, snapshot.observedAt, snapshot.expiresAt), 'quota decision references stale snapshot')
      }
    } else if (value.kind === 'quota-watermark') {
      bindOwnership(value)
      const quota = record('ProviderQuotaV1', value.quotaSnapshotId)
      require(quota.watermark === value.id && quota.poolId === value.poolId && quota.accountId === value.accountId && quota.fleetId === value.fleetId, 'quota watermark binding mismatch')
      for (const id of value.reflectedUsageIds) {
        const usage = record('UsageEventV1', id), reservation = record('ReservationV1', usage.reservationId)
        require(usage.fleetId === value.fleetId && usage.accountId === value.accountId && reservation.quotaPoolIds.includes(value.poolId) && Date.parse(usage.usageAt) <= Date.parse(quota.observedAt), 'quota watermark usage mismatch')
      }
    } else {
      const reservation = record('ReservationV1', value.reservationId), fleet = definition('fleet', value.fleetId)
      require(reservation.fleetId === fleet.id && reservation.purpose === value.purpose && fleet.emergencyPurposes.includes(value.purpose) && same(reservation.purposeEvidence, value.evidence), 'emergency purpose grant mismatch')
      value.evidence.forEach(artifacts.assertArtifact)
    }
  }
  for (const entry of input.records) {
    if (entry.kind === 'PricingSnapshotV1') {
      const pricing = entry.value, account = definition('account', pricing.accountId)
      require(account.provider === pricing.provider, 'pricing provider/account mismatch'); artifacts.assertArtifact(pricing.source)
    } else if (entry.kind === 'ReservationV1') {
      const reservation = entry.value, request = bindRequest(reservation), fleet = definition('fleet', reservation.fleetId)
      require(request.reservationId === reservation.id && reservation.authorityEpoch === fleet.authorityEpoch, 'reservation request/authority epoch mismatch')
      require(same([...reservation.quotaPoolIds].sort(), [...definition('account', reservation.accountId).quotaPoolIds].sort()), 'reservation omits limiting quota pools')
      for (const id of reservation.quotaPoolIds) definition('quota-pool', id)
      reservation.purposeEvidence.forEach(artifacts.assertArtifact)
      if (reservation.purpose !== 'routine') require(input.definitions.some(value => value.kind === 'emergency-purpose-grant' && value.reservationId === reservation.id && value.purpose === reservation.purpose), 'emergency purpose lacks registered grant')
    } else if (entry.kind === 'UsageEventV1') {
      const usage = entry.value, request = bindRequest(usage), reservation = record('ReservationV1', usage.reservationId)
      require(request.usageEventIds.includes(usage.id) && request.reservationId === usage.reservationId && request.provider === usage.provider && request.modelVersion === usage.modelVersion && usage.pricingRevision === reservation.pricingRevision, 'usage request/reservation/model/pricing mismatch')
      require(Date.parse(usage.usageAt) >= Date.parse(request.createdAt), 'usage predates request')
      if (usage.correctionOf) {
        const prior = record('UsageEventV1', usage.correctionOf)
        require(prior.requestId === usage.requestId && prior.reservationId === usage.reservationId && prior.streamSequence < usage.streamSequence && Date.parse(prior.usageAt) <= Date.parse(usage.usageAt), 'usage correction lineage mismatch')
      }
    } else if (entry.kind === 'ProviderQuotaV1') {
      const quota = entry.value
      bindOwnership(quota); artifacts.assertArtifact(quota.source)
      require(definition('quota-pool', quota.poolId).quotaSnapshotId === quota.id, 'quota snapshot pool backlink mismatch')
      definition('quota-watermark', quota.watermark)
    } else {
      const assignment = entry.value, attempt = definition('attempt', assignment.attemptId), reservation = record('ReservationV1', assignment.reservationId)
      require(attempt.modelAssignmentId === assignment.id && attempt.generation === assignment.generation && reservation.attemptId === attempt.id && reservation.generation === assignment.generation, 'assignment attempt/reservation mismatch')
      const catalogs = input.definitions.filter((value): value is Extract<Definition, { kind: 'model-catalog' }> => value.kind === 'model-catalog' && value.revision === assignment.catalogRevision)
      require(catalogs.length === 1 && catalogs[0]!.digest === assignment.catalogDigest, 'assignment catalog revision/digest mismatch')
      const catalog = catalogs[0]!, model = catalog.models.find(value => identity(value) === identity(assignment))
      require(model && model.accountId === reservation.accountId && same(model.capabilities, assignment.capabilities) && same(model.benchmark, assignment.benchmark) && same(model.health, assignment.health), 'assignment normalized catalog payload mismatch')
      require(between(assignment.assignedAt, catalog.observedAt, catalog.expiresAt), 'assignment catalog is stale')
      for (const fallback of assignment.fallbackChain) require(catalog.models.some(model => identity(model) === identity(fallback)), 'fallback missing from pinned catalog')
      const decision = definition('quota-decision', assignment.quotaDecisionId)
      require(decision.reservationId === reservation.id && decision.attemptId === assignment.attemptId && decision.generation === assignment.generation && Date.parse(decision.observedAt) <= Date.parse(assignment.assignedAt), 'assignment quota decision mismatch')
      artifacts.assertArtifact(assignment.benchmark.evidence); artifacts.assertArtifact(assignment.health.evidence)
    }
  }
  return { lane: 'fleet-economics', records: input.records.length, registeredDefinitions: input.definitions.length, artifacts: input.artifacts.length,
    authorityVerified: false, accountingReconciled: false, providerBillingVerified: false }
}
