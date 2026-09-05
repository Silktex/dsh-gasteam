/** Built-in templates shipped with the coordinator package, independent of process.cwd(). */
import type { WorkflowTemplate } from './workflows.ts'

export const investigationReportTemplate = {
  format: 'agent-team-workflow/v1', id: 'investigation-report', version: 1,
  parameters: { question: { type: 'string', required: true } },
  steps: [
    { id: 'investigate', title: 'Investigate {{question}}', retry: { maxAttempts: 2, backoffMs: 1000 }, artifacts: { produces: ['findings'] }, acceptance: { kind: 'report-review' } },
    { id: 'report', title: 'Review report for {{question}}', dependsOn: ['investigate'], retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { requires: ['findings'], produces: ['report'] }, acceptance: { kind: 'report-review' } },
  ],
} satisfies WorkflowTemplate

/**
 * The code path deliberately routes verification through the existing pinned
 * integration worker. `review` is a fresh non-code Lead review task whose
 * intent names the exact source, target, candidate, and integration receipt.
 */
export const implementationTestReviewIntegrationTemplate = {
  format: 'agent-team-workflow/v1', id: 'implementation-test-review-integration', version: 1,
  parameters: { subject: { type: 'string', required: true } },
  steps: [
    { id: 'implement', title: 'Implement {{subject}}', retry: { maxAttempts: 4, backoffMs: 0 }, artifacts: { produces: ['source'] }, acceptance: { kind: 'artifact-submitted', artifact: 'source' } },
    { id: 'test', title: 'Verify {{subject}}', dependsOn: ['implement'], retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { requires: ['source'], produces: ['candidate'] }, acceptance: { kind: 'checks-passed', source: 'source', candidate: 'candidate' } },
    { id: 'review', title: 'Review verified {{subject}}', dependsOn: ['test'], retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { requires: ['source', 'candidate'], produces: ['review'] }, acceptance: { kind: 'report-review' } },
    { id: 'integrate', title: 'Integrate reviewed {{subject}}', dependsOn: ['review'], retry: { maxAttempts: 1, backoffMs: 0 }, artifacts: { requires: ['source', 'candidate', 'review'] }, acceptance: { kind: 'integrated', source: 'source', candidate: 'candidate' } },
  ],
} satisfies WorkflowTemplate
