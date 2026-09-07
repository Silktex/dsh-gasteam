/** Shared synthetic compiler input; registered fixture IDs never come from provider prose. */
import { compilerHostContextSchema } from '../../src/darkfactory/spec-compiler.ts'
import { inboundEnvelopeSchema, inboundWorkItemSchema } from '../../src/darkfactory/contracts/ingestion.ts'
import { pinWorkflowDefinition } from '../../src/workflows.ts'
import { darkFactoryTemplate } from '../../src/workflow-templates.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
import { examples, spec, digest } from './fixtures.ts'

function context() {
  return compilerHostContextSchema.parse({
    outcomeId: 'compiler-1', specId: 'spec-1', ingress: examples.InboundWorkItemV1,
    priority: 50, risk: 'low', purposeId: 'repair-api', baseCommit: spec.baseCommit,
    policyDigest: digest, rulesDigest: digest, toolchainDigest: digest, workflowDigest: digest,
    compilerRevision: 1, promptRevision: 1, modelAssignmentId: 'model-1',
    authorityProvenance: [{ ...spec.provenance[0], id: 'authority-1' }],
    registries: {
      checks: [{ id: 'api-check', commandId: 'unit', conflictsWith: [] }],
      commands: [{ id: 'unit', executable: '/usr/bin/node', args: ['trusted-test-runner'], deadlineMs: 1000 }],
      fixtures: [{ id: 'empty-request', runnable: true, commandIds: ['unit'], assertionIds: ['status-400'] }],
      assertions: [{ id: 'status-400', runnable: true }], capabilities: ['typescript'],
      paths: [{ id: 'handler', path: 'src/handler.ts' }, { id: 'all-source', path: 'src' }],
      controlledPaths: [{ path: 'src/authorization', class: 'authorization' }],
      reproductions: [{ id: 'repro-1', sourceRevision: spec.source.sourceRevision, artifact: spec.provenance[0], expected: '400', actual: '500', fixtureId: 'empty-request', commandId: 'unit' }],
    }, purposeGrants: [],
  })
}
function proposal() {
  return {
    outcome: 'COMPILED', spec: {
      objective: 'Repair empty requests', nonGoals: ['No API redesign'],
      invariants: [{ id: 'invariant-1', description: 'Keep API contract', checkId: 'api-check' }],
      acceptanceScenarios: [{ id: 'scenario-1', description: 'Empty request returns 400', fixtureId: 'empty-request', assertionIds: ['status-400'], commandId: 'unit', reproductionId: 'repro-1' }],
      allowedPathIds: ['handler'], requiredCapabilities: ['typescript'],
    },
  }
}

export function compilationFixture() {
  const initial = inboundWorkItemSchema.parse({ ...examples.InboundWorkItemV1, state: 'received', trust: { ...examples.InboundWorkItemV1.trust, decision: 'unresolved' } })
  const trusted = inboundWorkItemSchema.parse({ ...initial, revision: 2, state: 'trusted', trust: { ...initial.trust, decision: 'trusted' } })
  const workflow = { template: structuredClone(darkFactoryTemplate), parameters: { subject: 'durable compiler fixture' } }
  const host = { ...context(), ingress: trusted, workflowDigest: digestJson(pinWorkflowDefinition(workflow.template, workflow.parameters)) }
  return { input: { context: host, registeredLeadId: 'lead', workflow, policyRefs: { policyRecordId: 'policy', decisionReceiptId: 'decision' } },
    initial, envelope: inboundEnvelopeSchema.parse({ ...examples.InboundEnvelopeV1, id: initial.envelopeId }), proposal: proposal() }
}
