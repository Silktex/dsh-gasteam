import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReportStore } from '../src/reports.ts'
import { WorkflowRuntime, type WorkflowCodeStatus, type WorkflowCodeTaskCreateIntent, type WorkflowIntegrationApproval, type WorkflowTaskCreateIntent, type WorkflowTaskHost } from '../src/workflow-runtime.ts'
import { WorkflowStore, pinWorkflowDefinition, validateWorkflowTemplate } from '../src/workflows.ts'
import { darkFactoryTemplate, releasePublicationTemplate } from '../src/workflow-templates.ts'
import { DarkFactoryAdmissionStore } from '../src/darkfactory/admission-store.ts'
import { pinExecutableSpec } from '../src/darkfactory/contracts/spec.ts'
import { digestJson } from '../src/darkfactory/json.ts'
import { examples } from './darkfactory/fixtures.ts'

const roots: string[] = []
const closeables: { close(): Promise<void> }[] = []

afterEach(async () => {
  for (const closeable of closeables.splice(0).reverse()) await closeable.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const template = {
  format: 'agent-team-workflow/v1', id: 'investigation-report', version: 1,
  parameters: { question: { type: 'string', required: true } },
  steps: [
    { id: 'investigate', title: 'Investigate {{question}}', retry: { maxAttempts: 2, backoffMs: 0 }, artifacts: { produces: ['findings'] }, acceptance: { kind: 'report-review' } },
    { id: 'report', title: 'Review report for {{question}}', dependsOn: ['investigate'], retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { requires: ['findings'], produces: ['report'] }, acceptance: { kind: 'report-review' } },
  ],
} as const

class Host implements WorkflowTaskHost {
  readonly calls: WorkflowTaskCreateIntent[] = []
  private readonly tasks = new Map<string, string>()
  failTaskCreation = false

  async createPinnedTask(input: WorkflowTaskCreateIntent): Promise<{ taskId: string }> {
    this.calls.push(input)
    if (this.failTaskCreation) throw new Error('injected task creation crash')
    let taskId = this.tasks.get(input.intentId)
    if (!taskId) { taskId = `task-${this.tasks.size + 1}`; this.tasks.set(input.intentId, taskId) }
    return { taskId }
  }
}

class CodeHost extends Host {
  readonly codeCalls: WorkflowCodeTaskCreateIntent[] = []
  readonly approvals: WorkflowIntegrationApproval[] = []
  status: WorkflowCodeStatus | undefined
  async createPinnedCodeTask(input: WorkflowCodeTaskCreateIntent): Promise<{ taskId: string }> {
    this.codeCalls.push(input)
    return { taskId: 'code-task' }
  }
  async codeStatus(_input: WorkflowCodeTaskCreateIntent): Promise<WorkflowCodeStatus | undefined> { return this.status }
  async approvePinnedIntegration(receipt: WorkflowIntegrationApproval): Promise<void> {
    if (!this.approvals.some(candidate => JSON.stringify(candidate) === JSON.stringify(receipt))) this.approvals.push(receipt)
  }
}
class PublicationHost extends CodeHost {
  readonly publicationPublisher = { identity: 'release-publisher', revision: 1 }
  readonly publicationCalls: import('../src/workflow-runtime.ts').WorkflowPublicationIntent[] = []
  readonly effects = new Set<string>()
  failure?: 'definite' | 'unknown'
  failWithoutClassification = false
  async publishAuthorizedRelease(intent: import('../src/workflow-runtime.ts').WorkflowPublicationIntent): Promise<import('../src/workflow-runtime.ts').WorkflowPublicationReceipt> {
    this.publicationCalls.push(intent)
    this.effects.add(intent.idempotencyKey)
    if (this.failure) { const error = Object.assign(new Error(this.failure), { publicationOutcome: this.failure }); throw error }
    if (this.failWithoutClassification) throw new Error('unclassified publisher failure')
    return { publisher: 'release-publisher', reference: { kind: 'publication', ref: `published:${intent.idempotencyKey}` }, idempotencyKey: intent.idempotencyKey,
      publisherIdentity: intent.publisherIdentity, publisherRevision: intent.publisherRevision, authorization: intent.authorization, evidence: intent.evidence, release: intent.release }
  }
}

const codeTemplate = {
  format: 'agent-team-workflow/v1', id: 'implementation-test-review-integration', version: 1,
  parameters: { subject: { type: 'string', required: true } },
  steps: [
    { id: 'implement', title: 'Implement {{subject}}', retry: { maxAttempts: 2, backoffMs: 0 }, artifacts: { produces: ['source'] }, acceptance: { kind: 'artifact-submitted', artifact: 'source' } },
    { id: 'test', title: 'Verify {{subject}}', dependsOn: ['implement'], retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { requires: ['source'], produces: ['candidate'] }, acceptance: { kind: 'checks-passed', source: 'source', candidate: 'candidate' } },
    { id: 'review', title: 'Review {{subject}}', dependsOn: ['test'], retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { requires: ['source', 'candidate'], produces: ['review'] }, acceptance: { kind: 'report-review' } },
    { id: 'integrate', title: 'Integrate {{subject}}', dependsOn: ['review'], retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { requires: ['source', 'candidate', 'review'] }, acceptance: { kind: 'integrated', source: 'source', candidate: 'candidate' } },
  ],
} as const

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-workflow-runtime-'))
  roots.push(directory)
  const workflows = await WorkflowStore.open(directory)
  const reports = await ReportStore.open(directory)
  const host = new Host()
  const runtime = await WorkflowRuntime.open(directory, workflows, reports, host, [template])
  closeables.push(runtime, reports, workflows)
  return { directory, workflows, reports, host, runtime }
}

async function codeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-code-runtime-replay-'))
  roots.push(directory)
  const workflows = await WorkflowStore.open(directory)
  const reports = await ReportStore.open(directory)
  const host = new CodeHost()
  const runtime = await WorkflowRuntime.open(directory, workflows, reports, host, [codeTemplate])
  closeables.push(runtime, reports, workflows)
  return { directory, workflows, reports, host, runtime }
}

