import { sharedAdmissionQuarantineSnapshotFixture } from './reference-snapshot-fixture.ts'
import { expect, it } from 'vitest'
import { validateReferenceSnapshot } from '../../src/darkfactory/contracts/reference-snapshot.ts'
import { validateFactoryReferenceGraph } from '../../src/darkfactory/contracts/factory-reference-graph.ts'
import { canonicalJson, digestJson } from '../../src/darkfactory/json.ts'
import { referenceSnapshotFixture, scopedReferenceSnapshotFixture, quarantinedReleaseSnapshotFixture, workLifecycleSnapshotFixture } from './reference-snapshot-fixture.ts'
import { validateReferenceGraph } from '../../src/darkfactory/contracts/reference-graph.ts'
import { validateVerificationReferenceGraph } from '../../src/darkfactory/contracts/verification-reference-graph.ts'
import { sourceReferenceGraphFixture } from './source-reference-graph-fixture.ts'
import { verificationReferenceGraphFixture } from './verification-reference-graph-fixture.ts'
import { economicsGraphFixture } from './economics-graph-fixture.ts'
import { quarantineGraphFixture } from './quarantine-graph-fixture.ts'

it('validates one coherent four-lane snapshot including economic payload projections and its actual source health event', () => {
  const input = referenceSnapshotFixture()
  expect(validateReferenceSnapshot(canonicalJson(input))).toMatchObject({ coverage: 'all-lanes', externalLanes: [], authorityVerified: false, signaturesVerified: false })
})

it.each(['compiled', 'admitted', 'acknowledged', 'quarantined'] as const)('closes native %s work against its exact historical trusted compiler input', state => {
  const input = workLifecycleSnapshotFixture(state)
  const result = validateReferenceSnapshot(input)
  expect(result).toMatchObject({ coverage: 'all-lanes', externalLanes: [] })
  expect(result.summaries).toContainEqual(expect.objectContaining({ historicalWorkRecords: state === 'compiled' ? 3 : state === 'admitted' ? 4 : 5, resolvedHealthReferences: state === 'quarantined' ? 1 : 0 }))
})

it.each(['missing', 'skipped', 'rewritten', 'wrong-current', 'wrong-context', 'wrong-project', 'dangling-artifact', 'terminal-reopen', 'duplicate'] as const)('rejects %s native history without ignoring lifecycle or immutable fields', change => {
  const input = workLifecycleSnapshotFixture('acknowledged'), source = input.graphs.find(graph => graph.lane === 'source-admission')!
  if (source.lane !== 'source-admission') throw new Error('fixture source')
  const history = source.workHistories![0]!
  if (change === 'missing') delete source.workHistories
  if (change === 'skipped') history.versions.splice(2, 1)
  if (change === 'rewritten') history.versions[1]!.title = 'Rewritten immutable title'
  if (change === 'wrong-current') history.versions.pop()
  if (change === 'wrong-context') {
    const context = source.definitions.find(value => value.kind === 'compiler-context')!
    if (context.kind !== 'compiler-context') throw new Error('fixture context')
    context.context.ingress.trust.reasons = ['REWRITTEN_TRUST_DECISION']
    const { digest: _digest, ...payload } = context
    context.digest = digestJson(payload)
  }
  if (change === 'wrong-project') history.versions[0]!.projectId = 'other-project'
  if (change === 'dangling-artifact') history.versions[0]!.provenance = [{ ...history.versions[0]!.provenance[0]!, id: 'missing-history-evidence' }]
  if (change === 'terminal-reopen') history.versions.push({ ...history.versions.at(-1)!, state: 'trusted', revision: 6 })
  if (change === 'duplicate') source.workHistories!.push(structuredClone(history))
  expect(() => validateReferenceSnapshot(input)).toThrow()
})

