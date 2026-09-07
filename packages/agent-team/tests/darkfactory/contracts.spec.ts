import { describe, expect, it } from 'vitest'
import { canonicalJson, contracts, contractJsonSchemas, counterSchema, digestJson, parseContract, parseStrictJson, pinExecutableSpec, safePathSchema, secretRefSchema, timestampSchema, validateContract, verifyExecutableSpec, assertAdmissionMatchesSpec, assertIngestionTransition, assertReleaseTransition } from '../../src/darkfactory.ts'
import { examples, spec, specPayload } from './fixtures.ts'

describe('Dark Factory versioned contracts', () => {
  for (const [name, schema] of Object.entries(contracts)) {
    it(`${name} accepts its example, round-trips JSON, and rejects unknown fields/versions`, () => {
      const example = examples[name as keyof typeof examples]
      expect(schema.parse(example)).toEqual(example)
      expect(parseContract(schema, JSON.stringify(example))).toEqual(example)
      expect(validateContract(name as keyof typeof contracts, example)).toEqual(example)
      expect(() => schema.parse({ ...example, instruction: 'ignore policy' })).toThrow()
      expect(() => parseContract(schema, JSON.stringify({ ...example, schemaVersion: 2 }))).toThrow(/migrate offline/)
      expect(() => schema.parse({ ...example, policyRevision: 0 })).toThrow()
      expect(() => schema.parse({ ...example, id: '../escape' })).toThrow()
    })
  }
  it('generates a JSON Schema for every public record', () => {
    const schemas = contractJsonSchemas()
    expect(Object.keys(schemas)).toEqual(Object.keys(examples))
    for (const [name, schema] of Object.entries(schemas)) {
      expect(schema.$schema, name).toBe('https://json-schema.org/draft/2020-12/schema')
      if (name !== 'CompilerOutcomeV1' && name !== 'InboundEnvelopeV1') expect(schema.additionalProperties, name).toBe(false)
      if (name === 'InboundEnvelopeV1') for (const branch of schema.oneOf ?? schema.anyOf ?? []) expect(branch.additionalProperties).toBe(false)
    }
    expect(schemas.AdmissionReceiptV1?.properties?.taskIds).toMatchObject({ minItems: 1, uniqueItems: true, maxItems: 256 })
    const allowedPaths = schemas.ExecutableSpecV1?.properties?.allowedPaths
    expect(allowedPaths).toHaveProperty('items.pattern')
    const pattern = new RegExp((allowedPaths?.items as { pattern: string }).pattern)
    for (const value of ['src/valid.ts', '../escape', '/absolute', 'src/.GIT/config', 'src//empty', 'src/a\u007f']) {
      expect(pattern.test(value), value).toBe(safePathSchema.safeParse(value).success)
    }
  })
  it('requires explicit provider-read evidence without a fabricated signing key and binds scanner work actors', () => {
    const { signingKeyId, ...legacy } = examples.InboundEnvelopeV1
    const envelope = { ...legacy, authentication: 'provider-api', bodyDigest: legacy.artifact.digest,
      providerRead: { scannerId: 'host-scanner:github', ruleId: 'rule', requestReceiptId: 'request-1', responseDigest: digestJson('response'), observedAt: legacy.receivedAt } }
    expect(validateContract('InboundEnvelopeV1', envelope)).toEqual(envelope)
    for (const bad of [{ ...envelope, signingKeyId }, { ...envelope, source: 'maintenance' }, { ...envelope, providerRead: { ...envelope.providerRead, scannerId: 'human' } }, { ...envelope, bodyDigest: digestJson('different') }]) expect(() => validateContract('InboundEnvelopeV1', bad)).toThrow()
    const work = { ...examples.InboundWorkItemV1, actor: envelope.providerRead.scannerId, initiator: { kind: 'host-scanner', scannerId: envelope.providerRead.scannerId, ruleId: 'rule' } }
    expect(validateContract('InboundWorkItemV1', work)).toEqual(work)
    expect(() => validateContract('InboundWorkItemV1', { ...work, actor: 'human' })).toThrow(/host actor/)
    expect(() => assertIngestionTransition(work as never, { ...work, revision: work.revision + 1, state: 'compiled', initiator: { ...work.initiator, ruleId: 'changed' } } as never)).toThrow(/initiator/)
  })
  it('requires executable acceptance evidence and rejects cross-project or altered specs', () => {
    expect(verifyExecutableSpec(spec)).toEqual(spec)
    expect(() => pinExecutableSpec({ ...specPayload, acceptanceScenarios: [] })).toThrow()
    expect(() => pinExecutableSpec({ ...specPayload, provenance: [{ ...specPayload.provenance[0], projectId: 'other' }] })).toThrow(/Cross-project/)
    expect(() => pinExecutableSpec({ ...specPayload, invariants: [...specPayload.invariants, ...specPayload.invariants] })).toThrow(/Duplicate/)
    expect(() => verifyExecutableSpec({ ...spec, priority: 100 })).toThrow(/digest mismatch/)
    expect(spec.specDigest).toBe(digestJson(specPayload))
  })
  it('bounds nested records, money, paths, counters and secret references', () => {
    for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(counterSchema.safeParse(value).success).toBe(false)
    for (const value of ['../secret', '/etc/passwd', 'src/../../secret', 'src\\secret', '.git/config', 'src/.GIT/config', 'src//a', 'src/*', 'x\0y']) expect(safePathSchema.safeParse(value).success, value).toBe(false)
    expect(secretRefSchema.safeParse({ kind: 'env', name: 'DF_KEY', value: 'secret' }).success).toBe(false)
    expect(secretRefSchema.safeParse({ kind: 'file', path: 'relative' }).success).toBe(false)
    expect(contracts.ExecutableSpecV1.safeParse({ ...spec, acceptanceScenarios: Array(129).fill(spec.acceptanceScenarios[0]) }).success).toBe(false)
    expect(contracts.DeploymentCallbackV1.safeParse({ ...examples.DeploymentCallbackV1, status: { ...examples.DeploymentStatusV1, arbitraryUrl: 'https://evil.invalid' } }).success).toBe(false)
  })
  it('fences ingress revisions and terminal states and references the existing health inbox', () => {
    const from = contracts.InboundWorkItemV1.parse(examples.InboundWorkItemV1)
    expect(() => assertIngestionTransition(from, { ...from, revision: 2, state: 'compiled' })).not.toThrow()
    expect(() => assertIngestionTransition(from, { ...from, revision: 1, state: 'compiled' })).toThrow(/Stale/)
    expect(() => assertIngestionTransition(from, { ...from, revision: 2, state: 'quarantined' })).toThrow(/health inbox/)
    const terminal = { ...from, revision: 2, state: 'quarantined' as const, quarantineReason: 'SOURCE_CHANGED', healthEscalationId: 'health-1' }
    expect(() => assertIngestionTransition(from, terminal)).not.toThrow()
    expect(() => assertIngestionTransition(terminal, { ...terminal, revision: 3, state: 'trusted' })).toThrow(/Illegal/)
    expect(() => assertIngestionTransition(from, { ...from, revision: 2, state: 'compiled', title: 'Changed source' })).toThrow(/immutable/)
  })
  it('binds every nested artifact and record to the outer project and policy', () => {
    for (const [name, example] of Object.entries(examples)) {
      const rewrite = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(rewrite)
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'projectId' ? 'other-project' : rewrite(item)]))
        return value
      }
      const mismatched = { ...rewrite(example) as object, projectId: example.projectId }
      if (JSON.stringify(mismatched).includes('other-project')) expect(() => validateContract(name as keyof typeof contracts, mismatched), name).toThrow(/Cross-project/)
    }
    expect(() => validateContract('DeploymentCallbackV1', { ...examples.DeploymentCallbackV1, status: { ...examples.DeploymentStatusV1, policyRevision: 2 } })).toThrow(/policy revision/)
  })
  it.each([
    ['InboundEnvelopeV1', { authentication: 'host-scanner' }, /maintenance/],
    ['InboundWorkItemV1', { trust: { ...examples.InboundWorkItemV1.trust, entityRevision: `sha256:${'c'.repeat(64)}` } }, /source revision/],
    ['ExecutableSpecV1', { priority: 1 }, /digest mismatch/],
    ['CompilerOutcomeV1', { source: { ...examples.CompilerOutcomeV1.source, envelopeId: 'different' } }, /source mismatch/],
    ['CriticOutcomeV1', { defects: [{ severity: 'CRITICAL', description: 'Reproducible fault', evidence: spec.provenance[0], reproductionSteps: ['Run the pinned check'] }] }, /blocking defects/],
    ['VerificationEvidenceV1', { expiresAt: examples.VerificationEvidenceV1.createdAt }, /expiry/],
    ['VerificationEvidenceV1', { stages: examples.VerificationEvidenceV1.stages.slice(1) }, /verification stage/],
    ['VerificationEvidenceV1', { critics: examples.VerificationEvidenceV1.critics.slice(1) }, /two accepting critics/],
    ['VerificationEvidenceV1', { critics: examples.VerificationEvidenceV1.critics.map(critic => ({ ...critic, confidence: 0.79 })) }, /confidence/],
    ['VerificationEvidenceV1', { stages: [examples.VerificationEvidenceV1.stages[0], examples.VerificationEvidenceV1.stages[0]] }, /Duplicate/],
    ['MutantManifestV1', { selectedCount: 0 }, /mutant counts/],
    ['DeploymentStatusV1', { deploymentId: undefined }, /deployment identity/],
    ['DeploymentCallbackV1', { timestamp: '2026-09-06T11:00:00Z' }, /observation/],
    ['TelemetryVerdictV1', { sample: { ...examples.TelemetryVerdictV1.sample, errors: 1001 } }, /exceed requests/],
    ['TelemetryVerdictV1', { sample: { ...examples.TelemetryVerdictV1.sample, p99Ms: null } }, /latency data/],
    ['ReleaseRecordV1', { state: 'accepted' }, /deadlines/],
    ['PricingSnapshotV1', { expiresAt: examples.PricingSnapshotV1.observedAt }, /expiry/],
    ['ReservationV1', { purpose: 'canary-recovery' }, /authority evidence/],
    ['ReservationV1', { accountingMonth: '2026-10' }, /accounting window/],
    ['UsageEventV1', { correctionOf: examples.UsageEventV1.id }, /itself/],
    ['UsageEventV1', { countingSemantics: 'cache-in-input-reasoning-in-output', cacheTokens: 101 }, /subcounts/],
    ['ProviderQuotaV1', { observedRemaining: 1_000_001 }, /exceeds total/],
    ['ProviderQuotaV1', { expiresAt: '2026-09-06T14:00:00Z' }, /expiry window/],
    ['ModelRoleAssignmentV1', { assignedAt: examples.ModelRoleAssignmentV1.health.expiresAt }, /health expiry/],
  ] as const)('rejects semantically inconsistent %s', (name, changes, message) => {
    const value: Record<string, unknown> = { ...examples[name], ...changes }
    const hashField = ({ VerificationEvidenceV1: 'evidenceHash', TelemetryVerdictV1: 'attestationHash', UsageEventV1: 'eventDigest' } as Record<string, string>)[name]
    if (hashField) {
      const payload = { ...value }; delete payload[hashField]; delete payload.signature
      value[hashField] = digestJson(payload)
    }
    expect(() => validateContract(name, value)).toThrow(message)
  })
  it('fences release identity, operation history, revisions and terminal records', () => {
    const from = validateContract('ReleaseRecordV1', examples.ReleaseRecordV1)
    const next = { ...from, revision: 2, state: 'deploying' as const }
    expect(() => assertReleaseTransition(from, next)).not.toThrow()
    expect(() => assertReleaseTransition(from, { ...next, revision: 1 })).toThrow(/Stale/)
    expect(() => assertReleaseTransition(from, { ...next, commit: 'c'.repeat(40) })).toThrow(/immutable/)
    const failed = { ...next, state: 'failed' as const }
    expect(() => assertReleaseTransition(from, failed)).not.toThrow()
    expect(() => assertReleaseTransition(failed, { ...failed, revision: 3 })).toThrow(/Illegal/)
    const intent = { ...contracts.DeploymentRequestV1.parse(examples.DeploymentRequestV1), releaseId: from.id }
    const withIntent = { ...next, operationIntents: [intent] }
    expect(() => assertReleaseTransition(from, withIntent)).not.toThrow()
    expect(() => assertReleaseTransition(withIntent, { ...withIntent, revision: 3, operationIntents: [] })).toThrow(/append-only/)
    expect(() => validateContract('ReleaseRecordV1', { ...withIntent, operationIntents: [intent, intent] })).toThrow(/Duplicate operation key/)
    const receipt = { ...examples.DeploymentStatusV1, releaseId: from.id, requestDigest: digestJson(intent) }
    expect(() => validateContract('ReleaseRecordV1', { ...withIntent, operationReceipts: [receipt] })).not.toThrow()
    expect(() => validateContract('ReleaseRecordV1', { ...withIntent, operationReceipts: [{ ...receipt, fencingToken: 2 }] })).toThrow(/Mismatched operation receipt/)
  })
  it('binds admission to immutable spec, workflow, policy and source revisions', () => {
    expect(() => assertAdmissionMatchesSpec(examples.AdmissionReceiptV1, spec)).not.toThrow()
    for (const changes of [{ projectId: 'other' }, { policyRevision: 2 }, { workflowDigest: `sha256:${'d'.repeat(64)}` }, { source: { ...examples.AdmissionReceiptV1.source, envelopeId: 'other' } }]) {
      expect(() => assertAdmissionMatchesSpec({ ...examples.AdmissionReceiptV1, ...changes }, spec)).toThrow(/Admission/)
    }
  })
  it('permits a critic diversity deficit only in explicitly bound non-deploying qualification evidence', () => {
    const original = examples.VerificationEvidenceV1
    const critics = original.critics.map(critic => ({ ...critic, provider: original.critics[0]!.provider, modelVersion: original.critics[0]!.modelVersion }))
    const diversityDeficit = { reasonCode: 'NO_ELIGIBLE_HEALTHY_DIVERSE_MODEL', catalogRevision: 1, catalogDigest: spec.policyDigest, eligibilityEvidence: spec.provenance }
    const evidence = (changes: Record<string, unknown>) => {
      const { evidenceHash: _hash, signature, ...payload } = { ...original, ...changes }
      return { ...payload, signature, evidenceHash: digestJson(payload) }
    }
    expect(() => validateContract('VerificationEvidenceV1', evidence({ critics }))).toThrow(/diversity/)
    expect(() => validateContract('VerificationEvidenceV1', evidence({ critics, diversityDeficit }))).toThrow(/restricted to non-deploying/)
    expect(() => validateContract('VerificationEvidenceV1', evidence({ critics, executionMode: 'non-deploying-qualification' }))).toThrow(/recorded non-deploying/)
    expect(() => validateContract('VerificationEvidenceV1', evidence({ critics, diversityDeficit, executionMode: 'non-deploying-qualification' }))).not.toThrow()
    expect(() => validateContract('VerificationEvidenceV1', evidence({ critics, diversityDeficit: { ...diversityDeficit, eligibilityEvidence: [] }, executionMode: 'non-deploying-qualification' }))).toThrow()
    expect(() => validateContract('VerificationEvidenceV1', { ...original, environment: 'production' })).toThrow(/hash mismatch/)
    expect(() => validateContract('VerificationEvidenceV1', { ...original, executionMode: 'non-deploying-qualification' })).toThrow(/hash mismatch/)
    expect(() => contracts.VerificationEvidenceV1.parse({ ...original, environment: undefined })).toThrow()
    expect(() => contracts.VerificationEvidenceV1.parse({ ...original, executionMode: undefined })).toThrow()
  })
  it('preserves verification stage order and timing while allowing explicit twin/mutation non-applicability', () => {
    const { evidenceHash: _hash, signature, ...original } = examples.VerificationEvidenceV1
    const validate = (stages: typeof original.stages) => {
      const payload = { ...original, stages }
      return validateContract('VerificationEvidenceV1', { ...payload, signature, evidenceHash: digestJson(payload) })
    }
    expect(() => validate(original.stages.map(stage => ({ ...stage, result: stage.stage === 'twins' || stage.stage === 'mutations' ? 'NOT_APPLICABLE' : 'PASSED' })))).not.toThrow()
    expect(() => validate(original.stages.map(stage => ({ ...stage, result: stage.stage === 'tests' ? 'NOT_APPLICABLE' : 'PASSED' })))).toThrow(/all verification stages/)
    expect(() => validate([original.stages[1]!, original.stages[0]!, ...original.stages.slice(2)])).toThrow(/stage order/)
    const overlapping = original.stages.map((stage, index) => ({ ...stage, startedAt: index === 1 ? '2026-09-06T11:59:59Z' : stage.startedAt }))
    expect(() => validate(overlapping)).toThrow(/sequential verification stages/)
    const sequential = original.stages.map((stage, index) => ({ ...stage, startedAt: `2026-09-06T11:0${index}:00Z`, endedAt: `2026-09-06T11:0${index + 1}:00Z` }))
    expect(() => validate(sequential)).not.toThrow()
  })
  it('requires RFC 3339 seconds and preserves fractional timestamp ordering', () => {
    expect(timestampSchema.safeParse('2026-09-06T12:00Z').success).toBe(false)
    expect(timestampSchema.safeParse('2026-09-06T12:00:00+01:00').success).toBe(false)
    expect(() => validateContract('PricingSnapshotV1', { ...examples.PricingSnapshotV1, observedAt: '2026-09-06T12:00:00.0000001Z', expiresAt: '2026-09-06T12:00:00.0000002Z' })).not.toThrow()
  })
})