it.each(['intentId', 'subject', 'description', 'inputs', 'candidateRound', 'sourceRound', 'missingSourceRound', 'taskKind'] as const)('rejects factory %s replay tampering before any host effect', async field => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-factory-runtime-replay-'))
  roots.push(directory)
  const template = validateWorkflowTemplate(darkFactoryTemplate)
  const workflow = { template, parameters: { subject: 'registered repair' } }
  const { specDigest: _digest, ...payload } = examples.ExecutableSpecV1
  const spec = pinExecutableSpec({ ...payload, workflowDigest: digestJson(pinWorkflowDefinition(template, workflow.parameters)) })
  const admissions = await DarkFactoryAdmissionStore.open(directory, { projectId: spec.projectId, registeredLeadId: 'lead', workflowTemplates: [template] })
  const workflows = await WorkflowStore.open(directory)
  const reports = await ReportStore.open(directory)
  closeables.push(admissions, workflows, reports)
  const record = (await admissions.begin({ projectId: spec.projectId, expectedRevision: 0, intent: {
    registeredLeadId: 'lead', spec, workflow, policyRefs: { policyRecordId: 'policy-record', decisionReceiptId: 'decision-record' },
    compilerOutcome: { ...examples.CompilerOutcomeV1, source: spec.source, spec },
    compilerCursor: { schemaVersion: 1, contextDigest: digestJson({ host: 'fixture' }), malformedAttempts: 0, phase: 'finished' },
  } })).record
  const host = new Host()
  host.failTaskCreation = true
  const runtime = await WorkflowRuntime.open(directory, workflows, reports, host, [template])
  closeables.push(runtime)
  await expect(runtime.materializeFactoryAdmission(record, { id: spec.projectId, teamIds: ['lead'] })).rejects.toThrow('injected task creation crash')
  await runtime.close()
  const filename = join(directory, 'workflow-runtime.jsonl')
  const events = (await readFile(filename, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const intended = events.find(event => event.type === 'workflow-runtime/task-intended')!
  if (field === 'sourceRound') intended.sourceRound = 1
  else if (field === 'missingSourceRound') delete intended.sourceRound
  else if (field === 'candidateRound') intended.intent.candidateRound = 1
  else if (field === 'inputs') intended.intent.inputs = [{ name: 'injected', artifact: { kind: 'file', ref: 'unregistered/path' } }]
  else if (field === 'taskKind') { delete intended.intent.nonCodeCriteria; intended.intent.reviewGate = 'injected-gate' }
  else intended.intent[field] = 'altered-payload'
  await writeFile(filename, `${events.map(event => JSON.stringify(event)).join('\n')}\n`)
  host.calls.length = 0
  await expect(WorkflowRuntime.open(directory, workflows, reports, host, [template])).rejects.toMatchObject({ cause: { message: 'Factory task intent does not match admission' } })
  expect(host.calls).toEqual([])
})

it('pins report template work to the registered Lead, creates each managed task once, and carries accepted evidence into the next step', async () => {
  const { workflows, reports, host, runtime } = await fixture()
  const execution = await runtime.create({ projectId: 'project', teamId: 'lead', templateId: 'investigation-report', templateVersion: 1, parameters: { question: 'Why did the job fail?' }, executionId: 'workflow-1' }, { id: 'project', teamIds: ['lead'] })
  expect(workflows.inspect(execution.executionId)!.definition).toEqual(expect.objectContaining({ id: 'investigation-report', version: 1 }))
  expect((await runtime.scan({ id: 'project', teamIds: ['lead'] }))[0]!.steps).toContainEqual(expect.objectContaining({ stepId: 'investigate', taskId: 'task-1' }))
  expect(host.calls).toHaveLength(1)
  expect(workflows.inspect(execution.executionId)!.steps[0]).toMatchObject({ phase: 'running', attempts: 1 })

  await reports.record({ projectId: 'project', teamId: 'lead', taskId: 'task-1', attemptId: 'attempt-1', generation: 1, expectedRevision: 3, expectedTaskRevision: 1,
    report: 'The job failed because the credential expired.', criteria: host.calls[0]!.nonCodeCriteria, reviewerId: 'lead', rationale: 'The report identifies the observed cause.' })
  await reports.accepted(reports.list()[0]!.id)
  expect((await runtime.scan({ id: 'project', teamIds: ['lead'] }))[0]!.steps).toContainEqual(expect.objectContaining({ stepId: 'report', taskId: 'task-2' }))
  expect(workflows.inspect(execution.executionId)!.steps[0]).toMatchObject({ phase: 'completed', receipt: { kind: 'report-review', decision: 'approved', reference: { kind: 'report', ref: reports.list()[0]!.id } } })
  expect(host.calls[1]!.description).toContain('findings: report:' + reports.list()[0]!.id)
  expect(host.calls[1]!.description).toContain('The job failed because the credential expired.')
  expect(host.calls[1]!.description).toContain('The report identifies the observed cause.')
})

it.each([
  ['definite', 'definite' as const, false, /definitely/],
  ['classified unknown', 'unknown' as const, false, /uncertain/],
  ['unclassified', undefined, true, /uncertain/],
])('persists a %s publisher failure and never repeats its side effect on scans', async (_name, failure, failWithoutClassification, reason) => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-release-failure-')); roots.push(directory)
  const workflows = await WorkflowStore.open(directory), reports = await ReportStore.open(directory), host = new PublicationHost()
  const project = { id: 'project', teamIds: ['lead'], publicationGrants: [{ teamId: 'lead', authorization: 'release-manager' }], publicationPublisher: { identity: 'release-publisher', revision: 1 } }
  const runtime = await WorkflowRuntime.open(directory, workflows, reports, host, [releasePublicationTemplate]); closeables.push(runtime, reports, workflows)
  await runtime.create({ projectId: 'project', teamId: 'lead', templateId: 'release-publication', templateVersion: 1, parameters: { release: 'v1' }, executionId: 'release-failure' }, project); await runtime.scan(project)
  const prepare = workflows.inspect('release-failure')!.steps[0]!; await workflows.completeStep('release-failure', prepare.id, prepare.revision, { artifacts: { 'release-candidate': { kind: 'report', ref: 'manifest' } }, receipt: { kind: 'report-review', reviewer: 'lead', decision: 'approved', reference: { kind: 'report', ref: 'manifest' } } }); await runtime.scan(project)
  const publish = workflows.inspect('release-failure')!.steps[1]!; await runtime.authorizePublication('release-failure', publish.id, publish.revision, { kind: 'ticket', ref: 'CAB-2' }, 'lead')
  host.failure = failure; host.failWithoutClassification = failWithoutClassification; await runtime.scan(project); await runtime.scan(project)
  expect(host.publicationCalls).toHaveLength(1); expect(workflows.inspect('release-failure')!.steps[1]).toMatchObject({ phase: 'failed', failure: { reason: expect.stringMatching(reason) } })
  expect(runtime.inspect('release-failure')!.steps[1]).toMatchObject({ phase: 'failed', revision: expect.any(Number), attempts: 1,
    failure: { reason: expect.stringMatching(reason), evidence: { kind: 'publication', ref: expect.stringMatching(/^publication-/) } } })
})

