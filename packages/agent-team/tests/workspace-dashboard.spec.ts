import { expect, it } from 'vitest'
import { projectWorkspaceDashboard } from '../src/workspace-dashboard.ts'

const input = {
  projects: [
    { id: 'api', revision: 2, paused: false, capacity: 2, active: 1, repository: '/private/api', publicationToken: 'secret' },
    { id: 'web', revision: 3, paused: true, capacity: 1, active: 0 },
  ],
  attempts: [
    { attemptId: 'attempt-api', generation: 1, revision: 4, projectId: 'api', teamId: 'lead-api', taskId: 'task-api', phase: 'active', progress: { classification: 'progressing', certainty: 'known', observedAt: 10, cursor: 'secret-tool-output' }, externalUsage: { provider: 'external', attemptId: 'attempt-api', generation: 1, runtimeRevision: 7, inputTokens: 0, cachedInputTokens: 4, outputTokens: 0, reasoningOutputTokens: 2, estimatedCost: 99, rawReceipt: 'secret-provider-receipt' }, prompt: 'do not expose' },
    { attemptId: 'attempt-web', generation: 1, revision: 1, projectId: 'web', teamId: 'lead-web', taskId: 'task-web', phase: 'terminal', provisioning: { count: 1, maxAttempts: 2, notBefore: 50, retryable: true }, progress: { classification: 'unavailable', certainty: 'uncertain', observedAt: 11 } },
  ],
  workflows: [{ executionId: 'workflow-api', projectId: 'api', teamId: 'lead-api', steps: [
    { stepId: 'implement', revision: 2, phase: 'completed', taskId: 'task-api', report: 'private report' },
    { stepId: 'review', revision: 1, phase: 'running', taskId: 'task-review' },
  ] }],
  batches: [{ id: 'release', phase: 'active', required: 2, completedRequired: 1, completionEpoch: 0, history: [{ phase: 'reopened', at: 9 }] }],
  mergeBatches: [{ id: 'merge-api', phase: 'active', members: [{ integrationId: 'integration-api', projectId: 'api', teamId: 'lead-api', taskId: 'task-api', privatePath: '/secret' }] }],
  queue: [{ projectId: 'web', teamId: 'lead-web', taskId: 'task-web', revision: 3, state: 'waiting', blockers: [
    { code: 'workspace-batch-dependency', detail: 'private dependency path' },
  ] }],
  integrations: [{ integrationId: 'integration-api', projectId: 'api', teamId: 'lead-api', phase: 'failed', sourceCommit: 'a'.repeat(40), failureKind: 'verification', diagnostic: 'Checks failed.', worktree: '/private/worktree' }],
  escalations: [{ id: 'health-api', revision: 2, projectId: 'api', teamId: 'lead-api', taskId: 'task-api', attemptId: 'attempt-api', generation: 1, severity: 'warning', condition: 'stale', diagnostics: 'No durable checkpoint.', token: 'secret' }],
}

it('projects an operator-safe dashboard and strips prompts, paths, credentials, and unsupported fields', () => {
  const view = projectWorkspaceDashboard(input)
  expect(view.projectsTruncated).toBe(false)
  expect(view.attempts[0]).toMatchObject({ attemptId: 'attempt-api', phase: 'active', progress: { classification: 'progressing', certainty: 'known', observedAt: 10 } })
  expect(view.attempts[0]?.externalUsage).toEqual({ provider: 'external', attemptId: 'attempt-api', generation: 1, runtimeRevision: 7, inputTokens: 0, cachedInputTokens: 4, outputTokens: 0, reasoningOutputTokens: 2 })
  expect(view.workflows[0]?.executionId).toBe('workflow-api')
  expect(view.attempts[1]?.provisioning).toEqual({ count: 1, maxAttempts: 2, notBefore: 50, retryable: true })
  expect(view.workflows[0]?.steps[0]).toMatchObject({ stepId: 'implement', taskId: 'task-api' })
  expect(view.batches[0]).toMatchObject({ id: 'release', completedRequired: 1, required: 2 })
  expect(view.mergeBatches[0]).toEqual({ id: 'merge-api', phase: 'active', members: [{ integrationId: 'integration-api', projectId: 'api', teamId: 'lead-api', taskId: 'task-api' }] })
  expect(view.queue[0]).toMatchObject({ blockers: [{ code: 'workspace-batch-dependency' }] })
  expect(view.integrations[0]).toMatchObject({ integrationId: 'integration-api', phase: 'failed', failureKind: 'verification', diagnostic: 'Checks failed.' })
  expect(view.escalations[0]).toMatchObject({ severity: 'warning', diagnostics: 'No durable checkpoint.' })
  expect(JSON.stringify(view)).not.toMatch(/private|secret|prompt|repository|cursor|report|estimatedCost|rawReceipt/i)
})

it('preserves missing provider usage as unknown and rejects a receipt attributed to another attempt generation', () => {
  const unknown = projectWorkspaceDashboard({ ...input, attempts: [{ ...input.attempts[1], externalUsage: undefined }], workflows: [], batches: [], mergeBatches: [], queue: [], integrations: [], escalations: [] })
  expect(unknown.attempts[0]?.externalUsage).toBeUndefined()
  expect(() => projectWorkspaceDashboard({ ...input, attempts: [{ ...input.attempts[0], externalUsage: { provider: 'external', attemptId: 'attempt-api', generation: 2, runtimeRevision: 7, inputTokens: 1 } }] })).toThrow(/generation/i)
})

it('bounds every dashboard collection, workflow step, and queue blocker list with explicit truncation', () => {
  const view = projectWorkspaceDashboard(input, { projects: 1, attempts: 1, workflows: 1, workflowSteps: 1, batches: 0, mergeBatches: 0, queue: 1, queueBlockers: 0, integrations: 0, escalations: 0 })
  expect(view).toMatchObject({
    projectsTruncated: true, attemptsTruncated: true, workflowsTruncated: false,
    batchesTruncated: true, mergeBatchesTruncated: true, queueTruncated: false, integrationsTruncated: true, escalationsTruncated: true,
  })
  expect(view.projects).toHaveLength(1)
  expect(view.attempts).toHaveLength(1)
  expect(view.workflows[0]).toMatchObject({ stepsTruncated: true })
  expect(view.workflows[0]!.steps).toHaveLength(1)
  expect(view.batches).toEqual([])
  expect(view.mergeBatches).toEqual([])
  expect(view.queue[0]).toMatchObject({ blockers: [], blockersTruncated: true })
  expect(view.integrations).toEqual([])
  expect(view.escalations).toEqual([])
})

it('preserves authoritative uncertain health rather than inventing active progress or terminal success', () => {
  const view = projectWorkspaceDashboard({ ...input, attempts: [input.attempts[1]], workflows: [], batches: [], mergeBatches: [], queue: [], integrations: [], escalations: [] })
  expect(view.attempts).toEqual([expect.objectContaining({ phase: 'terminal', progress: { classification: 'unavailable', certainty: 'uncertain', observedAt: 11 } })])
})
