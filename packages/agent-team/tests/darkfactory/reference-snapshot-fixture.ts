import { planAdmission } from '../../src/darkfactory/admission-store.ts'
import { referenceSnapshotSchema, type ReferenceSnapshot } from '../../src/darkfactory/contracts/reference-snapshot.ts'
import { referenceGraphInputSchema } from '../../src/darkfactory/contracts/reference-graph.ts'
import { verificationReferenceGraphInputSchema } from '../../src/darkfactory/contracts/verification-reference-graph.ts'
import { economicsReferenceGraphSchema } from '../../src/darkfactory/contracts/economics-reference-graph.ts'
import { quarantineReferenceGraphInputSchema } from '../../src/darkfactory/contracts/quarantine-reference-graph.ts'
import { compilerHostContextSchema, SpecCompilerSession } from '../../src/darkfactory/spec-compiler.ts'
import { canonicalJson, digestBytes, digestJson } from '../../src/darkfactory/json.ts'
import { pinExecutableSpec } from '../../src/darkfactory/contracts/spec.ts'
import { verificationReferenceGraphFixture } from './verification-reference-graph-fixture.ts'
import { economicsGraphFixture } from './economics-graph-fixture.ts'
import { examples } from './fixtures.ts'

const base = { schemaVersion: 1 as const, projectId: 'project-1', policyRevision: 1 }
const seal = <T extends object>(value: T) => { const { digest: _digest, ...payload } = value as T & { digest?: string }; return { ...payload, digest: digestJson(payload) } }
const registration = (kind: string, id: string, payload: object) => seal({ ...base, kind, id, revision: 1, ...payload })
function replace(value: unknown, substitutions: Map<string, string>): unknown {
  if (typeof value === 'string') return substitutions.get(value) ?? value
  if (Array.isArray(value)) return value.map(item => replace(item, substitutions))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item, substitutions)]))
  return value
}

