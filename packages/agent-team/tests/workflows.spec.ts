import { afterEach, expect, it } from 'vitest'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateWorkflowTemplate, WorkflowStore, type StepCompletion } from '../src/workflows.ts'

const roots: string[] = []
const stores: WorkflowStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(now?: () => number) {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-workflows-'))
  roots.push(directory)
  const store = await WorkflowStore.open(directory, now)
  stores.push(store)
  return { directory, store }
}

const reference = (kind: string, ref: string) => ({ kind, ref })
const submitted = (artifact: ReturnType<typeof reference>): StepCompletion['receipt'] => ({ kind: 'artifact-submitted', submitter: 'worker', artifact })
const checksPassed = (source: ReturnType<typeof reference>, candidate: ReturnType<typeof reference>): StepCompletion['receipt'] => ({ kind: 'checks-passed', verifier: 'ci', source, candidate, verification: reference('verification', 'checks:passed') })
const integrated = (source: ReturnType<typeof reference>, candidate: ReturnType<typeof reference>): StepCompletion['receipt'] => ({ kind: 'integrated', integrator: 'integration-worker', source, candidate, integration: reference('integration', 'integration:accepted') })

const codeTemplate = {
  format: 'agent-team-workflow/v1', id: 'code-review', version: 1,
  parameters: { subject: { type: 'string', required: true } },
  steps: [
    { id: 'implement', title: 'Implement {{subject}}', retry: { maxAttempts: 2, backoffMs: 0 }, artifacts: { produces: ['source'] }, acceptance: { kind: 'artifact-submitted', artifact: 'source' } },
    { id: 'test', title: 'Test {{subject}}', dependsOn: ['implement'], retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { requires: ['source'], produces: ['candidate'] }, acceptance: { kind: 'checks-passed', source: 'source', candidate: 'candidate' } },
    { id: 'review', title: 'Review {{subject}}', dependsOn: ['test'], retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { requires: ['source', 'candidate'], produces: ['review-result'] }, acceptance: { kind: 'report-review' } },
    { id: 'integrate', title: 'Integrate {{subject}}', dependsOn: ['review'], retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { requires: ['source', 'candidate', 'review-result'] }, acceptance: { kind: 'integrated', source: 'source', candidate: 'candidate' } },
  ],
}

async function start(store: WorkflowStore, executionId: string, stepId: string) {
  const step = store.inspect(executionId)!.steps.find(step => step.id === stepId)!
  return store.startStep(executionId, stepId, step.revision)
}
async function complete(store: WorkflowStore, executionId: string, stepId: string, artifacts: Record<string, ReturnType<typeof reference>>, receipt: StepCompletion['receipt']) {
  const step = store.inspect(executionId)!.steps.find(step => step.id === stepId)!
  return store.completeStep(executionId, stepId, step.revision, { artifacts, receipt })
}

it('rejects invalid templates and missing parameters before it records or dispatches an execution', async () => {
  const { directory, store } = await fixture()
  await expect(store.create({ ...codeTemplate, steps: [{ ...codeTemplate.steps[0], dependsOn: ['missing'] }] }, { subject: 'a' })).rejects.toThrow(/dependency|graph/i)
  await expect(store.create(codeTemplate, {})).rejects.toThrow(/subject|parameter/i)
  expect(store.list()).toEqual([])
  expect(await readFile(join(directory, 'workflows.jsonl'), 'utf8')).toBe('')
})

it('pins the substituted template and restores completed expensive steps after reconstruction', async () => {
  const { directory, store } = await fixture()
  const template = structuredClone(codeTemplate)
  const execution = await store.create(template, { subject: 'durable checkpoints' }, 'execution-code')
  template.steps[0].title = 'MUTATED {{subject}}'
  await start(store, execution.id, 'implement')
  await complete(store, execution.id, 'implement', { source: reference('commit', 'a'.repeat(40)) }, submitted(reference('commit', 'a'.repeat(40))))
  await store.close()
  const restored = await WorkflowStore.open(directory)
  stores.push(restored)
  expect(restored.inspect(execution.id)!.definition.steps[0]!.title).toBe('Implement durable checkpoints')
  expect(restored.inspect(execution.id)!.steps[0]).toMatchObject({ id: 'implement', phase: 'completed', artifacts: { source: reference('commit', 'a'.repeat(40)) } })
  expect(restored.resume(execution.id)).toMatchObject({ id: 'test', phase: 'pending' })
})

