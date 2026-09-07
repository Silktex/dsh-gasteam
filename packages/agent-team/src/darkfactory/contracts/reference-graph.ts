/** Offline source/admission closure. Registered definitions are inputs, never proof of live authority. */
import z from 'zod'
import { artifactRefSchema, counterSchema, digestSchema, idSchema, recordFields, revisionSchema, textSchema, timestampSchema, uniqueIds } from './common.ts'
import { inboundEnvelopeSchema, inboundWorkItemSchema, ingressReceiptSchema, assertIngestionTransition, assertIngressOrigin } from './ingestion.ts'
import { admissionReceiptSchema, compilerOutcomeSchema, executableSpecSchema, assertAdmissionMatchesSpec } from './spec.ts'
import { validateContract } from './index.ts'
import { compilerHostContextSchema, SpecCompilerSession } from '../spec-compiler.ts'
import { admissionRecordSchema, planAdmission } from '../admission-store.ts'
import { enabledDarkFactoryConfigSchema } from '../config.ts'
import { canonicalJson, digestBytes, digestJson, parseStrictJson } from '../json.ts'
import { workflowTemplateSchema, validateWorkflowTemplate } from '../../workflows.ts'
import { factoryEscalationSchema } from '../../health.ts'
import { operationalEventSchema } from './operations.ts'

const MAX_RECORDS = 128, MAX_DEFINITIONS = 128, MAX_ARTIFACTS = 128
const MAX_ARTIFACT_BYTES = 1_048_576, MAX_TOTAL_ARTIFACT_BYTES = 4_194_304, MAX_BUNDLE_BYTES = 12_582_912
export const referenceGraphSupportedLanes = ['source-admission'] as const
export const referenceGraphUnsupportedLanes = ['verification-release', 'fleet-economics', 'quarantine-health'] as const
const supportedKinds = ['InboundEnvelopeV1', 'InboundWorkItemV1', 'IngressReceiptV1', 'ExecutableSpecV1', 'CompilerOutcomeV1', 'AdmissionReceiptV1'] as const
export const referenceGraphRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('InboundEnvelopeV1'), value: inboundEnvelopeSchema }),
  z.strictObject({ kind: z.literal('InboundWorkItemV1'), value: inboundWorkItemSchema }),
  z.strictObject({ kind: z.literal('IngressReceiptV1'), value: ingressReceiptSchema }),
  z.strictObject({ kind: z.literal('ExecutableSpecV1'), value: executableSpecSchema }),
  z.strictObject({ kind: z.literal('CompilerOutcomeV1'), value: compilerOutcomeSchema }),
  z.strictObject({ kind: z.literal('AdmissionReceiptV1'), value: admissionReceiptSchema }),
])
const registration = { ...recordFields, revision: revisionSchema, digest: digestSchema }
/** Every registered leaf has a full immutable payload, revision and canonical digest.
 * Model catalog/pricing blobs are externally registered snapshots, not validated economic records.
 */