/** One admitted spec, worker and two paid critics, exact release, and a health event for its inbound envelope. */
export function referenceSnapshotFixture(): ReferenceSnapshot {
  let verification = verificationReferenceGraphFixture()
  const originalSpec = verification.definitions.find(value => value.kind === 'spec')!
  if (originalSpec.kind !== 'spec') throw new Error('spec fixture')
  const { specDigest: oldSpecDigest, ...unsigned } = originalSpec.spec
  const compiledSpec = pinExecutableSpec({ ...unsigned, provenance: [...unsigned.provenance, ...unsigned.provenance] })
  verification = verificationReferenceGraphInputSchema.parse(replace(verification, new Map([[oldSpecDigest, compiledSpec.specDigest]])))
  const specRegistration = verification.definitions.find(value => value.kind === 'spec')!
  if (specRegistration.kind !== 'spec') throw new Error('spec fixture')
  specRegistration.spec = compiledSpec
  const evidenceEntry = verification.records.find(value => value.kind === 'VerificationEvidenceV1')!
  if (evidenceEntry.kind !== 'VerificationEvidenceV1') throw new Error('evidence fixture')
  const { evidenceHash: oldEvidenceHash, signature: _signature, ...evidencePayload } = evidenceEntry.value
  verification = verificationReferenceGraphInputSchema.parse(replace(verification, new Map([[oldEvidenceHash, digestJson(evidencePayload)]])))
  const models = [
    { id: compiledSpec.modelAssignmentId, attemptId: 'attempt-1', provider: 'fixture', deploymentId: 'fixture-1', modelVersion: 'fixture-v1' },
    { id: 'model-1', attemptId: 'critic-attempt-1', provider: 'model-provider-1', deploymentId: 'critic-deployment-1', modelVersion: 'v1' },
    { id: 'model-2', attemptId: 'critic-attempt-2', provider: 'model-provider-2', deploymentId: 'critic-deployment-2', modelVersion: 'v2' },
  ]
  const parts = models.map((model, index) => {
    const n = index + 1, substitutions = new Map<string, string>([
      ['assignment-1', model.id], ['attempt-1', model.attemptId], ['fixture', model.provider], ['fixture-1', model.deploymentId], ['fixture-v1', model.modelVersion],
      ['2026-09-06T12:00:00Z', '2026-09-06T11:00:00Z'],
      ...['account', 'reservation', 'quota', 'pool', 'watermark', 'request', 'pricing', 'usage', 'quota-decision'].map(prefix => [`${prefix}-1`, `${prefix}-${n}`] as [string, string]),
    ])
    return economicsReferenceGraphSchema.parse(replace(economicsGraphFixture(), substitutions))
  })
  const economics = parts[0]!
  economics.records = parts.flatMap(part => part.records)
  const catalog = economics.definitions.find(value => value.kind === 'model-catalog')!
  if (catalog.kind !== 'model-catalog') throw new Error('catalog fixture')
  catalog.models = parts.flatMap(part => part.definitions.filter(value => value.kind === 'model-catalog').flatMap(value => value.models))
  for (const model of catalog.models) model.pricingSnapshotDigest = digestJson(economics.records.find(value => value.kind === 'PricingSnapshotV1' && value.value.id === model.pricingSnapshotId)!.value)
  Object.assign(catalog, seal(catalog))
  economics.definitions = [
    ...economics.definitions.filter(value => value.kind === 'fleet' || value.kind === 'host'), catalog,
    ...parts.flatMap(part => part.definitions.filter(value => !['fleet', 'host', 'model-catalog'].includes(value.kind))),
  ]
  const fleet = economics.definitions.find(value => value.kind === 'fleet')!
  if (fleet.kind !== 'fleet') throw new Error('fleet fixture')
  fleet.accountIds = ['account-1', 'account-2', 'account-3']
  for (const entry of economics.records) {
    if (entry.kind === 'ModelRoleAssignmentV1') entry.value.catalogDigest = catalog.digest
    if (entry.kind === 'UsageEventV1') { const { eventDigest: _digest, ...payload } = entry.value; entry.value.eventDigest = digestJson(payload) }
  }
  for (const item of economics.definitions) {
    if (item.kind === 'request') {
      item.assignmentDigest = digestJson(economics.records.find(value => value.kind === 'ModelRoleAssignmentV1' && value.value.id === item.assignmentId)!.value)
      item.reservationDigest = digestJson(economics.records.find(value => value.kind === 'ReservationV1' && value.value.id === item.reservationId)!.value)
      item.pricingSnapshotDigest = digestJson(economics.records.find(value => value.kind === 'PricingSnapshotV1' && value.value.id === item.pricingSnapshotId)!.value)
      item.usageEventDigests = item.usageEventIds.map(id => { const event = economics.records.find(value => value.kind === 'UsageEventV1' && value.value.id === id)!; return event.kind === 'UsageEventV1' ? event.value.eventDigest : '' })
    }
    if (item.kind === 'quota-decision') {
      item.reservationDigest = digestJson(economics.records.find(value => value.kind === 'ReservationV1' && value.value.id === item.reservationId)!.value)
      for (const snapshot of item.snapshots) snapshot.quotaDigest = digestJson(economics.records.find(value => value.kind === 'ProviderQuotaV1' && value.value.id === snapshot.quotaId)!.value)
    }
    Object.assign(item, seal(item))
  }
  const artifacts = [...verification.artifacts, ...economics.artifacts]
  const artifact = (id: string, payload: unknown) => {
    const bytes = Buffer.from(canonicalJson(payload)), digest = digestBytes(bytes)
    const reference = { id, projectId: base.projectId, mediaType: 'application/json', sizeBytes: bytes.length, digest }
    artifacts.push({ reference, bytesBase64: bytes.toString('base64') }); return reference
  }
  const compactCatalog = artifact('source-catalog-projection', { schemaVersion: 1, revision: catalog.revision, models: catalog.models.map(({ provider, deploymentId, modelVersion }) => ({ provider, deploymentId, modelVersion })) })
  const criticCatalog = artifact('critic-catalog-projection', { revision: catalog.revision, models: catalog.models.map(({ provider, modelVersion }) => ({ provider, modelVersion })) })
  const prices = economics.records.find(value => value.kind === 'PricingSnapshotV1')!
  if (prices.kind !== 'PricingSnapshotV1') throw new Error('pricing fixture')
  const pricing = artifact('source-pricing-projection', { schemaVersion: 1, revision: prices.value.revision, provider: prices.value.provider, modelVersion: prices.value.modelVersion,
    currency: prices.value.currency, inputMicrosPerMillion: prices.value.inputMicrosPerMillion, outputMicrosPerMillion: prices.value.outputMicrosPerMillion })
  for (const item of verification.definitions) { if (item.kind === 'model-assignment') item.catalog = criticCatalog; Object.assign(item, seal(item)) }
  verification.artifacts = artifacts
  const policy = verification.definitions.find(value => value.kind === 'policy')!
  if (policy.kind !== 'policy') throw new Error('policy fixture')
  const route = policy.policy.ingestion.routes[0]!, log = compiledSpec.provenance[0]!
  const envelope = { ...examples.InboundEnvelopeV1, id: compiledSpec.source.envelopeId, artifact: log, bodyDigest: log.digest, routeId: route.id, adapterVersion: route.providerVersion, signingKeyId: route.signingKeyId }
  const work = { ...examples.InboundWorkItemV1, id: 'work-1', ...compiledSpec.source, provenance: [log] }
  const context = compilerHostContextSchema.parse({ outcomeId: 'compiler-1', specId: compiledSpec.id, ingress: work, priority: compiledSpec.priority, risk: compiledSpec.risk, purposeId: 'repair-api', baseCommit: compiledSpec.baseCommit,
    policyDigest: compiledSpec.policyDigest, rulesDigest: compiledSpec.rulesDigest, toolchainDigest: compiledSpec.toolchainDigest, workflowDigest: compiledSpec.workflowDigest,
    compilerRevision: compiledSpec.compilerRevision, promptRevision: compiledSpec.promptRevision, modelAssignmentId: compiledSpec.modelAssignmentId, authorityProvenance: [log], purposeGrants: [],
    registries: { checks: [{ id: 'api-contract', commandId: 'unit', conflictsWith: [] }], commands: policy.policy.verification.commands,
      fixtures: [{ id: 'empty-request', runnable: true, commandIds: ['unit'], assertionIds: ['status-400'] }], assertions: [{ id: 'status-400', runnable: true }], capabilities: ['typescript'],
      paths: [{ id: 'handler', path: 'src/handler.ts' }], controlledPaths: [], reproductions: [{ id: 'reproduction-1', sourceRevision: work.sourceRevision, artifact: log, expected: '400', actual: '500', fixtureId: 'empty-request', commandId: 'unit' }] },
  })
  const compiled = new SpecCompilerSession(context).evaluate({ outcome: 'COMPILED', spec: { objective: compiledSpec.objective, nonGoals: compiledSpec.nonGoals, invariants: compiledSpec.invariants,
    acceptanceScenarios: compiledSpec.acceptanceScenarios.map(({ reproduction: _reproduction, expected: _expected, actual: _actual, ...scenario }) => ({ ...scenario, reproductionId: 'reproduction-1' })), allowedPathIds: ['handler'], requiredCapabilities: compiledSpec.requiredCapabilities } }, context.ingress)
  if (compiled.outcome.outcome !== 'COMPILED' || canonicalJson(compiled.outcome.spec) !== canonicalJson(compiledSpec)) throw new Error('Cross-lane compiler fixture disagrees with verification spec')
  const workflow = verification.definitions.find(value => value.kind === 'workflow')!
  if (workflow.kind !== 'workflow') throw new Error('workflow fixture')
  const source = referenceGraphInputSchema.parse({ ...base, lane: 'source-admission', artifacts,
    definitions: [registration('workflow', workflow.id, { definition: workflow.definition, definitionDigest: digestJson(workflow.definition), taskIds: workflow.taskIds }),
      ...verification.definitions.filter(value => value.kind === 'task').map(value => registration('task', value.id, { workflowId: value.workflowId, stepId: value.stepId, subject: value.subject })),
      ...verification.definitions.filter(value => value.kind === 'attempt').map(value => registration('attempt', value.id, { taskId: value.taskId, generation: value.generation })),
      registration('model-assignment', compiledSpec.modelAssignmentId, { attemptId: 'attempt-1', generation: 1, provider: 'fixture', deploymentId: 'fixture-1', modelVersion: 'fixture-v1', catalogRevision: 1, pricingRevision: 1, catalog: compactCatalog, pricing }),
      registration('compiler-context', 'compiler-registry', { context })],
    records: [{ kind: 'InboundEnvelopeV1', value: envelope }, { kind: 'InboundWorkItemV1', value: work }, { kind: 'IngressReceiptV1', value: { ...examples.IngressReceiptV1, envelopeId: envelope.id, bodyDigest: envelope.bodyDigest, receivedAt: envelope.receivedAt } },
      { kind: 'ExecutableSpecV1', value: compiledSpec }, { kind: 'CompilerOutcomeV1', value: compiled.outcome },
      { kind: 'AdmissionReceiptV1', value: { ...examples.AdmissionReceiptV1, specId: compiledSpec.id, specDigest: compiledSpec.specDigest, policyDigest: compiledSpec.policyDigest, workflowId: workflow.id, workflowDigest: compiledSpec.workflowDigest, taskIds: workflow.taskIds } }],
  })
  const quarantine = quarantineReferenceGraphInputSchema.parse({ ...base, lane: 'quarantine-health', envelopes: [envelope], workItems: [], admissions: [], releases: [], specs: [], definitions: [],
    artifacts: artifacts.filter(value => value.reference.id === log.id),
    incidents: [{ ...base, id: 'ingress-warning', revision: 1, source: 'darkfactory', stage: 'ingress', reason: 'SANITIZED_ATTACHMENT', effectId: envelope.id, evidenceRefs: [envelope.id, log.id], severity: 'warning', diagnostics: 'Attachment was sanitized; retained source remains authenticated.', raisedAt: Date.parse(envelope.receivedAt), cooldownUntil: Date.parse(envelope.receivedAt) + 1000 }],
    events: [{ ...base, id: 'ingress-event', version: 1, sequence: 1, expectedRecordRevision: 0, recordId: envelope.id, eventKind: 'sanitized', occurredAt: envelope.receivedAt, severity: 'warning', reasonCode: 'SANITIZED_ATTACHMENT', healthEscalationId: 'ingress-warning', artifacts: [log] }],
  })
  return referenceSnapshotSchema.parse({ ...base, scope: { coverage: 'all-lanes', lanes: ['source-admission', 'verification-release', 'fleet-economics', 'quarantine-health'] }, graphs: [source, verification, economics, quarantine] })
}

