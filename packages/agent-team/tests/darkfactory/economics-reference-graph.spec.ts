import { describe, expect, it } from 'vitest'
import { economicsGraphLimits, validateEconomicsReferenceGraph, type EconomicsReferenceGraph } from '../../src/darkfactory/contracts/economics-reference-graph.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
import { economicsGraphFixture } from './economics-graph-fixture.ts'
type Entry = EconomicsReferenceGraph['records'][number]
type ValueMap = { [R in Entry as R['kind']]: R['value'] }
type Definition = EconomicsReferenceGraph['definitions'][number]
function value<K extends Entry['kind']>(graph: EconomicsReferenceGraph, kind: K): ValueMap[K] { return graph.records.find(entry => entry.kind === kind)!.value as ValueMap[K] }
function node<K extends Definition['kind']>(graph: EconomicsReferenceGraph, kind: K): Extract<Definition, { kind: K }> { return graph.definitions.find(entry => entry.kind === kind) as Extract<Definition, { kind: K }> }
function seal<T extends { digest: string }>(value: T): void { const { digest, ...payload } = value; value.digest = digestJson(payload) }
/** Re-sign fixture digests so a negative test reaches relationship validation, not a stale fixture hash. */
function repin(graph: EconomicsReferenceGraph): void {
  for (const entry of graph.records) if (entry.kind === 'UsageEventV1') { const { eventDigest, ...payload } = entry.value; entry.value.eventDigest = digestJson(payload) }
  for (const definition of graph.definitions) if (definition.kind === 'model-catalog') {
    for (const model of definition.models) {
      const pricing = graph.records.find(entry => entry.kind === 'PricingSnapshotV1' && entry.value.id === model.pricingSnapshotId)
      if (pricing) model.pricingSnapshotDigest = digestJson(pricing.value)
    }
    seal(definition)
  }
  for (const entry of graph.records) if (entry.kind === 'ModelRoleAssignmentV1') {
    const catalog = graph.definitions.find(definition => definition.kind === 'model-catalog' && definition.revision === entry.value.catalogRevision)
    if (catalog) entry.value.catalogDigest = catalog.digest
  }
  for (const definition of graph.definitions) {
    if (definition.kind === 'request') {
      definition.usageEventDigests = definition.usageEventIds.map(id => graph.records.find(entry => entry.kind === 'UsageEventV1' && entry.value.id === id)?.value).map(record => record && 'eventDigest' in record ? record.eventDigest : digestJson('missing'))
      for (const [kind, id, field] of [['PricingSnapshotV1', definition.pricingSnapshotId, 'pricingSnapshotDigest'], ['ReservationV1', definition.reservationId, 'reservationDigest'], ['ModelRoleAssignmentV1', definition.assignmentId, 'assignmentDigest']] as const) {
        const record = graph.records.find(entry => entry.kind === kind && entry.value.id === id)
        if (record) definition[field] = digestJson(record.value)
      }
    } else if (definition.kind === 'quota-decision') {
      const reservation = graph.records.find(entry => entry.kind === 'ReservationV1' && entry.value.id === definition.reservationId)
      if (reservation) definition.reservationDigest = digestJson(reservation.value)
      for (const snapshot of definition.snapshots) {
        const quota = graph.records.find(entry => entry.kind === 'ProviderQuotaV1' && entry.value.id === snapshot.quotaId)
        if (quota) snapshot.quotaDigest = digestJson(quota.value)
      }
    }
    seal(definition)
  }
}

