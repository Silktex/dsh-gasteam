import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DarkFactoryAdmissionStore } from '../../src/darkfactory/admission-store.ts'
import { DarkFactoryPolicyStore } from '../../src/darkfactory/policy-store.ts'
import { darkFactoryTemplate } from '../../src/workflow-templates.ts'
import { pinWorkflowDefinition } from '../../src/workflows.ts'
import { pinExecutableSpec } from '../../src/darkfactory/contracts/spec.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
import { enabledPolicy } from './config-fixture.ts'
import { examples } from './fixtures.ts'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'factory-native-migration-')); cleanup.push(() => rm(root, { recursive: true, force: true })); return root }
it('sanitizes invalid admission migration registries before accessing storage', async () => {
  const template = structuredClone(darkFactoryTemplate)
  template.steps[0]!.dependsOn = ['sensitive-unregistered-step']
  await expect(DarkFactoryAdmissionStore.migrate('/unused-migration-fixture', {
    projectId: 'project-1', registeredLeadId: 'lead', workflowTemplates: [template],
  }, { migrationId: 'invalid-registry', validateReferences: async () => {} })).rejects.toThrow(/^Invalid admission workflow registry$/)
})
it('migrates native policy decisions and retains authority fences through replay and append', async () => {
  const root = await directory(), policy = enabledPolicy()
  const host = { projectId: 'project', operatorId: 'operator', authorizationRef: 'grant' }
  const options = { grants: [{ projectId: 'project', operatorIds: ['operator'], authorizationRefs: ['grant'] }] }
  let owner = await DarkFactoryPolicyStore.open(root, options); cleanup.push(() => owner.close())
  await owner.installPolicy({ ...host, expectedRevision: 0, policy })
  await owner.control({ ...host, expectedRevision: 1, action: 'pause', reason: 'manual' })
  const before = owner.snapshot(), filename = join(root, 'darkfactory-policy.jsonl'), original = await readFile(filename)
  await expect(DarkFactoryPolicyStore.migrate(root, { migrationId: 'native-policy', validateReferences: async () => {} })).rejects.toThrow(/Invalid/)
  await owner.close()
  let validations = 0
  const result = await DarkFactoryPolicyStore.migrate(root, { migrationId: 'native-policy', validateReferences: async snapshot => {
    validations++; expect(snapshot.projects).toEqual(before)
    expect(snapshot.projects[0]!.policies[0]!.policy).toEqual(policy)
  } })
  expect(validations).toBe(2)
  expect(result.backup).toBe(join(root, result.directory, 'legacy-backup.jsonl'))
  expect(await readFile(result.backup)).toEqual(original)
  owner = await DarkFactoryPolicyStore.open(root, options)
  expect(owner.snapshot()).toEqual(before)
  await owner.control({ ...host, expectedRevision: 2, action: 'pause', reason: 'safety' })
  expect(owner.snapshot()[0]?.pauses).toEqual(['manual', 'safety'])
  expect((await readFile(result.target)).subarray(0, original.length)).toEqual(original)
  expect(await readFile(result.backup)).toEqual(original)
})
it('migrates the full held admission plan with exact receipts and refuses corrupt native events before reference callbacks', async () => {
  const root = await directory(), options = { projectId: 'project-1', registeredLeadId: 'lead', workflowTemplates: [darkFactoryTemplate] }
  const workflow = { template: darkFactoryTemplate, parameters: { subject: 'retained admission' } }
  const { specDigest: _, ...payload } = examples.ExecutableSpecV1
  const spec = pinExecutableSpec({ ...payload, workflowDigest: digestJson(pinWorkflowDefinition(darkFactoryTemplate, workflow.parameters)) })
  let owner = await DarkFactoryAdmissionStore.open(root, options); cleanup.push(() => owner.close())
  const { record } = await owner.begin({ projectId: 'project-1', expectedRevision: 0, intent: {
    registeredLeadId: 'lead', spec, workflow,
    compilerOutcome: { schemaVersion: 1, id: 'compiler-outcome', projectId: spec.projectId, policyRevision: spec.policyRevision, source: spec.source, outcome: 'COMPILED', reasons: ['Registered fixture evidence'], spec },
    compilerCursor: { schemaVersion: 1, contextDigest: digestJson('context'), malformedAttempts: 0, phase: 'finished' },
    policyRefs: { policyRecordId: 'policy-record', decisionReceiptId: 'decision' },
  } })
  const before = owner.snapshot(), filename = join(root, 'darkfactory/project-1/admission.jsonl'), original = await readFile(filename)
  await owner.close()
  const result = await DarkFactoryAdmissionStore.migrate(root, options, { migrationId: 'native-admission', validateReferences: async snapshot => {
    expect(snapshot).toEqual(before)
    expect(snapshot.admissions[0]?.intent.compilerOutcome).toEqual(record.intent.compilerOutcome)
  } })
  expect(await readFile(result.backup)).toEqual(original)
  owner = await DarkFactoryAdmissionStore.open(root, options)
  expect(owner.snapshot()).toEqual(before)
  await owner.recordMaterialized({ projectId: 'project-1', expectedRevision: before.revision, admissionId: record.id, workflowId: record.intent.workflowId, workflowDigest: spec.workflowDigest, taskIds: record.receipt.taskIds })
  expect(owner.snapshot().admissions[0]).toMatchObject({ status: 'materialized', barrier: 'closed', receipt: { taskIds: record.receipt.taskIds } })
  expect(await readFile(result.backup)).toEqual(original)
  await owner.close()

  const brokenRoot = await directory(), broken = await DarkFactoryAdmissionStore.open(brokenRoot, options)
  await broken.close()
  const brokenPath = join(brokenRoot, 'darkfactory/project-1/admission.jsonl')
  const event = JSON.parse(original.toString('utf8')); event.hash = digestJson('wrong-chain')
  const corrupted = JSON.stringify(event) + '\n'; await writeFile(brokenPath, corrupted)
  let calls = 0
  await expect(DarkFactoryAdmissionStore.migrate(brokenRoot, options, { migrationId: 'broken', validateReferences: async () => { calls++ } })).rejects.toThrow(/Invalid/)
  expect(calls).toBe(0)
  expect(await readFile(brokenPath, 'utf8')).toBe(corrupted)
})
