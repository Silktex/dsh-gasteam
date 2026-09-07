/** Offline quarantine/health edge closure over concrete terminal snapshots.
 * Compiler, verification/release internals, live authority and signatures are
 * separate lanes; this validator neither resolves an incident nor permits work.
 */
import z from 'zod'
import { factoryEscalationSchema } from '../../health.ts'
import { validateWorkflowTemplate } from '../../workflows.ts'
import { admissionRecordSchema, planAdmission } from '../admission-store.ts'
import { canonicalJson, digestJson, parseStrictJson } from '../json.ts'
import { artifactRefSchema, idSchema, revisionSchema } from './common.ts'
import { graphArtifactDescriptorSchema, validateGraphArtifacts } from './graph-core.ts'
import { inboundEnvelopeSchema, inboundWorkItemSchema } from './ingestion.ts'
import { operationalEventSchema } from './operations.ts'
import { referenceGraphDefinitionSchema } from './reference-graph.ts'
import { releaseRecordSchema } from './release.ts'
import { executableSpecSchema, verifyExecutableSpec, assertAdmissionMatchesSpec } from './spec.ts'
import { assertContractSemantics } from './semantics.ts'

const bounded = <T extends z.ZodType>(schema: T) => z.array(schema).max(64)
export const quarantineReferenceGraphInputSchema = z.strictObject({
  schemaVersion: z.literal(1), lane: z.literal('quarantine-health'), projectId: idSchema, policyRevision: revisionSchema,
  envelopes: bounded(inboundEnvelopeSchema), workItems: bounded(inboundWorkItemSchema), admissions: bounded(admissionRecordSchema),
  releases: bounded(releaseRecordSchema), events: bounded(operationalEventSchema), incidents: bounded(factoryEscalationSchema).min(1),
  specs: bounded(executableSpecSchema),
  // Reuse strict full-payload registered definitions; this lane consumes only
  // workflow/task/attempt definitions, not model/compiler registry authority.
  definitions: bounded(referenceGraphDefinitionSchema), artifacts: z.array(graphArtifactDescriptorSchema).max(128),
})
export type QuarantineReferenceGraphInput = z.input<typeof quarantineReferenceGraphInputSchema>
type Input = z.output<typeof quarantineReferenceGraphInputSchema>
type Target = { kind: 'envelope'; value: Input['envelopes'][number] } | { kind: 'work'; value: Input['workItems'][number] } |
  { kind: 'admission'; value: Input['admissions'][number] } | { kind: 'release'; value: Input['releases'][number] }
