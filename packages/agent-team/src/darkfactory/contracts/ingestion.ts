import z from 'zod'
import { artifactRefSchema, counterSchema, digestSchema, httpsUrlSchema, idSchema, recordFields, repositorySchema, revisionSchema, sourceRefSchema, textSchema, timestampSchema, uniqueIds } from './common.ts'
import { canonicalJson } from '../json.ts'
import { assertContractSemantics } from './semantics.ts'

const envelopeFields = {
  ...recordFields, source: z.enum(['github', 'sentry', 'apm', 'maintenance']), adapterVersion: idSchema,
  routeId: idSchema, deliveryId: idSchema, eventKind: idSchema, action: idSchema,
  bodyDigest: digestSchema, receivedAt: timestampSchema, providerAt: timestampSchema.optional(),
  artifact: artifactRefSchema,
}
export const scannerIdSchema = idSchema.regex(/^host-scanner:[A-Za-z0-9]/)
export const providerReadSchema = z.strictObject({
  scannerId: scannerIdSchema, ruleId: idSchema, requestReceiptId: idSchema, responseDigest: digestSchema, observedAt: timestampSchema,
})
export const legacyInboundEnvelopeSchema = z.strictObject({ ...envelopeFields, signingKeyId: idSchema, authentication: z.enum(['verified', 'host-scanner']) })
export const providerApiEnvelopeSchema = z.strictObject({ ...envelopeFields, source: z.literal('github'), authentication: z.literal('provider-api'), providerRead: providerReadSchema })
export const inboundEnvelopeSchema = z.discriminatedUnion('authentication', [legacyInboundEnvelopeSchema, providerApiEnvelopeSchema])
export const scannerInitiatorSchema = z.strictObject({ kind: z.literal('host-scanner'), scannerId: scannerIdSchema, ruleId: idSchema })
export const trustDecisionSchema = z.strictObject({
  decision: z.enum(['trusted', 'unresolved', 'denied', 'revoked']), reasons: uniqueIds(32),
  checkedAt: timestampSchema, entityRevision: digestSchema, authorityRevision: revisionSchema,
})
export const inboundWorkItemSchema = z.strictObject({
  ...recordFields, ...sourceRefSchema.shape, repository: repositorySchema,
  author: idSchema, actor: idSchema, initiator: scannerInitiatorSchema.optional(), title: z.string().min(1).max(1024), context: textSchema,
  labels: uniqueIds(64), sourceUrl: httpsUrlSchema, provenance: z.array(artifactRefSchema).min(1).max(64),
  trust: trustDecisionSchema, state: z.enum(['received', 'trusted', 'compiled', 'admitted', 'acknowledged', 'quarantined']),
  revision: revisionSchema, quarantineReason: idSchema.optional(), healthEscalationId: idSchema.optional(),
})
export const ingestionTransitions = {
  received: ['trusted', 'quarantined'], trusted: ['compiled', 'quarantined'],
  compiled: ['admitted', 'quarantined'], admitted: ['acknowledged', 'quarantined'],
  acknowledged: [], quarantined: [],
} as const
export function assertIngestionTransition(from: InboundWorkItemV1, to: InboundWorkItemV1): void {
  inboundWorkItemSchema.parse(from)
  inboundWorkItemSchema.parse(to)
  if (from.id !== to.id || from.projectId !== to.projectId || from.policyRevision !== to.policyRevision ||
    from.sourceRevision !== to.sourceRevision || from.sourceEntityId !== to.sourceEntityId || from.envelopeId !== to.envelopeId ||
    from.source !== to.source || to.revision !== from.revision + 1) throw new Error('Stale or mismatched ingress transition')
  if (!(ingestionTransitions[from.state] as readonly string[]).includes(to.state)) throw new Error('Illegal ingress lifecycle transition')
  if (to.state === 'quarantined' && (!to.quarantineReason || !to.healthEscalationId)) throw new Error('Quarantine requires a reason and health inbox reference')
  for (const key of ['repository', 'author', 'actor', 'title', 'context', 'labels', 'sourceUrl', 'provenance'] as const) {
    if (canonicalJson(from[key]) !== canonicalJson(to[key])) throw new Error('Ingress source payload is immutable')
  }
  if (canonicalJson(from.initiator ?? null) !== canonicalJson(to.initiator ?? null)) throw new Error('Ingress initiator is immutable')
  assertContractSemantics('InboundWorkItemV1', from)
  assertContractSemantics('InboundWorkItemV1', to)
}
export const ingressReceiptSchema = z.strictObject({
  ...recordFields, envelopeId: idSchema, bodyDigest: digestSchema, receivedAt: timestampSchema,
  duplicateCount: counterSchema, decision: z.enum(['received', 'quarantined']),
})
export type InboundEnvelopeV1 = z.output<typeof inboundEnvelopeSchema>
export type ProviderApiEnvelopeV1 = z.output<typeof providerApiEnvelopeSchema>
type WithoutArtifact<T> = T extends unknown ? Omit<T, 'artifact'> : never
export type InboundEnvelopeWithoutArtifact = WithoutArtifact<InboundEnvelopeV1>
export type InboundWorkItemV1 = z.output<typeof inboundWorkItemSchema>

/** Transport provenance is immutable and cannot impersonate a provider webhook actor. */
export function assertIngressOrigin(item: InboundWorkItemV1, envelope: InboundEnvelopeV1): void {
  if (envelope.authentication === 'provider-api') {
    if (item.source !== 'github' || item.initiator?.kind !== 'host-scanner' || item.actor !== envelope.providerRead.scannerId ||
      item.initiator.scannerId !== envelope.providerRead.scannerId || item.initiator.ruleId !== envelope.providerRead.ruleId) throw new Error('Provider-read item initiator does not match custody')
  } else if (item.initiator) throw new Error('Scanner initiator requires provider-read custody')
}

export type IngressReceiptV1 = z.output<typeof ingressReceiptSchema>