it('records a rejected explicit review and gates downstream integration', async () => {
  const { store } = await fixture()
  const execution = await store.create(codeTemplate, { subject: 'review gate' })
  await start(store, execution.id, 'implement')
  await complete(store, execution.id, 'implement', { source: reference('commit', 'b'.repeat(40)) }, submitted(reference('commit', 'b'.repeat(40))))
  await start(store, execution.id, 'test')
  await complete(store, execution.id, 'test', { candidate: reference('commit', 'candidate-b') }, checksPassed(reference('commit', 'b'.repeat(40)), reference('commit', 'candidate-b')))
  await start(store, execution.id, 'review')
  const review = store.inspect(execution.id)!.steps.find(step => step.id === 'review')!
  await store.completeStep(execution.id, 'review', review.revision, {
    artifacts: { 'review-result': reference('report', 'review:rejected') },
    receipt: { kind: 'report-review', reviewer: 'reviewer', decision: 'rejected', reference: reference('report', 'review:rejected') },
  })
  expect(store.inspect(execution.id)!.steps.find(step => step.id === 'review')).toMatchObject({ phase: 'failed' })
  expect(store.resume(execution.id)).toBeUndefined()
  const integration = store.inspect(execution.id)!.steps.find(step => step.id === 'integrate')!
  await expect(store.startStep(execution.id, 'integrate', integration.revision)).rejects.toThrow(/eligible|dependency/i)
})

it('requires submitted source, checked candidate, reviewed evidence, then an integration receipt in that order', async () => {
  const { store } = await fixture()
  const execution = await store.create(codeTemplate, { subject: 'receipt boundaries' })
  await start(store, execution.id, 'implement')
  let implement = store.inspect(execution.id)!.steps.find(step => step.id === 'implement')!
  await expect(store.completeStep(execution.id, 'implement', implement.revision, { artifacts: { source: reference('commit', 'source-a') }, receipt: integrated(reference('commit', 'source-a'), reference('commit', 'candidate-a')) })).rejects.toThrow(/acceptance/i)
  await complete(store, execution.id, 'implement', { source: reference('commit', 'source-a') }, submitted(reference('commit', 'source-a')))
  await start(store, execution.id, 'test')
  await complete(store, execution.id, 'test', { candidate: reference('commit', 'candidate-a') }, checksPassed(reference('commit', 'source-a'), reference('commit', 'candidate-a')))
  await start(store, execution.id, 'review')
  let review = store.inspect(execution.id)!.steps.find(step => step.id === 'review')!
  await store.completeStep(execution.id, 'review', review.revision, { artifacts: { 'review-result': reference('report', 'review-a') }, receipt: { kind: 'report-review', reviewer: 'reviewer', decision: 'approved', reference: reference('report', 'review-a') } })
  await start(store, execution.id, 'integrate')
  const integrate = store.inspect(execution.id)!.steps.find(step => step.id === 'integrate')!
  await expect(store.completeStep(execution.id, 'integrate', integrate.revision, { artifacts: {}, receipt: checksPassed(reference('commit', 'source-a'), reference('commit', 'candidate-a')) })).rejects.toThrow(/acceptance/i)
  await expect(store.completeStep(execution.id, 'integrate', integrate.revision, { artifacts: {}, receipt: integrated(reference('commit', 'source-a'), reference('commit', 'candidate-a')) })).resolves.toMatchObject({ phase: 'completed', receipt: { kind: 'integrated' } })
})

