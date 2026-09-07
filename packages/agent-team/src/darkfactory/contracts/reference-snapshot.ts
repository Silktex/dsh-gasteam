/** Explicit multi-lane snapshot consistency; registered snapshots never confer live authority. */
import z from 'zod'
import { idSchema, revisionSchema } from './common.ts'
import { referenceGraphInputSchema, referenceGraphCatalogRegistrationSchema, referenceGraphPricingRegistrationSchema, validateReferenceGraph } from './reference-graph.ts'
import { verificationReferenceGraphInputSchema, validateVerificationReferenceGraph } from './verification-reference-graph.ts'
import { economicsReferenceGraphSchema } from './economics-reference-graph.ts'
import { quarantineReferenceGraphInputSchema, validateQuarantineReferenceGraph } from './quarantine-reference-graph.ts'
import { validateFactoryReferenceGraph } from './factory-reference-graph.ts'
import { validateGraphArtifacts, type GraphArtifactDescriptor } from './graph-core.ts'
import { canonicalJson, digestJson, parseStrictJson } from '../json.ts'

export const referenceSnapshotLanes = ['source-admission', 'verification-release', 'fleet-economics', 'quarantine-health'] as const
const laneSchema = z.enum(referenceSnapshotLanes)
export const referenceSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), projectId: idSchema, policyRevision: revisionSchema,
  scope: z.strictObject({ coverage: z.enum(['declared-lanes', 'all-lanes']), lanes: z.array(laneSchema).min(2).max(4) }),
  graphs: z.array(z.discriminatedUnion('lane', [referenceGraphInputSchema, verificationReferenceGraphInputSchema, economicsReferenceGraphSchema, quarantineReferenceGraphInputSchema])).min(2).max(4),
})
export type ReferenceSnapshotInput = z.input<typeof referenceSnapshotSchema>
export type ReferenceSnapshot = z.output<typeof referenceSnapshotSchema>
type Lane = typeof referenceSnapshotLanes[number]
const MAX_BYTES = 33_554_432, MAX_NODES = 768
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)
function assert(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Reference snapshot rejected: ${reason}`) }

/** All declared lanes must form one connected graph through typed records, not shared log artifacts.
 * Compact catalog/pricing registrations are exact projections of economic payloads when that lane is present.
 * Omitted lanes remain external boundaries; no lifecycle revision is silently substituted for another.
 */
export function validateReferenceSnapshot(raw: unknown) {
  let input: ReferenceSnapshot
  try {
    const decoded = parseStrictJson(typeof raw === 'string' || raw instanceof Uint8Array ? raw : canonicalJson(raw, MAX_BYTES), MAX_BYTES)
    if (decoded && typeof decoded === 'object' && 'graphs' in decoded && Array.isArray(decoded.graphs)) {
      assert(decoded.graphs.length <= 4, 'lane count bound')
      let nodes = 0
      for (const graph of decoded.graphs) if (graph && typeof graph === 'object') {
        for (const value of Object.values(graph)) if (Array.isArray(value)) nodes += value.length
        if ('workHistories' in graph && Array.isArray(graph.workHistories)) for (const history of graph.workHistories) if (history && typeof history === 'object' && 'versions' in history && Array.isArray(history.versions)) nodes += history.versions.length
      }
      assert(nodes <= MAX_NODES, 'aggregate graph node bound')
    }
    input = referenceSnapshotSchema.parse(decoded)
  } catch { throw new Error('Reference snapshot rejected: strict bounded snapshot required') }
  const declared = [...input.scope.lanes].sort(), actual = input.graphs.map(graph => graph.lane).sort()
  assert(new Set(declared).size === declared.length && same(declared, actual), 'declared lane scope differs from supplied graphs')
  assert(input.scope.coverage !== 'all-lanes' || declared.length === referenceSnapshotLanes.length, 'all-lanes coverage requires every lane')
  assert(input.graphs.every(graph => graph.projectId === input.projectId && graph.policyRevision === input.policyRevision), 'project/policy snapshot mismatch')
  let nodes = 0
  const artifacts = new Map<string, GraphArtifactDescriptor>(), digests = new Map<string, string>()
  for (const graph of input.graphs) {
    for (const value of Object.values(graph)) if (Array.isArray(value)) nodes += value.length
    if (graph.lane === 'source-admission') nodes += (graph.workHistories ?? []).reduce((sum, history) => sum + history.versions.length, 0)
    assert(nodes <= MAX_NODES, 'aggregate graph node bound')
    for (const descriptor of graph.artifacts) {
      const prior = artifacts.get(descriptor.reference.id), alias = digests.get(descriptor.reference.digest)
      assert(!prior || same(prior, descriptor), 'shared artifact identity has different bytes or payload')
      assert(!alias || alias === descriptor.reference.id, 'shared artifact digest has an identity alias')
      artifacts.set(descriptor.reference.id, descriptor); digests.set(descriptor.reference.digest, descriptor.reference.id)
    }
  }
  const custody = validateGraphArtifacts(input.projectId, [...artifacts.values()])
  const edges = new Map<Lane, Set<Lane>>(input.scope.lanes.map(lane => [lane, new Set<Lane>()]))
  const connect = (a: Lane, b: Lane) => { if (a !== b) { edges.get(a)!.add(b); edges.get(b)!.add(a) } }
  const source = input.graphs.find(graph => graph.lane === 'source-admission')
  const verification = input.graphs.find(graph => graph.lane === 'verification-release')
  const economics = input.graphs.find(graph => graph.lane === 'fleet-economics')
  const quarantine = input.graphs.find(graph => graph.lane === 'quarantine-health')
  // Validate the owning quarantine graph before handing concrete resolved records
  // to verification. Never turn this boundary into a boolean validation bypass.
  const quarantineSummary = quarantine ? validateQuarantineReferenceGraph(quarantine) : undefined
  const healthReleases = quarantine?.releases.filter(release => release.healthEscalationId) ?? []
  const healthIds = new Set(healthReleases.map(release => release.healthEscalationId!))
  const releaseIds = new Set(healthReleases.map(release => release.id))
  const healthWork = quarantine?.workItems.filter(work => work.healthEscalationId) ?? []
  const workHealthIds = new Set(healthWork.map(work => work.healthEscalationId!)), workIds = new Set(healthWork.map(work => work.id))
  const summaries = input.graphs.map(graph => graph.lane === 'quarantine-health' ? quarantineSummary!
    : graph.lane === 'source-admission' ? validateReferenceGraph(graph, healthWork.length ? { schemaVersion: 1, workItems: healthWork,
      admissions: quarantine!.admissions.filter(admission => admission.healthEscalationId && workHealthIds.has(admission.healthEscalationId)),
      incidents: quarantine!.incidents.filter(incident => workHealthIds.has(incident.id)),
      events: quarantine!.events.filter(event => workIds.has(event.recordId) && event.healthEscalationId && workHealthIds.has(event.healthEscalationId)),
    } : undefined)
    : graph.lane === 'verification-release' ? validateVerificationReferenceGraph(graph, healthReleases.length ? {
      schemaVersion: 1, releases: healthReleases, incidents: quarantine!.incidents.filter(incident => healthIds.has(incident.id)),
      events: quarantine!.events.filter(event => releaseIds.has(event.recordId) && event.healthEscalationId && healthIds.has(event.healthEscalationId)),
    } : undefined) : validateFactoryReferenceGraph(graph))

  const shared = new Map<string, { payload: unknown; lane: Lane }>()
  const content = new Map<string, { id: string; payload: unknown }>()
  function addRecord(lane: Lane, kind: string, value: { id: string }) {
    const key = `${kind}:${value.id}`, prior = shared.get(key)
    assert(!prior || same(prior.payload, value), `shared ${kind} payload/revision mismatch`)
    if (prior) connect(lane, prior.lane)
    else shared.set(key, { payload: value, lane })
    const hashed = value as { specDigest?: string; evidenceHash?: string; attestationHash?: string; eventDigest?: string }
    const hash = kind === 'ExecutableSpecV1' ? hashed.specDigest : kind === 'VerificationEvidenceV1' ? hashed.evidenceHash : kind === 'TelemetryVerdictV1' ? hashed.attestationHash : kind === 'UsageEventV1' ? hashed.eventDigest : undefined
    if (hash) {
      const old = content.get(`${kind}:${hash}`)
      assert(!old || old.id === value.id && same(old.payload, value), 'shared contract digest aliases another payload')
      content.set(`${kind}:${hash}`, { id: value.id, payload: value })
    }
  }
  for (const graph of input.graphs) {
    if ('records' in graph) for (const entry of graph.records) addRecord(graph.lane, entry.kind, entry.value)
    if (graph.lane === 'verification-release') for (const entry of graph.definitions) if (entry.kind === 'spec') addRecord(graph.lane, 'ExecutableSpecV1', entry.spec)
    if (graph.lane === 'quarantine-health') {
      for (const value of graph.envelopes) addRecord(graph.lane, 'InboundEnvelopeV1', value)
      for (const value of graph.workItems) addRecord(graph.lane, 'InboundWorkItemV1', value)
      for (const value of graph.specs) addRecord(graph.lane, 'ExecutableSpecV1', value)
      for (const value of graph.releases) addRecord(graph.lane, 'ReleaseRecordV1', value)
      for (const value of graph.admissions) {
        addRecord(graph.lane, 'AdmissionReceiptV1', value.receipt)
        addRecord(graph.lane, 'ExecutableSpecV1', value.intent.spec)
        addRecord(graph.lane, 'CompilerOutcomeV1', value.intent.compilerOutcome)
      }
    }
  }
  // Same registered object viewed through different strict schemas must agree on
  // every represented common field. Schema-specific digests cover different payloads.
  const registrations = new Map<string, { value: Record<string, unknown>; lane: Lane }[]>()
  for (const graph of input.graphs) for (const entry of graph.definitions) {
    const key = `${entry.kind}:${entry.id}`, previous = registrations.get(key) ?? [], value = entry as unknown as Record<string, unknown>
    for (const old of previous) {
      const keys = Object.keys(value).filter(key => key !== 'digest' && key !== 'catalog' && key !== 'pricing' && key in old.value)
      assert(keys.every(key => same(value[key], old.value[key])), `shared registered ${entry.kind} payload mismatch`)
      if (same(Object.keys(old.value).sort(), Object.keys(value).sort())) assert(same(old.value, value), `shared registered ${entry.kind} digest mismatch`)
      else if (entry.kind === 'model-assignment' && 'catalog' in old.value && 'catalog' in value) {
        const projectCatalog = (reference: unknown) => {
          const descriptor = reference as GraphArtifactDescriptor['reference']
          const parsed = z.object({ revision: revisionSchema, models: z.array(z.object({ provider: idSchema, modelVersion: idSchema })) }).parse(parseStrictJson(custody.readArtifact(descriptor)))
          return { revision: parsed.revision, models: parsed.models.map(({ provider, modelVersion }) => ({ provider, modelVersion })) }
        }
        assert(same(projectCatalog(value.catalog), projectCatalog(old.value.catalog)), 'shared compact model catalog projections differ')
      }
    }
    registrations.set(key, [...previous, { value, lane: graph.lane }])
  }
  if (source && verification) {
    const specs = source.records.filter(entry => entry.kind === 'ExecutableSpecV1')
    const verified = verification.definitions.filter(entry => entry.kind === 'spec')
    assert(same(specs.map(entry => entry.value.id).sort(), verified.map(entry => entry.spec.id).sort()), 'source/verification spec scope incomplete')
    for (const entry of verified) assert(specs.some(candidate => same(candidate.value, entry.spec)), 'verification spec is not the admitted source payload')
    for (const entry of source.records) if (entry.kind === 'AdmissionReceiptV1') {
      const workflow = verification.definitions.find(value => value.kind === 'workflow' && value.id === entry.value.workflowId)
      assert(workflow?.kind === 'workflow' && digestJson(workflow.definition) === entry.value.workflowDigest && same([...workflow.taskIds].sort(), [...entry.value.taskIds].sort()), 'admitted workflow/task closure differs from verification')
      for (const taskId of entry.value.taskIds) {
        const task = verification.definitions.find(value => value.kind === 'task' && value.id === taskId)
        assert(task?.kind === 'task' && task.specDigest === entry.value.specDigest, 'admitted task points to another verification spec')
      }
    }
    connect(source.lane, verification.lane)
  }
  if (economics && (source || verification)) {
    const assignments = economics.records.filter(entry => entry.kind === 'ModelRoleAssignmentV1').map(entry => entry.value)
    const catalogs = economics.definitions.filter(entry => entry.kind === 'model-catalog')
    const consumed = new Set<string>(), ownedAttempts = new Set<string>()
    function assignmentFor(id: string, attemptId: string, generation: number, lane: Lane) {
      const assignment = assignments.find(value => value.id === id)
      assert(assignment && assignment.attemptId === attemptId && assignment.generation === generation, 'missing/mismatched economic assignment for registered attempt')
      consumed.add(id); ownedAttempts.add(attemptId); connect(lane, economics!.lane)
      return assignment
    }
    if (source) for (const registered of source.definitions) if (registered.kind === 'model-assignment') {
      const assignment = assignmentFor(registered.id, registered.attemptId, registered.generation, source.lane)
      assert(registered.provider === assignment.provider && registered.deploymentId === assignment.deploymentId && registered.modelVersion === assignment.modelVersion && registered.catalogRevision === assignment.catalogRevision && registered.pricingRevision === assignment.pricingRevision, 'compiler model identity/pricing revision differs from economics')
      const catalog = catalogs.find(value => value.digest === assignment.catalogDigest)
      assert(catalog, 'missing full compiler catalog')
      const projected = referenceGraphCatalogRegistrationSchema.parse(parseStrictJson(custody.readArtifact(registered.catalog)))
      assert(same(projected, { schemaVersion: 1, revision: catalog.revision, models: catalog.models.map(({ provider, deploymentId, modelVersion }) => ({ provider, deploymentId, modelVersion })) }), 'compiler catalog projection differs from full economic payload')
      const pricing = referenceGraphPricingRegistrationSchema.parse(parseStrictJson(custody.readArtifact(registered.pricing)))
      const reservation = economics.records.find(entry => entry.kind === 'ReservationV1' && entry.value.id === assignment.reservationId)
      assert(reservation?.kind === 'ReservationV1', 'missing compiler pricing account')
      const actual = economics.records.filter(entry => entry.kind === 'PricingSnapshotV1').find(entry => entry.value.accountId === reservation.value.accountId && entry.value.provider === assignment.provider && entry.value.modelVersion === assignment.modelVersion && entry.value.revision === assignment.pricingRevision)?.value
      assert(actual && same(pricing, { schemaVersion: 1, revision: actual.revision, provider: actual.provider, modelVersion: actual.modelVersion, currency: actual.currency, inputMicrosPerMillion: actual.inputMicrosPerMillion, outputMicrosPerMillion: actual.outputMicrosPerMillion }), 'compiler pricing projection differs from full economic payload')
    }
    if (verification) {
      for (const registered of verification.definitions) if (registered.kind === 'attempt') {
        const economicAttempt = economics.definitions.find(value => value.kind === 'attempt' && value.id === registered.id)
        assert(economicAttempt?.kind === 'attempt', 'verification attempt lacks economic request closure')
        assignmentFor(registered.modelAssignmentId ?? economicAttempt.modelAssignmentId, registered.id, registered.generation, verification.lane)
      }
      for (const registered of verification.definitions) if (registered.kind === 'model-assignment') {
        const assignment = assignmentFor(registered.id, registered.attemptId, registered.generation, verification.lane)
        assert(registered.provider === assignment.provider && registered.modelVersion === assignment.modelVersion && registered.catalogRevision === assignment.catalogRevision, 'critic model differs from economic assignment')
        const catalog = catalogs.find(value => value.digest === assignment.catalogDigest)
        assert(catalog, 'missing full critic catalog')
        const projected = parseStrictJson(custody.readArtifact(registered.catalog))
        const models = catalog.models.map(({ provider, modelVersion }) => ({ provider, modelVersion }))
        assert(new Set(models.map(model => canonicalJson(model))).size === models.length && same(projected, { revision: catalog.revision, models }), 'critic catalog projection differs from full economic payload')
      }
      for (const entry of verification.records) if (entry.kind === 'CriticOutcomeV1') {
        const assignment = assignments.find(value => value.id === entry.value.modelAssignmentId)!
        assert(Date.parse(assignment.assignedAt) <= Date.parse(entry.value.committedAt), 'critic verdict predates economic model assignment')
      }
    }
    assert(assignments.every(value => consumed.has(value.id)) && economics.definitions.filter(value => value.kind === 'attempt').every(value => ownedAttempts.has(value.id)), 'unrelated economic assignments/attempts outside declared work scope')
  }
  if (quarantine) {
    function requireCounterpart(kind: string, values: readonly { id: string }[], owner: Lane, owned: readonly { id: string }[] | undefined) {
      if (!owned) return
      for (const value of values) assert(owned.some(candidate => candidate.id === value.id && same(candidate, value)), `quarantine ${kind} lacks exact ${owner} snapshot`)
      if (values.length) connect(quarantine!.lane, owner)
    }
    requireCounterpart('envelope', quarantine.envelopes, 'source-admission', source?.records.filter(entry => entry.kind === 'InboundEnvelopeV1').map(entry => entry.value))
    requireCounterpart('work', quarantine.workItems, 'source-admission', source?.records.filter(entry => entry.kind === 'InboundWorkItemV1').map(entry => entry.value))
    requireCounterpart('admission', quarantine.admissions.map(value => value.receipt), 'source-admission', source?.records.filter(entry => entry.kind === 'AdmissionReceiptV1').map(entry => entry.value))
    requireCounterpart('spec', quarantine.specs, 'source-admission', source?.records.filter(entry => entry.kind === 'ExecutableSpecV1').map(entry => entry.value))
    requireCounterpart('release', quarantine.releases, 'verification-release', verification?.records.filter(entry => entry.kind === 'ReleaseRecordV1').map(entry => entry.value))
    requireCounterpart('spec', quarantine.specs, 'verification-release', verification?.definitions.filter(entry => entry.kind === 'spec').map(entry => entry.spec))
  }
  const visited = new Set<Lane>(), pending: Lane[] = [input.scope.lanes[0]!]
  while (pending.length) { const lane = pending.pop()!; if (visited.has(lane)) continue; visited.add(lane); pending.push(...edges.get(lane)!) }
  assert(visited.size === input.scope.lanes.length, 'declared lanes are unrelated; no complete typed connection')
  return { schemaVersion: 1 as const, projectId: input.projectId, policyRevision: input.policyRevision, snapshotDigest: digestJson(input),
    lanes: [...input.scope.lanes], coverage: input.scope.coverage, externalLanes: referenceSnapshotLanes.filter(lane => !visited.has(lane)),
    sharedRecords: shared.size, artifacts: artifacts.size, summaries, authorityVerified: false as const, signaturesVerified: false as const,
    limitations: ['Only the exact declared snapshot revisions are compared; no lifecycle history reconstruction', 'Compact model catalogs/pricing are checked as exact projections of full economic records', 'All lane-specific runtime, signature and registry-authority limits remain in force'] as const }
}
