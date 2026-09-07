import z from 'zod'
import { artifactRefSchema, assertProjectArtifacts, commitSchema, digestSchema, idSchema, recordFields, revisionSchema, safePathSchema, sourceRefSchema, textSchema, uniqueIds } from './common.ts'
import { digestJson } from '../json.ts'

export const executableSpecPayloadSchema = z.strictObject({
  ...recordFields, objective: textSchema, nonGoals: z.array(textSchema).max(64),
  invariants: z.array(z.strictObject({ id: idSchema, description: textSchema, checkId: idSchema })).min(1).max(128),
  acceptanceScenarios: z.array(z.strictObject({
    id: idSchema, description: textSchema, fixtureId: idSchema, assertionIds: uniqueIds(64).min(1),
    commandId: idSchema, expected: textSchema, actual: textSchema, reproduction: artifactRefSchema,
  })).min(1).max(128),
  allowedPaths: z.array(safePathSchema).min(1).max(256), requiredCapabilities: uniqueIds(64),
  risk: z.enum(['low', 'medium', 'high', 'critical']), priority: z.number().int().min(0).max(100),
  source: sourceRefSchema, provenance: z.array(artifactRefSchema).min(1).max(64), baseCommit: commitSchema,
  compilerRevision: revisionSchema, promptRevision: revisionSchema, modelAssignmentId: idSchema,
  policyDigest: digestSchema, rulesDigest: digestSchema, toolchainDigest: digestSchema, workflowDigest: digestSchema,
})
export const executableSpecSchema = executableSpecPayloadSchema.extend({ specDigest: digestSchema })
export type ExecutableSpecV1 = z.output<typeof executableSpecSchema>
export function pinExecutableSpec(raw: unknown): ExecutableSpecV1 {
  const payload = executableSpecPayloadSchema.parse(raw)
  assertProjectArtifacts(payload.projectId, [...payload.provenance, ...payload.acceptanceScenarios.map(s => s.reproduction)])
  for (const records of [payload.invariants, payload.acceptanceScenarios]) {
    if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('Duplicate spec criterion identity')
  }
  return { ...payload, specDigest: digestJson(payload) }
}
export function verifyExecutableSpec(raw: unknown): ExecutableSpecV1 {
  const spec = executableSpecSchema.parse(raw)
  const { specDigest, ...payload } = spec
  if (pinExecutableSpec(payload).specDigest !== specDigest) throw new Error('Executable spec digest mismatch')
  return spec
}
const outcomeFields = { ...recordFields, source: sourceRefSchema, reasons: z.array(textSchema).min(1).max(32) }
export const compilerOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ ...outcomeFields, outcome: z.literal('COMPILED'), spec: executableSpecSchema }),
  z.strictObject({ ...outcomeFields, outcome: z.enum(['AMBIGUOUS', 'CONFLICTING', 'INSUFFICIENT_EVIDENCE', 'UNSUPPORTED']) }),
])
export const admissionReceiptSchema = z.strictObject({
  ...recordFields, source: sourceRefSchema, specId: idSchema, specDigest: digestSchema, policyDigest: digestSchema,
  workflowId: idSchema, workflowDigest: digestSchema, taskIds: uniqueIds(256).min(1),
  state: z.enum(['intended', 'admitted', 'acknowledged', 'quarantined']), revision: revisionSchema,
})

/** Checks pinned admission references; persisting/replaying admission remains the coordinator's job. */
export function assertAdmissionMatchesSpec(rawReceipt: unknown, rawSpec: unknown): void {
  const receipt = admissionReceiptSchema.parse(rawReceipt)
  const spec = verifyExecutableSpec(rawSpec)
  if (receipt.projectId !== spec.projectId || receipt.policyRevision !== spec.policyRevision ||
    receipt.specId !== spec.id || receipt.specDigest !== spec.specDigest ||
    receipt.policyDigest !== spec.policyDigest || receipt.workflowDigest !== spec.workflowDigest) throw new Error('Admission pinned spec mismatch')
  for (const key of ['envelopeId', 'source', 'sourceEntityId', 'sourceRevision'] as const) {
    if (receipt.source[key] !== spec.source[key]) throw new Error('Admission source revision mismatch')
  }
}

export type CompilerOutcomeV1 = z.output<typeof compilerOutcomeSchema>
export type AdmissionReceiptV1 = z.output<typeof admissionReceiptSchema>
