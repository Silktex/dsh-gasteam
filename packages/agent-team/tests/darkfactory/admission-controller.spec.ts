import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DarkFactoryAdmissionController } from '../../src/darkfactory/admission-controller.ts'
import { DarkFactoryAdmissionStore } from '../../src/darkfactory/admission-store.ts'
import { DarkFactoryIngestionStore } from '../../src/darkfactory/ingestion-store.ts'
import { HealthStore } from '../../src/health.ts'
import { FactoryMaterializationConflictError } from '../../src/workflow-runtime.ts'
import { pinExecutableSpec } from '../../src/darkfactory/contracts/spec.ts'
import { inboundEnvelopeSchema, inboundWorkItemSchema } from '../../src/darkfactory/contracts/ingestion.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
import { pinWorkflowDefinition, validateWorkflowTemplate } from '../../src/workflows.ts'
import { implementationTestReviewIntegrationTemplate } from '../../src/workflow-templates.ts'
import { examples } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'factory-admission-controller-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const template = validateWorkflowTemplate(implementationTestReviewIntegrationTemplate)
  const workflow = { template, parameters: { subject: 'durable scope' } }
  const { specDigest, ...payload } = examples.ExecutableSpecV1
  const spec = pinExecutableSpec({ ...payload, workflowDigest: digestJson(pinWorkflowDefinition(template, workflow.parameters)) })
  const intent = { registeredLeadId: 'lead', spec, workflow,
    compilerOutcome: { schemaVersion: 1 as const, id: 'outcome', projectId: 'project-1', policyRevision: 1, source: spec.source, outcome: 'COMPILED' as const, reasons: ['Compiled registered evidence'], spec },
    compilerCursor: { schemaVersion: 1 as const, contextDigest: digestJson('context'), malformedAttempts: 0, phase: 'finished' as const },
    policyRefs: { policyRecordId: 'policy', decisionReceiptId: 'decision' },
  }
  const options = { projectId: 'project-1', registeredLeadId: 'lead', workflowTemplates: [template] }
  let admissions = await DarkFactoryAdmissionStore.open(directory, options)
  let ingestion = await DarkFactoryIngestionStore.open(directory, { projectId: 'project-1' })
  const health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
  const initial = inboundWorkItemSchema.parse({ ...examples.InboundWorkItemV1, id: 'item', state: 'received', trust: { ...examples.InboundWorkItemV1.trust, decision: 'unresolved' } })
  await ingestion.recordReceived({ envelope: inboundEnvelopeSchema.parse({ ...examples.InboundEnvelopeV1, id: initial.envelopeId }), item: initial, bodySizeBytes: 100 })
  await ingestion.transition({ projectId: 'project-1', expectedRevision: 1, item: { ...initial, state: 'trusted', revision: 2, trust: { ...initial.trust, decision: 'trusted' } } })
  let denyAt = Infinity
  let authority = true, materializeCalls = 0, authorizeCalls = 0, mode: 'ok' | 'uncertain' | 'conflict' | 'wrong-receipt' = 'ok'
  const creations = new Map<string, string[]>()
  const openController = () => new DarkFactoryAdmissionController({ admissions, ingestion,
    authorize: async () => { authorizeCalls++; return authority && authorizeCalls < denyAt },
    quarantine: async input => (await health.raiseFactoryEscalation({ schemaVersion: 1, projectId: input.projectId, policyRevision: 1, stage: 'admission', reason: input.reason, effectId: input.admissionId, evidenceRefs: input.evidenceRefs, severity: 'warning', diagnostics: input.reason }, Date.now())).id,
    materialize: async record => {
      materializeCalls++
      // The callback sees an already synced full intent and compiled source, never an unrecorded plan.
      expect(admissions.snapshot().admissions[0]!.intent).toEqual(record.intent)
      expect(ingestion.snapshot().items[0]!.state).toBe('compiled')
      expect(record.barrier).toBe('closed')
      const journal = await readFile(join(directory, 'darkfactory/project-1/admission.jsonl'), 'utf8')
      expect(journal).toContain(record.intent.workflowId)
      if (mode === 'conflict') throw new FactoryMaterializationConflictError()
      creations.set(record.intent.workflowId, record.receipt.taskIds)
      if (mode === 'uncertain') throw new Error('provider-sensitive-detail')
      return { workflowId: record.intent.workflowId, workflowDigest: record.intent.spec.workflowDigest, taskIds: mode === 'wrong-receipt' ? ['wrong-task'] : record.receipt.taskIds }
    },
  })
  let controller = openController()
  cleanups.push(async () => { await controller.settled(); await admissions.close(); await ingestion.close(); await health.close() })
  return { intent, directory, health, creations, request: { projectId: 'project-1', itemId: 'item', intent },
    get admissions() { return admissions }, get ingestion() { return ingestion }, get controller() { return controller },
    get materializeCalls() { return materializeCalls }, get authorizeCalls() { return authorizeCalls },
    setMode(value: typeof mode) { mode = value }, revoke() { authority = false }, revokeAt(call: number) { denyAt = call },
    async reopen() { await controller.settled(); await admissions.close(); await ingestion.close(); admissions = await DarkFactoryAdmissionStore.open(directory, options); ingestion = await DarkFactoryIngestionStore.open(directory, { projectId: 'project-1' }); controller = openController() },
  }
}