it('requires exact source quarantine incident/event context both alone and in the all-lane snapshot', () => {
  const input = workLifecycleSnapshotFixture('quarantined'), source = input.graphs.find(graph => graph.lane === 'source-admission')!, quarantine = input.graphs.find(graph => graph.lane === 'quarantine-health')!
  if (quarantine.lane !== 'quarantine-health') throw new Error('fixture quarantine')
  expect(() => validateReferenceGraph(source)).toThrow(/validated concrete health context/)
  const context = { schemaVersion: 1 as const, workItems: quarantine.workItems, incidents: quarantine.incidents.filter(value => value.id === 'work-incident'), events: quarantine.events.filter(value => value.recordId === 'work-1') }
  expect(validateReferenceGraph(source, context)).toMatchObject({ historicalWorkRecords: 5, resolvedHealthReferences: 1 })
  context.incidents[0]!.reason = 'SUBSTITUTED_REASON'
  expect(() => validateReferenceGraph(source, context)).toThrow(/substituted source health/)
  quarantine.incidents = quarantine.incidents.filter(value => value.id !== 'work-incident')
  expect(() => validateReferenceSnapshot(input)).toThrow(/dangling health incident/)
})

it('rejects history node overflow before decoding artifacts', () => {
  const input = workLifecycleSnapshotFixture('acknowledged'), source = input.graphs.find(graph => graph.lane === 'source-admission')!
  if (source.lane !== 'source-admission') throw new Error('fixture source')
  source.workHistories = Array.from({ length: 128 }, () => structuredClone(source.workHistories![0]!))
  expect(() => validateReferenceGraph(source)).toThrow(/historical work node bound/)
})

it('closes a quarantined release against the validated incident and exact operational event, while standalone remains closed', () => {
  const input = quarantinedReleaseSnapshotFixture()
  const verification = input.graphs.find(graph => graph.lane === 'verification-release')!
  expect(() => validateVerificationReferenceGraph(verification)).toThrow(/validated concrete release context/)
  const result = validateReferenceSnapshot(input)
  expect(result).toMatchObject({ coverage: 'all-lanes', externalLanes: [], authorityVerified: false })
  expect(result.summaries).toContainEqual(expect.objectContaining({ lane: 'verification-release', resolvedHealthReferences: 1 }))
})

it.each(['missing', 'project', 'policy', 'effect', 'reason', 'evidence', 'release-payload', 'event-missing'] as const)('rejects %s quarantine context before permitting composed release references', change => {
  const input = quarantinedReleaseSnapshotFixture(), quarantine = input.graphs.find(graph => graph.lane === 'quarantine-health')!
  if (quarantine.lane !== 'quarantine-health') throw new Error('fixture')
  const incident = quarantine.incidents.find(value => value.id === 'release-incident')!
  if (change === 'missing') quarantine.incidents = quarantine.incidents.filter(value => value.id !== incident.id)
  if (change === 'project') incident.projectId = 'other-project'
  if (change === 'policy') incident.policyRevision++
  if (change === 'effect') incident.effectId = quarantine.envelopes[0]!.id
  if (change === 'reason') incident.reason = 'SUBSTITUTED_REASON'
  if (change === 'evidence') incident.evidenceRefs = ['unknown-evidence']
  if (change === 'release-payload') quarantine.releases[0]!.revision++
  if (change === 'event-missing') quarantine.events = quarantine.events.filter(value => value.recordId !== quarantine.releases[0]!.id)
  expect(() => validateReferenceSnapshot(input)).toThrow()
})

it('rejects a forged standalone resolved-health context rather than trusting a flag or identifier list', () => {
  const input = quarantinedReleaseSnapshotFixture(), verification = input.graphs.find(graph => graph.lane === 'verification-release')!, quarantine = input.graphs.find(graph => graph.lane === 'quarantine-health')!
  if (quarantine.lane !== 'quarantine-health') throw new Error('fixture')
  const context = { schemaVersion: 1 as const, releases: quarantine.releases, incidents: quarantine.incidents.filter(value => value.id === 'release-incident'), events: quarantine.events.filter(value => value.recordId === 'release-1') }
  expect(validateVerificationReferenceGraph(verification, context)).toMatchObject({ resolvedHealthReferences: 1, authorityVerified: false })
  context.incidents[0]!.reason = 'FORGED_REASON'
  expect(() => validateVerificationReferenceGraph(verification, context)).toThrow(/reason\/revision\/identity/)
})