it('retains a stale candidate round, requires a new review, and refuses to reopen an integrated workflow', async () => {
  const { store } = await fixture()
  const execution = await store.create(codeTemplate, { subject: 'moved target' }, 'moved-target')
  await start(store, execution.id, 'implement')
  await complete(store, execution.id, 'implement', { source: reference('commit', 'source-moved') }, submitted(reference('commit', 'source-moved')))
  await start(store, execution.id, 'test')
  await complete(store, execution.id, 'test', { candidate: reference('commit', 'candidate-old') }, checksPassed(reference('commit', 'source-moved'), reference('commit', 'candidate-old')))
  await start(store, execution.id, 'review')
  await complete(store, execution.id, 'review', { 'review-result': reference('report', 'old-review') }, { kind: 'report-review', reviewer: 'lead', decision: 'approved', reference: reference('report', 'old-review') })
  const test = store.inspect(execution.id)!.steps.find(step => step.id === 'test')!
  const replacement = { integration: reference('integration', 'job-1'), source: reference('commit', 'source-moved'), target: reference('commit', 'target-new'),
    candidate: reference('commit', 'candidate-new'), retryRound: 1, previousCandidates: [reference('commit', 'candidate-old')] }
  await store.invalidateCandidate(execution.id, 'test', test.revision, replacement, 'target advanced after the old review')
  const reset = store.inspect(execution.id)!
  expect(reset.steps).toMatchObject([
    { id: 'implement', phase: 'completed', artifacts: { source: reference('commit', 'source-moved') } },
    { id: 'test', phase: 'pending', attempts: 0 }, { id: 'review', phase: 'pending', attempts: 0 }, { id: 'integrate', phase: 'pending', attempts: 0 },
  ])
  expect(reset.candidateHistory[0]).toMatchObject({ source: reference('commit', 'source-moved'), candidate: reference('commit', 'candidate-old'), replacement })
  expect(reset.candidateHistory[0]!.priorSteps.find(step => step.id === 'review')).toMatchObject({ phase: 'completed', receipt: { kind: 'report-review', reference: reference('report', 'old-review') } })
  const stale = reset.steps.find(step => step.id === 'test')!
  await expect(store.invalidateCandidate(execution.id, 'test', stale.revision, replacement, 'forged same candidate')).rejects.toThrow(/completed|candidate/i)
  await start(store, execution.id, 'test')
  await complete(store, execution.id, 'test', { candidate: reference('commit', 'candidate-new') }, checksPassed(reference('commit', 'source-moved'), reference('commit', 'candidate-new')))
  await start(store, execution.id, 'review')
  await complete(store, execution.id, 'review', { 'review-result': reference('report', 'new-review') }, { kind: 'report-review', reviewer: 'lead', decision: 'approved', reference: reference('report', 'new-review') })
  await start(store, execution.id, 'integrate')
  await complete(store, execution.id, 'integrate', {}, integrated(reference('commit', 'source-moved'), reference('commit', 'candidate-new')))
  const integratedStep = store.inspect(execution.id)!.steps.find(step => step.id === 'test')!
  await expect(store.invalidateCandidate(execution.id, 'test', integratedStep.revision, { ...replacement, candidate: reference('commit', 'candidate-later'), retryRound: 2,
    previousCandidates: [reference('commit', 'candidate-new')] }, 'late target movement')).rejects.toThrow(/integrated/i)
})

it('retains the old submitted source and resets its dependent candidate round for a bounded repair source', async () => {
  const { store } = await fixture()
  const execution = await store.create(codeTemplate, { subject: 'repair source' })
  await start(store, execution.id, 'implement')
  const oldSource = 'd'.repeat(40), repairedSource = 'e'.repeat(40)
  await complete(store, execution.id, 'implement', { source: reference('commit', oldSource) }, submitted(reference('commit', oldSource)))
  const implement = store.inspect(execution.id)!.steps.find(step => step.id === 'implement')!
  await store.reworkSource(execution.id, 'implement', implement.revision, reference('commit', repairedSource), { previousAttemptId: 'attempt-old', submissionId: 'submission-old', sourceCommit: oldSource, round: 1, budget: 3 }, 'authorized repair attempt produced a replacement source')
  const reworked = store.inspect(execution.id)!
  expect(reworked.steps).toMatchObject([{ id: 'implement', phase: 'pending', attempts: 0 }, { id: 'test', phase: 'pending' }, { id: 'review', phase: 'pending' }, { id: 'integrate', phase: 'pending' }])
  expect(reworked.sourceHistory[0]).toMatchObject({ source: reference('commit', oldSource), replacement: reference('commit', repairedSource) })
  expect(reworked.sourceHistory[0]!.priorSteps.find(step => step.id === 'implement')).toMatchObject({ phase: 'completed', receipt: { kind: 'artifact-submitted' } })
})

