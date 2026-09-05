import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReportStore } from '../src/reports.ts'
import { WorkflowRuntime, type WorkflowTaskHost } from '../src/workflow-runtime.ts'
import { WorkflowStore } from '../src/workflows.ts'

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
  readonly calls: { intentId: string; subject: string; description: string; criteria: string }[] = []
  private readonly tasks = new Map<string, string>()

  async createPinnedTask(input: { intentId: string; projectId: string; teamId: string; subject: string; description: string; nonCodeCriteria: string }): Promise<{ taskId: string }> {
    this.calls.push(input)
    let taskId = this.tasks.get(input.intentId)
    if (!taskId) { taskId = `task-${this.tasks.size + 1}`; this.tasks.set(input.intentId, taskId) }
    return { taskId }
  }
}

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
  await expect(runtime.create({ projectId: 'project', teamId: 'lead', templateId: 'implementation-test-review-integration', templateVersion: 1, parameters: {}, executionId: 'no-code' }, { id: 'project', teamIds: ['lead'] })).rejects.toThrow(/only.*investigation-report|unsupported/i)
  await runtime.create({ projectId: 'project', teamId: 'lead', templateId: 'investigation-report', templateVersion: 1, parameters: { question: 'Receipt fence' }, executionId: 'receipt-fence' }, { id: 'project', teamIds: ['lead'] })
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  await reports.record({ projectId: 'project', teamId: 'lead', taskId: 'task-1', attemptId: 'attempt-1', generation: 1, expectedRevision: 2, expectedTaskRevision: 1,
    report: 'Unaccepted report.', criteria: 'Report review: Investigate Receipt fence', reviewerId: 'lead', rationale: 'Not accepted yet.' })
  await runtime.scan({ id: 'project', teamIds: ['lead'] })
  expect(runtime.inspect('receipt-fence')!.steps[0]).toMatchObject({ phase: 'running' })
})