it('rejects invalid parameters before it records runtime intent, then accepts a valid execution', async () => {
  const { workflows, host, runtime } = await fixture()
  await expect(runtime.create({ projectId: 'project', teamId: 'lead', templateId: 'investigation-report', templateVersion: 1, parameters: {}, executionId: 'invalid-parameters' }, { id: 'project', teamIds: ['lead'] })).rejects.toThrow(/question|parameter/i)
  expect(workflows.list()).toEqual([])
  expect(runtime.inspect('invalid-parameters')).toBeUndefined()
  await runtime.create({ projectId: 'project', teamId: 'lead', templateId: 'investigation-report', templateVersion: 1, parameters: { question: 'Validated after rejection' }, executionId: 'valid-parameters' }, { id: 'project', teamIds: ['lead'] })
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(host.calls).toHaveLength(1)
})

it('rejects an oversized substituted subject before intent and bounds max-length accepted evidence for the next task', async () => {
  const { workflows, reports, host, runtime } = await fixture()
  await expect(runtime.create({ projectId: 'project', teamId: 'lead', templateId: 'investigation-report', templateVersion: 1, parameters: { question: 'x'.repeat(200) }, executionId: 'long-subject' }, { id: 'project', teamIds: ['lead'] })).rejects.toThrow(/subject limit/i)
  expect(workflows.list()).toEqual([])
  await runtime.create({ projectId: 'project', teamId: 'lead', templateId: 'investigation-report', templateVersion: 1, parameters: { question: 'bounded evidence' }, executionId: 'bounded-evidence' }, { id: 'project', teamIds: ['lead'] })
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  await reports.record({ projectId: 'project', teamId: 'lead', taskId: 'task-1', attemptId: 'attempt-1', generation: 1, expectedRevision: 2, expectedTaskRevision: 1,
    report: 'r'.repeat(16_384), criteria: host.calls[0]!.nonCodeCriteria, reviewerId: 'lead', rationale: 'a'.repeat(16_384) })
  await reports.accepted(reports.list()[0]!.id)
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(host.calls[1]!.description.length).toBeLessThanOrEqual(16_384)
  expect(host.calls[1]!.description).toContain('[truncated; durable report receipt')
})

