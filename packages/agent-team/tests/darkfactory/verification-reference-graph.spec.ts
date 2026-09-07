import { describe, expect, it } from 'vitest'
import { canonicalJson, digestJson } from '../../src/darkfactory/json.ts'
import { validateVerificationReferenceGraph, type VerificationReferenceGraphRecord, type VerificationReferenceGraphDefinition } from '../../src/darkfactory/contracts/verification-reference-graph.ts'
import { verificationReferenceGraphFixture } from './verification-reference-graph-fixture.ts'

type Bundle = ReturnType<typeof verificationReferenceGraphFixture>
function record<K extends VerificationReferenceGraphRecord['kind']>(input: Bundle, kind: K): Extract<VerificationReferenceGraphRecord, { kind: K }>['value'] {
  return input.records.find(item => item.kind === kind)!.value as Extract<VerificationReferenceGraphRecord, { kind: K }>['value']
}
function definition<K extends VerificationReferenceGraphDefinition['kind']>(input: Bundle, kind: K): Extract<VerificationReferenceGraphDefinition, { kind: K }> {
  return input.definitions.find(item => item.kind === kind)! as Extract<VerificationReferenceGraphDefinition, { kind: K }>
}
function rehashDefinition(item: VerificationReferenceGraphDefinition) { const { digest: _digest, ...payload } = item; item.digest = digestJson(payload) }
function rehashEvidence(input: Bundle) {
  const evidence = record(input, 'VerificationEvidenceV1'), prior = evidence.evidenceHash
  const { evidenceHash: _hash, signature: _signature, ...payload } = evidence
  evidence.evidenceHash = digestJson(payload)
  for (const value of input.definitions) if (value.kind === 'integration') { value.evidenceHashes = value.evidenceHashes.map(hash => hash === prior ? evidence.evidenceHash : hash); rehashDefinition(value) }
  for (const value of input.records) if (value.kind === 'ReleaseRecordV1') value.value.evidenceHashes = value.value.evidenceHashes.map(hash => hash === prior ? evidence.evidenceHash : hash)
}