it.each([['source-admission', 'verification-release'], ['verification-release', 'fleet-economics'], ['source-admission', 'quarantine-health']] as const)('supports the explicit %s and %s boundary with all shared referents', (a, b) => {
  const input = scopedReferenceSnapshotFixture([a, b])
  expect(validateReferenceSnapshot(input)).toMatchObject({ coverage: 'declared-lanes', lanes: [a, b] })
  expect(validateReferenceSnapshot(input).externalLanes).toHaveLength(2)
})

it('rejects independently valid unrelated fixture bags as all-lane closure', () => {
  const graphs = [sourceReferenceGraphFixture(), verificationReferenceGraphFixture(), economicsGraphFixture(), quarantineGraphFixture()]
  graphs.forEach(graph => expect(() => validateFactoryReferenceGraph(graph)).not.toThrow())
  expect(() => validateReferenceSnapshot({ schemaVersion: 1, projectId: 'project-1', policyRevision: 1,
    scope: { coverage: 'all-lanes', lanes: graphs.map(graph => graph.lane) }, graphs })).toThrow()
})

it('rejects a declared lane omission, duplicate lane and cross-project snapshot', () => {
  const input = referenceSnapshotFixture()
  input.graphs.pop()
  expect(() => validateReferenceSnapshot(input)).toThrow(/scope/)
  input.scope.lanes.pop()
  expect(() => validateReferenceSnapshot(input)).toThrow(/every lane/)
  const duplicate = referenceSnapshotFixture()
  duplicate.graphs[1] = duplicate.graphs[0]!
  expect(() => validateReferenceSnapshot(duplicate)).toThrow(/scope/)
  const other = referenceSnapshotFixture()
  other.graphs[0]!.projectId = 'other-project'
  expect(() => validateReferenceSnapshot(other)).toThrow(/project\/policy/)
})

it('rejects differing shared workflow payloads even after valid definition digests are recomputed', () => {
  const input = referenceSnapshotFixture(), source = input.graphs.find(graph => graph.lane === 'source-admission')!
  if (source.lane !== 'source-admission') throw new Error('fixture')
  const task = source.definitions.find(value => value.kind === 'task')!
  if (task.kind !== 'task') throw new Error('fixture')
  task.subject = 'Different immutable instructions'
  const { digest: _digest, ...payload } = task
  task.digest = digestJson(payload)
  expect(() => validateFactoryReferenceGraph(source)).not.toThrow()
  expect(() => validateReferenceSnapshot(input)).toThrow(/shared registered task/)
})

it('rejects a changed shared envelope with its local health event still valid', () => {
  const input = referenceSnapshotFixture(), quarantine = input.graphs.find(graph => graph.lane === 'quarantine-health')!
  if (quarantine.lane !== 'quarantine-health') throw new Error('fixture')
  quarantine.envelopes[0]!.deliveryId = 'different-delivery'
  expect(() => validateFactoryReferenceGraph(quarantine)).not.toThrow()
  expect(() => validateReferenceSnapshot(input)).toThrow(/shared InboundEnvelopeV1/)
})

it('rejects a recomputed compact compiler price projection that disagrees with full economics', () => {
  const input = referenceSnapshotFixture(), source = input.graphs.find(graph => graph.lane === 'source-admission')!
  if (source.lane !== 'source-admission') throw new Error('fixture')
  const assignment = source.definitions.find(value => value.kind === 'model-assignment')!
  if (assignment.kind !== 'model-assignment') throw new Error('fixture')
  const artifact = source.artifacts.find(value => value.reference.id === assignment.pricing.id)!
  const price = JSON.parse(Buffer.from(artifact.bytesBase64, 'base64').toString())
  price.inputMicrosPerMillion++
  const bytes = Buffer.from(canonicalJson(price)), updated = { ...artifact, reference: { ...artifact.reference, sizeBytes: bytes.length, digest: digestJson(price) }, bytesBase64: bytes.toString('base64') }
  // The artifact remains consistent in every lane; only its typed economic meaning differs.
  for (const graph of input.graphs) {
    const index = graph.artifacts.findIndex(value => value.reference.id === artifact.reference.id)
    if (index >= 0) graph.artifacts[index] = structuredClone(updated)
  }
  assignment.pricing = updated.reference
  const { digest: _digest, ...payload } = assignment
  assignment.digest = digestJson(payload)
  input.graphs.forEach(graph => expect(() => validateFactoryReferenceGraph(graph)).not.toThrow())
  expect(() => validateReferenceSnapshot(input)).toThrow(/pricing projection/)
})

