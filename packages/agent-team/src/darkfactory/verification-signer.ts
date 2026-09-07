/**
 * Signed Verification Evidence and Integration Review Gate (DF-10)
 *
 * RFC 8785 JSON Canonicalization Scheme (JCS), SHA-256 evidence hashing,
 * host-isolated Ed25519 cryptographic signing outside worker reach,
 * trusted key registry, revocation, 1-hour expiry, and review gate binding.
 */

import {
  generateKeyPairSync,
  sign,
  verify,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from 'node:crypto'
import { digestJson, canonicalJson } from './json.ts'
import {
  verificationEvidencePayloadSchema,
  verificationEvidenceSchema,
  type VerificationEvidenceV1,
} from './contracts/verification.ts'
import type { TeamIntegrationReviewReceipt, TeamIntegrationSnapshot } from '../types.ts'

export const VERIFICATION_EVIDENCE_DOMAIN = 'gasteam/verification-evidence/v1'

export interface KeyPairRecord {
  keyId: string
  publicKeyPem: string
  privateKeyPem?: string | undefined
  createdAt: string
  revokedAt?: string | undefined
  revocationReason?: string | undefined
}

export interface ExpectedEvidenceBindings {
  projectId: string
  candidateCommit: string
  candidateTreeDigest?: string | undefined
  specDigest?: string | undefined
  taskId?: string | undefined
  attemptId?: string | undefined
  generation?: number | undefined
  environment?: string | undefined
}

export interface EvidenceVerificationResult {
  valid: boolean
  decision: 'ACCEPT' | 'REJECT' | 'INCONCLUSIVE'
  evidenceHash: `sha256:${string}` | string
  reason?: string | undefined
}

/**
 * Host-isolated Ed25519 Key Registry.
 * Lives outside worker sandboxes. Stores trusted public keys and revoked keys/evidence hashes.
 */
export class HostKeyRegistry {
  private readonly keys = new Map<string, KeyPairRecord>()
  private readonly revokedEvidenceHashes = new Map<string, { revokedAt: string; reason: string }>()

  /**
   * Generate a new host Ed25519 keypair and register it.
   */
  generateKey(keyId: string): { keyId: string; publicKeyPem: string; privateKeyPem: string } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

    const record: KeyPairRecord = {
      keyId,
      publicKeyPem,
      privateKeyPem,
      createdAt: new Date().toISOString(),
    }
    this.keys.set(keyId, record)
    return { keyId, publicKeyPem, privateKeyPem }
  }

  /**
   * Register an existing public (or public+private) key.
   */
  registerKey(keyId: string, publicKeyPem: string, privateKeyPem?: string): void {
    this.keys.set(keyId, {
      keyId,
      publicKeyPem,
      privateKeyPem,
      createdAt: new Date().toISOString(),
    })
  }

  /**
   * Revoke a signing key by ID.
   */
  revokeKey(keyId: string, reason = 'Key revoked'): void {
    const rec = this.keys.get(keyId)
    if (rec) {
      rec.revokedAt = new Date().toISOString()
      rec.revocationReason = reason
    }
  }

  /**
   * Check if a key is revoked.
   */
  isKeyRevoked(keyId: string): boolean {
    const rec = this.keys.get(keyId)
    return rec?.revokedAt !== undefined
  }

  /**
   * Revoke a specific verification evidence hash.
   */
  revokeEvidence(evidenceHash: string, reason = 'Evidence revoked'): void {
    this.revokedEvidenceHashes.set(evidenceHash, {
      revokedAt: new Date().toISOString(),
      reason,
    })
  }

  /**
   * Check if an evidence hash is revoked.
   */
  isEvidenceRevoked(evidenceHash: string): boolean {
    return this.revokedEvidenceHashes.has(evidenceHash)
  }

  /**
   * Retrieve public key PEM for a given key ID.
   */
  getPublicKey(keyId: string): string | undefined {
    return this.keys.get(keyId)?.publicKeyPem
  }

  /**
   * Retrieve private key PEM for host signing.
   */
  getPrivateKey(keyId: string): string | undefined {
    return this.keys.get(keyId)?.privateKeyPem
  }
}

/**
 * Sign an unsigned verification evidence payload using RFC 8785 JCS and Ed25519.
 *
 * Steps:
 * 1. Validate payload against verificationEvidencePayloadSchema.
 * 2. Compute canonical SHA-256 digest over JCS UTF-8 bytes.
 * 3. Sign domain-separated message `${VERIFICATION_EVIDENCE_DOMAIN}\n${evidenceHash}` with Ed25519.
 * 4. Construct complete signed evidence and validate against verificationEvidenceSchema.
 */
