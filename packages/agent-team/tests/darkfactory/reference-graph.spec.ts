import { describe, expect, it } from 'vitest'
import { referenceGraphInputSchema, validateReferenceGraph, type ReferenceGraphInput } from '../../src/darkfactory/contracts/reference-graph.ts'
import { canonicalJson, digestBytes, digestJson } from '../../src/darkfactory/json.ts'
import { examples } from './fixtures.ts'
import { sourceReferenceGraphFixture as fixture } from './source-reference-graph-fixture.ts'

function resignDefinitions(input: ReferenceGraphInput): void {
  for (const definition of input.definitions) { const { digest: _digest, ...payload } = definition; definition.digest = digestJson(payload) }
}
describe('closed offline source/admission reference graph', () => {
  it('checks actual artifact bytes and every supported chain through concrete registered definitions', () => {
    const input = fixture(), result = validateReferenceGraph(input)
    expect(result).toMatchObject({ supportedLanes: ['source-admission'], unsupportedLanes: ['verification-release', 'fleet-economics', 'quarantine-health'], records: 6, registeredDefinitions: 5, artifacts: 8, authorityVerified: false, signaturesVerified: false })
    expect(result.decodedArtifactBytes).toBe(input.artifacts.reduce((bytes, artifact) => bytes + artifact.reference.sizeBytes, 0))
    expect(validateReferenceGraph(JSON.stringify(input))).toEqual(result)
  })
  it('closes explicit provider-read scanner authority and the actual request receipt payload without a signing key', () => {
    const input = fixture(true)
    expect(validateReferenceGraph(input)).toMatchObject({ records: 6, registeredDefinitions: 6, authorityVerified: false })
    const envelope = input.records.find(record => record.kind === 'InboundEnvelopeV1')!.value
    expect(envelope).toMatchObject({ source: 'github', authentication: 'provider-api', providerRead: { scannerId: 'host-scanner:fixture' } })
    expect(envelope).not.toHaveProperty('signingKeyId')
    const missing = structuredClone(input); missing.definitions = missing.definitions.filter(definition => definition.kind !== 'provider-request')
    expect(() => validateReferenceGraph(missing)).toThrow(/unresolved/)
    for (const patch of [{ routeId: 'other' }, { projectId: 'other' }, { id: 'other' }, { at: '2099-01-01T00:00:00Z' }]) {
      const changed = structuredClone(input), charge = changed.definitions.find(definition => definition.kind === 'provider-request')!
      if (charge.kind !== 'provider-request') throw new Error('Expected charge')
      Object.assign(charge.receipt, patch); resignDefinitions(changed)
      expect(() => validateReferenceGraph(changed)).toThrow(/request|project/)
    }
    const crossed = structuredClone(input), work = crossed.records.find(record => record.kind === 'InboundWorkItemV1')!
    if (work.kind !== 'InboundWorkItemV1') throw new Error('Expected work')
    work.value.initiator!.ruleId = 'other'
    const context = crossed.definitions.find(definition => definition.kind === 'compiler-context')!
    if (context.kind !== 'compiler-context') throw new Error('Expected context')
    context.context.ingress = structuredClone(work.value); resignDefinitions(crossed)
    expect(() => validateReferenceGraph(crossed)).toThrow(/initiator|compiler/)
  })
  it.each(['InboundEnvelopeV1', 'InboundWorkItemV1', 'ExecutableSpecV1', 'CompilerOutcomeV1'] as const)('rejects missing %s links', kind => {
    const input = fixture(); input.records = input.records.filter(record => record.kind !== kind)
    expect(() => validateReferenceGraph(input)).toThrow(/unresolved/)
  })
  it.each(['workflow', 'task', 'attempt', 'model-assignment', 'compiler-context'] as const)('rejects missing concrete %s registration', kind => {
    const input = fixture(); input.definitions = input.definitions.filter(definition => definition.kind !== kind)
    expect(() => validateReferenceGraph(input)).toThrow(/unresolved|missing concrete/)
  })
  it('rejects cross-project records, references and referenced policy revisions', () => {
    const record = fixture(); record.records[0]!.value.projectId = 'other'
    expect(() => validateReferenceGraph(record)).toThrow(/cross-project/)
    const artifact = fixture(); artifact.artifacts[0]!.reference.projectId = 'other'
    expect(() => validateReferenceGraph(artifact)).toThrow(/cross-project/)
    const registration = fixture(); registration.definitions[0]!.policyRevision = 2; resignDefinitions(registration)
    expect(() => validateReferenceGraph(registration)).toThrow(/policy revision/)
  })
  it('rejects duplicate IDs, source aliases, digest aliases and contradictory artifact metadata', () => {
    const duplicateRecord = fixture(); duplicateRecord.records.push(duplicateRecord.records[0]!)
    expect(() => validateReferenceGraph(duplicateRecord)).toThrow(/duplicate record/)
    const duplicateDefinition = fixture(); duplicateDefinition.definitions.push(duplicateDefinition.definitions[0]!)
    expect(() => validateReferenceGraph(duplicateDefinition)).toThrow(/duplicate registered/)
    const alias = fixture(), work = alias.records.find(record => record.kind === 'InboundWorkItemV1')!
    alias.records.push({ ...work, value: { ...work.value, id: 'alias-work' } })
    expect(() => validateReferenceGraph(alias)).toThrow(/source revision alias/)
    const digestAlias = fixture(); digestAlias.artifacts.push({ ...digestAlias.artifacts[0]!, reference: { ...digestAlias.artifacts[0]!.reference, id: 'alias-artifact' } })
    expect(() => validateReferenceGraph(digestAlias)).toThrow(/digest alias/)
    const metadata = fixture(); metadata.artifacts[0]!.reference.mediaType = 'text/plain'
    expect(() => validateReferenceGraph(metadata)).toThrow(/aliased artifact/)
    const doubleAdmission = fixture(), admission = doubleAdmission.records.find(record => record.kind === 'AdmissionReceiptV1')!
    doubleAdmission.records.push({ ...admission, value: { ...admission.value, id: 'second-admission' } })
    expect(() => validateReferenceGraph(doubleAdmission)).toThrow(/duplicate admission/)
  })
  it('rejects missing and tampered artifact bytes', () => {
    const missing = fixture(); missing.artifacts.shift()
    expect(() => validateReferenceGraph(missing)).toThrow(/unresolved.*artifact/)
    const changed = fixture(); changed.artifacts[0]!.bytesBase64 = Buffer.alloc(changed.artifacts[0]!.reference.sizeBytes).toString('base64')
    expect(() => validateReferenceGraph(changed)).toThrow(/artifact digest mismatch/)
    const wrongSize = fixture(); wrongSize.artifacts[0]!.reference.sizeBytes++
    expect(() => validateReferenceGraph(wrongSize)).toThrow(/artifact size/)
  })
  it('checks model generation, catalog/pricing revisions, workflow task ownership and definition digests', () => {
    for (const changes of [{ generation: 2 }, { catalogRevision: 2 }, { pricingRevision: 2 }, { modelVersion: 'invented' }]) {
      const input = fixture(), model = input.definitions.find(definition => definition.kind === 'model-assignment')!
      Object.assign(model, changes); resignDefinitions(input)
      expect(() => validateReferenceGraph(input)).toThrow(/generation mismatch|revision\/identity mismatch/)
    }
    const task = fixture(), taskDefinition = task.definitions.find(definition => definition.kind === 'task')!
    taskDefinition.stepId = 'invented'; resignDefinitions(task)
    expect(() => validateReferenceGraph(task)).toThrow(/task step mismatch/)
    const workflow = fixture(), workflowDefinition = workflow.definitions.find(definition => definition.kind === 'workflow')!
    workflowDefinition.definitionDigest = `sha256:${'a'.repeat(64)}`; resignDefinitions(workflow)
    expect(() => validateReferenceGraph(workflow)).toThrow(/workflow definition digest/)
  })
  it('revalidates host command/fixture registries and immutable compiler pins independently of spec hashes', () => {
    const registry = fixture(), compiler = registry.definitions.find(definition => definition.kind === 'compiler-context')!
    compiler.context.registries.commands = []; resignDefinitions(registry)
    expect(() => validateReferenceGraph(registry)).toThrow(/host registry\/pins/)
    const pins = fixture(), pinnedCompiler = pins.definitions.find(definition => definition.kind === 'compiler-context')!
    pinnedCompiler.context.baseCommit = 'c'.repeat(40); resignDefinitions(pins)
    expect(() => validateReferenceGraph(pins)).toThrow(/host registry\/pins/)
    const escapedPolicy = fixture(), unregisteredCompiler = escapedPolicy.definitions.find(definition => definition.kind === 'compiler-context')!
    unregisteredCompiler.context.registries.commands[0]!.args = ['unregistered-code']; resignDefinitions(escapedPolicy)
    expect(() => validateReferenceGraph(escapedPolicy)).toThrow(/registry escapes pinned policy/)
    const workflow = fixture(), admission = workflow.records.find(record => record.kind === 'AdmissionReceiptV1')!
    admission.value.taskIds = ['unregistered-task']
    expect(() => validateReferenceGraph(workflow)).toThrow(/workflow\/task pins/)
  })
  it('rejects noncanonical base64 before decoding and bounds decoded aggregate bytes', () => {
    for (const bytesBase64 of ['Zg', 'Zg==\n', 'Zh==', 'Zm9=']) {
      const input = fixture(); input.artifacts[0] = { reference: { ...input.artifacts[0]!.reference, sizeBytes: 1 }, bytesBase64 }
      expect(() => validateReferenceGraph(input)).toThrow(/base64/)
    }
    const input = fixture(), bytes = Buffer.alloc(1_048_576)
    for (let index = 0; index < 4; index++) input.artifacts.push({ reference: { id: `large-${index}`, projectId: input.projectId, mediaType: 'application/octet-stream', sizeBytes: bytes.length, digest: digestBytes(bytes) }, bytesBase64: bytes.toString('base64') })
    expect(() => validateReferenceGraph(input)).toThrow(/aggregate decoded artifact byte limit/)
  })
  it('rejects unsupported lanes, unknown fields, duplicate JSON keys and oversized record collections', () => {
    expect(() => validateReferenceGraph({ ...fixture(), lane: 'verification-release' })).toThrow()
    expect(() => validateReferenceGraph({ ...fixture(), records: [{ kind: 'VerificationEvidenceV1', value: examples.VerificationEvidenceV1 }] })).toThrow(/unsupported record kind\/lane/)
    expect(() => validateReferenceGraph({ ...fixture(), records: [{ kind: 'UsageEventV1', value: examples.UsageEventV1 }] })).toThrow(/unsupported record kind\/lane/)
    expect(() => validateReferenceGraph({ ...fixture(), grantAuthority: true })).toThrow(/invalid bounded input/)
    const quarantine = fixture(), work = quarantine.records.find(record => record.kind === 'InboundWorkItemV1')!
    work.value.state = 'quarantined'; work.value.quarantineReason = 'SOURCE_CHANGED'; work.value.healthEscalationId = 'unresolved-health'
    expect(() => validateReferenceGraph(quarantine)).toThrow(/explicit native history|validated concrete health context/)
    expect(() => validateReferenceGraph('{"schemaVersion":1,"schemaVersion":2}')).toThrow(/invalid bounded input/)
    const input = fixture(); input.records = Array(129).fill(input.records[0])
    expect(() => validateReferenceGraph(input)).toThrow(/record count limit/)
  })
})