export function scopedReferenceSnapshotFixture(lanes: ReferenceSnapshot['scope']['lanes']): ReferenceSnapshot {
  const input = referenceSnapshotFixture()
  input.scope = { coverage: 'declared-lanes', lanes }
  input.graphs = input.graphs.filter(graph => lanes.includes(graph.lane))
  return input
}

/** Quarantine before final release acceptance, retaining the exact observed deployment/evidence. */
export function quarantinedReleaseSnapshotFixture(): ReferenceSnapshot {
  const input = referenceSnapshotFixture()
  const source = input.graphs.find(graph => graph.lane === 'source-admission')!
  const verification = input.graphs.find(graph => graph.lane === 'verification-release')!
  const quarantine = input.graphs.find(graph => graph.lane === 'quarantine-health')!
  if (source.lane !== 'source-admission' || verification.lane !== 'verification-release' || quarantine.lane !== 'quarantine-health') throw new Error('fixture lanes')
  const workflow = verification.definitions.find(value => value.kind === 'workflow')!
  const spec = verification.definitions.find(value => value.kind === 'spec')!
  if (workflow.kind !== 'workflow' || spec.kind !== 'spec') throw new Error('fixture definitions')
  const ids = ['reproduction-task', 'task-1', 'critic-task-1', 'integration-task', 'release-task']
  verification.definitions = verification.definitions.filter(value => value.kind !== 'task')
  workflow.taskIds = ids
  for (const [index, step] of workflow.definition.steps.entries()) verification.definitions.push(registration('task', ids[index]!, { workflowId: workflow.id, stepId: step.id, subject: step.title, specDigest: spec.spec.specDigest }) as typeof verification.definitions[number])
  for (const definition of verification.definitions) {
    if (definition.kind === 'attempt' && definition.taskId === 'critic-task-2') definition.taskId = 'critic-task-1'
    Object.assign(definition, seal(definition))
  }
  source.definitions = source.definitions.filter(value => !['workflow', 'task', 'attempt'].includes(value.kind))
  source.definitions.push(registration('workflow', workflow.id, { definition: workflow.definition, definitionDigest: digestJson(workflow.definition), taskIds: ids }) as typeof source.definitions[number])
  for (const definition of verification.definitions) {
    if (definition.kind === 'task') source.definitions.push(registration('task', definition.id, { workflowId: definition.workflowId, stepId: definition.stepId, subject: definition.subject }) as typeof source.definitions[number])
    if (definition.kind === 'attempt') source.definitions.push(registration('attempt', definition.id, { taskId: definition.taskId, generation: definition.generation }) as typeof source.definitions[number])
  }
  for (const entry of source.records) if (entry.kind === 'AdmissionReceiptV1') entry.value.taskIds = ids
  const release = verification.records.find(entry => entry.kind === 'ReleaseRecordV1')!
  if (release.kind !== 'ReleaseRecordV1') throw new Error('fixture release')
  release.value.state = 'quarantined'; release.value.healthEscalationId = 'release-incident'
  quarantine.releases = [structuredClone(release.value)]
  quarantine.specs = [structuredClone(spec.spec)]
  quarantine.workItems = source.records.filter(entry => entry.kind === 'InboundWorkItemV1').map(entry => structuredClone(entry.value))
  quarantine.definitions = source.definitions.filter(value => ['workflow', 'task', 'attempt'].includes(value.kind)).map(value => structuredClone(value))
  quarantine.artifacts = structuredClone(verification.artifacts)
  const occurredAt = '2026-09-06T12:30:00Z', reference = release.value.artifact
  quarantine.incidents.push({ ...base, id: 'release-incident', revision: 1, source: 'darkfactory', stage: 'release', reason: 'AUTHORITY_REVOKED', effectId: release.value.id,
    evidenceRefs: [release.value.id, reference.id], severity: 'critical', diagnostics: 'Release authority was revoked before final acceptance.', raisedAt: Date.parse(occurredAt), cooldownUntil: Date.parse(occurredAt) + 1000 })
  quarantine.events.push({ ...base, id: 'release-quarantined', version: 1, sequence: 2, expectedRecordRevision: release.value.revision - 1,
    recordId: release.value.id, releaseId: release.value.id, workflowId: release.value.workflowId, attemptId: release.value.attemptIds[0]!,
    eventKind: 'quarantined', occurredAt, severity: 'error', reasonCode: 'AUTHORITY_REVOKED', healthEscalationId: 'release-incident', artifacts: [reference] })
  return referenceSnapshotSchema.parse(input)
}