it('reconstructs the durable binding after a crash boundary without duplicating task creation or a completed step', async () => {
  const { directory, workflows, reports, host, runtime } = await fixture()
  const created = await runtime.create({ projectId: 'project', teamId: 'lead', templateId: 'investigation-report', templateVersion: 1, parameters: { question: 'Restart safety' }, executionId: 'workflow-restart' }, { id: 'project', teamIds: ['lead'] })
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  await reports.record({ projectId: 'project', teamId: 'lead', taskId: 'task-1', attemptId: 'attempt-1', generation: 1, expectedRevision: 2, expectedTaskRevision: 1,
    report: 'Evidence survives.', criteria: host.calls[0]!.nonCodeCriteria, reviewerId: 'lead', rationale: 'Accepted.' })
  await reports.accepted(reports.list()[0]!.id)
  await runtime.close()
  await reports.close()
  await workflows.close()
  closeables.length = 0

  const restoredWorkflows = await WorkflowStore.open(directory)
  const restoredReports = await ReportStore.open(directory)
  const restored = await WorkflowRuntime.open(directory, restoredWorkflows, restoredReports, host, [template])
  closeables.push(restored, restoredReports, restoredWorkflows)
  expect((await restored.resume('workflow-restart', { id: 'project', teamIds: ['lead'] }))!.steps).toContainEqual(expect.objectContaining({ stepId: 'report', taskId: 'task-2' }))
  expect(host.calls).toHaveLength(2)
  expect(restored.inspect(created.executionId)!.steps).toMatchObject([{ stepId: 'investigate', taskId: 'task-1', phase: 'completed' }, { stepId: 'report', taskId: 'task-2', phase: 'running' }])
})

it('rejects templates outside the initial report-review slice and ignores pending report intents', async () => {
  const { reports, runtime } = await fixture()
  await expect(runtime.create({ projectId: 'project', teamId: 'lead', templateId: 'implementation-test-review-integration', templateVersion: 1, parameters: {}, executionId: 'no-code' }, { id: 'project', teamIds: ['lead'] })).rejects.toThrow(/unsupported|template/i)
  await runtime.create({ projectId: 'project', teamId: 'lead', templateId: 'investigation-report', templateVersion: 1, parameters: { question: 'Receipt fence' }, executionId: 'receipt-fence' }, { id: 'project', teamIds: ['lead'] })
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  await reports.record({ projectId: 'project', teamId: 'lead', taskId: 'task-1', attemptId: 'attempt-1', generation: 1, expectedRevision: 2, expectedTaskRevision: 1,
    report: 'Unaccepted report.', criteria: 'Report review: Investigate Receipt fence', reviewerId: 'lead', rationale: 'Not accepted yet.' })
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(runtime.inspect('receipt-fence')!.steps[0]).toMatchObject({ phase: 'running' })
})

it('runs the pinned code path through submission, verified candidate, fresh candidate review, approval, and one integration receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-workflow-code-runtime-'))
  roots.push(directory)
  const workflows = await WorkflowStore.open(directory)
  const reports = await ReportStore.open(directory)
  const host = new CodeHost()
  const runtime = await WorkflowRuntime.open(directory, workflows, reports, host, [codeTemplate])
  closeables.push(runtime, reports, workflows)
  const source = 'a'.repeat(40), firstCandidate = 'b'.repeat(40), secondCandidate = 'c'.repeat(40), firstTarget = 'd'.repeat(40), secondTarget = 'e'.repeat(40)
  await runtime.create({ projectId: 'project', teamId: 'lead', templateId: codeTemplate.id, templateVersion: 1, parameters: { subject: 'the workflow path' }, executionId: 'code-vertical' }, { id: 'project', teamIds: ['lead'] })
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(host.codeCalls).toHaveLength(1)
  host.status = { sourceCommit: source, submissionId: 'submission-1', integrationId: 'integration-1', phase: 'verified', targetCommit: firstTarget, candidateCommit: firstCandidate, reviewGate: host.codeCalls[0]!.reviewGate }
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(runtime.inspect('code-vertical')!.steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ stepId: 'implement', phase: 'completed' }), expect.objectContaining({ stepId: 'test', phase: 'completed' }), expect.objectContaining({ stepId: 'review', phase: 'running', taskId: 'task-1' }),
  ]))
  expect(host.calls[0]!.description).toContain(firstCandidate)
  await reports.record({ projectId: 'project', teamId: 'lead', taskId: 'task-1', attemptId: 'review-attempt-1', generation: 1, expectedRevision: 2, expectedTaskRevision: 1,
    report: 'Candidate is correct.', criteria: host.calls[0]!.nonCodeCriteria, reviewerId: 'lead', rationale: 'Reviewed the pinned diff.', decision: 'approved', reviewBinding: { projectId: 'project', teamId: 'lead', executionId: 'code-vertical', candidateRound: 0, ...host.calls[0]!.review! } })
  await reports.accepted(reports.list()[0]!.id)
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(host.approvals).toEqual([expect.objectContaining({ sourceCommit: source, targetCommit: firstTarget, candidateCommit: firstCandidate, reviewId: reports.list()[0]!.id })])

  host.status = { ...host.status, phase: 'verified', targetCommit: secondTarget, candidateCommit: secondCandidate, previousCandidates: [firstCandidate], diagnostic: 'target advanced' }
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(workflows.inspect('code-vertical')!.candidateHistory[0]).toMatchObject({ candidate: { kind: 'commit', ref: firstCandidate }, replacement: { candidate: { kind: 'commit', ref: secondCandidate } } })
  expect(workflows.inspect('code-vertical')!.candidateHistory[0]!.priorSteps.find(step => step.id === 'review')).toMatchObject({ phase: 'completed', receipt: { kind: 'report-review', reference: { kind: 'report', ref: reports.list()[0]!.id } } })
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(runtime.inspect('code-vertical')!.steps.find(step => step.stepId === 'review')).toMatchObject({ phase: 'running', taskId: 'task-2' })
  expect(host.calls[1]!.description).toContain(secondCandidate)
  await reports.record({ projectId: 'project', teamId: 'lead', taskId: 'task-2', attemptId: 'review-attempt-2', generation: 1, expectedRevision: 2, expectedTaskRevision: 1,
    report: 'New candidate is correct.', criteria: host.calls[1]!.nonCodeCriteria, reviewerId: 'lead', rationale: 'Reviewed the new pinned diff.', decision: 'approved', reviewBinding: { projectId: 'project', teamId: 'lead', executionId: 'code-vertical', candidateRound: 1, ...host.calls[1]!.review! } })
  await reports.accepted(reports.list()[1]!.id)
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(host.approvals).toHaveLength(2)
  host.status = { ...host.status, phase: 'merged', reviewId: reports.list()[1]!.id }
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(workflows.inspect('code-vertical')!.steps.find(step => step.id === 'integrate')).toMatchObject({ phase: 'completed', receipt: { kind: 'integrated', candidate: { kind: 'commit', ref: secondCandidate } } })
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(host.approvals).toHaveLength(2)
})