describe('held admission orchestration', () => {
  it('persists full intent before effects and acknowledges both stores without opening a barrier', async () => {
    const f = await fixture()
    const record = await f.controller.admit(f.request)
    expect(record).toMatchObject({ status: 'acknowledged', barrier: 'closed' })
    expect(f.ingestion.snapshot().items[0]!.state).toBe('acknowledged')
    expect(f.materializeCalls).toBe(1)
    expect(f.authorizeCalls).toBe(5)
    const authorityCalls = f.authorizeCalls
    expect(await f.controller.admit(f.request)).toEqual(record)
    expect(f.materializeCalls).toBe(1)
    expect(f.authorizeCalls).toBe(authorityCalls)
    await f.reopen()
    expect(await f.controller.resume({ projectId: 'project-1', limit: 10 })).toEqual([])
    expect(f.admissions.snapshot().admissions[0]).toEqual(record)
    expect(f.health.listEscalations()).toEqual([])
  })

  it('replays uncertain materialization with original compiler/policy refs and deterministic host identities', async () => {
    const f = await fixture(); f.setMode('uncertain')
    await expect(f.controller.admit(f.request)).rejects.toMatchObject({ code: 'ADMISSION_MATERIALIZATION_PENDING' })
    const intent = f.admissions.snapshot().admissions[0]!.intent
    expect(f.admissions.snapshot().admissions[0]!.status).toBe('intended')
    expect(f.ingestion.snapshot().items[0]!.state).toBe('compiled')
    f.setMode('ok'); await f.reopen()
    const [record] = await f.controller.resume({ projectId: 'project-1', limit: 1 })
    expect(record).toMatchObject({ status: 'acknowledged', barrier: 'closed', intent })
    expect(f.creations.size).toBe(1)
    expect(f.materializeCalls).toBe(2)
    expect(f.health.listEscalations()).toEqual([])
  })

  it.each(['after-begin', 'after-materialized', 'after-admitted', 'after-acknowledge'])('resumes interruption %s from durable state without new caller refs', async boundary => {
    const f = await fixture()
    if (boundary === 'after-begin') {
      const original = f.admissions.begin.bind(f.admissions)
      f.admissions.begin = async request => { await original(request); throw new Error('fixture interruption') }
    } else if (boundary === 'after-materialized') {
      const original = f.admissions.recordMaterialized.bind(f.admissions)
      f.admissions.recordMaterialized = async request => { await original(request); throw new Error('fixture interruption') }
    } else if (boundary === 'after-admitted') {
      const original = f.ingestion.transition.bind(f.ingestion)
      f.ingestion.transition = async request => { const result = await original(request); if (request.item.state === 'admitted') throw new Error('fixture interruption'); return result }
    } else {
      const original = f.admissions.acknowledge.bind(f.admissions)
      f.admissions.acknowledge = async request => { await original(request); throw new Error('fixture interruption') }
    }
    try { await f.controller.admit(f.request) } catch { /* Synchronous CAS recovery may finish an acknowledged write in the same call. */ }
    await f.reopen()
    await f.controller.resume({ projectId: 'project-1', limit: 1 })
    expect(f.admissions.snapshot().admissions[0]).toMatchObject({ status: 'acknowledged', barrier: 'closed' })
    expect(f.ingestion.snapshot().items[0]!.state).toBe('acknowledged')
    expect(f.creations.size).toBe(1)
    expect(f.materializeCalls).toBe(1)
  })

  it.each(['conflict', 'wrong-receipt'] as const)('quarantines %s materialization against the real inbox while preserving intent', async mode => {
    const f = await fixture(); f.setMode(mode)
    const record = await f.controller.admit(f.request)
    expect(record).toMatchObject({ status: 'quarantined', barrier: 'closed', quarantineReason: 'MATERIALIZATION_CONFLICT' })
    expect(f.ingestion.snapshot().items[0]).toMatchObject({ state: 'quarantined', healthEscalationId: record.healthEscalationId })
    expect(f.health.listEscalations()).toMatchObject([{ id: record.healthEscalationId, source: 'darkfactory', stage: 'admission' }])
    await f.reopen()
    expect(await f.controller.resume({ projectId: 'project-1', limit: 1 })).toEqual([])
  })

  it('quarantines revoked authority before materialization and resumes an interrupted quarantine without another incident', async () => {
    const f = await fixture(); f.revoke()
    const transition = f.ingestion.transition.bind(f.ingestion)
    f.ingestion.transition = async () => { throw new Error('fixture interruption after admission quarantine') }
    await expect(f.controller.admit(f.request)).rejects.toThrow()
    expect(f.admissions.snapshot().admissions[0]!.status).toBe('quarantined')
    expect(f.ingestion.snapshot().items[0]!.state).toBe('trusted')
    f.ingestion.transition = transition
    await f.reopen(); await f.controller.resume({ projectId: 'project-1', limit: 1 })
    expect(f.ingestion.snapshot().items[0]!.state).toBe('quarantined')
    expect(f.materializeCalls).toBe(0)
    expect(f.health.listEscalations()).toHaveLength(1)
  })

  it('quarantines ingress on authority denial after immutable store acknowledgement and never repeats recovery effects', async () => {
    const f = await fixture(); f.revokeAt(5)
    await expect(f.controller.admit(f.request)).rejects.toMatchObject({ code: 'ADMISSION_AUTHORITY_DENIED' })
    const record = f.admissions.snapshot().admissions[0]!
    expect(record).toMatchObject({ status: 'acknowledged', barrier: 'closed' })
    expect(f.ingestion.snapshot().items[0]).toMatchObject({ state: 'quarantined', quarantineReason: 'AUTHORITY_REVOKED' })
    expect(f.health.listEscalations()).toHaveLength(1)
    const calls = f.authorizeCalls
    await f.reopen()
    expect(await f.controller.resume({ projectId: 'project-1', limit: 1 })).toEqual([])
    expect(f.authorizeCalls).toBe(calls)
    expect(f.materializeCalls).toBe(1)
    expect(f.admissions.snapshot().admissions[0]).toEqual(record)
  })

  it('treats changed receipt references as a real conflict and preserves acknowledged terminal history', async () => {
    const f = await fixture()
    const original = await f.controller.admit(f.request)
    await expect(f.controller.admit({ ...f.request, intent: { ...f.intent, policyRefs: { ...f.intent.policyRefs, decisionReceiptId: 'different-receipt' } } })).rejects.toMatchObject({ code: 'ADMISSION_INTENT_CONFLICT' })
    expect(f.admissions.snapshot().admissions[0]).toEqual(original)
    expect(f.ingestion.snapshot().items[0]!.state).toBe('acknowledged')
    expect(f.health.listEscalations()).toMatchObject([{ reason: 'ADMISSION_INTENT_CONFLICT' }])
    expect(f.materializeCalls).toBe(1)
  })

  it('rejects untrusted, cross-project, source-mismatched and unknown raw requests before admission writes', async () => {
    const f = await fixture()
    await expect(f.controller.admit({ ...f.request, projectId: 'other' })).rejects.toThrow(/identity/)
    await expect(f.controller.admit({ ...f.request, itemId: 'absent' })).rejects.toThrow(/identity/)
    await expect(f.controller.admit({ ...f.request, unknownSecretKey: 'secret' } as never)).rejects.toThrow('Invalid admission controller input: strict bounded JSON required')
    await expect(f.controller.resume({ projectId: 'project-1', limit: 101 })).rejects.toThrow(/strict bounded JSON/)
    const item = f.ingestion.snapshot().items[0]!
    await f.ingestion.transition({ projectId: item.projectId, expectedRevision: item.revision, item: { ...item, revision: item.revision + 1, state: 'quarantined', quarantineReason: 'SOURCE_DENIED', healthEscalationId: 'existing-host-health' } })
    await expect(f.controller.admit(f.request)).rejects.toThrow(/trusted work/)
    expect(f.admissions.snapshot().admissions).toEqual([])
    expect(f.materializeCalls).toBe(0)
  })
})