export const referenceGraphDefinitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...registration, kind: z.literal('workflow'), definition: workflowTemplateSchema, definitionDigest: digestSchema, taskIds: uniqueIds().min(1) }),
  z.strictObject({ ...registration, kind: z.literal('task'), workflowId: idSchema, stepId: idSchema, subject: textSchema }),
  z.strictObject({ ...registration, kind: z.literal('attempt'), taskId: idSchema, generation: revisionSchema }),
  z.strictObject({ ...registration, kind: z.literal('model-assignment'), attemptId: idSchema, generation: revisionSchema,
    provider: idSchema, deploymentId: idSchema, modelVersion: idSchema, catalogRevision: revisionSchema, pricingRevision: revisionSchema,
    catalog: artifactRefSchema, pricing: artifactRefSchema }),
  z.strictObject({ ...registration, kind: z.literal('compiler-context'), context: compilerHostContextSchema }),
  z.strictObject({ ...registration, kind: z.literal('provider-request'), receipt: z.strictObject({ schemaVersion: z.literal(1), id: idSchema, projectId: idSchema, routeId: idSchema, at: timestampSchema }) }),
])
const bytesDescriptorSchema = z.strictObject({
  reference: artifactRefSchema,
  // Size and aggregate checks below run before the first base64 decoding allocation.
  bytesBase64: z.string().max(Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4),
})
export const referenceGraphCatalogRegistrationSchema = z.strictObject({
  schemaVersion: z.literal(1), revision: revisionSchema,
  models: z.array(z.strictObject({ provider: idSchema, deploymentId: idSchema, modelVersion: idSchema })).min(1).max(256),
})
export const referenceGraphPricingRegistrationSchema = z.strictObject({
  schemaVersion: z.literal(1), revision: revisionSchema, provider: idSchema, modelVersion: idSchema, currency: z.literal('USD'),
  inputMicrosPerMillion: counterSchema, outputMicrosPerMillion: counterSchema,
})
export const referenceGraphInputSchema = z.strictObject({
  schemaVersion: z.literal(1), lane: z.literal('source-admission'), projectId: idSchema, policyRevision: revisionSchema,
  records: z.array(referenceGraphRecordSchema).min(1).max(MAX_RECORDS),
  definitions: z.array(referenceGraphDefinitionSchema).min(1).max(MAX_DEFINITIONS),
  artifacts: z.array(bytesDescriptorSchema).min(1).max(MAX_ARTIFACTS),
  workHistories: z.array(z.strictObject({ workItemId: idSchema, versions: z.array(inboundWorkItemSchema).min(2).max(6) })).max(MAX_RECORDS).optional(),
})
export const sourceHealthContextSchema = z.strictObject({ schemaVersion: z.literal(1), admissions: z.array(admissionRecordSchema).max(64).optional(), workItems: z.array(inboundWorkItemSchema).min(1).max(64),
  incidents: z.array(factoryEscalationSchema).min(1).max(64), events: z.array(operationalEventSchema).min(1).max(64),
})
export type SourceHealthContext = z.input<typeof sourceHealthContextSchema>
export type ReferenceGraphInput = z.input<typeof referenceGraphInputSchema>
export type ReferenceGraphRecord = z.output<typeof referenceGraphRecordSchema>
type RecordValues = { [Entry in ReferenceGraphRecord as Entry['kind']]: Entry['value'] }
export type ReferenceGraphDefinition = z.output<typeof referenceGraphDefinitionSchema>
export interface ReferenceGraphSummary {
  supportedLanes: typeof referenceGraphSupportedLanes
  unsupportedLanes: typeof referenceGraphUnsupportedLanes
  records: number
  registeredDefinitions: number
  artifacts: number
  decodedArtifactBytes: number
  authorityVerified: false
  signaturesVerified: false
  historicalWorkRecords: number
  resolvedHealthReferences: number
}
function assert(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(`Reference graph rejected: ${reason}`) }
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b) }
function sourceKey(value: { envelopeId: string; source: string; sourceEntityId: string; sourceRevision: string }): string {
  return canonicalJson([value.envelopeId, value.source, value.sourceEntityId, value.sourceRevision])
}
function byteLength(encoded: string): number {
  assert(encoded.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded), 'noncanonical base64')
  // Enforce zero padding bits without decoding an unbounded string.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (encoded.endsWith('==')) assert((alphabet.indexOf(encoded.at(-3)!) & 15) === 0, 'noncanonical base64 padding')
  else if (encoded.endsWith('=')) assert((alphabet.indexOf(encoded.at(-2)!) & 3) === 0, 'noncanonical base64 padding')
  return encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0)
}

/** Verifies the supported graph against its supplied, concrete registered definitions.
 * This does not authenticate registry authors, run commands, verify source truth,
 * or validate economics/verification/release lanes hidden in opaque artifact bytes.
 */