it('reconciles already-submitted repair ancestry in source order after a missed scan', async () => {
  const { workflows, host, runtime } = await codeFixture()
  const original = 'a'.repeat(40), repaired = 'b'.repeat(40)
  await runtime.create({ projectId: 'project', teamId: 'lead', templateId: codeTemplate.id, templateVersion: 1,
    parameters: { subject: 'missed repair scan' }, executionId: 'missed-repair-lineage' }, { id: 'project', teamIds: ['lead'] })
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  host.status = {
    sourceCommit: repaired, submissionId: 'submission-repaired', integrationId: 'integration-repaired', phase: 'failed', reviewGate: host.codeCalls[0]!.reviewGate,
    repair: { previousAttemptId: 'attempt-original', submissionId: 'submission-original', sourceCommit: original, round: 1, budget: 1 },
    sourceLineage: [
      { sourceCommit: original, submissionId: 'submission-original', integrationId: 'integration-original' },
      { sourceCommit: repaired, submissionId: 'submission-repaired', integrationId: 'integration-repaired',
        repair: { previousAttemptId: 'attempt-original', submissionId: 'submission-original', sourceCommit: original, round: 1, budget: 1 } },
    ],
  }

  // Both source submissions were durable before the first code reconciliation.
  // The runtime must retain the original checkpoint before reworking it.
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(workflows.inspect('missed-repair-lineage')!.steps.find(step => step.id === 'implement')).toMatchObject({ phase: 'completed', artifacts: { source: { ref: original } } })
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(workflows.inspect('missed-repair-lineage')!.sourceHistory).toMatchObject([{ source: { ref: original }, replacement: { ref: repaired }, repair: { submissionId: 'submission-original', round: 1 } }])
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(workflows.inspect('missed-repair-lineage')!.steps.find(step => step.id === 'implement')).toMatchObject({ phase: 'completed', artifacts: { source: { ref: repaired } } })
  expect(host.codeCalls).toHaveLength(1)
})