describe('offline fleet economics reference closure', () => {
  it('accepts the complete typed graph with concrete bytes and explicitly withholds live authority/accounting claims', () => {
    const graph = economicsGraphFixture(), original = structuredClone(graph)
    const result = validateEconomicsReferenceGraph(graph)
    expect(result).toEqual({ lane: 'fleet-economics', records: 5, registeredDefinitions: 9, artifacts: 4, authorityVerified: false, accountingReconciled: false, providerBillingVerified: false })
    expect(validateEconomicsReferenceGraph(JSON.stringify(graph))).toEqual(result)
    expect(validateEconomicsReferenceGraph(Buffer.from(JSON.stringify(graph)))).toEqual(result)
    expect(graph).toEqual(original)
  })

  it('closes immutable usage corrections without treating compression estimates as billed savings', () => {
    const graph = economicsGraphFixture(), first = value(graph, 'UsageEventV1')
    const correction = { ...first, id: 'usage-correction', streamSequence: 2, correctionOf: first.id, compression: { compressed: true, estimatedInputTokens: null, estimatedSavedTokens: null, retrievalCostMicros: null } }
    graph.records.push({ kind: 'UsageEventV1', value: correction })
    node(graph, 'request').usageEventIds.push(correction.id); node(graph, 'request').lastStreamSequence = 2
    repin(graph)
    expect(validateEconomicsReferenceGraph(graph).records).toBe(6)
    correction.correctionOf = 'missing-original'; repin(graph)
    expect(() => validateEconomicsReferenceGraph(graph)).toThrow(/dangling/)
  })

  it('supports a second separately reserved request under the original pinned assignment', () => {
    const graph = economicsGraphFixture(), first = value(graph, 'ReservationV1')
    const second = { ...first, id: 'reservation-2', requestId: 'request-2', state: 'reserved' as const }
    graph.records.push({ kind: 'ReservationV1', value: second })
    const request = { ...node(graph, 'request'), id: 'request-2', reservationId: second.id, usageEventIds: [], usageEventDigests: [], lastStreamSequence: 0, quotaDecisionId: 'quota-decision-2' }
    graph.definitions.push(request, { ...node(graph, 'quota-decision'), id: 'quota-decision-2', requestId: request.id, reservationId: second.id })
    node(graph, 'attempt').requestIds.push(request.id)
    repin(graph)
    expect(validateEconomicsReferenceGraph(graph).records).toBe(6)
  })

  it('requires a registered evidenced emergency purpose and configured fleet purpose', () => {
    const graph = economicsGraphFixture(), reservation = value(graph, 'ReservationV1'), fleet = node(graph, 'fleet')
    reservation.purpose = 'verified-p0-security'; reservation.purposeEvidence = [graph.artifacts[2]!.reference]
    fleet.emergencyPurposes = ['verified-p0-security']
    repin(graph)
    expect(() => validateEconomicsReferenceGraph(graph)).toThrow(/lacks registered grant/)
    graph.definitions.push({ schemaVersion: 1, projectId: graph.projectId, policyRevision: graph.policyRevision, revision: 1, digest: digestJson('placeholder'), kind: 'emergency-purpose-grant', id: 'emergency-grant', fleetId: fleet.id, reservationId: reservation.id, purpose: 'verified-p0-security', evidence: reservation.purposeEvidence })
    repin(graph)
    expect(validateEconomicsReferenceGraph(graph).registeredDefinitions).toBe(10)
    fleet.emergencyPurposes = []; repin(graph)
    expect(() => validateEconomicsReferenceGraph(graph)).toThrow(/purpose grant mismatch/)
  })

  const negatives: [string, (graph: EconomicsReferenceGraph) => void, RegExp][] = [
    ['dangling fleet', graph => { graph.definitions = graph.definitions.filter(entry => entry.kind !== 'fleet') }, /dangling/],
    ['dangling reservation', graph => { graph.records = graph.records.filter(entry => entry.kind !== 'ReservationV1') }, /dangling/],
    ['dangling usage', graph => { graph.records = graph.records.filter(entry => entry.kind !== 'UsageEventV1') }, /dangling/],
    ['cross-project record', graph => { value(graph, 'UsageEventV1').projectId = 'other' }, /project\/policy/],
    ['cross-project definition', graph => { node(graph, 'account').projectId = 'other' }, /project\/policy/],
    ['cross-policy revision', graph => { value(graph, 'ReservationV1').policyRevision = 2 }, /project\/policy/],
    ['host fleet', graph => { node(graph, 'host').fleetId = 'other' }, /fleet host backlink|dangling/],
    ['account provider', graph => { node(graph, 'account').provider = 'other' }, /catalog pricing|pricing provider/],
    ['reservation fleet', graph => { value(graph, 'ReservationV1').fleetId = 'other' }, /dangling/],
    ['reservation account', graph => { value(graph, 'ReservationV1').accountId = 'other' }, /dangling/],
    ['reservation generation', graph => { value(graph, 'ReservationV1').generation = 2 }, /generation/],
    ['request generation', graph => { node(graph, 'request').generation = 2 }, /request backlink|generation/],
    ['reservation request', graph => { value(graph, 'ReservationV1').requestId = 'absent' }, /request assignment\/reservation/],
    ['reservation epoch', graph => { value(graph, 'ReservationV1').authorityEpoch = 'old-epoch' }, /authority epoch/],
    ['stale pricing', graph => { value(graph, 'PricingSnapshotV1').observedAt = '2026-09-06T11:00:00Z'; value(graph, 'PricingSnapshotV1').expiresAt = '2026-09-06T11:59:59Z' }, /pricing is stale/],
    ['stale catalog', graph => { node(graph, 'model-catalog').observedAt = '2026-09-06T11:00:00Z'; node(graph, 'model-catalog').expiresAt = '2026-09-06T11:59:59Z' }, /catalog is stale/],
    ['pricing revision', graph => { value(graph, 'PricingSnapshotV1').revision = 2 }, /pricing identity\/revision/],
    ['pricing model', graph => { value(graph, 'PricingSnapshotV1').modelVersion = 'different' }, /catalog pricing/],
    ['missing limiting quota pool', graph => { value(graph, 'ReservationV1').quotaPoolIds = [] }, /limiting pools/],
    ['quota account', graph => { value(graph, 'ProviderQuotaV1').accountId = 'other' }, /quota pool snapshot/],
    ['quota adapter version', graph => { value(graph, 'ProviderQuotaV1').adapterVersion = 'v2' }, /quota pool snapshot/],
    ['quota snapshot watermark', graph => { value(graph, 'ProviderQuotaV1').watermark = 'absent' }, /watermark binding/],
    ['watermark reflected usage', graph => { node(graph, 'quota-watermark').reflectedUsageIds = ['absent'] }, /dangling/],
    ['quota decision pool', graph => { node(graph, 'quota-decision').snapshots = [] }, /limiting pools/],
    ['assignment capability', graph => { value(graph, 'ModelRoleAssignmentV1').capabilities = { ...value(graph, 'ModelRoleAssignmentV1').capabilities, tools: false } }, /normalized catalog/],
    ['assignment benchmark', graph => { value(graph, 'ModelRoleAssignmentV1').benchmark = { ...value(graph, 'ModelRoleAssignmentV1').benchmark, score: 0.5 } }, /normalized catalog/],
    ['assignment generation', graph => { value(graph, 'ModelRoleAssignmentV1').generation = 2 }, /model assignment/],
    ['fallback missing model', graph => { value(graph, 'ModelRoleAssignmentV1').fallbackChain = [{ provider: 'fixture', deploymentId: 'unknown', modelVersion: 'fixture-v1' }] }, /fallback missing/],
    ['served usage model', graph => { value(graph, 'UsageEventV1').modelVersion = 'silent-fallback' }, /usage request/],
    ['usage account', graph => { value(graph, 'UsageEventV1').accountId = 'other' }, /dangling/],
    ['usage generation', graph => { value(graph, 'UsageEventV1').generation = 2 }, /generation/],
    ['usage pricing', graph => { value(graph, 'UsageEventV1').pricingRevision = 2 }, /usage request/],
    ['usage stream gap', graph => { value(graph, 'UsageEventV1').streamSequence = 2 }, /sequence/],
    ['usage omitted from request', graph => { node(graph, 'request').usageEventIds = []; node(graph, 'request').lastStreamSequence = 0 }, /usage request/],
    ['usage predates request', graph => { value(graph, 'UsageEventV1').usageAt = '2026-09-06T11:59:59Z' }, /usage predates/],
  ]
  it.each(negatives)('rejects %s even when all supplied hashes are recomputed', (_name, mutate, reason) => {
    const graph = economicsGraphFixture(); mutate(graph); repin(graph)
    expect(() => validateEconomicsReferenceGraph(graph)).toThrow(reason)
  })

  it('checks full definition and referenced record digests instead of accepting known IDs', () => {
    const definition = economicsGraphFixture(); node(definition, 'fleet').authorityEpoch = 'changed'
    expect(() => validateEconomicsReferenceGraph(definition)).toThrow(/definition digest/)
    const pricing = economicsGraphFixture(); value(pricing, 'PricingSnapshotV1').inputMicrosPerMillion++
    expect(() => validateEconomicsReferenceGraph(pricing)).toThrow(/catalog pricing/)
    const usage = economicsGraphFixture(); value(usage, 'UsageEventV1').billedCostMicros++
    expect(() => validateEconomicsReferenceGraph(usage)).toThrow(/Usage event digest/)
    const catalog = economicsGraphFixture(); value(catalog, 'ModelRoleAssignmentV1').catalogDigest = digestJson('wrong')
    node(catalog, 'request').assignmentDigest = digestJson(value(catalog, 'ModelRoleAssignmentV1')); seal(node(catalog, 'request'))
    expect(() => validateEconomicsReferenceGraph(catalog)).toThrow(/catalog revision\/digest/)
  })

  it('rejects missing, changed and cross-project artifact bytes', () => {
    const missing = economicsGraphFixture(); missing.artifacts.pop()
    expect(() => validateEconomicsReferenceGraph(missing)).toThrow(/artifact custody/)
    const changed = economicsGraphFixture(); changed.artifacts[0]!.bytesBase64 = Buffer.from('changed').toString('base64')
    expect(() => validateEconomicsReferenceGraph(changed)).toThrow(/artifact custody/)
    const crossed = economicsGraphFixture(); crossed.artifacts[0]!.reference.projectId = 'other'
    expect(() => validateEconomicsReferenceGraph(crossed)).toThrow(/artifact custody/)
  })

  it('bounds collections and JSON before validation and sanitizes unknown keys', () => {
    const input = economicsGraphFixture()
    expect(() => validateEconomicsReferenceGraph({ ...input, 'sensitive-secret-key': 'secret' })).toThrow('Economics graph rejected: strict bounded JSON required')
    expect(() => validateEconomicsReferenceGraph(JSON.stringify(input).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'))).toThrow(/strict bounded JSON/)
    expect(() => validateEconomicsReferenceGraph({ ...input, schemaVersion: 2 })).toThrow(/strict bounded JSON/)
    expect(() => validateEconomicsReferenceGraph({ ...input, records: Array.from({ length: economicsGraphLimits.records + 1 }, () => input.records[0]) })).toThrow(/strict bounded JSON/)
    expect(() => validateEconomicsReferenceGraph({ ...input, definitions: Array.from({ length: economicsGraphLimits.definitions + 1 }, () => input.definitions[0]) })).toThrow(/strict bounded JSON/)
    expect(() => validateEconomicsReferenceGraph(' '.repeat(economicsGraphLimits.bundleBytes + 1))).toThrow(/strict bounded JSON/)
    expect(() => validateEconomicsReferenceGraph({ ...input, records: [...input.records, input.records[0]] })).toThrow(/duplicate record/)
  })
})