/** Native per-item received -> trusted -> compiled -> admitted -> terminal chain. */
export function workLifecycleSnapshotFixture(state: 'compiled' | 'admitted' | 'acknowledged' | 'quarantined'): ReferenceSnapshot {
  const input = referenceSnapshotFixture(), source = input.graphs.find(graph => graph.lane === 'source-admission')!, quarantine = input.graphs.find(graph => graph.lane === 'quarantine-health')!
  if (source.lane !== 'source-admission' || quarantine.lane !== 'quarantine-health') throw new Error('fixture source lanes')
  const entry = source.records.find(value => value.kind === 'InboundWorkItemV1')!, context = source.definitions.find(value => value.kind === 'compiler-context')!
  if (entry.kind !== 'InboundWorkItemV1' || context.kind !== 'compiler-context') throw new Error('fixture compiler source')
  const trusted = { ...structuredClone(entry.value), revision: 2 }
  const received = { ...structuredClone(trusted), state: 'received' as const, revision: 1, trust: { ...trusted.trust, decision: 'unresolved' as const, reasons: ['AUTHORITY_PENDING'] } }
  context.context.ingress = structuredClone(trusted); Object.assign(context, seal(context))
  const versions = [received, trusted]
  versions.push({ ...structuredClone(trusted), state: 'compiled', revision: 3 })
  if (state !== 'compiled') versions.push({ ...structuredClone(trusted), state: 'admitted', revision: 4 })
  if (state === 'acknowledged') versions.push({ ...structuredClone(trusted), state, revision: 5 })
  if (state === 'quarantined') versions.push({ ...structuredClone(trusted), state, revision: 5, quarantineReason: 'SOURCE_REVOKED', healthEscalationId: 'work-incident', trust: { ...trusted.trust, decision: 'revoked', reasons: ['SOURCE_REVOKED'] } })
  entry.value = structuredClone(versions.at(-1)!)
  source.workHistories = [{ workItemId: entry.value.id, versions }]
  quarantine.workItems = [structuredClone(entry.value)]
  if (state === 'quarantined') {
    const occurredAt = '2026-09-06T12:30:00Z', artifact = entry.value.provenance[0]!
    quarantine.incidents.push({ ...base, id: 'work-incident', revision: 1, source: 'darkfactory', stage: 'trust', reason: 'SOURCE_REVOKED', effectId: entry.value.id,
      evidenceRefs: [entry.value.id, entry.value.envelopeId, artifact.id], severity: 'critical', diagnostics: 'Authority revoked after immutable source compilation.', raisedAt: Date.parse(occurredAt), cooldownUntil: Date.parse(occurredAt) + 1000 })
    quarantine.events.push({ ...base, id: 'work-quarantined', version: 1, sequence: 2, expectedRecordRevision: entry.value.revision - 1,
      recordId: entry.value.id, eventKind: 'quarantined', occurredAt, severity: 'error', reasonCode: 'SOURCE_REVOKED', healthEscalationId: 'work-incident', artifacts: [artifact] })
  }
  return referenceSnapshotSchema.parse(input)
}

