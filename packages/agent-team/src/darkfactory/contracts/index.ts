import z from 'zod'
import { inboundEnvelopeSchema, inboundWorkItemSchema, ingressReceiptSchema } from './ingestion.ts'
import { executableSpecSchema, compilerOutcomeSchema, admissionReceiptSchema } from './spec.ts'
import { criticOutcomeSchema, verificationEvidenceSchema, mutantManifestSchema } from './verification.ts'
import { deploymentRequestSchema, deploymentStatusSchema, deploymentCallbackSchema, telemetryVerdictSchema, releaseRecordSchema } from './release.ts'
import { pricingSnapshotSchema, reservationSchema, usageEventSchema, providerQuotaSchema, modelRoleAssignmentSchema } from './economics.ts'
import { operationalEventSchema } from './operations.ts'
import { assertContractSemantics, type ContractArguments } from './semantics.ts'
export * from './common.ts'
export * from './ingestion.ts'
export * from './spec.ts'
export * from './verification.ts'
export * from './release.ts'
export * from './economics.ts'
export * from './operations.ts'
export * from './semantics.ts'

/** Public shape contracts. State owners additionally enforce references, revisions and authority. */
export const contracts = {
  InboundEnvelopeV1: inboundEnvelopeSchema, InboundWorkItemV1: inboundWorkItemSchema, IngressReceiptV1: ingressReceiptSchema,
  ExecutableSpecV1: executableSpecSchema, CompilerOutcomeV1: compilerOutcomeSchema, AdmissionReceiptV1: admissionReceiptSchema,
  CriticOutcomeV1: criticOutcomeSchema, VerificationEvidenceV1: verificationEvidenceSchema, MutantManifestV1: mutantManifestSchema,
  DeploymentRequestV1: deploymentRequestSchema, DeploymentStatusV1: deploymentStatusSchema, DeploymentCallbackV1: deploymentCallbackSchema,
  TelemetryVerdictV1: telemetryVerdictSchema, ReleaseRecordV1: releaseRecordSchema, PricingSnapshotV1: pricingSnapshotSchema,
  ReservationV1: reservationSchema, UsageEventV1: usageEventSchema, ProviderQuotaV1: providerQuotaSchema, ModelRoleAssignmentV1: modelRoleAssignmentSchema,
  OperationalEventV1: operationalEventSchema,
} as const
/** Validates record-local invariants, not signatures, registration, or live authority. */
export function validateContract<K extends keyof typeof contracts>(name: K, raw: unknown): z.output<(typeof contracts)[K]> {
  const record = contracts[name].parse(raw)
  assertContractSemantics(...[name, record] as ContractArguments)
  return record as z.output<(typeof contracts)[K]>
}
export function contractJsonSchemas(): Record<string, z.core.JSONSchema.JSONSchema> {
  return Object.fromEntries(Object.entries(contracts).map(([name, schema]) => [name, z.toJSONSchema(schema as z.ZodType, { target: 'draft-2020-12' })]))
}

