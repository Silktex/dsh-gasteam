import z from 'zod'
import { artifactRefSchema, commitSchema, counterSchema, digestSchema, idSchema, recordFields, revisionSchema, safePathSchema, signatureSchema, textSchema, timestampSchema, uniqueIds } from './common.ts'

export const stageResultSchema = z.strictObject({
  id: idSchema, stage: z.enum(['architecture', 'tests', 'twins', 'mutations', 'critics']),
  result: z.enum(['PASSED', 'FAILED', 'INCONCLUSIVE', 'NOT_APPLICABLE']),
  definitionRevision: revisionSchema, startedAt: timestampSchema, endedAt: timestampSchema,
  exitCondition: idSchema, artifacts: z.array(artifactRefSchema).max(256),
})
export const criticOutcomeSchema = z.strictObject({
  ...recordFields, attemptId: idSchema, modelAssignmentId: idSchema, provider: idSchema, modelVersion: idSchema,
  contextDigest: digestSchema, specDigest: digestSchema, candidateCommit: commitSchema,
  verdict: z.enum(['ACCEPT', 'REJECT', 'INSUFFICIENT_EVIDENCE']), confidence: z.number().min(0).max(1),
  coveredCriteria: uniqueIds(256), defects: z.array(z.strictObject({
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), description: textSchema,
    path: safePathSchema.optional(), line: revisionSchema.optional(), evidence: artifactRefSchema,
    reproductionSteps: z.array(textSchema).max(32),
  })).max(128), committedAt: timestampSchema,
})
export const verificationEvidencePayloadSchema = z.strictObject({
  ...recordFields, taskId: idSchema, workflowId: idSchema, attemptId: idSchema, generation: revisionSchema,
  environment: idSchema, executionMode: z.enum(['deploying', 'non-deploying-qualification']),
  diversityDeficit: z.strictObject({
    reasonCode: z.literal('NO_ELIGIBLE_HEALTHY_DIVERSE_MODEL'),
    catalogRevision: revisionSchema, catalogDigest: digestSchema,
    eligibilityEvidence: z.array(artifactRefSchema).min(1).max(32),
  }).optional(),
  sourceCommit: commitSchema, targetCommit: commitSchema, candidateCommit: commitSchema, candidateTreeDigest: digestSchema,
  specDigest: digestSchema, policyDigest: digestSchema, toolchainDigest: digestSchema,
  stages: z.array(stageResultSchema).min(1).max(5), critics: z.array(criticOutcomeSchema).max(2),
  createdAt: timestampSchema, expiresAt: timestampSchema, decision: z.enum(['ACCEPT', 'REJECT', 'INCONCLUSIVE']),
  signerKeyId: idSchema,
  batchMembers: z.array(z.strictObject({ taskId: idSchema, attemptId: idSchema, generation: revisionSchema, specDigest: digestSchema, sourceCommit: commitSchema })).max(64),
})
export const verificationEvidenceSchema = verificationEvidencePayloadSchema.extend({ evidenceHash: digestSchema, signature: signatureSchema })
export const mutantManifestSchema = z.strictObject({
  ...recordFields, attemptId: idSchema, generation: revisionSchema, candidateCommit: commitSchema,
  eligibleCount: counterSchema, selectedCount: counterSchema.max(20), selectionRevision: revisionSchema,
  baseline: z.enum(['PASSED_TWICE', 'FAILED', 'FLAKY_BASELINE']),
  mutants: z.array(z.strictObject({
    id: idSchema, path: safePathSchema, start: counterSchema, end: counterSchema, operatorId: idSchema,
    outcome: z.enum(['KILLED', 'SURVIVED', 'NO_COVERAGE', 'INVALID', 'TIMEOUT', 'INFRA_ERROR']),
    repeatedKill: z.boolean(), artifacts: z.array(artifactRefSchema).max(32),
  })).max(20),
})
export type VerificationEvidenceV1 = z.output<typeof verificationEvidenceSchema>
export type CriticOutcomeV1 = z.output<typeof criticOutcomeSchema>
export type StageResultV1 = z.output<typeof stageResultSchema>
export type MutantManifestV1 = z.output<typeof mutantManifestSchema>