export function validateReferenceGraph(raw: unknown, rawHealthContext?: SourceHealthContext): ReferenceGraphSummary {
  let input: z.output<typeof referenceGraphInputSchema>
  try {
    const decoded = parseStrictJson(typeof raw === 'string' || raw instanceof Uint8Array ? raw : canonicalJson(raw, 12_582_912), MAX_BUNDLE_BYTES)
    if (decoded && typeof decoded === 'object' && 'records' in decoded && Array.isArray(decoded.records)) {
      assert(decoded.records.length <= MAX_RECORDS, 'record count limit')
      for (const record of decoded.records) if (record && typeof record === 'object' && 'kind' in record) {
        assert((supportedKinds as readonly unknown[]).includes(record.kind), 'unsupported record kind/lane')
      }
      const histories = 'workHistories' in decoded && Array.isArray(decoded.workHistories) ? decoded.workHistories : []
      const historicalRecords = histories.reduce((sum, item) => sum + (item && typeof item === 'object' && 'versions' in item && Array.isArray(item.versions) ? item.versions.length : 0), 0)
      assert(histories.length <= MAX_RECORDS && historicalRecords + decoded.records.length <= 256, 'historical work node bound')
    }
    input = referenceGraphInputSchema.parse(decoded)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Reference graph rejected:')) throw error
    throw new Error('Reference graph rejected: invalid bounded input')
  }
  const healthContext = rawHealthContext === undefined ? undefined : sourceHealthContextSchema.parse(parseStrictJson(canonicalJson(rawHealthContext, MAX_BUNDLE_BYTES), MAX_BUNDLE_BYTES))
  const historicalWorkRecords = (input.workHistories ?? []).reduce((count, history) => count + history.versions.length, 0)
  let decodedBytes = 0
  assert(input.records.length + input.definitions.length + input.artifacts.length + historicalWorkRecords + (healthContext ? healthContext.workItems.length + healthContext.incidents.length + healthContext.events.length + (healthContext.admissions?.length ?? 0) : 0) <= 256, 'total graph node limit')
  for (const artifact of input.artifacts) {
    const length = byteLength(artifact.bytesBase64)
    assert(length <= MAX_ARTIFACT_BYTES && length === artifact.reference.sizeBytes, 'artifact size mismatch or limit')
    decodedBytes += length
    assert(decodedBytes <= MAX_TOTAL_ARTIFACT_BYTES, 'aggregate decoded artifact byte limit')
  }
  const artifacts = new Map<string, z.output<typeof artifactRefSchema>>()
  const content = new Map<string, Buffer>()
  for (const artifact of input.artifacts) {
    const ref = artifact.reference
    assert(ref.projectId === input.projectId, 'cross-project artifact')
    assert(!artifacts.has(ref.id) && !content.has(ref.digest), 'duplicate artifact identity or digest alias')
    const bytes = Buffer.from(artifact.bytesBase64, 'base64')
    assert(digestBytes(bytes) === ref.digest, 'artifact digest mismatch')
    artifacts.set(ref.id, ref); content.set(ref.digest, bytes)
  }
  const checkBindings = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if ('projectId' in value) assert(value.projectId === input.projectId, 'cross-project reference')
    if ('policyRevision' in value) assert(value.policyRevision === input.policyRevision, 'referenced policy revision mismatch')
    if ('mediaType' in value && 'sizeBytes' in value && 'digest' in value && 'id' in value) {
      assert(typeof value.id === 'string' && same(artifacts.get(value.id) ?? null, value), 'unresolved or aliased artifact reference')
    }
    for (const nested of Object.values(value)) checkBindings(nested)
  }
  const recordMap = new Map<string, ReferenceGraphRecord>()
  for (const record of input.records) {
    checkBindings(record.value)
    const key = `${record.kind}:${record.value.id}`
    assert(!recordMap.has(key), 'duplicate record identity')
    validateContract(record.kind, record.value)
    recordMap.set(key, record)
  }
  const definitions = new Map<string, ReferenceGraphDefinition>()
  for (const definition of input.definitions) {
    checkBindings(definition)
    const key = `${definition.kind}:${definition.id}`
    assert(!definitions.has(key), 'duplicate registered identity')
    const { digest, ...payload } = definition
    assert(digest === digestJson(payload), 'registered definition digest mismatch')
    definitions.set(key, definition)
  }
  function definition<K extends ReferenceGraphDefinition['kind']>(kind: K, id: string): Extract<ReferenceGraphDefinition, { kind: K }> {
    const found = definitions.get(`${kind}:${id}`)
    assert(found, 'unresolved registered definition')
    return found as Extract<ReferenceGraphDefinition, { kind: K }>
  }
  function record<K extends ReferenceGraphRecord['kind']>(kind: K, id: string): RecordValues[K] {
    const found = recordMap.get(`${kind}:${id}`)
    assert(found, 'unresolved contract record')
    return found.value as RecordValues[K]
  }
  const histories = new Map<string, z.output<typeof inboundWorkItemSchema>[]>()
  for (const history of input.workHistories ?? []) {
    assert(!histories.has(history.workItemId), 'duplicate work history')
    const current = record('InboundWorkItemV1', history.workItemId), first = history.versions[0]!
    assert(first.state === 'received' && first.revision === 1 && first.id === history.workItemId, 'history must start at received revision one')
    for (const [index, version] of history.versions.entries()) {
      checkBindings(version); validateContract('InboundWorkItemV1', version)
      assert(version.id === history.workItemId, 'history item identity mismatch')
      if (index > 0) assertIngestionTransition(history.versions[index - 1]!, version)
    }
    assert(same(history.versions.at(-1), current), 'history does not end at exact current work snapshot')
    histories.set(history.workItemId, history.versions)
  }
  const healthWork = new Set<string>()
  if (healthContext) {
    assert(new Set(healthContext.workItems.map(value => value.id)).size === healthContext.workItems.length && new Set(healthContext.incidents.map(value => value.id)).size === healthContext.incidents.length && new Set(healthContext.events.map(value => value.id)).size === healthContext.events.length, 'ambiguous source health context')
    const referents = new Set([...input.records.map(value => value.value.id), ...input.definitions.map(value => value.id), ...input.artifacts.map(value => value.reference.id)])
    const incidents = new Set<string>(), events = new Set<string>(), usedAdmissions = new Set<string>()
    const admissions = healthContext.admissions ?? []
    assert(new Set(admissions.map(value => value.id)).size === admissions.length, 'ambiguous source admission health context')
    for (const admission of admissions) {
      checkBindings(admission)
      const { workKey: _workKey, intentDigest: _intentDigest, admissionId: _admissionId, workflowId: _workflowId, definition: _definition, plannedSteps: _steps, ...planInput } = admission.intent
      assert(same(planAdmission(planInput), admission.intent), 'source health admission plan mismatch')
      assert(admission.id === admission.intent.admissionId && admission.receipt.id === admission.id && same(record('AdmissionReceiptV1', admission.id), admission.receipt) && same(record('ExecutableSpecV1', admission.intent.spec.id), admission.intent.spec), 'source health admission payload mismatch')
      const workflow = definition('workflow', admission.intent.workflowId)
      assert(same(workflow.definition, admission.intent.definition) && same(workflow.taskIds, admission.receipt.taskIds) && same(admission.receipt.taskIds, admission.intent.plannedSteps.map(step => step.taskId)), 'source health admission workflow mismatch')
      assert(admission.status === 'quarantined' && admission.receipt.state === 'quarantined' && admission.healthEscalationId && admission.quarantineReason, 'source health admission is not quarantined')
    }
    for (const work of healthContext.workItems) {
      assert(same(record('InboundWorkItemV1', work.id), work) && work.healthEscalationId && work.quarantineReason, 'resolved source health payload mismatch')
      const incident = healthContext.incidents.find(value => value.id === work.healthEscalationId)
      assert(incident && incident.projectId === work.projectId && incident.policyRevision === work.policyRevision && incident.reason === work.quarantineReason && ['ingress', 'trust', 'admission', 'verification', 'operations'].includes(incident.stage), 'missing or substituted source health incident')
      const sharedAdmissions = admissions.filter(admission => sourceKey(admission.intent.spec.source) === sourceKey(work) && admission.healthEscalationId === incident.id && admission.quarantineReason === incident.reason)
      const effects = [work.id, work.envelopeId, ...sharedAdmissions.map(admission => admission.id)]
      for (const admission of sharedAdmissions) {
        assert(['admission', 'operations'].includes(incident.stage) && [admission.id, admission.intent.workflowId, work.envelopeId].includes(incident.effectId), 'shared admission health effect mismatch')
        usedAdmissions.add(admission.id)
      }
      assert(effects.includes(incident.effectId) && incident.evidenceRefs.some(id => effects.includes(id)) && [...incident.evidenceRefs, ...(incident.resolution?.evidenceRefs ?? [])].every(id => referents.has(id)), 'source health effect/evidence mismatch')
      assert(incident.cooldownUntil >= incident.raisedAt && (!incident.acknowledgement || incident.acknowledgement.at >= incident.raisedAt) && (!incident.resolution || incident.resolution.at >= incident.raisedAt), 'source health chronology mismatch')
      const boundEvents = healthContext.events.filter(event => event.recordId === work.id && event.healthEscalationId === incident.id)
      assert(boundEvents.length > 0, 'source health event missing')
      for (const event of boundEvents) {
        checkBindings(event); validateContract('OperationalEventV1', event)
        assert(event.reasonCode === incident.reason && event.expectedRecordRevision + 1 === work.revision && Date.parse(event.occurredAt) >= incident.raisedAt, 'source health event reason/revision mismatch')
        if (event.workflowId) assert(input.records.some(value => value.kind === 'AdmissionReceiptV1' && value.value.workflowId === event.workflowId && sourceKey(value.value.source) === sourceKey(work)), 'source health workflow mismatch')
        if (event.attemptId) { const attempt = definition('attempt', event.attemptId), task = definition('task', attempt.taskId); assert(event.workflowId === task.workflowId, 'source health attempt mismatch') }
        assert(!event.releaseId, 'source health release references require release graph context')
        events.add(event.id)
      }
      incidents.add(incident.id); healthWork.add(work.id)
    }
    assert(incidents.size === healthContext.incidents.length && events.size === healthContext.events.length && usedAdmissions.size === admissions.length, 'orphan source health context')
  }
  for (const entry of input.records) if (entry.kind === 'InboundWorkItemV1') {
    assert(['received', 'trusted'].includes(entry.value.state) || histories.has(entry.value.id), 'progressed work requires explicit native history')
    assert(!entry.value.healthEscalationId || healthWork.has(entry.value.id), 'source quarantine requires validated concrete health context')
  }
  const workBySource = new Map<string, z.output<typeof inboundWorkItemSchema>>()
  const workIdentities = new Set<string>()
  for (const entry of input.records) if (entry.kind === 'InboundWorkItemV1') {
    const key = sourceKey(entry.value)
    const identity = canonicalJson([entry.value.source, entry.value.sourceEntityId, entry.value.sourceRevision])
    assert(!workBySource.has(key) && !workIdentities.has(identity), 'ambiguous source revision alias')
    workIdentities.add(identity)
    workBySource.set(key, entry.value)
  }
  const sourceWork = (source: Parameters<typeof sourceKey>[0]) => {
    const work = workBySource.get(sourceKey(source))
    assert(work, 'unresolved source revision')
    return work
  }
  const compilerContexts = new Map<string, Extract<ReferenceGraphDefinition, { kind: 'compiler-context' }>>()
  for (const registered of input.definitions) {
    switch (registered.kind) {
      case 'workflow': {
        assert(same(validateWorkflowTemplate(registered.definition), registered.definition), 'workflow definition is not normalized')
        assert(digestJson(registered.definition) === registered.definitionDigest, 'workflow definition digest mismatch')
        for (const id of registered.taskIds) assert(definition('task', id).workflowId === registered.id, 'workflow task ownership mismatch')
        break
      }
      case 'task': {
        const workflow = definition('workflow', registered.workflowId)
        assert(workflow.taskIds.includes(registered.id) && workflow.definition.steps.some(step => step.id === registered.stepId), 'registered task step mismatch')
        break
      }
      case 'attempt': definition('task', registered.taskId); break
      case 'provider-request':
        assert(registered.id === registered.receipt.id && registered.projectId === registered.receipt.projectId, 'provider request receipt identity mismatch')
        break
      case 'model-assignment': {
        assert(definition('attempt', registered.attemptId).generation === registered.generation, 'model assignment generation mismatch')
        const catalog = referenceGraphCatalogRegistrationSchema.parse(parseStrictJson(content.get(registered.catalog.digest)!))
        const pricing = referenceGraphPricingRegistrationSchema.parse(parseStrictJson(content.get(registered.pricing.digest)!))
        assert(catalog.revision === registered.catalogRevision && catalog.models.filter(model => model.provider === registered.provider && model.deploymentId === registered.deploymentId && model.modelVersion === registered.modelVersion).length === 1, 'model catalog revision/identity mismatch')
        assert(pricing.revision === registered.pricingRevision && pricing.provider === registered.provider && pricing.modelVersion === registered.modelVersion, 'model pricing revision/identity mismatch')
        break
      }
      case 'compiler-context': {
        const context = registered.context
        assert(!compilerContexts.has(context.specId), 'ambiguous compiler context alias')
        const work = record('InboundWorkItemV1', context.ingress.id)
        assert(same(context.ingress, work) || histories.get(work.id)?.some(version => same(version, context.ingress)), 'compiler source snapshot is not an exact validated historical revision')
        assert(context.ingress.state === 'trusted', 'compiler context requires trusted source snapshot')
        definition('model-assignment', context.modelAssignmentId)
        for (const digest of [context.policyDigest, context.rulesDigest, context.toolchainDigest]) assert(content.has(digest), 'unresolved compiler pin digest')
        const policyBytes = content.get(context.policyDigest)!
        const policy = enabledDarkFactoryConfigSchema.parse(parseStrictJson(policyBytes))
        assert(policyBytes.toString('utf8') === canonicalJson(policy), 'policy snapshot is not canonical normalized JSON')
        assert(policy.policyRevision === input.policyRevision && policy.projectIds.includes(input.projectId), 'compiler policy project/revision mismatch')
        assert(policy.mode !== 'observe', 'compiler policy is observe-only')
        const envelope = record('InboundEnvelopeV1', context.ingress.envelopeId)
        const route = policy.ingestion.routes.find(route => route.id === envelope.routeId && route.projectId === input.projectId && route.source === envelope.source)
        assert(route && route.providerVersion === envelope.adapterVersion, 'unresolved envelope policy route/revision')
        if (envelope.authentication === 'provider-api') {
          const scan = route.source === 'github' ? route.reconciliation?.scan : undefined
          assert(scan && scan.scannerId === envelope.providerRead.scannerId && scan.ruleId === envelope.providerRead.ruleId && route.senderIds.includes(scan.scannerId), 'unresolved provider-read scanner registration')
          assert(route.source === 'github' && route.bindings.authorIds.includes(context.ingress.author), 'provider-read source author is not registered')
          assert(route.source === 'github' && route.bindings.automationRules.filter(mapping => mapping.ruleId === scan.ruleId && route.ruleIds.includes(mapping.ruleId) && context.ingress.labels.includes(mapping.automationLabel)).length === 1, 'provider-read scanner rule lacks current automation label')
        } else assert(route.signingKeyId === envelope.signingKeyId, 'unresolved envelope signing key')
        assert(context.registries.checks.every(check => policy.verification.checkIds.includes(check.id)) &&
          context.registries.fixtures.every(fixture => policy.verification.fixtureIds.includes(fixture.id)) &&
          context.registries.commands.every(command => policy.verification.commands.some(configured => same(configured, command))), 'compiler registry escapes pinned policy')
        record('ExecutableSpecV1', context.specId)
        record('CompilerOutcomeV1', context.outcomeId)
        compilerContexts.set(context.specId, registered)
        break
      }
    }
  }
  let admissions = 0
  const sourceSpecs = new Set<string>(), sourceAdmissions = new Set<string>(), sourceOutcomes = new Set<string>(), receiptedEnvelopes = new Set<string>()
  for (const entry of input.records) {
    switch (entry.kind) {
      case 'InboundEnvelopeV1': {
        const envelope = entry.value
        if (envelope.authentication === 'provider-api') {
          const request = definition('provider-request', envelope.providerRead.requestReceiptId).receipt
          assert(request.routeId === envelope.routeId && request.projectId === envelope.projectId && Date.parse(request.at) <= Date.parse(envelope.providerRead.observedAt), 'provider-read request charge route/project/time mismatch')
        }
        break
      }
      case 'InboundWorkItemV1': {
        const envelope = record('InboundEnvelopeV1', entry.value.envelopeId)
        assert(envelope.source === entry.value.source, 'work item source adapter mismatch')
        assertIngressOrigin(entry.value, envelope)
        break
      }
      case 'IngressReceiptV1': {
        assert(!receiptedEnvelopes.has(entry.value.envelopeId), 'ambiguous envelope receipt alias')
        receiptedEnvelopes.add(entry.value.envelopeId)
        const envelope = record('InboundEnvelopeV1', entry.value.envelopeId)
        assert(envelope.bodyDigest === entry.value.bodyDigest && envelope.receivedAt === entry.value.receivedAt, 'ingress receipt envelope mismatch')
        break
      }
      case 'ExecutableSpecV1': {
        const spec = entry.value, work = sourceWork(spec.source)
        assert(!sourceSpecs.has(sourceKey(spec.source)), 'ambiguous source spec alias')
        sourceSpecs.add(sourceKey(spec.source))
        const registration = compilerContexts.get(spec.id)
        assert(registration, 'missing concrete compiler registry snapshot')
        const context = registration.context
        assert(context.ingress.trust.decision === 'trusted' && context.ingress.state === 'trusted', 'spec compiler source was not trusted')
        const pathIds = spec.allowedPaths.map(path => {
          const matches = context.registries.paths.filter(value => value.path === path)
          assert(matches.length === 1, 'unresolved or ambiguous scope definition')
          return matches[0]!.id
        })
        const proposal = { outcome: 'COMPILED', spec: {
          objective: spec.objective, nonGoals: spec.nonGoals, invariants: spec.invariants, allowedPathIds: pathIds, requiredCapabilities: spec.requiredCapabilities,
          acceptanceScenarios: spec.acceptanceScenarios.map(scenario => {
            const matches = context.registries.reproductions.filter(reproduction => same(reproduction.artifact, scenario.reproduction) && reproduction.fixtureId === scenario.fixtureId && reproduction.commandId === scenario.commandId && reproduction.expected === scenario.expected && reproduction.actual === scenario.actual)
            assert(matches.length === 1, 'unresolved or ambiguous reproduction definition')
            return { id: scenario.id, description: scenario.description, fixtureId: scenario.fixtureId, assertionIds: scenario.assertionIds, commandId: scenario.commandId, reproductionId: matches[0]!.id }
          }),
        } }
        const rebuilt = new SpecCompilerSession(context).evaluate(proposal, context.ingress)
        assert(rebuilt.outcome.outcome === 'COMPILED' && same(rebuilt.outcome.spec, spec), 'spec disagrees with host registry/pins')
        break
      }
      case 'CompilerOutcomeV1': {
        assert(!sourceOutcomes.has(sourceKey(entry.value.source)), 'conflicting compiler outcomes for source revision')
        sourceOutcomes.add(sourceKey(entry.value.source))
        sourceWork(entry.value.source)
        if (entry.value.outcome === 'COMPILED') {
          const spec = record('ExecutableSpecV1', entry.value.spec.id)
          assert(same(spec, entry.value.spec), 'compiler outcome spec alias')
          assert(compilerContexts.get(spec.id)?.context.outcomeId === entry.value.id, 'compiler outcome registry identity mismatch')
        }
        break
      }
      case 'AdmissionReceiptV1': {
        admissions++
        const admission = entry.value
        assert(!sourceAdmissions.has(sourceKey(admission.source)), 'duplicate admission for source revision')
        sourceAdmissions.add(sourceKey(admission.source))
        sourceWork(admission.source)
        const spec = record('ExecutableSpecV1', admission.specId)
        assertAdmissionMatchesSpec(admission, spec)
        const workflow = definition('workflow', admission.workflowId)
        assert(workflow.definitionDigest === admission.workflowDigest && same([...workflow.taskIds].sort(), [...admission.taskIds].sort()), 'admission workflow/task pins mismatch')
        for (const id of admission.taskIds) assert(definition('task', id).workflowId === workflow.id, 'admission task ownership mismatch')
        break
      }
    }
  }
  assert(admissions > 0, 'source-admission lane requires an admission record')
  return { supportedLanes: referenceGraphSupportedLanes, unsupportedLanes: referenceGraphUnsupportedLanes,
    records: input.records.length, registeredDefinitions: input.definitions.length, artifacts: input.artifacts.length,
    decodedArtifactBytes: decodedBytes, historicalWorkRecords, resolvedHealthReferences: healthWork.size, authorityVerified: false, signaturesVerified: false }
}