it('requires one durable authorization bound to the publication step revision', async () => {
  const { store } = await fixture()
  const release = {
    format: 'agent-team-workflow/v1', id: 'release', version: 3, parameters: {},
    steps: [
      { id: 'prepare', title: 'Prepare release', retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { produces: ['release'] }, acceptance: { kind: 'artifact-submitted', artifact: 'release' } },
      { id: 'publish', title: 'Publish release', dependsOn: ['prepare'], retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { requires: ['release'] }, acceptance: { kind: 'externally-authorized-publication', authorization: 'release-manager' } },
    ],
  }
  const execution = await store.create(release, {}, 'execution-release')
  await start(store, execution.id, 'prepare')
  await complete(store, execution.id, 'prepare', { release: reference('file', 'dist/release.tgz') }, submitted(reference('file', 'dist/release.tgz')))
  await start(store, execution.id, 'publish')
  let publish = store.inspect(execution.id)!.steps.find(step => step.id === 'publish')!
  await expect(store.completeStep(execution.id, 'publish', publish.revision, { artifacts: {}, receipt: { kind: 'externally-authorized-publication', publisher: 'release-bot', reference: reference('publication', 'release:v3') } })).rejects.toThrow(/authorization/i)
  await store.authorizePublication(execution.id, 'publish', publish.revision, { actor: 'release-manager', evidence: reference('ticket', 'CAB-42') })
  publish = store.inspect(execution.id)!.steps.find(step => step.id === 'publish')!
  await expect(store.authorizePublication(execution.id, 'publish', publish.revision - 1, { actor: 'release-manager', evidence: reference('ticket', 'CAB-42') })).rejects.toThrow(/revision|authorization/i)
  const second = await store.create(release, {}, 'execution-release-second')
  await start(store, second.id, 'prepare')
  await complete(store, second.id, 'prepare', { release: reference('file', 'dist/release-2.tgz') }, submitted(reference('file', 'dist/release-2.tgz')))
  await start(store, second.id, 'publish')
  const secondPublish = store.inspect(second.id)!.steps.find(step => step.id === 'publish')!
  await expect(store.authorizePublication(second.id, 'publish', secondPublish.revision, { actor: 'release-manager', evidence: reference('ticket', 'CAB-42') })).rejects.toThrow(/already bound/i)
  await complete(store, execution.id, 'publish', {}, { kind: 'externally-authorized-publication', publisher: 'release-bot', reference: reference('publication', 'release:v3') })
  expect(store.inspect(execution.id)!.steps.find(step => step.id === 'publish')).toMatchObject({ phase: 'completed', authorization: { actor: 'release-manager', evidence: reference('ticket', 'CAB-42') } })
})

it('enforces revisions and bounded retries without runtime side effects', async () => {
  const { store } = await fixture()
  const execution = await store.create(codeTemplate, { subject: 'retry bounds' })
  const first = await start(store, execution.id, 'implement')
  await expect(store.failStep(execution.id, 'implement', first.revision - 1, { reason: 'stale', reference: reference('report', 'stale') })).rejects.toThrow(/revision/i)
  const failed = await store.failStep(execution.id, 'implement', first.revision, { reason: 'test failure', reference: reference('report', 'failure-1') })
  const retried = await store.retryStep(execution.id, 'implement', failed.revision)
  const second = await store.startStep(execution.id, 'implement', retried.revision)
  const exhausted = await store.failStep(execution.id, 'implement', second.revision, { reason: 'again', reference: reference('report', 'failure-2') })
  await expect(store.retryStep(execution.id, 'implement', exhausted.revision)).rejects.toThrow(/retry|attempt/i)
})

it('ships valid JSON templates for code, investigation, and explicitly authorized release work', async () => {
  for (const filename of ['implementation-test-review-integration.json', 'investigation-report.json', 'release-publication.json']) {
    const template = JSON.parse(await readFile(join(process.cwd(), 'workflows', filename), 'utf8'))
    expect(validateWorkflowTemplate(template)).toMatchObject({ format: 'agent-team-workflow/v1' })
  }
})