describe('verification-release offline reference closure', () => {
  it('closes every verification, mutation, release, deployment, callback and telemetry record against byte-backed registrations', () => {
    const input = verificationReferenceGraphFixture()
    expect(validateVerificationReferenceGraph(canonicalJson(input))).toMatchObject({ lane: 'verification-release', records: 12, authorityVerified: false, signaturesVerified: false, executionVerified: false })
  })
  it.each(['CriticOutcomeV1', 'MutantManifestV1', 'DeploymentRequestV1', 'DeploymentStatusV1', 'TelemetryVerdictV1'] as const)('rejects a dangling %s reference', kind => {
    const input = verificationReferenceGraphFixture()
    input.records.splice(input.records.findIndex(item => item.kind === kind), 1)
    expect(() => validateVerificationReferenceGraph(input)).toThrow()
  })
  it('rejects cross-project embedded callbacks and changed referenced policy revisions', () => {
    const input = verificationReferenceGraphFixture()
    record(input, 'DeploymentCallbackV1').status.projectId = 'other-project'
    expect(() => validateVerificationReferenceGraph(input)).toThrow(/cross-project/)
    const revision = verificationReferenceGraphFixture()
    definition(revision, 'attempt').policyRevision++
    rehashDefinition(definition(revision, 'attempt'))
    expect(() => validateVerificationReferenceGraph(revision)).toThrow(/policy revision/)
  })
  it.each(['sourceCommit', 'targetCommit', 'candidateCommit', 'generation', 'toolchainDigest'] as const)('rejects rehashed evidence with a substituted %s', field => {
    const input = verificationReferenceGraphFixture(), evidence = record(input, 'VerificationEvidenceV1')
    if (field === 'generation') evidence.generation++
    else evidence[field] = field === 'toolchainDigest' ? `sha256:${'f'.repeat(64)}` : 'f'.repeat(40)
    rehashEvidence(input)
    expect(() => validateVerificationReferenceGraph(input)).toThrow()
  })
  it('rejects a release substituting another policy digest or immutable artifact', () => {
    for (const change of ['policy', 'artifact']) {
      const input = verificationReferenceGraphFixture(), release = record(input, 'ReleaseRecordV1')
      if (change === 'policy') release.policyDigest = `sha256:${'f'.repeat(64)}`
      else release.artifact = release.priorArtifact
      expect(() => validateVerificationReferenceGraph(input)).toThrow()
    }
  })
  it('rejects a registered signer bound to the wrong purpose, environment, public key or validity period', () => {
    for (const change of ['purpose', 'environment', 'public-key', 'expired', 'revoked']) {
      const input = verificationReferenceGraphFixture(), key = definition(input, 'key')
      if (change === 'purpose') key.purposes = ['telemetry']
      if (change === 'environment') key.environment = 'production'
      if (change === 'public-key') key.publicKey = 'not-a-public-key'
      if (change === 'expired') key.validUntil = '2026-09-06T11:00:00Z'
      if (change === 'revoked') key.revokedAt = '2026-09-06T11:00:00Z'
      rehashDefinition(key)
      expect(() => validateVerificationReferenceGraph(input)).toThrow()
    }
  })
  it('rejects a substituted critic model catalog and omitted criterion coverage even after rehashing', () => {
    const input = verificationReferenceGraphFixture(), assignment = definition(input, 'model-assignment')
    assignment.modelVersion = 'unregistered-model'; rehashDefinition(assignment)
    expect(() => validateVerificationReferenceGraph(input)).toThrow(/catalog/)
    const coverage = verificationReferenceGraphFixture(), critic = record(coverage, 'CriticOutcomeV1')
    critic.coveredCriteria = ['invented-criterion']
    record(coverage, 'VerificationEvidenceV1').critics[0] = critic
    rehashEvidence(coverage)
    expect(() => validateVerificationReferenceGraph(coverage)).toThrow(/criterion/)
  })
  it('rejects definition/artifact aliases, corrupted bytes and noncanonical base64', () => {
    for (const change of ['definition', 'artifact', 'bytes', 'base64']) {
      const input = verificationReferenceGraphFixture()
      if (change === 'definition') input.definitions.push(structuredClone(input.definitions[0]!))
      if (change === 'artifact') input.artifacts.push({ ...input.artifacts[0]!, reference: { ...input.artifacts[0]!.reference, id: 'alias' } })
      if (change === 'bytes') input.artifacts[0]!.bytesBase64 = Buffer.from('tampered bytes').toString('base64')
      if (change === 'base64') input.artifacts[0]!.bytesBase64 += '\n'
      expect(() => validateVerificationReferenceGraph(input)).toThrow()
    }
  })
  it('rejects telemetry for an unknown deployment and a changed query revision', () => {
    for (const change of ['deployment', 'query']) {
      const input = verificationReferenceGraphFixture(), telemetry = record(input, 'TelemetryVerdictV1')
      if (change === 'deployment') telemetry.deploymentId = 'foreign-deployment'
      else telemetry.queryRevision++
      const { attestationHash: _hash, signature: _signature, ...payload } = telemetry
      telemetry.attestationHash = digestJson(payload)
      expect(() => validateVerificationReferenceGraph(input)).toThrow()
    }
  })
  it('rejects callback key substitution and a terminal provider status regression', () => {
    const input = verificationReferenceGraphFixture()
    record(input, 'DeploymentCallbackV1').keyId = 'telemetry-key'
    expect(() => validateVerificationReferenceGraph(input)).toThrow(/callback/)
    const regression = verificationReferenceGraphFixture(), status = structuredClone(record(regression, 'DeploymentStatusV1'))
    status.id = 'later-status'; status.providerRevision++; status.status = 'running'
    record(regression, 'ReleaseRecordV1').operationReceipts.push(status)
    regression.records.push({ kind: 'DeploymentStatusV1', value: status })
    expect(() => validateVerificationReferenceGraph(regression)).toThrow(/terminal status regression/)
  })
  it('rejects promotion against a stale prior deployment even when all request digests agree', () => {
    const input = verificationReferenceGraphFixture(), release = record(input, 'ReleaseRecordV1')
    const promotion = release.operationIntents.find(item => item.operation === 'promote')!
    promotion.expectedPriorDeployment = 'stable-deployment'
    const request = input.records.find(item => item.kind === 'DeploymentRequestV1' && item.value.id === promotion.id)!
    Object.assign(request.value, promotion)
    const receipt = release.operationReceipts.find(item => item.operationId === promotion.operationId)!
    receipt.requestDigest = digestJson(promotion)
    for (const entry of input.records) {
      if (entry.kind === 'DeploymentStatusV1' && entry.value.id === receipt.id) entry.value.requestDigest = receipt.requestDigest
      if (entry.kind === 'DeploymentCallbackV1' && entry.value.status.id === receipt.id) entry.value.status.requestDigest = receipt.requestDigest
    }
    expect(() => validateVerificationReferenceGraph(input)).toThrow(/prior\/key\/time/)
  })
  it('rejects telemetry using aliased verification public key material', () => {
    const input = verificationReferenceGraphFixture(), verification = definition(input, 'key')
    const telemetry = input.definitions.find(item => item.kind === 'key' && item.id === 'telemetry-key')!
    if (telemetry.kind !== 'key') throw new Error('fixture key missing')
    telemetry.publicKey = verification.publicKey!
    rehashDefinition(telemetry)
    expect(() => validateVerificationReferenceGraph(input)).toThrow(/reuse public key/)
  })
  it('rejects missing manifest bytes and false not-applicable stage claims', () => {
    const input = verificationReferenceGraphFixture()
    const mutations = record(input, 'VerificationEvidenceV1').stages.find(stage => stage.stage === 'mutations')!
    mutations.artifacts = []
    rehashEvidence(input)
    expect(() => validateVerificationReferenceGraph(input)).toThrow(/manifest/)
    const na = verificationReferenceGraphFixture()
    record(na, 'VerificationEvidenceV1').stages.find(stage => stage.stage === 'twins')!.result = 'NOT_APPLICABLE'
    rehashEvidence(na)
    expect(() => validateVerificationReferenceGraph(na)).toThrow(/applicability/)
  })
  it('rejects unsupported lanes and early aggregate node overflow', () => {
    const input = verificationReferenceGraphFixture()
    expect(() => validateVerificationReferenceGraph({ ...input, lane: 'fleet-economics' })).toThrow(/unsupported/)
    expect(() => validateVerificationReferenceGraph({ ...input, definitions: Array(257).fill(input.definitions[0]) })).toThrow(/bounded/)
  })
})