it('requires a pinned server grant and replays one idempotent publication after a post-effect crash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-release-runtime-'))
  roots.push(directory)
  const workflows = await WorkflowStore.open(directory)
  const reports = await ReportStore.open(directory)
  const host = new PublicationHost()
  const project = { id: 'project', teamIds: ['lead'], publicationGrants: [{ teamId: 'lead', authorization: 'release-manager' }], publicationPublisher: { identity: 'release-publisher', revision: 1 } }
  const runtime = await WorkflowRuntime.open(directory, workflows, reports, host, [releasePublicationTemplate])
  closeables.push(runtime, reports, workflows)
  await runtime.create({ projectId: 'project', teamId: 'lead', templateId: 'release-publication', templateVersion: 1, parameters: { release: 'v1' }, executionId: 'release-crash' }, project)
  await runtime.scan(project)
  const prepare = workflows.inspect('release-crash')!.steps.find(step => step.id === 'prepare')!
  await workflows.completeStep('release-crash', 'prepare', prepare.revision, { artifacts: { 'release-candidate': { kind: 'report', ref: 'manifest-v1' } }, receipt: { kind: 'report-review', reviewer: 'lead', decision: 'approved', reference: { kind: 'report', ref: 'manifest-v1' } } })
  await runtime.scan(project)
  const publish = workflows.inspect('release-crash')!.steps.find(step => step.id === 'publish')!
  await expect(runtime.authorizePublication('release-crash', 'publish', publish.revision, { kind: 'ticket', ref: 'CAB-1' }, 'other')).rejects.toThrow(/grant/)
  await runtime.authorizePublication('release-crash', 'publish', publish.revision, { kind: 'ticket', ref: 'CAB-1' }, 'lead')
  const journal = (runtime as unknown as { journal: { append(producer: () => unknown): Promise<unknown> } }).journal
  const append = journal.append.bind(journal)
  journal.append = async producer => {
    const event = producer() as { type?: string }
    if (event.type === 'workflow-runtime/publication-recorded') throw new Error('injected crash after publisher effect')
    return await append(() => event)
  }
  await expect(runtime.scan(project)).rejects.toThrow(/publisher effect/)
  const firstKey = host.publicationCalls[0]!.idempotencyKey
  await runtime.close(); await reports.close(); await workflows.close(); closeables.length = 0
  const restoredWorkflows = await WorkflowStore.open(directory), restoredReports = await ReportStore.open(directory)
  const restored = await WorkflowRuntime.open(directory, restoredWorkflows, restoredReports, host, [releasePublicationTemplate])
  closeables.push(restored, restoredReports, restoredWorkflows)
  await restored.resume('release-crash', project)
  expect(host.publicationCalls.map(call => call.idempotencyKey)).toEqual([firstKey, firstKey])
  expect(host.effects).toEqual(new Set([firstKey]))
  expect(restoredWorkflows.inspect('release-crash')!.steps.find(step => step.id === 'publish')).toMatchObject({ phase: 'completed', receipt: { kind: 'externally-authorized-publication', publisher: 'release-publisher' } })
})

it('fails closed before any publisher call when the restored publisher identity or revision differs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-release-publisher-mismatch-')); roots.push(directory)
  const workflows = await WorkflowStore.open(directory), reports = await ReportStore.open(directory), host = new PublicationHost()
  const project = { id: 'project', teamIds: ['lead'], publicationGrants: [{ teamId: 'lead', authorization: 'release-manager' }], publicationPublisher: { identity: 'release-publisher', revision: 1 } }
  const runtime = await WorkflowRuntime.open(directory, workflows, reports, host, [releasePublicationTemplate]); closeables.push(runtime, reports, workflows)
  await runtime.create({ projectId: 'project', teamId: 'lead', templateId: 'release-publication', templateVersion: 1, parameters: { release: 'v1' }, executionId: 'release-mismatch' }, project)
  await runtime.scan(project)
  const prepare = workflows.inspect('release-mismatch')!.steps[0]!
  await workflows.completeStep('release-mismatch', prepare.id, prepare.revision, { artifacts: { 'release-candidate': { kind: 'report', ref: 'manifest' } }, receipt: { kind: 'report-review', reviewer: 'lead', decision: 'approved', reference: { kind: 'report', ref: 'manifest' } } })
  await runtime.scan(project)
  const publish = workflows.inspect('release-mismatch')!.steps[1]!
  await runtime.authorizePublication('release-mismatch', publish.id, publish.revision, { kind: 'ticket', ref: 'CAB-3' }, 'lead')
  await runtime.close(); await reports.close(); await workflows.close(); closeables.length = 0
  const restoredWorkflows = await WorkflowStore.open(directory), restoredReports = await ReportStore.open(directory), changed = new PublicationHost()
  ;(changed as unknown as { publicationPublisher: { identity: string; revision: number } }).publicationPublisher = { identity: 'release-publisher', revision: 2 }
  const restored = await WorkflowRuntime.open(directory, restoredWorkflows, restoredReports, changed, [releasePublicationTemplate]); closeables.push(restored, restoredReports, restoredWorkflows)
  await expect(restored.resume('release-mismatch', project)).rejects.toThrow(/publisher configuration disagrees/)
  expect(changed.publicationCalls).toEqual([])
  expect(restoredWorkflows.inspect('release-mismatch')!.steps[1]).toMatchObject({ phase: 'running' })
})