it('keeps publication authorization evidence consumed after a failed retry', async () => {
  const { store } = await fixture()
  const release = {
    format: 'agent-team-workflow/v1', id: 'retry-release', version: 1, parameters: {}, steps: [
      { id: 'prepare', title: 'Prepare', retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { produces: ['release'] }, acceptance: { kind: 'artifact-submitted', artifact: 'release' } },
      { id: 'publish', title: 'Publish', dependsOn: ['prepare'], retry: { maxAttempts: 2, backoffMs: 0 }, artifacts: { requires: ['release'] }, acceptance: { kind: 'externally-authorized-publication', authorization: 'release-manager' } },
    ],
  }
  const first = await store.create(release, {}, 'retry-release-one')
  await start(store, first.id, 'prepare')
  await complete(store, first.id, 'prepare', { release: reference('file', 'release-one.tgz') }, submitted(reference('file', 'release-one.tgz')))
  await start(store, first.id, 'publish')
  let publish = store.inspect(first.id)!.steps.find(step => step.id === 'publish')!
  await store.authorizePublication(first.id, 'publish', publish.revision, { actor: 'release-manager', evidence: reference('ticket', 'CAB-retry') })
  publish = store.inspect(first.id)!.steps.find(step => step.id === 'publish')!
  const failed = await store.failStep(first.id, 'publish', publish.revision, { reason: 'publisher unavailable', reference: reference('report', 'publish-failed') })
  await store.retryStep(first.id, 'publish', failed.revision)
  expect(store.inspect(first.id)!.authorizationHistory).toMatchObject([{ executionId: first.id, stepId: 'publish', actor: 'release-manager', evidence: reference('ticket', 'CAB-retry') }])
  const second = await store.create(release, {}, 'retry-release-two')
  await start(store, second.id, 'prepare')
  await complete(store, second.id, 'prepare', { release: reference('file', 'release-two.tgz') }, submitted(reference('file', 'release-two.tgz')))
  await start(store, second.id, 'publish')
  const other = store.inspect(second.id)!.steps.find(step => step.id === 'publish')!
  await expect(store.authorizePublication(second.id, 'publish', other.revision, { actor: 'release-manager', evidence: reference('ticket', 'CAB-retry') })).rejects.toThrow(/already bound/i)
})

it('persists retry backoff and makes the retry eligible only after its durable deadline', async () => {
  let now = 1_000
  const { directory, store } = await fixture(() => now)
  const template = structuredClone(codeTemplate)
  template.steps[0].retry = { maxAttempts: 2, backoffMs: 500 }
  const execution = await store.create(template, { subject: 'backoff' })
  const active = await start(store, execution.id, 'implement')
  const failed = await store.failStep(execution.id, 'implement', active.revision, { reason: 'temporary', reference: reference('report', 'temporary-failure') })
  await store.retryStep(execution.id, 'implement', failed.revision)
  await store.close()
  const restored = await WorkflowStore.open(directory, () => now)
  stores.push(restored)
  expect(restored.inspect(execution.id)!.steps.find(step => step.id === 'implement')).toMatchObject({ failedAt: 1_000, notBefore: 1_500 })
  expect(restored.resume(execution.id)).toBeUndefined()
  const pending = restored.inspect(execution.id)!.steps.find(step => step.id === 'implement')!
  await expect(restored.startStep(execution.id, 'implement', pending.revision)).rejects.toThrow(/eligible/i)
  now += 500
  expect(restored.resume(execution.id)).toMatchObject({ id: 'implement', phase: 'pending' })
  await expect(restored.startStep(execution.id, 'implement', pending.revision)).resolves.toMatchObject({ phase: 'running', attempts: 2 })
})

it('rejects forged workflow creation checkpoints and treats prototype-named parameters as own keys', async () => {
  const { directory, store } = await fixture()
  const template = { ...codeTemplate, parameters: { constructor: { type: 'string', required: true } }, steps: [{ ...codeTemplate.steps[0], title: 'Implement {{constructor}}', dependsOn: [] }] }
  const execution = await store.create(template, { constructor: 'a real value' }, 'prototype-parameter')
  expect(execution.definition.steps[0]!.title).toBe('Implement a real value')
  await expect(store.create(template, {}, 'missing-prototype-parameter')).rejects.toThrow(/missing required.*constructor/i)
  await store.close()
  const forged = structuredClone(execution)
  forged.id = 'forged-execution'
  forged.steps[0]!.artifacts = { source: reference('commit', 'forged') }
  await appendFile(join(directory, 'workflows.jsonl'), `${JSON.stringify({ version: 1, sequence: 2, type: 'workflow/created', execution: forged })}\n`)
  await expect(WorkflowStore.open(directory)).rejects.toThrow(/creation.*pending|backup/i)
})