it('requires actual economic attempts for all verified worker and critic records', () => {
  const input = referenceSnapshotFixture()
  input.graphs = input.graphs.filter(graph => graph.lane !== 'fleet-economics')
  input.graphs.push(economicsGraphFixture())
  expect(() => validateReferenceSnapshot(input)).toThrow()
})

it('keeps aggregate artifacts and strict JSON bounded before lane decoding', () => {
  const input = referenceSnapshotFixture()
  expect(() => validateReferenceSnapshot({ ...input, extra: true })).toThrow(/strict/)
  expect(() => validateReferenceSnapshot('{"schemaVersion":1,"schemaVersion":1}')).toThrow(/strict/)
  const alias = structuredClone(input.graphs[0]!.artifacts[0]!)
  alias.reference.id = 'different-artifact-id'
  input.graphs[1]!.artifacts.push(alias)
  expect(() => validateReferenceSnapshot(input)).toThrow(/artifact digest/)
})

it('closes one native admission incident shared with its quarantined source item', () => {
  const input = sharedAdmissionQuarantineSnapshotFixture()
  expect(validateReferenceSnapshot(input).coverage).toBe('all-lanes')
})
it.each(['missing-admission', 'substituted-incident', 'dangling-effect', 'changed-source', 'changed-receipt'] as const)('rejects shared admission quarantine %s', mutation => {
  const input = sharedAdmissionQuarantineSnapshotFixture(), quarantine = input.graphs.find(graph => graph.lane === 'quarantine-health')!
  if (quarantine.lane !== 'quarantine-health') throw new Error('fixture')
  if (mutation === 'missing-admission') quarantine.admissions = []
  if (mutation === 'substituted-incident') quarantine.admissions[0]!.healthEscalationId = 'other-incident'
  if (mutation === 'dangling-effect') quarantine.incidents.find(value => value.id === 'work-incident')!.effectId = 'missing-admission'
  if (mutation === 'changed-source') quarantine.admissions[0]!.intent.spec.source.sourceRevision = digestJson('different source')
  if (mutation === 'changed-receipt') quarantine.admissions[0]!.receipt.revision++
  expect(() => validateReferenceSnapshot(input)).toThrow()
})

it('requires the full matching admission when resolving a shared source health effect directly', () => {
  const input = sharedAdmissionQuarantineSnapshotFixture(), source = input.graphs.find(graph => graph.lane === 'source-admission')!, quarantine = input.graphs.find(graph => graph.lane === 'quarantine-health')!
  if (source.lane !== 'source-admission' || quarantine.lane !== 'quarantine-health') throw new Error('fixture')
  const context = { schemaVersion: 1 as const, workItems: quarantine.workItems, admissions: quarantine.admissions,
    incidents: quarantine.incidents.filter(value => value.id === 'work-incident'), events: quarantine.events.filter(value => value.id === 'work-quarantined') }
  expect(validateReferenceGraph(source, context).resolvedHealthReferences).toBe(1)
  expect(() => validateReferenceGraph(source, { ...context, admissions: [] })).toThrow(/effect/)
  const substituted = structuredClone(context)
  substituted.admissions[0]!.receipt.revision++
  expect(() => validateReferenceGraph(source, substituted)).toThrow(/payload/)
  const dangling = structuredClone(context)
  dangling.admissions[0]!.healthEscalationId = 'different-incident'
  expect(() => validateReferenceGraph(source, dangling)).toThrow(/effect|orphan/)
})