export function signVerificationEvidence(
  payload: unknown,
  privateKeyInput: KeyObject | string,
): VerificationEvidenceV1 {
  // 1. Validate payload
  const validatedPayload = verificationEvidencePayloadSchema.parse(payload)

  // 2. Canonicalize using RFC 8785 and compute SHA-256 hash
  const canonicalBytes = canonicalJson(validatedPayload)
  const evidenceHash = digestJson(validatedPayload)

  // 3. Domain separation
  const messageBytes = Buffer.from(`${VERIFICATION_EVIDENCE_DOMAIN}\n${evidenceHash}`, 'utf8')

  const privateKey = typeof privateKeyInput === 'string'
    ? createPrivateKey(privateKeyInput)
    : privateKeyInput

  const signatureBytes = sign(null, messageBytes, privateKey)
  const signature = signatureBytes.toString('base64')

  // 4. Construct complete evidence
  const signed = {
    ...validatedPayload,
    evidenceHash,
    signature,
  }

  return verificationEvidenceSchema.parse(signed)
}

/**
 * Verify a signed verification evidence record at the integration review gate.
 *
 * Invariants checked:
 * 1. Structural schema validation.
 * 2. Recomputed RFC 8785 canonical hash matches evidenceHash.
 * 3. Cryptographic Ed25519 signature validity against host trusted public key.
 * 4. Key revocation and evidence hash revocation checks.
 * 5. Expiry check (evidence expires after 1 hour default).
 * 6. Binding check (candidate commit, tree digest, spec, task, attempt, generation, environment).
 * 7. Verification stage completeness (all 5 stages in order: architecture, tests, twins, mutations, critics).
 * 8. All stages PASSED (or NOT_APPLICABLE for twins/mutations).
 */
