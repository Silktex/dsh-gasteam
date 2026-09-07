import { referenceGraphInputSchema, type ReferenceGraphInput } from '../../src/darkfactory/contracts/reference-graph.ts'
import { compilerHostContextSchema, SpecCompilerSession } from '../../src/darkfactory/spec-compiler.ts'
import { validateWorkflowTemplate } from '../../src/workflows.ts'
import { canonicalJson, digestBytes, digestJson } from '../../src/darkfactory/json.ts'
import { examples } from './fixtures.ts'
import { enabledPolicy } from './config-fixture.ts'
import { githubReconciliationRegistrationSchema } from '../../src/darkfactory/config.ts'
import type { InboundEnvelopeV1, InboundWorkItemV1 } from '../../src/darkfactory/contracts/ingestion.ts'

function artifact(id: string, value: unknown) {
  const bytes = Buffer.from(canonicalJson(value))
  return { reference: { id, projectId: 'project-1', mediaType: 'application/json', sizeBytes: bytes.length, digest: digestBytes(bytes) }, bytesBase64: bytes.toString('base64') }
}
export function sourceReferenceGraphFixture(scanner = false): ReferenceGraphInput {
  const source = artifact('source-artifact', { observation: 'source fixture' })
  const authority = artifact('authority-artifact', { authority: 'synthetic registry' })
  const policySnapshot = enabledPolicy()
  policySnapshot.mode = 'build'; policySnapshot.projectIds = ['project-1']
  policySnapshot.ingestion.routes[0]!.projectId = 'project-1'
  policySnapshot.fleet.projectCaps[0]!.id = 'project-1'
  policySnapshot.verification.checkIds = ['api-check']; policySnapshot.verification.fixtureIds = ['empty-request']
  policySnapshot.verification.commands = [{ id: 'unit', executable: '/usr/bin/node', args: ['trusted-tests'], deadlineMs: 1000 }]
  if (scanner) {
    const route = policySnapshot.ingestion.routes[0]!
    if (route.source !== 'github') throw new Error('Expected GitHub route')
    route.senderIds.push('host-scanner:fixture')
    route.bindings.authorIds = [examples.InboundWorkItemV1.author]
    route.reconciliation = githubReconciliationRegistrationSchema.parse({ installationId: route.bindings.installationIds[0], repositoryId: route.repositoryIds[0], repositoryName: 'owner/repo', credentialRef: { kind: 'env', name: 'GITHUB_FIXTURE_TOKEN' }, credentialKind: 'installation-token',
      scan: { scannerId: 'host-scanner:fixture', ruleId: 'rule', initialSince: '2026-09-06T00:00:00Z' } })
  }
  const policy = artifact('policy-artifact', policySnapshot)
  const rules = artifact('rules-artifact', { rulesRevision: 1, rule: 'api-check' })
  const toolchain = artifact('toolchain-artifact', { toolchain: 'fixture-v1' })
  const reproduction = artifact('reproduction-artifact', { fixture: 'empty-request', expected: '400', actual: '500' })
  const catalog = artifact('catalog-artifact', { schemaVersion: 1, revision: 1, models: [{ provider: 'fixture', deploymentId: 'fixture-deployment', modelVersion: 'fixture-v1' }] })
  const pricing = artifact('pricing-artifact', { schemaVersion: 1, revision: 1, provider: 'fixture', modelVersion: 'fixture-v1', currency: 'USD', inputMicrosPerMillion: 100, outputMicrosPerMillion: 200 })
  const workflow = validateWorkflowTemplate({ format: 'agent-team-workflow/v1', id: 'registered-fixture', version: 1, parameters: {},
    steps: [{ id: 'implement', title: 'Implement fixture', dependsOn: [], retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { requires: [], produces: ['result'] }, acceptance: { kind: 'report-review' } }] })
  const workflowDigest = digestJson(workflow)
  let envelope: InboundEnvelopeV1 = { ...examples.InboundEnvelopeV1, id: 'envelope-1', artifact: source.reference, bodyDigest: source.reference.digest,
    routeId: policySnapshot.ingestion.routes[0]!.id, adapterVersion: policySnapshot.ingestion.routes[0]!.providerVersion, signingKeyId: policySnapshot.ingestion.routes[0]!.signingKeyId }
  let work: InboundWorkItemV1 = { ...examples.InboundWorkItemV1, id: 'work-1', envelopeId: envelope.id, provenance: [source.reference] }
  if (scanner) {
    const { signingKeyId: _key, ...fields } = envelope
    envelope = { ...fields, source: 'github', authentication: 'provider-api', providerRead: { scannerId: 'host-scanner:fixture', ruleId: 'rule', requestReceiptId: 'provider-request-1', responseDigest: digestJson('provider-response'), observedAt: envelope.receivedAt } }
    work = { ...work, actor: 'host-scanner:fixture', labels: ['automate'], initiator: { kind: 'host-scanner', scannerId: 'host-scanner:fixture', ruleId: 'rule' } }
  }
  const host = compilerHostContextSchema.parse({
    outcomeId: 'compiler-1', specId: 'spec-1', ingress: work, priority: 50, risk: 'low', purposeId: 'repair-api', baseCommit: 'b'.repeat(40),
    policyDigest: policy.reference.digest, rulesDigest: rules.reference.digest, toolchainDigest: toolchain.reference.digest, workflowDigest,
    compilerRevision: 1, promptRevision: 1, modelAssignmentId: 'compiler-model', authorityProvenance: [authority.reference],
    registries: {
      checks: [{ id: 'api-check', commandId: 'unit', conflictsWith: [] }],
      commands: [{ id: 'unit', executable: '/usr/bin/node', args: ['trusted-tests'], deadlineMs: 1000 }],
      fixtures: [{ id: 'empty-request', runnable: true, commandIds: ['unit'], assertionIds: ['status-400'] }],
      assertions: [{ id: 'status-400', runnable: true }], capabilities: ['typescript'], paths: [{ id: 'handler', path: 'src/handler.ts' }], controlledPaths: [],
      reproductions: [{ id: 'reproduction-1', sourceRevision: work.sourceRevision, artifact: reproduction.reference, expected: '400', actual: '500', fixtureId: 'empty-request', commandId: 'unit' }],
    }, purposeGrants: [],
  })
  const compiled = new SpecCompilerSession(host).evaluate({ outcome: 'COMPILED', spec: {
    objective: 'Fix empty request handling', nonGoals: [], invariants: [{ id: 'invariant-1', description: 'Preserve API', checkId: 'api-check' }],
    acceptanceScenarios: [{ id: 'scenario-1', description: 'Return 400', fixtureId: 'empty-request', assertionIds: ['status-400'], commandId: 'unit', reproductionId: 'reproduction-1' }],
    allowedPathIds: ['handler'], requiredCapabilities: ['typescript'],
  } }, host.ingress)
  if (compiled.outcome.outcome !== 'COMPILED') throw new Error('Invalid graph compiler fixture')
  const common = { schemaVersion: 1, projectId: 'project-1', policyRevision: 1, revision: 1 }
  const registrations = [
    { ...common, kind: 'workflow', id: 'workflow-1', definition: workflow, definitionDigest: workflowDigest, taskIds: ['task-1'] },
    { ...common, kind: 'task', id: 'task-1', workflowId: 'workflow-1', stepId: 'implement', subject: 'Implement fixture' },
    { ...common, kind: 'attempt', id: 'compiler-attempt', taskId: 'task-1', generation: 1 },
    { ...common, kind: 'model-assignment', id: 'compiler-model', attemptId: 'compiler-attempt', generation: 1, provider: 'fixture', deploymentId: 'fixture-deployment', modelVersion: 'fixture-v1', catalogRevision: 1, pricingRevision: 1, catalog: catalog.reference, pricing: pricing.reference },
    { ...common, kind: 'compiler-context', id: 'compiler-registry', context: host },
    ...(scanner ? [{ ...common, kind: 'provider-request', id: 'provider-request-1', receipt: { schemaVersion: 1, id: 'provider-request-1', projectId: common.projectId, routeId: envelope.routeId, at: envelope.receivedAt } }] : []),
  ].map(value => ({ ...value, digest: digestJson(value) }))
  return referenceGraphInputSchema.parse({ schemaVersion: 1, lane: 'source-admission', projectId: 'project-1', policyRevision: 1,
    artifacts: [source, authority, policy, rules, toolchain, reproduction, catalog, pricing], definitions: registrations,
    records: [
      { kind: 'InboundEnvelopeV1', value: envelope }, { kind: 'InboundWorkItemV1', value: work },
      { kind: 'IngressReceiptV1', value: { ...examples.IngressReceiptV1, envelopeId: envelope.id, bodyDigest: envelope.bodyDigest, receivedAt: envelope.receivedAt } },
      { kind: 'ExecutableSpecV1', value: compiled.outcome.spec }, { kind: 'CompilerOutcomeV1', value: compiled.outcome },
      { kind: 'AdmissionReceiptV1', value: { ...examples.AdmissionReceiptV1, specId: compiled.outcome.spec.id, specDigest: compiled.outcome.spec.specDigest, policyDigest: host.policyDigest, workflowId: 'workflow-1', workflowDigest, taskIds: ['task-1'] } },
    ],
  })
}
