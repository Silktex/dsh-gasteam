import { describe, expect, it } from 'vitest'
import { quarantineReferenceGraphInputSchema, validateQuarantineReferenceGraph } from '../../src/darkfactory/contracts/quarantine-reference-graph.ts'
import { canonicalJson, digestJson } from '../../src/darkfactory/json.ts'
import { quarantineGraphFixture } from './quarantine-graph-fixture.ts'

const rejects = (mutate: (input: ReturnType<typeof quarantineGraphFixture>) => void, kind: Parameters<typeof quarantineGraphFixture>[0] = 'work') => {
  const input = quarantineGraphFixture(kind); mutate(input); expect(() => validateQuarantineReferenceGraph(input)).toThrow()
}
describe('concrete quarantine/health reference closure', () => {
  it.each(['work', 'release', 'admission'] as const)('closes a concrete %s quarantine with actual health and operational records', kind => {
    const input = quarantineGraphFixture(kind)
    expect(quarantineReferenceGraphInputSchema.safeParse(input).success).toBe(true)
    expect(validateQuarantineReferenceGraph(input)).toMatchObject({ lane: 'quarantine-health', quarantinedRecords: 1, incidents: 1, events: 1, authorityVerified: false, signaturesVerified: false, externalContextInternalsVerified: false })
    expect(validateQuarantineReferenceGraph(canonicalJson(input))).toEqual(validateQuarantineReferenceGraph(input))
  })
  it('rejects missing, cross-project and stale-policy incidents', () => {
    rejects(input => { input.incidents = [] })
    rejects(input => { input.incidents[0]!.id = 'different-incident' })
    rejects(input => { input.incidents[0]!.projectId = 'other-project' })
    rejects(input => { input.incidents[0]!.policyRevision = 2 })
    rejects(input => { input.workItems[0]!.trust.authorityRevision = 2 })
    rejects(input => { input.incidents[0]!.reason = 'OTHER_REASON' })
    rejects(input => { input.incidents[0]!.effectId = input.artifacts[0]!.reference.id })
    rejects(input => { input.incidents[0]!.stage = 'release' })
  })
  it('rejects dangling evidence/effects and ID-only health or source stubs', () => {
    rejects(input => { input.incidents[0]!.evidenceRefs.push('absent-evidence') })
    rejects(input => { input.incidents[0]!.effectId = 'absent-effect' })
    rejects(input => { input.incidents[0]!.evidenceRefs = [input.incidents[0]!.id] })
    rejects(input => { input.envelopes = [] })
    rejects(input => { input.incidents[0] = { id: input.incidents[0]!.id } as never })
    rejects(input => { input.workItems[0] = { id: input.workItems[0]!.id } as never })
    rejects(input => { input.incidents.push({ ...input.incidents[0]!, id: 'orphan-incident' }) })
  })
  it('pins event target revisions, incident identity, reason and temporal context', () => {
    rejects(input => { input.events[0]!.recordId = 'absent-record' })
    rejects(input => { input.events[0]!.expectedRecordRevision = 0 })
    rejects(input => { input.events[0]!.healthEscalationId = 'other-incident' })
    rejects(input => { delete input.events[0]!.healthEscalationId })
    rejects(input => { input.events[0]!.reasonCode = 'OTHER_REASON' })
    rejects(input => { input.events[0]!.occurredAt = '2026-09-06T11:59:59Z' })
    rejects(input => { input.incidents[0]!.cooldownUntil = 0 })
  })
  it('retains quarantine after acknowledgement/resolution but closes every resolution evidence reference', () => {
    const input = quarantineGraphFixture()
    input.incidents[0]!.acknowledgement = { actor: 'operator', at: input.incidents[0]!.raisedAt }
    input.incidents[0]!.resolution = { reason: 'operator-resolved', source: 'factory-reconciliation', actor: 'operator', evidenceRefs: [input.artifacts[0]!.reference.id], at: input.incidents[0]!.raisedAt }
    expect(validateQuarantineReferenceGraph(input).quarantinedRecords).toBe(1)
    input.incidents[0]!.resolution!.evidenceRefs = ['missing-resolution-evidence']
    expect(() => validateQuarantineReferenceGraph(input)).toThrow(/evidence/)
  })
  it('verifies artifact bytes, descriptor identity, project, canonical base64 and total bounds', () => {
    rejects(input => { input.artifacts = [] })
    rejects(input => { input.artifacts[0]!.bytesBase64 = Buffer.from('substituted').toString('base64') })
    rejects(input => { input.artifacts[0]!.reference.projectId = 'other-project' })
    rejects(input => { input.workItems[0]!.provenance[0]!.sizeBytes++ })
    rejects(input => { input.artifacts[0]!.bytesBase64 += '\n' })
    rejects(input => { input.events = Array.from({ length: 65 }, () => input.events[0]!) })
  })
  it('rejects unrelated workflow/attempt/release context and substituted registered definitions', () => {
    rejects(input => { input.events[0]!.workflowId = 'absent-workflow' }, 'release')
    rejects(input => { input.events[0]!.attemptId = 'absent-attempt' }, 'release')
    rejects(input => { input.events[0]!.releaseId = 'absent-release' }, 'release')
    rejects(input => { input.releases[0]!.workflowId = 'other-workflow' }, 'release')
    rejects(input => { input.releases[0]!.specDigests = [digestJson('different-spec')] }, 'release')
    rejects(input => { input.releases[0]!.operationIntents[0]!.releaseId = 'other-release' }, 'release')
    rejects(input => { input.definitions[0]!.digest = digestJson('substituted') }, 'release')
    rejects(input => { input.definitions.pop() }, 'release')
  })
  it('resolves concrete deployment status evidence and checks its operation request digest', () => {
    const input = quarantineGraphFixture('release'), release = input.releases[0]!, request = release.operationIntents[0]!
    release.operationReceipts = [{ schemaVersion: 1, id: 'deployment-status-1', projectId: input.projectId, policyRevision: input.policyRevision,
      protocolVersion: 1, environment: request.environment, releaseId: release.id, operationId: request.operationId, fencingToken: request.fencingToken,
      commit: request.commit, artifactDigest: request.artifactDigest, providerRevision: 1, status: 'unknown', requestDigest: digestJson(request), observedAt: request.timestamp }]
    input.incidents[0]!.evidenceRefs.push('deployment-status-1')
    expect(validateQuarantineReferenceGraph(input).quarantinedRecords).toBe(1)
    release.operationReceipts[0]!.requestDigest = digestJson('different request')
    expect(() => validateQuarantineReferenceGraph(input)).toThrow(/digest/)
  })
  it('binds actual admission plan, spec, workflow/tasks and quarantine receipt', () => {
    rejects(input => { input.admissions[0]!.intent.plannedSteps[0]!.taskId = 'other-task' }, 'admission')
    rejects(input => { input.admissions[0]!.receipt.state = 'intended' }, 'admission')
    rejects(input => { input.admissions[0]!.healthEscalationId = 'missing-incident' }, 'admission')
    rejects(input => { input.specs = [] }, 'admission')
    rejects(input => { input.incidents[0]!.stage = 'release' }, 'admission')
  })
  it('rejects ambiguous JSON and unknown fields with sanitized diagnostics', () => {
    expect(() => validateQuarantineReferenceGraph('{"schemaVersion":1,"schemaVersion":2}')).toThrow('invalid bounded input')
    const input = { ...quarantineGraphFixture(), secret: 'fixture-secret-must-not-appear' }
    try { validateQuarantineReferenceGraph(input); throw new Error('fixture') } catch (error) { expect(String(error)).toContain('invalid bounded input'); expect(String(error)).not.toContain(input.secret) }
  })
})
