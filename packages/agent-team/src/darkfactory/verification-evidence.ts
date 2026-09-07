/**
 * Machine-Only Verification Pipeline Orchestrator (DF-10)
 *
 * Orchestrates the full Dark Factory Gate 2 pipeline:
 * 1. Scope and AST Path Guard (DF-07)
 * 2. Clean Test Execution
 * 3. Digital Twins (DF-09)
 * 4. Mutation Policy and Isolated Execution (DF-08)
 * 5. Dual Independent Critics (DF-09)
 * 6. Canonical RFC 8785 Ed25519 Evidence Signing (DF-10)
 */

import { digestJson } from './json.ts'
import {
  signVerificationEvidence,
  type HostKeyRegistry,
} from './verification-signer.ts'
import type {
  VerificationEvidenceV1,
  StageResultV1,
  CriticOutcomeV1,
} from './contracts/verification.ts'
import type { ArtifactRef } from './contracts/common.ts'

export interface DarkFactoryPipelineOptions {
  projectId: string
  policyRevision?: number
  taskId: string
  workflowId: string
  attemptId: string
  generation: number
  environment?: string
  executionMode?: 'deploying' | 'non-deploying-qualification'
  sourceCommit: string
  targetCommit: string
  candidateCommit: string
  candidateTreeDigest: `sha256:${string}`
  specDigest: `sha256:${string}`
  policyDigest: `sha256:${string}`
  toolchainDigest: `sha256:${string}`
  stages: StageResultV1[]
  critics: CriticOutcomeV1[]
  signerKeyId: string
  keyRegistry: HostKeyRegistry
  batchMembers?: Array<{
    taskId: string
    attemptId: string
    generation: number
    specDigest: `sha256:${string}`
    sourceCommit: string
  }>
  diversityDeficit?: {
    reasonCode: 'NO_ELIGIBLE_HEALTHY_DIVERSE_MODEL'
    catalogRevision: number
    catalogDigest: `sha256:${string}`
    eligibilityEvidence: ArtifactRef[]
  }
}

export interface DarkFactoryPipelineResult {
  decision: 'ACCEPT' | 'REJECT' | 'INCONCLUSIVE'
  evidence?: VerificationEvidenceV1 | undefined
  reason?: string | undefined
}

/**
 * Package and sign verification evidence if all 5 Gate 2 stages are satisfied.
 */
export function buildAndSignVerificationEvidence(
  options: DarkFactoryPipelineOptions,
  nowMs = Date.now(),
): DarkFactoryPipelineResult {
  const {
    projectId,
    policyRevision = 1,
    taskId,
    workflowId,
    attemptId,
    generation,
    environment = 'staging',
    executionMode = 'deploying',
    sourceCommit,
    targetCommit,
    candidateCommit,
    candidateTreeDigest,
    specDigest,
    policyDigest,
    toolchainDigest,
    stages,
    critics,
    signerKeyId,
    keyRegistry,
    batchMembers = [],
    diversityDeficit,
  } = options

  // Validate stages presence and order
  const EXPECTED_STAGE_ORDER = ['architecture', 'tests', 'twins', 'mutations', 'critics'] as const
  if (stages.length !== 5) {
    return {
      decision: 'REJECT',
      reason: `Gate 2 requires exactly 5 stages, received ${stages.length}`,
    }
  }

  for (let i = 0; i < 5; i++) {
    const expected = EXPECTED_STAGE_ORDER[i]!
    const actual = stages[i]!
    if (actual.stage !== expected) {
      return {
        decision: 'REJECT',
        reason: `Stage order violation at index ${i}: expected ${expected}, got ${actual.stage}`,
      }
    }
    if (
      actual.result !== 'PASSED' &&
      !(
        (actual.stage === 'twins' || actual.stage === 'mutations') &&
        actual.result === 'NOT_APPLICABLE'
      )
    ) {
      return {
        decision: 'REJECT',
        reason: `Stage ${actual.stage} did not succeed (result: ${actual.result})`,
      }
    }
  }

  // Check critics: 2 critics required, both ACCEPT, confidence >= 0.8, no HIGH/CRITICAL defects
  if (critics.length !== 2) {
    return {
      decision: 'REJECT',
      reason: `Gate 2 requires exactly 2 independent critic evaluations, received ${critics.length}`,
    }
  }

  const [c1, c2] = critics as [CriticOutcomeV1, CriticOutcomeV1]
  if (c1.verdict !== 'ACCEPT' || c2.verdict !== 'ACCEPT') {
    return {
      decision: 'REJECT',
      reason: `Critic verdicts not all ACCEPT (Critic 1: ${c1.verdict}, Critic 2: ${c2.verdict})`,
    }
  }

  if (c1.confidence < 0.8 || c2.confidence < 0.8) {
    return {
      decision: 'REJECT',
      reason: `Critic confidence below 0.8 threshold (Critic 1: ${c1.confidence}, Critic 2: ${c2.confidence})`,
    }
  }

  const c1HasHigh = c1.defects.some((d) => d.severity === 'HIGH' || d.severity === 'CRITICAL')
  const c2HasHigh = c2.defects.some((d) => d.severity === 'HIGH' || d.severity === 'CRITICAL')
  if (c1HasHigh || c2HasHigh) {
    return {
      decision: 'REJECT',
      reason: 'Critics reported HIGH or CRITICAL defects on candidate',
    }
  }

  // Lookup host private key
  const privateKeyPem = keyRegistry.getPrivateKey(signerKeyId)
  if (!privateKeyPem) {
    return {
      decision: 'INCONCLUSIVE',
      reason: `Host signer key ${signerKeyId} private key unavailable outside worker sandbox`,
    }
  }

  const createdAt = new Date(nowMs).toISOString()
  const expiresAt = new Date(nowMs + 3600_000).toISOString() // 1 hour expiry

  const payload = {
    schemaVersion: 1 as const,
    id: `evidence-${attemptId}`,
    projectId,
    policyRevision,
    taskId,
    workflowId,
    attemptId,
    generation,
    environment,
    executionMode,
    sourceCommit,
    targetCommit,
    candidateCommit,
    candidateTreeDigest,
    specDigest,
    policyDigest,
    toolchainDigest,
    stages,
    critics,
    createdAt,
    expiresAt,
    decision: 'ACCEPT' as const,
    signerKeyId,
    batchMembers,
    ...(diversityDeficit ? { diversityDeficit } : {}),
  }

  const evidence = signVerificationEvidence(payload, privateKeyPem)

  return {
    decision: 'ACCEPT',
    evidence,
  }
}