/** Native admission quarantine shares one incident with its exact source item. */
export function sharedAdmissionQuarantineSnapshotFixture(): ReferenceSnapshot {
  let input = quarantinedReleaseSnapshotFixture()
  const source = input.graphs.find(graph => graph.lane === 'source-admission')!, verification = input.graphs.find(graph => graph.lane === 'verification-release')!, quarantine = input.graphs.find(graph => graph.lane === 'quarantine-health')!
  if (source.lane !== 'source-admission' || verification.lane !== 'verification-release' || quarantine.lane !== 'quarantine-health') throw new Error('fixture lanes')
  const historyInput = workLifecycleSnapshotFixture('quarantined'), historicalSource = historyInput.graphs.find(graph => graph.lane === 'source-admission')!, historicalHealth = historyInput.graphs.find(graph => graph.lane === 'quarantine-health')!
  if (historicalSource.lane !== 'source-admission' || historicalHealth.lane !== 'quarantine-health') throw new Error('fixture history')
  source.workHistories = structuredClone(historicalSource.workHistories)
  source.records = source.records.map(entry => entry.kind === 'InboundWorkItemV1' ? structuredClone(historicalSource.records.find(value => value.kind === 'InboundWorkItemV1')!) : entry)
  source.definitions = source.definitions.map(entry => entry.kind === 'compiler-context' ? structuredClone(historicalSource.definitions.find(value => value.kind === 'compiler-context')!) : entry)
  quarantine.workItems = structuredClone(historicalHealth.workItems); quarantine.incidents = structuredClone(historicalHealth.incidents); quarantine.events = structuredClone(historicalHealth.events); quarantine.releases = []
  const release = verification.records.find(entry => entry.kind === 'ReleaseRecordV1')!
  if (release.kind !== 'ReleaseRecordV1') throw new Error('fixture release')
  release.value.state = 'accepted'; delete release.value.healthEscalationId
  const spec = source.records.find(entry => entry.kind === 'ExecutableSpecV1')!, compiler = source.records.find(entry => entry.kind === 'CompilerOutcomeV1')!, workflow = source.definitions.find(value => value.kind === 'workflow')!, context = source.definitions.find(value => value.kind === 'compiler-context')!
  if (spec.kind !== 'ExecutableSpecV1' || compiler.kind !== 'CompilerOutcomeV1' || workflow.kind !== 'workflow' || context.kind !== 'compiler-context') throw new Error('fixture plan')
  const plan = planAdmission({ registeredLeadId: 'lead', spec: spec.value, compilerOutcome: compiler.value, compilerCursor: { schemaVersion: 1, contextDigest: digestJson(context.context), malformedAttempts: 0, phase: 'finished' }, workflow: { template: workflow.definition, parameters: { subject: 'Fixture repair' } }, policyRefs: { policyRecordId: 'policy-1', decisionReceiptId: 'decision-1' } })
  const receiptEntry = source.records.find(entry => entry.kind === 'AdmissionReceiptV1')!
  if (receiptEntry.kind !== 'AdmissionReceiptV1') throw new Error('fixture receipt')
  const substitutions = new Map([[workflow.id, plan.workflowId], [receiptEntry.value.id, plan.admissionId], ...workflow.taskIds.map((id, index) => [id, plan.plannedSteps[index]!.taskId] as [string, string])])
  receiptEntry.value.state = 'quarantined'; receiptEntry.value.revision = 3
  const incident = quarantine.incidents.find(value => value.id === 'work-incident')!
  incident.stage = 'admission'; incident.effectId = plan.admissionId; incident.evidenceRefs = [plan.admissionId, spec.value.id, quarantine.workItems[0]!.id]
  input = referenceSnapshotSchema.parse(replace(input, substitutions))
  const updatedSource = input.graphs.find(graph => graph.lane === 'source-admission')!, updatedQuarantine = input.graphs.find(graph => graph.lane === 'quarantine-health')!, updatedVerification = input.graphs.find(graph => graph.lane === 'verification-release')!
  if (updatedSource.lane !== 'source-admission' || updatedQuarantine.lane !== 'quarantine-health' || updatedVerification.lane !== 'verification-release') throw new Error('fixture updated lanes')
  const receipt = updatedSource.records.find(entry => entry.kind === 'AdmissionReceiptV1')!
  if (receipt.kind !== 'AdmissionReceiptV1') throw new Error('fixture updated receipt')
  updatedQuarantine.admissions = [{ id: plan.admissionId, projectId: base.projectId, revision: 3, intent: plan, receipt: receipt.value, status: 'quarantined', barrier: 'closed', createdAt: '2026-09-06T11:00:00Z', updatedAt: '2026-09-06T12:30:00Z', quarantineReason: 'SOURCE_REVOKED', healthEscalationId: 'work-incident' }]
  updatedQuarantine.events.push({ ...updatedQuarantine.events.find(event => event.id === 'work-quarantined')!, id: 'admission-quarantined', sequence: 3, recordId: plan.admissionId, expectedRecordRevision: 2 })
  const evidence = updatedVerification.records.find(entry => entry.kind === 'VerificationEvidenceV1')!
  if (evidence.kind !== 'VerificationEvidenceV1') throw new Error('fixture evidence')
  const { evidenceHash, signature: _signature, ...payload } = evidence.value
  input = referenceSnapshotSchema.parse(replace(input, new Map([[evidenceHash, digestJson(payload)]])))
  for (const graph of input.graphs) for (const definition of graph.definitions) Object.assign(definition, seal(definition))
  return input
}
