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
