import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DarkFactoryAdmissionStore, planAdmission, type AdmissionStoreOptions } from '../../src/darkfactory/admission-store.ts'
import { pinExecutableSpec } from '../../src/darkfactory/contracts/spec.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
import { pinWorkflowDefinition, validateWorkflowTemplate } from '../../src/workflows.ts'
import { implementationTestReviewIntegrationTemplate } from '../../src/workflow-templates.ts'
import { examples } from './fixtures.ts'

const directories: string[] = [], stores: DarkFactoryAdmissionStore[] = []
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
const template = validateWorkflowTemplate({ ...implementationTestReviewIntegrationTemplate, steps: [...implementationTestReviewIntegrationTemplate.steps,
  { id: 'report', title: 'Report integrated result', dependsOn: ['integrate'], retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { requires: [], produces: [] }, acceptance: { kind: 'report-review' } },
] })
function intent() {
  const workflow = { template, parameters: { subject: 'source-bound repair' } }
  const { specDigest, ...payload } = examples.ExecutableSpecV1
  const spec = pinExecutableSpec({ ...payload, workflowDigest: digestJson(pinWorkflowDefinition(template, workflow.parameters)) })
  return { registeredLeadId: 'registered-lead', spec,
    compilerOutcome: { schemaVersion: 1 as const, id: 'compiler-outcome', projectId: spec.projectId, policyRevision: spec.policyRevision, source: spec.source, reasons: ['Registered evidence compiled'], outcome: 'COMPILED' as const, spec },
    compilerCursor: { schemaVersion: 1 as const, contextDigest: digestJson({ pinned: 'host-context' }), malformedAttempts: 0, phase: 'finished' as const },
    workflow, policyRefs: { policyRecordId: 'policy-record', decisionReceiptId: 'policy-decision' },
  }
}
async function open(options: Partial<AdmissionStoreOptions> = {}, existing?: string) {
  const directory = existing ?? await mkdtemp(join(tmpdir(), 'factory-admission-'))
  if (!directories.includes(directory)) directories.push(directory)
  const store = await DarkFactoryAdmissionStore.open(directory, { projectId: 'project-1', registeredLeadId: 'registered-lead', workflowTemplates: [template], ...options }, () => '2026-09-06T12:00:00Z')
  stores.push(store)
  return { store, directory, filename: join(directory, 'darkfactory/project-1/admission.jsonl') }
}
const fence = (store: DarkFactoryAdmissionStore) => ({ projectId: 'project-1', expectedRevision: store.snapshot().revision })
const materialized = (store: DarkFactoryAdmissionStore) => {
  const record = store.snapshot().admissions[0]!
  return { ...fence(store), admissionId: record.id, workflowId: record.intent.workflowId, workflowDigest: record.intent.spec.workflowDigest, taskIds: record.receipt.taskIds }
}