export interface QuarantineReferenceGraphSummary {
  lane: 'quarantine-health'; quarantinedRecords: number; incidents: number; events: number; concreteReferents: number
  authorityVerified: false; signaturesVerified: false; externalContextInternalsVerified: false
}
function assert(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Quarantine reference graph rejected: ${reason}`) }
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b) }
function sourceMatches(spec: Input['specs'][number], item: Input['workItems'][number]): boolean {
  return ['envelopeId', 'source', 'sourceEntityId', 'sourceRevision'].every(key => spec.source[key as keyof typeof spec.source] === item[key as keyof typeof item])
}

/** Proves only the named quarantine/health contextual edges. A full concrete
 * ReleaseRecord is a registered external snapshot, not verified deployment proof.
 * No opaque ID-only definitions or arbitrary supplied resolver callbacks exist.
 */
export function validateQuarantineReferenceGraph(raw: unknown): QuarantineReferenceGraphSummary {
  let input: Input
  try { input = quarantineReferenceGraphInputSchema.parse(parseStrictJson(typeof raw === 'string' || raw instanceof Uint8Array ? raw : canonicalJson(raw, 12_582_912), 12_582_912)) }
  catch { throw new Error('Quarantine reference graph rejected: invalid bounded input') }
  const allCollections = [input.envelopes, input.workItems, input.admissions, input.releases, input.events, input.incidents, input.specs, input.definitions, input.artifacts]
  assert(allCollections.reduce((sum, values) => sum + values.length, 0) <= 256, 'total node limit')
  const artifacts = validateGraphArtifacts(input.projectId, input.artifacts)
  const refs = new Map<string, unknown>(), targets = new Map<string, Target>()
  function scope(value: { projectId: string; policyRevision?: number }): void {
    assert(value.projectId === input.projectId && (value.policyRevision === undefined || value.policyRevision === input.policyRevision), 'cross-project or policy referent')
  }
  function add(id: string, value: unknown): void { assert(!refs.has(id), 'ambiguous referent identity'); refs.set(id, value) }
  function inspectArtifacts(rawValue: unknown): void {
    if (!rawValue || typeof rawValue !== 'object') return
    if (Array.isArray(rawValue)) { for (const value of rawValue) inspectArtifacts(value); return }
    const value = rawValue as Record<string, unknown>
    const artifact = artifactRefSchema.safeParse(value)
    if (artifact.success) { artifacts.assertArtifact(artifact.data); return }
    if ('projectId' in value) assert(value.projectId === input.projectId, 'nested cross-project referent')
    if ('policyRevision' in value) assert(value.policyRevision === input.policyRevision, 'nested policy mismatch')
    for (const nested of Object.values(value)) inspectArtifacts(nested)
  }
  for (const artifact of input.artifacts) add(artifact.reference.id, artifact.reference)
  for (const [kind, values] of [['envelope', input.envelopes], ['work', input.workItems], ['admission', input.admissions], ['release', input.releases]] as const) {
    for (const value of values) {
      scope(value); inspectArtifacts(value); add(value.id, value)
      targets.set(value.id, { kind, value } as Target)
    }
  }
  for (const value of [...input.specs, ...input.definitions, ...input.events, ...input.incidents]) {
    scope(value); inspectArtifacts(value); add(value.id, value)
  }
  const workflows = input.definitions.filter(value => value.kind === 'workflow')
  const tasks = input.definitions.filter(value => value.kind === 'task')
  const attempts = input.definitions.filter(value => value.kind === 'attempt')
  assert(workflows.length + tasks.length + attempts.length === input.definitions.length, 'unsupported external definition kind')
  for (const definition of input.definitions) {
    const { digest, ...payload } = definition
    assert(digest === digestJson(payload), 'registered definition digest mismatch')
  }
  for (const workflow of workflows) {
    try { validateWorkflowTemplate(workflow.definition) } catch { assert(false, 'invalid workflow definition') }
    assert(digestJson(workflow.definition) === workflow.definitionDigest, 'workflow definition digest mismatch')
    assert(workflow.taskIds.length === workflow.definition.steps.length, 'incomplete workflow tasks')
    const stepIds = new Set<string>()
    for (const id of workflow.taskIds) {
      const task = tasks.find(value => value.id === id)
      assert(task && task.workflowId === workflow.id && workflow.definition.steps.some(step => step.id === task.stepId && step.title === task.subject), 'workflow task context mismatch')
      assert(!stepIds.has(task.stepId), 'duplicate workflow task step'); stepIds.add(task.stepId)
    }
  }
  for (const task of tasks) assert(workflows.some(workflow => workflow.id === task.workflowId && workflow.taskIds.includes(task.id)), 'dangling task workflow')
  for (const attempt of attempts) assert(tasks.some(task => task.id === attempt.taskId), 'dangling attempt task')
  for (const envelope of input.envelopes) assertContractSemantics('InboundEnvelopeV1', envelope)
  for (const item of input.workItems) {
    assertContractSemantics('InboundWorkItemV1', item)
    const envelope = input.envelopes.find(value => value.id === item.envelopeId)
    assert(envelope && envelope.source === item.source && item.provenance.some(ref => same(ref, envelope.artifact)), 'work envelope/provenance mismatch')
    assert(item.trust.authorityRevision === input.policyRevision, 'work trust policy mismatch')
  }
  for (const spec of input.specs) {
    try { verifyExecutableSpec(spec) } catch { assert(false, 'spec digest mismatch') }
    assert(input.workItems.some(item => sourceMatches(spec, item)), 'spec source context missing')
    assert(workflows.some(workflow => workflow.definitionDigest === spec.workflowDigest), 'spec workflow context missing')
  }
  for (const admission of input.admissions) {
    const { workKey: _workKey, intentDigest: _intentDigest, admissionId: _admissionId, workflowId: _workflowId, definition: _definition, plannedSteps: _plannedSteps, ...planInput } = admission.intent
    let plan
    try { plan = planAdmission(planInput); assertAdmissionMatchesSpec(admission.receipt, admission.intent.spec) } catch { assert(false, 'invalid admission plan') }
    assert(same(plan!, admission.intent), 'admission plan mismatch')
    assert(admission.id === admission.intent.admissionId && admission.receipt.id === admission.id && admission.receipt.workflowId === admission.intent.workflowId && same(admission.receipt.taskIds, admission.intent.plannedSteps.map(step => step.taskId)), 'admission receipt identity mismatch')
    assert(input.specs.some(spec => same(spec, admission.intent.spec)), 'admission spec context missing')
    assert(workflows.some(workflow => workflow.id === admission.intent.workflowId && same(workflow.definition, admission.intent.definition) && same(workflow.taskIds, admission.receipt.taskIds)), 'admission workflow context missing')
    assert(admission.status !== 'quarantined' || admission.receipt.state === 'quarantined' && !!admission.quarantineReason && !!admission.healthEscalationId, 'incomplete admission quarantine')
  }
  for (const release of input.releases) {
    assertContractSemantics('ReleaseRecordV1', release)
    assert(workflows.some(workflow => workflow.id === release.workflowId), 'release workflow context missing')
    assert(release.attemptIds.every(id => attempts.some(attempt => attempt.id === id && tasks.some(task => task.id === attempt.taskId && task.workflowId === release.workflowId))), 'release attempt context mismatch')
    assert(release.specDigests.every(digest => input.specs.some(spec => spec.specDigest === digest && workflows.some(workflow => workflow.id === release.workflowId && workflow.definitionDigest === spec.workflowDigest))), 'release spec context mismatch')
    for (const operation of release.operationIntents) {
      add(operation.id, operation)
      if (operation.operationId !== operation.id) add(operation.operationId, operation)
      assert(operation.releaseId === release.id, 'release operation context mismatch')
    }
    for (const receipt of release.operationReceipts) add(receipt.id, receipt)
  }
  const incidentById = new Map(input.incidents.map(value => [value.id, value]))
  const usedIncidents = new Set<string>()
  function targetIncident(target: Target): string | undefined {
    if (target.kind === 'envelope') return undefined
    return target.value.healthEscalationId
  }
  function associatedWork(target: Target): Input['workItems'] {
    if (target.kind === 'work') return [target.value]
    if (target.kind === 'envelope') return input.workItems.filter(item => item.envelopeId === target.value.id)
    if (target.kind === 'admission') return input.workItems.filter(item => sourceMatches(target.value.intent.spec, item))
    return input.workItems.filter(item => input.specs.some(spec => target.value.specDigests.includes(spec.specDigest) && sourceMatches(spec, item)))
  }
  function targetWorkflow(target: Target, workflowId: string): boolean {
    const workflow = workflows.find(value => value.id === workflowId)
    if (!workflow) return false
    if (target.kind === 'release') return target.value.workflowId === workflowId
    if (target.kind === 'admission') return target.value.intent.workflowId === workflowId
    return associatedWork(target).some(item => input.specs.some(spec => sourceMatches(spec, item) && spec.workflowDigest === workflow.definitionDigest))
  }
  function bindIncident(target: Target, incidentId: string, reason?: string): void {
    const incident = incidentById.get(incidentId)
    assert(incident, 'dangling health incident'); usedIncidents.add(incidentId)
    if (reason) assert(incident.reason === reason, 'incident reason mismatch')
    const effects = [target.value.id]
    if (target.kind === 'work') {
      effects.push(target.value.envelopeId)
      // Native admission quarantine shares its incident with the exact source item.
      for (const admission of input.admissions) if (admission.status === 'quarantined' && admission.healthEscalationId === incidentId && admission.quarantineReason === target.value.quarantineReason && sourceMatches(admission.intent.spec, target.value)) effects.push(admission.id)
    }
    if (target.kind === 'admission') effects.push(target.value.intent.workflowId, target.value.intent.spec.source.envelopeId)
    if (target.kind === 'release') effects.push(...target.value.operationIntents.map(value => value.operationId))
    assert(effects.includes(incident.effectId), 'incident effect mismatch')
    assert(refs.has(incident.effectId), 'dangling incident effect')
    if (target.kind === 'release') assert(['release', 'operations'].includes(incident.stage), 'release incident stage mismatch')
    else if (target.kind === 'admission') assert(['admission', 'operations'].includes(incident.stage), 'admission incident stage mismatch')
    else assert(['ingress', 'trust', 'admission', 'verification', 'operations'].includes(incident.stage), 'source incident stage mismatch')
    assert(incident.evidenceRefs.some(id => effects.includes(id)), 'incident lacks concrete target evidence')
  }
  let quarantinedRecords = 0
  for (const target of targets.values()) {
    const quarantined = target.kind === 'admission' ? target.value.status === 'quarantined' : target.kind !== 'envelope' && target.value.state === 'quarantined'
    if (!quarantined) continue
    quarantinedRecords++
    const incident = targetIncident(target)
    assert(incident, 'quarantined record lacks health incident')
    const reason = target.kind === 'work' || target.kind === 'admission' ? target.value.quarantineReason : undefined
    bindIncident(target, incident, reason)
  }
  for (const event of input.events) {
    assertContractSemantics('OperationalEventV1', event)
    const target = targets.get(event.recordId)
    assert(target, 'dangling operational target')
    const revision = target.kind === 'envelope' ? 1 : target.value.revision
    assert(event.expectedRecordRevision + 1 === revision, 'event target revision mismatch')
    if (event.workflowId) assert(targetWorkflow(target, event.workflowId), 'event workflow context mismatch')
    if (event.attemptId) {
      const attempt = attempts.find(value => value.id === event.attemptId), task = tasks.find(value => value.id === attempt?.taskId)
      assert(task && targetWorkflow(target, task.workflowId) && (!event.workflowId || task.workflowId === event.workflowId), 'event attempt context mismatch')
    }
    if (event.releaseId) {
      const release = input.releases.find(value => value.id === event.releaseId)
      assert(release && (target.kind === 'release' ? target.value.id === release.id : associatedWork(target).some(item => input.specs.some(spec => release.specDigests.includes(spec.specDigest) && sourceMatches(spec, item)))), 'event release context mismatch')
    }
    if (event.healthEscalationId) {
      assert(!targetIncident(target) || targetIncident(target) === event.healthEscalationId, 'event incident mismatch')
      bindIncident(target, event.healthEscalationId, event.reasonCode)
      assert(incidentById.get(event.healthEscalationId)!.raisedAt <= Date.parse(event.occurredAt), 'event predates incident')
    } else assert(!targetIncident(target), 'event omits target incident')
  }
  for (const incident of input.incidents) {
    assert(usedIncidents.has(incident.id), 'orphan health incident')
    assert(incident.cooldownUntil >= incident.raisedAt && (!incident.acknowledgement || incident.acknowledgement.at >= incident.raisedAt) && (!incident.resolution || incident.resolution.at >= incident.raisedAt), 'incident timestamp mismatch')
    for (const ref of [...incident.evidenceRefs, ...(incident.resolution?.evidenceRefs ?? [])]) assert(refs.has(ref) && ref !== incident.id, 'dangling or self-referential incident evidence')
  }
  assert(quarantinedRecords > 0 || input.events.some(event => event.healthEscalationId), 'no quarantine or health event')
  return { lane: 'quarantine-health', quarantinedRecords, incidents: input.incidents.length, events: input.events.length, concreteReferents: refs.size,
    authorityVerified: false, signaturesVerified: false, externalContextInternalsVerified: false }
}
