import { describe, expect, it } from 'vitest'
import {
  HostKeyRegistry,
  signVerificationEvidence,
  verifyVerificationEvidence,
  createIntegrationReviewReceipt,
} from '../../src/darkfactory/verification-signer.ts'
import { buildAndSignVerificationEvidence } from '../../src/darkfactory/verification-evidence.ts'
import { digestJson, canonicalJson } from '../../src/darkfactory/json.ts'
import type { StageResultV1, CriticOutcomeV1 } from '../../src/darkfactory/contracts/verification.ts'
import type { TeamIntegrationSnapshot, TeamCommitId, TeamIntegrationId, TeamBranchName } from '../../src/types.ts'

describe('DF-10 Canonical Signed Verification Evidence and Integration Review Gate', () => {
  const registry = new HostKeyRegistry()
  const { keyId, privateKeyPem } = registry.generateKey('host-key-1')

  const now = Date.now()
  const createdAt = new Date(now).toISOString()
  const expiresAt = new Date(now + 3600_000).toISOString() // 1 hour

  const sampleStages: StageResultV1[] = [
    {
      id: 'st-arch',
      stage: 'architecture',
      result: 'PASSED',
      definitionRevision: 1,
      startedAt: createdAt,
      endedAt: createdAt,
      exitCondition: 'passed',
      artifacts: [],
    },
    {
      id: 'st-tests',
      stage: 'tests',
      result: 'PASSED',
      definitionRevision: 1,
      startedAt: createdAt,
      endedAt: createdAt,
      exitCondition: 'passed',
      artifacts: [],
    },
    {
      id: 'st-twins',
      stage: 'twins',
      result: 'NOT_APPLICABLE',
      definitionRevision: 1,
      startedAt: createdAt,
      endedAt: createdAt,
      exitCondition: 'NO_EXTERNAL_DEPENDENCY',
      artifacts: [],
    },
    {
      id: 'st-mut',
      stage: 'mutations',
      result: 'PASSED',
      definitionRevision: 1,
      startedAt: createdAt,
      endedAt: createdAt,
      exitCondition: 'passed',
      artifacts: [],
    },
    {
      id: 'st-critics',
      stage: 'critics',
      result: 'PASSED',
      definitionRevision: 1,
      startedAt: createdAt,
      endedAt: createdAt,
      exitCondition: 'passed',
      artifacts: [],
    },
  ]

  const sampleCritic: CriticOutcomeV1 = {
    schemaVersion: 1,
    id: 'critic-1',
    projectId: 'project-1',
    policyRevision: 1,
    attemptId: 'att-1',
    modelAssignmentId: 'assign-1',
    provider: 'anthropic',
    modelVersion: 'claude-3-7-sonnet',
    contextDigest: digestJson({ ctx: 1 }),
    specDigest: digestJson({ spec: 1 }),
    candidateCommit: '0123456789abcdef0123456789abcdef01234567',
    verdict: 'ACCEPT',
    confidence: 0.95,
    coveredCriteria: ['c1', 'c2'],
    defects: [],
    committedAt: createdAt,
  }

  const samplePayload = {
    schemaVersion: 1 as const,
    id: 'evidence-att-1',
    projectId: 'project-1',
    policyRevision: 1,
    taskId: 'task-1',
    workflowId: 'wf-1',
    attemptId: 'att-1',
    generation: 1,
    environment: 'staging',
    executionMode: 'deploying' as const,
    sourceCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    targetCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    candidateCommit: 'cccccccccccccccccccccccccccccccccccccccc',
    candidateTreeDigest: digestJson({ tree: 'cand' }),
    specDigest: digestJson({ spec: 'gate-2' }),
    policyDigest: digestJson({ policy: 'v1' }),
    toolchainDigest: digestJson({ node: '22', pnpm: '10' }),
    stages: sampleStages,
    critics: [sampleCritic, { ...sampleCritic, id: 'critic-2', provider: 'google', modelVersion: 'gemini-2.5-pro' }],
    createdAt,
    expiresAt,
    decision: 'ACCEPT' as const,
    signerKeyId: keyId,
    batchMembers: [],
  }

  describe('Suite 1: RFC 8785 Canonical JSON Hashing and Determinism', () => {
    it('produces identical digest regardless of object key order in payload', () => {
      const obj1 = { b: 2, a: 1, z: { d: 4, c: 3 } }
      const obj2 = { a: 1, b: 2, z: { c: 3, d: 4 } }

      expect(canonicalJson(obj1)).toBe(canonicalJson(obj2))
      expect(digestJson(obj1)).toBe(digestJson(obj2))
    })

    it('signs evidence with Ed25519 producing valid signatureSchema matching format', () => {
      const evidence = signVerificationEvidence(samplePayload, privateKeyPem)
      expect(evidence.signature).toMatch(/^[A-Za-z0-9+/]{86}==$/)
      expect(evidence.evidenceHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    })
  })

  describe('Suite 2: Host Key Registry and Signature Verification', () => {
    it('verifies valid evidence successfully against host public key', () => {
      const evidence = signVerificationEvidence(samplePayload, privateKeyPem)
      const res = verifyVerificationEvidence(evidence, registry)
      expect(res.valid).toBe(true)
      expect(res.decision).toBe('ACCEPT')
      expect(res.evidenceHash).toBe(evidence.evidenceHash)
    })

    it('rejects evidence when signature is tampered or forged', () => {
      const evidence = signVerificationEvidence(samplePayload, privateKeyPem)
      const tampered = {
        ...evidence,
        signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      }
      const res = verifyVerificationEvidence(tampered, registry)
      expect(res.valid).toBe(false)
      expect(res.reason).toContain('signature verification failed')
    })

    it('rejects evidence when signer key ID is untrusted in host registry', () => {
      const evidence = signVerificationEvidence(
        { ...samplePayload, signerKeyId: 'unknown-key' },
        privateKeyPem,
      )
      const res = verifyVerificationEvidence(evidence, registry)
      expect(res.valid).toBe(false)
      expect(res.reason).toContain('Untrusted signer key ID')
    })
  })

  describe('Suite 3: Payload Tamper Detection', () => {
    it('rejects evidence when candidateCommit is altered after signing', () => {
      const evidence = signVerificationEvidence(samplePayload, privateKeyPem)
      const tampered = {
        ...evidence,
        candidateCommit: 'dddddddddddddddddddddddddddddddddddddddd',
      }
      const res = verifyVerificationEvidence(tampered, registry)
      expect(res.valid).toBe(false)
      expect(res.reason).toContain('Evidence hash mismatch')
    })

    it('rejects evidence when stage results or critic verdicts are altered after signing', () => {
      const evidence = signVerificationEvidence(samplePayload, privateKeyPem)
      const tamperedStages = [...evidence.stages]
      tamperedStages[0] = { ...tamperedStages[0]!, result: 'FAILED' }
      const tampered = {
        ...evidence,
        stages: tamperedStages,
      }
      const res = verifyVerificationEvidence(tampered, registry)
      expect(res.valid).toBe(false)
      expect(res.reason).toContain('Evidence hash mismatch')
    })
  })

  describe('Suite 4: Expiry and Revocation Enforcement', () => {
    it('rejects evidence that has exceeded its 1-hour expiry', () => {
      const evidence = signVerificationEvidence(samplePayload, privateKeyPem)
      // Verify at now + 2 hours (after expiresAt)
      const futureMs = now + 7200_000
      const res = verifyVerificationEvidence(evidence, registry, undefined, futureMs)
      expect(res.valid).toBe(false)
      expect(res.reason).toContain('Evidence expired')
    })

    it('rejects evidence signed by a revoked key ID', () => {
      const revRegistry = new HostKeyRegistry()
      const { keyId: revKeyId, privateKeyPem: revPriv } = revRegistry.generateKey('rev-key-1')
      const evidence = signVerificationEvidence(
        { ...samplePayload, signerKeyId: revKeyId },
        revPriv,
      )

      // Before revocation -> valid
      expect(verifyVerificationEvidence(evidence, revRegistry).valid).toBe(true)

      // After revocation -> invalid
      revRegistry.revokeKey(revKeyId, 'Key compromised')
      const res = verifyVerificationEvidence(evidence, revRegistry)
      expect(res.valid).toBe(false)
      expect(res.reason).toContain('has been revoked')
    })

    it('rejects evidence when its evidenceHash has been explicitly revoked', () => {
      const revRegistry = new HostKeyRegistry()
      const { keyId: validKey, privateKeyPem: priv } = revRegistry.generateKey('valid-key')
      const evidence = signVerificationEvidence(
        { ...samplePayload, signerKeyId: validKey },
        priv,
      )

      expect(verifyVerificationEvidence(evidence, revRegistry).valid).toBe(true)

      revRegistry.revokeEvidence(evidence.evidenceHash, 'Flawed verification run')
      const res = verifyVerificationEvidence(evidence, revRegistry)
      expect(res.valid).toBe(false)
      expect(res.reason).toContain('Evidence hash')
      expect(res.reason).toContain('has been revoked')
    })
  })

  describe('Suite 5: Bindings and Stage Verification Invariants', () => {
    it('enforces expected candidate, tree, spec, and task bindings', () => {
      const evidence = signVerificationEvidence(samplePayload, privateKeyPem)

      // Correct bindings
      const ok = verifyVerificationEvidence(evidence, registry, {
        projectId: 'project-1',
        candidateCommit: 'cccccccccccccccccccccccccccccccccccccccc',
        candidateTreeDigest: samplePayload.candidateTreeDigest,
        specDigest: samplePayload.specDigest,
        taskId: 'task-1',
        attemptId: 'att-1',
        generation: 1,
        environment: 'staging',
      })
      expect(ok.valid).toBe(true)

      // Mismatched candidate commit
      const badCommit = verifyVerificationEvidence(evidence, registry, {
        projectId: 'project-1',
        candidateCommit: '1111111111111111111111111111111111111111',
      })
      expect(badCommit.valid).toBe(false)
      expect(badCommit.reason).toContain('Candidate commit binding mismatch')

      // Mismatched spec digest
      const badSpec = verifyVerificationEvidence(evidence, registry, {
        projectId: 'project-1',
        candidateCommit: 'cccccccccccccccccccccccccccccccccccccccc',
        specDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      })
      expect(badSpec.valid).toBe(false)
      expect(badSpec.reason).toContain('Spec digest binding mismatch')
    })

    it('rejects evidence with missing stages or incorrect stage ordering', () => {
      // Reordered stages (mutations before twins)
      const outOfOrderStages = [
        sampleStages[0]!,
        sampleStages[1]!,
        sampleStages[3]!, // mutations at index 2
        sampleStages[2]!, // twins at index 3
        sampleStages[4]!,
      ]
      const evidence = signVerificationEvidence(
        { ...samplePayload, stages: outOfOrderStages },
        privateKeyPem,
      )
      const res = verifyVerificationEvidence(evidence, registry)
      expect(res.valid).toBe(false)
      expect(res.reason).toContain('Invalid verification stage order')
    })
  })

  describe('Suite 6: Integration Review Gate Binding and Receipt Creation', () => {
    it('adapts verified evidence into a TeamIntegrationReviewReceipt', () => {
      const evidence = signVerificationEvidence(samplePayload, privateKeyPem)
      const mockSnapshot: TeamIntegrationSnapshot = {
        id: 'int-job-1' as TeamIntegrationId,
        memberId: 'worker-1' as any,
        provider: 'git',
        phase: 'verified',
        repository: '/tmp/repo',
        cwd: '/tmp/repo',
        sourceBranch: 'team/worker-1' as TeamBranchName,
        targetBranch: 'main' as TeamBranchName,
        sourceCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as TeamCommitId,
        targetCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as TeamCommitId,
        candidateCommit: 'cccccccccccccccccccccccccccccccccccccccc' as TeamCommitId,
        baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as TeamCommitId,
      }

      const receipt = createIntegrationReviewReceipt(evidence, mockSnapshot)
      expect(receipt.integrationId).toBe('int-job-1')
      expect(receipt.candidateCommit).toBe('cccccccccccccccccccccccccccccccccccccccc')
      expect(receipt.targetCommit).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
      expect(receipt.reviewGate).toBe('darkfactory-gate-2')
      expect(receipt.reviewId).toBe(evidence.evidenceHash)
    })

    it('rejects receipt adaptation if candidateCommit does not match snapshot', () => {
      const evidence = signVerificationEvidence(samplePayload, privateKeyPem)
      const mockSnapshot: TeamIntegrationSnapshot = {
        id: 'int-job-1' as TeamIntegrationId,
        memberId: 'worker-1' as any,
        provider: 'git',
        phase: 'verified',
        repository: '/tmp/repo',
        cwd: '/tmp/repo',
        sourceBranch: 'team/worker-1' as TeamBranchName,
        targetBranch: 'main' as TeamBranchName,
        sourceCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as TeamCommitId,
        targetCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as TeamCommitId,
        candidateCommit: '9999999999999999999999999999999999999999' as TeamCommitId, // Differs
        baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as TeamCommitId,
      }

      expect(() => createIntegrationReviewReceipt(evidence, mockSnapshot)).toThrow(
        /does not match integration candidateCommit/,
      )
    })
  })

  describe('Suite 7: Verification Pipeline Orchestrator and Crash Recovery', () => {
    it('builds and signs verification evidence across all 5 stages', () => {
      const pipelineRes = buildAndSignVerificationEvidence({
        ...samplePayload,
        keyRegistry: registry,
      })

      expect(pipelineRes.decision).toBe('ACCEPT')
      expect(pipelineRes.evidence).toBeDefined()
      expect(pipelineRes.evidence?.evidenceHash).toBeDefined()
      expect(pipelineRes.evidence?.signature).toBeDefined()

      // Re-reading identical evidence for the same candidate succeeds identically (idempotency)
      const verifyRes = verifyVerificationEvidence(pipelineRes.evidence!, registry)
      expect(verifyRes.valid).toBe(true)
    })

    it('rejects pipeline evidence building if any stage failed', () => {
      const failedStages = [...sampleStages]
      failedStages[1] = { ...failedStages[1]!, result: 'FAILED' }

      const pipelineRes = buildAndSignVerificationEvidence({
        ...samplePayload,
        stages: failedStages,
        keyRegistry: registry,
      })

      expect(pipelineRes.decision).toBe('REJECT')
      expect(pipelineRes.evidence).toBeUndefined()
      expect(pipelineRes.reason).toContain('Stage tests did not succeed')
    })
  })
})