it('replays a durable candidate invalidation after the binding-reset crash boundary without reusing its report or approval', async () => {
  const { directory, workflows, reports, host, runtime } = await codeFixture()
  const source = '1'.repeat(40), oldCandidate = '2'.repeat(40), newCandidate = '3'.repeat(40), oldTarget = '4'.repeat(40), newTarget = '5'.repeat(40)
  await runtime.create({ projectId: 'project', teamId: 'lead', templateId: codeTemplate.id, templateVersion: 1, parameters: { subject: 'candidate replay' }, executionId: 'candidate-replay' }, { id: 'project', teamIds: ['lead'] })
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  host.status = { sourceCommit: source, submissionId: 'submission-old', integrationId: 'integration-old', phase: 'verified', targetCommit: oldTarget, candidateCommit: oldCandidate, reviewGate: host.codeCalls[0]!.reviewGate }
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  await reports.record({ projectId: 'project', teamId: 'lead', taskId: 'task-1', attemptId: 'review-old', generation: 1, expectedRevision: 2, expectedTaskRevision: 1,
    report: 'The original candidate was accepted.', criteria: host.calls[0]!.nonCodeCriteria, reviewerId: 'lead', rationale: 'Exact old candidate reviewed.', decision: 'approved',
    reviewBinding: { projectId: 'project', teamId: 'lead', executionId: 'candidate-replay', candidateRound: 0, ...host.calls[0]!.review! } })
  await reports.accepted(reports.list()[0]!.id)
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(host.approvals).toHaveLength(1)

  const oldReview = reports.list()[0]!.id
  const test = workflows.inspect('candidate-replay')!.steps.find(step => step.id === 'test')!
  await workflows.invalidateCandidate('candidate-replay', 'test', test.revision, {
    integration: { kind: 'integration', ref: 'integration-new' }, source: { kind: 'commit', ref: source }, target: { kind: 'commit', ref: newTarget }, candidate: { kind: 'commit', ref: newCandidate },
    retryRound: 1, previousCandidates: [{ kind: 'commit', ref: oldCandidate }],
  }, 'target moved after the original candidate review')
  // Simulate SIGKILL after WorkflowStore flushes the transition, before the runtime can append task-reset.
  await runtime.close(); await reports.close(); await workflows.close(); closeables.length = 0

  host.status = { sourceCommit: source, submissionId: 'submission-new', integrationId: 'integration-new', phase: 'verified', targetCommit: newTarget, candidateCommit: newCandidate, reviewGate: host.codeCalls[0]!.reviewGate, previousCandidates: [oldCandidate] }
  const restoredWorkflows = await WorkflowStore.open(directory)
  const restoredReports = await ReportStore.open(directory)
  const restored = await WorkflowRuntime.open(directory, restoredWorkflows, restoredReports, host, [codeTemplate])
  closeables.push(restored, restoredReports, restoredWorkflows)
  await restored.resume('candidate-replay', { id: 'project', teamIds: ['lead'] })

  expect(host.codeCalls).toHaveLength(1)
  expect(host.calls).toHaveLength(2)
  expect(restored.inspect('candidate-replay')!.steps.find(step => step.stepId === 'review')).toMatchObject({ taskId: 'task-2', phase: 'running' })
  expect(restored.inspect('candidate-replay')!.steps.find(step => step.stepId === 'review')).not.toMatchObject({ reportId: oldReview })
  expect(restoredWorkflows.inspect('candidate-replay')!.candidateHistory[0]).toMatchObject({ candidate: { kind: 'commit', ref: oldCandidate } })
  expect(restoredWorkflows.inspect('candidate-replay')!.candidateHistory[0]!.priorSteps.find(step => step.id === 'review')).toMatchObject({ receipt: { kind: 'report-review', reference: { ref: oldReview } } })

  host.status = { ...host.status, phase: 'merged', reviewId: oldReview }
  await restored.scan({ id: 'project', teamIds: ['lead'] })
  expect(host.approvals).toHaveLength(1)
  expect(restoredWorkflows.inspect('candidate-replay')!.steps.find(step => step.id === 'integrate')).toMatchObject({ phase: 'pending' })
  expect((await readFile(join(directory, 'workflow-runtime.jsonl'), 'utf8')).split('\n').filter(line => line.includes('workflow-runtime/task-reset'))).toHaveLength(1)
})

it('archives a stale candidate-review intent before task creation and never resets the pinned implementation task', async () => {
  const { directory, workflows, reports, host, runtime } = await codeFixture()
  const source = 'c'.repeat(40), firstCandidate = 'd'.repeat(40), secondCandidate = 'e'.repeat(40), firstTarget = 'f'.repeat(40), secondTarget = '0'.repeat(40)
  await runtime.create({ projectId: 'project', teamId: 'lead', templateId: codeTemplate.id, templateVersion: 1, parameters: { subject: 'intent replay' }, executionId: 'intent-replay' }, { id: 'project', teamIds: ['lead'] })
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  host.status = { sourceCommit: source, submissionId: 'submission-old', integrationId: 'integration-old', phase: 'verified', targetCommit: firstTarget, candidateCommit: firstCandidate, reviewGate: host.codeCalls[0]!.reviewGate }
  host.failTaskCreation = true
  await expect(runtime.scan({ id: 'project', teamIds: ['lead'] })).rejects.toThrow(/injected task creation crash/)
  expect(host.calls).toHaveLength(1)
  const test = workflows.inspect('intent-replay')!.steps.find(step => step.id === 'test')!
  await workflows.invalidateCandidate('intent-replay', 'test', test.revision, {
    integration: { kind: 'integration', ref: 'integration-new' }, source: { kind: 'commit', ref: source }, target: { kind: 'commit', ref: secondTarget }, candidate: { kind: 'commit', ref: secondCandidate },
    retryRound: 1, previousCandidates: [{ kind: 'commit', ref: firstCandidate }],
  }, 'target advanced after reviewer intent was persisted')
  await runtime.close(); await reports.close(); await workflows.close(); closeables.length = 0

  host.failTaskCreation = false
  host.status = { sourceCommit: source, submissionId: 'submission-new', integrationId: 'integration-new', phase: 'verified', targetCommit: secondTarget, candidateCommit: secondCandidate, reviewGate: host.codeCalls[0]!.reviewGate, previousCandidates: [firstCandidate] }
  const restoredWorkflows = await WorkflowStore.open(directory)
  const restoredReports = await ReportStore.open(directory)
  const restored = await WorkflowRuntime.open(directory, restoredWorkflows, restoredReports, host, [codeTemplate])
  closeables.push(restored, restoredReports, restoredWorkflows)
  await restored.resume('intent-replay', { id: 'project', teamIds: ['lead'] })

  expect(host.codeCalls).toHaveLength(1)
  expect(host.calls).toHaveLength(2)
  expect(restored.inspect('intent-replay')!.steps.find(step => step.stepId === 'review')).toMatchObject({ taskId: 'task-1', phase: 'running' })
  expect(restoredWorkflows.inspect('intent-replay')!.candidateHistory[0]!.priorSteps.find(step => step.id === 'review')).toMatchObject({ phase: 'pending' })
  expect((await readFile(join(directory, 'workflow-runtime.jsonl'), 'utf8')).split('\n').filter(line => line.includes('workflow-runtime/task-reset'))).toHaveLength(1)
})