describe('durable full-payload admission intent', () => {
  it('pins every stage before materialization and replays exact work/receipt identities while the barrier stays closed', async () => {
    const { store, directory, filename } = await open()
    const input = intent(), planned = planAdmission(input)
    const result = await store.begin({ ...fence(store), intent: input })
    expect(result).toMatchObject({ duplicate: false, record: { status: 'intended', barrier: 'closed', intent: { spec: input.spec, compilerOutcome: input.compilerOutcome, compilerCursor: input.compilerCursor, policyRefs: input.policyRefs } } })
    expect(result.record.intent).toEqual(planned)
    expect(result.record.intent.plannedSteps).toHaveLength(5)
    for (const step of result.record.intent.plannedSteps) {
      expect(step.intentId).toMatch(/^df-[a-f0-9]{64}$/)
      expect(step.taskId).toBe(`workflow-${step.intentId}`)
    }
    const bytes = await readFile(filename)
    expect(bytes.byteLength).toBe(store.snapshot().journalBytes)
    expect(JSON.parse(bytes.toString('utf8')).request.intent).toEqual(planned)
    const committed = store.snapshot()
    await store.close()
    const replay = (await open({}, directory)).store
    expect(replay.snapshot()).toEqual(committed)
    const duplicate = await replay.begin({ ...fence(replay), intent: input })
    expect(duplicate).toEqual({ record: result.record, duplicate: true })
    expect(replay.snapshot().admissions).toHaveLength(1)
    expect((await replay.recordMaterialized(materialized(replay))).record).toMatchObject({ status: 'materialized', barrier: 'closed', receipt: { state: 'admitted', taskIds: result.record.receipt.taskIds } })
    const acknowledged = await replay.acknowledge({ ...fence(replay), admissionId: result.record.id })
    expect(acknowledged.record).toMatchObject({ status: 'acknowledged', barrier: 'closed', receipt: { state: 'acknowledged' } })
    expect(acknowledged.record.intent).toEqual(planned)
    expect((await replay.acknowledge({ ...fence(replay), admissionId: result.record.id })).duplicate).toBe(true)
    const final = replay.snapshot()
    await replay.close()
    expect((await open({}, directory)).store.snapshot()).toEqual(final)
  })

  it('rejects stale CAS, unregistered authority, changed digests and strict input violations without writes', async () => {
    const { store, filename } = await open()
    const input = intent()
    const before = await readFile(filename)
    await expect(store.begin({ ...fence(store), expectedRevision: 1, intent: input })).rejects.toThrow(/Stale/)
    await expect(store.begin({ ...fence(store), projectId: 'other', intent: input })).rejects.toThrow(/Cross-project/)
    await expect(store.begin({ ...fence(store), intent: { ...input, registeredLeadId: 'other-lead' } })).rejects.toThrow(/Lead/)
    await expect(store.begin({ ...fence(store), intent: { ...input, spec: { ...input.spec, objective: 'changed without digest' } } })).rejects.toThrow(/binding/)
    await expect(store.begin({ ...fence(store), intent: { ...input, compilerCursor: { ...input.compilerCursor, phase: 'initial' } } })).rejects.toThrow(/binding/)
    await expect(store.begin({ ...fence(store), intent: input, 'secret-bearing-field': 'secret' } as never)).rejects.toThrow('Invalid admission authority input: strict bounded JSON required')
    await expect(store.begin({ ...fence(store), intent: { ...input, workflow: { ...input.workflow, parameters: { subject: 'changed pinned value' } } } })).rejects.toThrow(/binding/)
    expect(await readFile(filename)).toEqual(before)
  })

  it('rejects changed same-work intents and requires health-backed terminal quarantine without overwriting pins', async () => {
    const { store, filename } = await open()
    const input = intent(), initial = await store.begin({ ...fence(store), intent: input })
    const before = await readFile(filename)
    await expect(store.begin({ ...fence(store), intent: { ...input, policyRefs: { ...input.policyRefs, decisionReceiptId: 'changed-decision' } } })).rejects.toMatchObject({ code: 'ADMISSION_INTENT_CONFLICT' })
    await expect(store.quarantine({ ...fence(store), admissionId: initial.record.id, reason: 'SOURCE_CHANGED' } as never)).rejects.toThrow(/strict bounded JSON/)
    expect(await readFile(filename)).toEqual(before)
    const quarantine = await store.quarantine({ ...fence(store), admissionId: initial.record.id, reason: 'SOURCE_CHANGED', healthEscalationId: 'real-health-reference' })
    expect(quarantine.record).toMatchObject({ status: 'quarantined', barrier: 'closed', healthEscalationId: 'real-health-reference' })
    expect(quarantine.record.intent).toEqual(initial.record.intent)
    expect((await store.quarantine({ ...fence(store), admissionId: initial.record.id, reason: 'SOURCE_CHANGED', healthEscalationId: 'real-health-reference' })).duplicate).toBe(true)
    await expect(store.recordMaterialized(materialized(store))).rejects.toThrow(/Terminal/)
    await expect(store.quarantine({ ...fence(store), admissionId: initial.record.id, reason: 'OTHER', healthEscalationId: 'other-health' })).rejects.toThrow(/Terminal/)
  })

  it('validates host template registration and fences concurrent work identities and intent count', async () => {
    const { store, filename } = await open({ maxIntents: 1 })
    const input = intent()
    const unregistered = { ...input, workflow: { ...input.workflow, template: { ...template, id: 'unregistered-template' } } }
    const { specDigest, ...payload } = input.spec
    unregistered.spec = pinExecutableSpec({ ...payload, workflowDigest: digestJson(pinWorkflowDefinition(unregistered.workflow.template, unregistered.workflow.parameters)) })
    unregistered.compilerOutcome = { ...input.compilerOutcome, spec: unregistered.spec }
    await expect(store.begin({ ...fence(store), intent: unregistered })).rejects.toThrow(/not registered/)
    const begin = { ...fence(store), intent: input }
    const attempts = await Promise.allSettled([store.begin(begin), store.begin(begin)])
    expect(attempts.map(attempt => attempt.status).sort()).toEqual(['fulfilled', 'rejected'])
    const before = await readFile(filename)
    const changedSpec = pinExecutableSpec({ ...payload, objective: 'Different execution scope for the same source revision' })
    await expect(store.begin({ ...fence(store), intent: { ...input, spec: changedSpec, compilerOutcome: { ...input.compilerOutcome, spec: changedSpec } } })).rejects.toMatchObject({ code: 'ADMISSION_INTENT_CONFLICT' })
    const nextSpec = pinExecutableSpec({ ...payload, source: { ...input.spec.source, sourceRevision: digestJson('next-source-revision') } })
    await expect(store.begin({ ...fence(store), intent: { ...input, spec: nextSpec, compilerOutcome: { ...input.compilerOutcome, source: nextSpec.source, spec: nextSpec } } })).rejects.toThrow(/intent capacity/)
    expect(await readFile(filename)).toEqual(before)
  })

  it('matches exact materialized task order, workflow identity and digest before acknowledging', async () => {
    const { store, filename } = await open()
    const first = await store.begin({ ...fence(store), intent: intent() })
    const before = await readFile(filename)
    await expect(store.acknowledge({ ...fence(store), admissionId: first.record.id })).rejects.toThrow(/materialized/)
    await expect(store.recordMaterialized({ ...materialized(store), taskIds: [...first.record.receipt.taskIds].reverse() })).rejects.toThrow(/differ/)
    await expect(store.recordMaterialized({ ...materialized(store), workflowId: 'different-workflow' })).rejects.toThrow(/differ/)
    await expect(store.recordMaterialized({ ...materialized(store), workflowDigest: digestJson('different') })).rejects.toThrow(/differ/)
    expect(await readFile(filename)).toEqual(before)
    await store.recordMaterialized(materialized(store))
    expect((await store.recordMaterialized(materialized(store))).duplicate).toBe(true)
    await store.acknowledge({ ...fence(store), admissionId: first.record.id })
    await expect(store.quarantine({ ...fence(store), admissionId: first.record.id, reason: 'OTHER', healthEscalationId: 'health' })).rejects.toThrow(/Terminal/)
  })

  it('bounds payload and journal capacity, and holds exclusive ownership across replay', async () => {
    const small = await open({ maxRecordBytes: 1024, maxJournalBytes: 1024 })
    await expect(small.store.begin({ ...fence(small.store), intent: intent() })).rejects.toThrow(/capacity/)
    expect(await readFile(small.filename, 'utf8')).toBe('')
    const full = await open()
    await full.store.begin({ ...fence(full.store), intent: intent() })
    await expect(DarkFactoryAdmissionStore.open(full.directory, { projectId: 'project-1', registeredLeadId: 'registered-lead', workflowTemplates: [template] })).rejects.toThrow()
    const bytes = (await readFile(full.filename)).byteLength
    await full.store.close()
    const bounded = await open({ maxRecordBytes: bytes, maxJournalBytes: bytes }, full.directory)
    const before = await readFile(full.filename)
    await expect(bounded.store.recordMaterialized(materialized(bounded.store))).rejects.toThrow(/capacity/)
    expect(await readFile(full.filename)).toEqual(before)
  })

  it.each(['partial', 'unknown', 'duplicate-key'])('preserves %s journals on replay rejection', async corruption => {
    const { store, directory, filename } = await open()
    await store.begin({ ...fence(store), intent: intent() })
    await store.close()
    if (corruption === 'partial') await appendFile(filename, '{')
    else if (corruption === 'unknown') await appendFile(filename, JSON.stringify({ version: 1, sequence: 2, type: 'unknown' }) + '\n')
    else {
      const original = await readFile(filename, 'utf8')
      await writeFile(filename, original.replace('"version":1', '"version":1,"version":1'))
    }
    const before = await readFile(filename)
    await expect(open({}, directory)).rejects.toThrow()
    expect(await readFile(filename)).toEqual(before)
  })

  it('rejects final journal symlinks without modifying the outside target', async () => {
    const { store, directory, filename } = await open()
    await store.close()
    const outside = join(directory, 'outside')
    await writeFile(outside, 'untouched')
    await rm(filename)
    await symlink(outside, filename)
    await expect(open({}, directory)).rejects.toThrow()
    expect(await readFile(outside, 'utf8')).toBe('untouched')
  })
})