describe('unambiguous JSON and canonical digests', () => {
  it.each(['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"nested":{"x":1,"x":2}}', '[1,]', '{"x":1,}', '01', 'true false', '1e999', '"\\ud800"', '"unterminated', '{"x" 1}', '\ufeff{}'])('rejects %s', input => {
    expect(() => parseStrictJson(input)).toThrow()
  })
  it('rejects invalid encoding, excessive depth and oversized UTF-8 bodies', () => {
    expect(() => parseStrictJson(Uint8Array.from([0x22, 0xc0, 0xaf, 0x22]))).toThrow()
    expect(() => parseStrictJson('['.repeat(66) + '0' + ']'.repeat(66))).toThrow(/nesting/)
    expect(() => parseStrictJson('"€"', 4)).toThrow(/byte limit/)
    expect(() => parseStrictJson('"\ud800"')).toThrow(/Unicode/)
    expect(parseStrictJson('{"__proto__":{"safe":true},"a":[null,true,-1.5e2]}')).toEqual(JSON.parse('{"__proto__":{"safe":true},"a":[null,true,-150]}'))
    expect(Object.getPrototypeOf(parseStrictJson('{"__proto__":1}'))).toBe(null)
  })
  it('matches RFC 8785 number serialization and UTF-16 property ordering', () => {
    // https://www.rfc-editor.org/rfc/rfc8785.html sections 3.2.2 and 3.2.3.
    expect(canonicalJson({ numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27, -0], literals: [null, true, false] }))
      .toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0]}')
    expect(canonicalJson({ '\ufb33': 7, '€': 5, '\r': 1, '😀': 6, '1': 2, 'ö': 4, '\u0080': 3 }))
      .toBe('{"\\r":1,"1":2,"\u0080":3,"ö":4,"€":5,"😀":6,"דּ":7}')
    expect(digestJson({ b: 1, a: { y: 2, x: 1 } })).toBe(digestJson({ a: { x: 1, y: 2 }, b: 1 }))
    expect(digestJson('é')).not.toBe(digestJson('e\u0301'))
  })
  it('never drops invalid values or invokes object serialization hooks', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    for (const value of [undefined, Infinity, NaN, 1n, '\ud800', { a: undefined }, new Date(), [, 1], cycle]) expect(() => canonicalJson(value)).toThrow()
    let invoked = false
    expect(() => canonicalJson({ get a() { invoked = true; return 1 } })).toThrow(/Accessors/)
    expect(invoked).toBe(false)
    const array = [1]
    Object.defineProperty(array, '0', { get() { invoked = true; return 1 } })
    expect(() => canonicalJson(array)).toThrow(/Accessors/)
    expect(invoked).toBe(false)
    const extended = [1]
    Object.defineProperty(extended, 'extra', { value: 2 })
    expect(() => canonicalJson(extended)).toThrow(/extended/)
  })
})
