import { type QuarantineReferenceGraphInput } from '../../src/darkfactory/contracts/quarantine-reference-graph.ts'
import { pinExecutableSpec } from '../../src/darkfactory/contracts/spec.ts'
import { planAdmission } from '../../src/darkfactory/admission-store.ts'
import { canonicalJson, digestBytes, digestJson } from '../../src/darkfactory/json.ts'
import { darkFactoryTemplate } from '../../src/workflow-templates.ts'
import { pinWorkflowDefinition } from '../../src/workflows.ts'
import { examples, at, base } from './fixtures.ts'

/** Concrete host snapshots; signatures/provider authority are deliberately not certified. */
export function quarantineGraphFixture(kind: 'work' | 'release' | 'admission' = 'work'): QuarantineReferenceGraphInput {
  const records = structuredClone(examples)
  const bytes = Buffer.from(canonicalJson({ reason: 'fixture-source-denied', restrictedContext: 'sanitized fixture' }))
  const artifact = { reference: { id: 'quarantine-artifact', projectId: base.projectId, mediaType: 'application/json', sizeBytes: bytes.length, digest: digestBytes(bytes) }, bytesBase64: bytes.toString('base64') }
  const envelope = { ...records.InboundEnvelopeV1, id: 'envelope-1', artifact: artifact.reference }
  const item = { ...records.InboundWorkItemV1, id: 'work-1', envelopeId: envelope.id, provenance: [artifact.reference],
    ...(kind === 'work' ? { state: 'quarantined', revision: 2, quarantineReason: 'SOURCE_DENIED', healthEscalationId: 'factory-incident-1' } : {}) }
  const incident = { ...base, id: 'factory-incident-1', source: 'darkfactory', revision: 1, stage: kind === 'work' ? 'trust' : kind, reason: 'SOURCE_DENIED', effectId: item.id,
    evidenceRefs: [item.id, envelope.id, artifact.reference.id], severity: 'warning', diagnostics: 'Fixture exception requires review', raisedAt: Date.parse(at), cooldownUntil: Date.parse(at) + 1000 }
  const event = { ...records.OperationalEventV1, id: 'event-1', recordId: item.id, expectedRecordRevision: 1, eventKind: 'quarantined', reasonCode: incident.reason, severity: 'warning', healthEscalationId: incident.id, artifacts: [artifact.reference] }
  delete (event as { workflowId?: string }).workflowId
  const input = { schemaVersion: 1, lane: 'quarantine-health', projectId: base.projectId, policyRevision: 1,
    envelopes: [envelope], workItems: [item], admissions: [], releases: [], specs: [], definitions: [], events: [event], incidents: [incident], artifacts: [artifact] } as unknown as QuarantineReferenceGraphInput
  if (kind === 'work') return input
  const workflow = { template: darkFactoryTemplate, parameters: { subject: 'fixture quarantine' } }
  const definition = pinWorkflowDefinition(workflow.template, workflow.parameters)
  const { specDigest: _specDigest, ...specPayload } = records.ExecutableSpecV1
  const spec = pinExecutableSpec({ ...specPayload, id: 'spec-1', provenance: [artifact.reference], workflowDigest: digestJson(definition),
    acceptanceScenarios: records.ExecutableSpecV1.acceptanceScenarios.map(scenario => ({ ...scenario, reproduction: artifact.reference })) })
  input.specs = [spec]
  const plan = planAdmission({ registeredLeadId: 'lead', spec, workflow,
    compilerOutcome: { schemaVersion: 1, id: 'outcome-1', projectId: base.projectId, policyRevision: 1, source: spec.source, outcome: 'COMPILED', reasons: ['fixture'], spec },
    compilerCursor: { schemaVersion: 1, contextDigest: digestJson('fixture context'), malformedAttempts: 0, phase: 'finished' }, policyRefs: { policyRecordId: 'policy-1', decisionReceiptId: 'decision-1' } })
  const workflowId = kind === 'admission' ? plan.workflowId : 'workflow-1'
  const taskIds = kind === 'admission' ? plan.plannedSteps.map(step => step.taskId) : definition.steps.map(step => `task-${step.id}`)
  const registered = (value: Record<string, unknown>) => { const payload = { ...base, revision: 1, ...value }; return { ...payload, digest: digestJson(payload) } }
  input.definitions = [
    registered({ kind: 'workflow', id: workflowId, definition, definitionDigest: digestJson(definition), taskIds }),
    ...definition.steps.map((step, index) => registered({ kind: 'task', id: taskIds[index], workflowId, stepId: step.id, subject: step.title })),
    registered({ kind: 'attempt', id: 'attempt-1', taskId: taskIds[1], generation: 1 }),
  ] as QuarantineReferenceGraphInput['definitions']
  if (kind === 'release') {
    const release = { ...records.ReleaseRecordV1, id: 'release-1', workflowId, artifact: artifact.reference, priorArtifact: artifact.reference, policySnapshot: artifact.reference,
      specDigests: [spec.specDigest], state: 'quarantined' as const, revision: 2, healthEscalationId: incident.id,
      operationIntents: [{ ...records.DeploymentRequestV1, id: 'deployment-request-1', releaseId: 'release-1', artifactDigest: artifact.reference.digest }], operationReceipts: [] }
    input.releases = [release]
    input.incidents[0]!.effectId = release.operationIntents[0]!.operationId
    input.incidents[0]!.evidenceRefs = [release.id, release.operationIntents[0]!.operationId, artifact.reference.id]
    input.events[0] = { ...input.events[0]!, recordId: release.id, releaseId: release.id, workflowId, attemptId: 'attempt-1' }
  } else {
    input.admissions = [{ id: plan.admissionId, projectId: base.projectId, revision: 2, intent: plan,
      receipt: { schemaVersion: 1, id: plan.admissionId, projectId: base.projectId, policyRevision: 1, source: spec.source, specId: spec.id, specDigest: spec.specDigest, policyDigest: spec.policyDigest, workflowId,
        workflowDigest: spec.workflowDigest, taskIds, state: 'quarantined', revision: 2 },
      status: 'quarantined', barrier: 'closed', createdAt: at, updatedAt: at, quarantineReason: incident.reason, healthEscalationId: incident.id }]
    input.incidents[0]!.effectId = plan.admissionId
    input.incidents[0]!.evidenceRefs = [plan.admissionId, item.id, artifact.reference.id]
    input.events[0] = { ...input.events[0]!, recordId: plan.admissionId, workflowId, attemptId: 'attempt-1' }
  }
  return input
}