export function verifyVerificationEvidence(
  evidenceInput: unknown,
  keyRegistry: HostKeyRegistry,
  expectedBindings?: ExpectedEvidenceBindings,
  nowMs: number = Date.now(),
): EvidenceVerificationResult {
  // 1. Schema check
  const parsed = verificationEvidenceSchema.safeParse(evidenceInput)
  if (!parsed.success) {
    return {
      valid: false,
      decision: 'REJECT',
      evidenceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      reason: `Schema validation error: ${parsed.error.message}`,
    }
  }

  const evidence = parsed.data
  const { evidenceHash, signature, ...payload } = evidence

  // 2. Recompute canonical digest
  const recomputedHash = digestJson(payload)
  if (recomputedHash !== evidenceHash) {
    return {
      valid: false,
      decision: 'REJECT',
      evidenceHash,
      reason: `Evidence hash mismatch: recomputed ${recomputedHash} !== declared ${evidenceHash}`,
    }
  }

  // 3. Trusted Key Lookup
  const publicKeyPem = keyRegistry.getPublicKey(evidence.signerKeyId)
  if (!publicKeyPem) {
    return {
      valid: false,
      decision: 'REJECT',
      evidenceHash,
      reason: `Untrusted signer key ID: ${evidence.signerKeyId} not found in host registry`,
    }
  }

  // 4. Revocation Checks
  if (keyRegistry.isKeyRevoked(evidence.signerKeyId)) {
    return {
      valid: false,
      decision: 'REJECT',
      evidenceHash,
      reason: `Signer key ${evidence.signerKeyId} has been revoked`,
    }
  }

  if (keyRegistry.isEvidenceRevoked(evidenceHash)) {
    return {
      valid: false,
      decision: 'REJECT',
      evidenceHash,
      reason: `Evidence hash ${evidenceHash} has been revoked`,
    }
  }

  // 5. Signature Verification
  try {
    const publicKey = createPublicKey(publicKeyPem)
    const messageBytes = Buffer.from(`${VERIFICATION_EVIDENCE_DOMAIN}\n${evidenceHash}`, 'utf8')
    const sigBytes = Buffer.from(signature, 'base64')
    const sigValid = verify(null, messageBytes, publicKey, sigBytes)
    if (!sigValid) {
      return {
        valid: false,
        decision: 'REJECT',
        evidenceHash,
        reason: 'Cryptographic Ed25519 signature verification failed',
      }
    }
  } catch (err) {
    return {
      valid: false,
      decision: 'REJECT',
      evidenceHash,
      reason: `Signature verification error: ${String(err)}`,
    }
  }

  // 6. Expiry Check
  const expiresAtMs = Date.parse(evidence.expiresAt)
  if (nowMs > expiresAtMs) {
    return {
      valid: false,
      decision: 'REJECT',
      evidenceHash,
      reason: `Evidence expired at ${evidence.expiresAt} (current time: ${new Date(nowMs).toISOString()})`,
    }
  }

  // 7. Binding Checks
  if (expectedBindings) {
    if (evidence.projectId !== expectedBindings.projectId) {
      return {
        valid: false,
        decision: 'REJECT',
        evidenceHash,
        reason: `Project ID binding mismatch: ${evidence.projectId} !== ${expectedBindings.projectId}`,
      }
    }
    if (evidence.candidateCommit !== expectedBindings.candidateCommit) {
      return {
        valid: false,
        decision: 'REJECT',
        evidenceHash,
        reason: `Candidate commit binding mismatch: ${evidence.candidateCommit} !== ${expectedBindings.candidateCommit}`,
      }
    }
    if (
      expectedBindings.candidateTreeDigest &&
      evidence.candidateTreeDigest !== expectedBindings.candidateTreeDigest
    ) {
      return {
        valid: false,
        decision: 'REJECT',
        evidenceHash,
        reason: `Candidate tree digest binding mismatch: ${evidence.candidateTreeDigest} !== ${expectedBindings.candidateTreeDigest}`,
      }
    }
    if (expectedBindings.specDigest && evidence.specDigest !== expectedBindings.specDigest) {
      return {
        valid: false,
        decision: 'REJECT',
        evidenceHash,
        reason: `Spec digest binding mismatch: ${evidence.specDigest} !== ${expectedBindings.specDigest}`,
      }
    }
    if (expectedBindings.taskId && evidence.taskId !== expectedBindings.taskId) {
      return {
        valid: false,
        decision: 'REJECT',
        evidenceHash,
        reason: `Task ID binding mismatch: ${evidence.taskId} !== ${expectedBindings.taskId}`,
      }
    }
    if (expectedBindings.attemptId && evidence.attemptId !== expectedBindings.attemptId) {
      return {
        valid: false,
        decision: 'REJECT',
        evidenceHash,
        reason: `Attempt ID binding mismatch: ${evidence.attemptId} !== ${expectedBindings.attemptId}`,
      }
    }
    if (expectedBindings.generation !== undefined && evidence.generation !== expectedBindings.generation) {
      return {
        valid: false,
        decision: 'REJECT',
        evidenceHash,
        reason: `Generation binding mismatch: ${evidence.generation} !== ${expectedBindings.generation}`,
      }
    }
    if (expectedBindings.environment && evidence.environment !== expectedBindings.environment) {
      return {
        valid: false,
        decision: 'REJECT',
        evidenceHash,
        reason: `Environment binding mismatch: ${evidence.environment} !== ${expectedBindings.environment}`,
      }
    }
  }

  // 8. Stage Order & Result Enforcement
  const EXPECTED_STAGES = ['architecture', 'tests', 'twins', 'mutations', 'critics'] as const
  if (evidence.stages.length !== 5) {
    return {
      valid: false,
      decision: 'REJECT',
      evidenceHash,
      reason: `Evidence must contain exactly 5 stages, found ${evidence.stages.length}`,
    }
  }

  for (let i = 0; i < 5; i++) {
    const expectedStage = EXPECTED_STAGES[i]!
    const actualStage = evidence.stages[i]!

    if (actualStage.stage !== expectedStage) {
      return {
        valid: false,
        decision: 'REJECT',
        evidenceHash,
        reason: `Invalid verification stage order at index ${i}: expected ${expectedStage}, got ${actualStage.stage}`,
      }
    }

    if (
      actualStage.result !== 'PASSED' &&
      !(
        (actualStage.stage === 'twins' || actualStage.stage === 'mutations') &&
        actualStage.result === 'NOT_APPLICABLE'
      )
    ) {
      return {
        valid: false,
        decision: 'REJECT',
        evidenceHash,
        reason: `Stage ${actualStage.stage} did not pass (result: ${actualStage.result})`,
      }
    }
  }

  // 9. Overall decision
  if (evidence.decision !== 'ACCEPT') {
    return {
      valid: false,
      decision: evidence.decision,
      evidenceHash,
      reason: `Overall evidence decision is ${evidence.decision}, expected ACCEPT`,
    }
  }

  return {
    valid: true,
    decision: 'ACCEPT',
    evidenceHash,
  }
}

/**
 * Adapt verified evidence into a TeamIntegrationReviewReceipt for the TeamIntegrations review gate.
 */
export function createIntegrationReviewReceipt(
  evidence: VerificationEvidenceV1,
  snapshot: TeamIntegrationSnapshot,
): TeamIntegrationReviewReceipt {
  if (evidence.candidateCommit !== snapshot.candidateCommit) {
    throw new Error(
      `Evidence candidateCommit (${evidence.candidateCommit}) does not match integration candidateCommit (${snapshot.candidateCommit})`,
    )
  }
  if (evidence.targetCommit !== snapshot.targetCommit) {
    throw new Error(
      `Evidence targetCommit (${evidence.targetCommit}) does not match integration targetCommit (${snapshot.targetCommit})`,
    )
  }

  return {
    integrationId: snapshot.id,
    sourceCommit: evidence.sourceCommit as TeamIntegrationReviewReceipt['sourceCommit'],
    targetCommit: evidence.targetCommit as TeamIntegrationReviewReceipt['targetCommit'],
    candidateCommit: evidence.candidateCommit as TeamIntegrationReviewReceipt['candidateCommit'],
    reviewGate: 'darkfactory-gate-2',
    reviewId: evidence.evidenceHash,
  }
}