it('replays a durable source rework after the binding-reset crash boundary without recreating implementation work', async () => {
  const { directory, workflows, reports, host, runtime } = await codeFixture()
  const oldSource = '6'.repeat(40), newSource = '7'.repeat(40), oldCandidate = '8'.repeat(40), newCandidate = '9'.repeat(40), oldTarget = 'a'.repeat(40), newTarget = 'b'.repeat(40)
  await runtime.create({ projectId: 'project', teamId: 'lead', templateId: codeTemplate.id, templateVersion: 1, parameters: { subject: 'source replay' }, executionId: 'source-replay' }, { id: 'project', teamIds: ['lead'] })
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  host.status = { sourceCommit: oldSource, submissionId: 'submission-old', integrationId: 'integration-old', phase: 'verified', targetCommit: oldTarget, candidateCommit: oldCandidate, reviewGate: host.codeCalls[0]!.reviewGate }
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  await reports.record({ projectId: 'project', teamId: 'lead', taskId: 'task-1', attemptId: 'review-old', generation: 1, expectedRevision: 2, expectedTaskRevision: 1,
    report: 'The old source was accepted.', criteria: host.calls[0]!.nonCodeCriteria, reviewerId: 'lead', rationale: 'Exact old source candidate reviewed.', decision: 'approved',
    reviewBinding: { projectId: 'project', teamId: 'lead', executionId: 'source-replay', candidateRound: 0, ...host.calls[0]!.review! } })
  await reports.accepted(reports.list()[0]!.id)
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(host.approvals).toHaveLength(1)

  const oldReview = reports.list()[0]!.id
  const implement = workflows.inspect('source-replay')!.steps.find(step => step.id === 'implement')!
  await workflows.reworkSource('source-replay', 'implement', implement.revision, { kind: 'commit', ref: newSource }, {
    previousAttemptId: 'attempt-old', submissionId: 'submission-old', sourceCommit: oldSource, round: 1, budget: 1,
  }, 'authorized repair replaced the submitted source')
  // Simulate SIGKILL after WorkflowStore flushes the source transition, before task bindings are reset.
  await runtime.close(); await reports.close(); await workflows.close(); closeables.length = 0

  host.status = { sourceCommit: newSource, submissionId: 'submission-new', integrationId: 'integration-new', phase: 'verified', targetCommit: newTarget, candidateCommit: newCandidate, reviewGate: host.codeCalls[0]!.reviewGate,
    repair: { previousAttemptId: 'attempt-old', submissionId: 'submission-old', sourceCommit: oldSource, round: 1, budget: 1 } }
  const restoredWorkflows = await WorkflowStore.open(directory)
  const restoredReports = await ReportStore.open(directory)
  const restored = await WorkflowRuntime.open(directory, restoredWorkflows, restoredReports, host, [codeTemplate])
  closeables.push(restored, restoredReports, restoredWorkflows)
  await restored.resume('source-replay', { id: 'project', teamIds: ['lead'] })
  await restored.resume('source-replay', { id: 'project', teamIds: ['lead'] })

  expect(host.codeCalls).toHaveLength(1)
  expect(host.calls).toHaveLength(2)
  expect(restored.inspect('source-replay')!.steps.find(step => step.stepId === 'review')).toMatchObject({ taskId: 'task-2', phase: 'running' })
  expect(restoredWorkflows.inspect('source-replay')!.sourceHistory[0]).toMatchObject({ source: { kind: 'commit', ref: oldSource }, replacement: { kind: 'commit', ref: newSource } })
  expect(restoredWorkflows.inspect('source-replay')!.sourceHistory[0]!.priorSteps.find(step => step.id === 'review')).toMatchObject({ receipt: { kind: 'report-review', reference: { ref: oldReview } } })
  const runtimeLog = await readFile(join(directory, 'workflow-runtime.jsonl'), 'utf8')
  expect(runtimeLog).toContain('"sourceRound":1')
  expect(runtimeLog.split('\n').filter(line => line.includes('workflow-runtime/task-reset'))).toHaveLength(1)

  host.status = { ...host.status, phase: 'merged', reviewId: oldReview }
  await restored.scan({ id: 'project', teamIds: ['lead'] })
  expect(host.approvals).toHaveLength(1)
  expect(restoredWorkflows.inspect('source-replay')!.steps.find(step => step.id === 'integrate')).toMatchObject({ phase: 'pending' })
})
