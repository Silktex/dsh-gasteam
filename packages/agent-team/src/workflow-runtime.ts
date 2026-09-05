/** Host-only vertical runtime for the pinned investigation/report workflow. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import z from 'zod'
import { DurableJournal } from './durable-journal.ts'
import type { ReportAcceptanceRecord } from './reports.ts'
import { ReportStore } from './reports.ts'
import { pinWorkflowDefinition, validateWorkflowTemplate, WorkflowStore } from './workflows.ts'
import type { PinnedWorkflowDefinition, WorkflowExecution } from './workflows.ts'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const text = z.string().trim().min(1).max(16_384)
const scalar = z.union([z.string().max(16_384), z.number().finite(), z.boolean()])

/** The registered project grant required to create or resume its workflow work. */
export interface WorkflowRuntimeProject {
  readonly id: string
  readonly teamIds: readonly string[]
}

/** Persisted before the host is allowed to create the corresponding Team task. */
export interface WorkflowTaskCreateIntent {
  readonly intentId: string
  readonly projectId: string
  readonly teamId: string
  readonly executionId: string
  readonly stepId: string
  readonly subject: string
  readonly description: string
  readonly nonCodeCriteria: string
}

/**
 * Host boundary for task creation. The implementation must key idempotency on
 * `intentId`; it must never infer ownership from user-visible task text.
 */
export interface WorkflowTaskHost {
  createPinnedTask(intent: WorkflowTaskCreateIntent): Promise<{ taskId: string }>
}

export const createWorkflowRequestSchema = z.object({
  projectId: id, teamId: id, templateId: id, templateVersion: positive, parameters: z.record(id, scalar), executionId: id.optional(),
}).strict()
export type CreateWorkflowRequest = z.input<typeof createWorkflowRequestSchema>

const intentSchema = z.object({
  intentId: id, projectId: id, teamId: id, executionId: id, stepId: id, subject: text, description: text, nonCodeCriteria: text,
}).strict()
const creationSchema = z.object({
  executionId: id, projectId: id, teamId: id, template: z.unknown(), parameters: z.record(id, scalar), definition: z.unknown(),
}).strict()
const bindingSchema = z.object({
  executionId: id, projectId: id, teamId: id, stepId: id, intent: intentSchema.optional(), taskId: id.optional(), reportId: id.optional(),
}).strict()
const envelope = { version: z.literal(1), sequence: positive }
const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('workflow-runtime/created'), creation: creationSchema }).strict(),
  z.object({ ...envelope, type: z.literal('workflow-runtime/task-intended'), executionId: id, stepId: id, intent: intentSchema }).strict(),
  z.object({ ...envelope, type: z.literal('workflow-runtime/task-created'), executionId: id, stepId: id, taskId: id }).strict(),
  z.object({ ...envelope, type: z.literal('workflow-runtime/step-receipted'), executionId: id, stepId: id, reportId: id }).strict(),
])
type Event = z.output<typeof eventSchema>
type Payload = Event extends infer E ? E extends Event ? Omit<E, 'version' | 'sequence'> : never : never

interface Creation {
  readonly executionId: string
  readonly projectId: string
  readonly teamId: string
  readonly template: PinnedWorkflowDefinition
  readonly parameters: Record<string, string | number | boolean>
  readonly definition: PinnedWorkflowDefinition
}
interface State { readonly creations: Creation[]; readonly bindings: z.output<typeof bindingSchema>[] }

function binding(state: State, executionId: string, stepId: string) {
  return state.bindings.find(value => value.executionId === executionId && value.stepId === stepId)
}
function replaceBinding(state: State, next: z.output<typeof bindingSchema>): State {
  return { ...state, bindings: [...state.bindings.filter(value => value.executionId !== next.executionId || value.stepId !== next.stepId), next] }
}
function reduce(state: State, raw: unknown): State {
  const event = eventSchema.parse(raw)
  if (event.type === 'workflow-runtime/created') {
    if (state.creations.some(value => value.executionId === event.creation.executionId)) throw new Error('Workflow runtime execution already exists')
    const template = validateReportTemplate(event.creation.template)
    const definition = validateReportTemplate(event.creation.definition)
    if (!isDeepStrictEqual(pinWorkflowDefinition(template, event.creation.parameters), definition)) throw new Error('Workflow runtime creation has a different pinned definition')
    const creation: Creation = { ...event.creation, template, definition }
    return { ...state, creations: [...state.creations, creation] }
  }
  const creation = state.creations.find(value => value.executionId === event.executionId)
  if (!creation) throw new Error('Workflow runtime execution is missing')
  const prior = binding(state, event.executionId, event.stepId) ?? { executionId: event.executionId, projectId: creation.projectId, teamId: creation.teamId, stepId: event.stepId }
  if (event.type === 'workflow-runtime/task-intended') {
    if (prior.intent || prior.taskId || prior.reportId) throw new Error('Workflow task intent already exists')
    if (event.intent.executionId !== event.executionId || event.intent.stepId !== event.stepId || event.intent.projectId !== creation.projectId || event.intent.teamId !== creation.teamId) throw new Error('Workflow task intent escapes its execution grant')
    return replaceBinding(state, { ...prior, intent: event.intent })
  }
  if (event.type === 'workflow-runtime/task-created') {
    if (!prior.intent || prior.taskId || prior.reportId) throw new Error('Workflow task creation lacks an unconsumed intent')
    return replaceBinding(state, { ...prior, taskId: event.taskId })
  }
  if (!prior.taskId || prior.reportId) throw new Error('Workflow report receipt lacks a created task or is already recorded')
  return replaceBinding(state, { ...prior, reportId: event.reportId })
}

function validateReportTemplate(value: unknown): PinnedWorkflowDefinition {
  const template = validateWorkflowTemplate(value)
  if (template.id !== 'investigation-report') throw new Error('Only the investigation-report report-review template is supported by this workflow runtime')
  if (!template.steps.every(step => step.acceptance.kind === 'report-review')) throw new Error('Only report-review workflow steps are supported by this workflow runtime')
  return template
}
function assertProject(project: WorkflowRuntimeProject, projectId: string, teamId: string): void {
  if (project.id !== projectId || !project.teamIds.includes(teamId)) throw new Error('Workflow project or Lead team is not registered')
}
function validateTaskCompatibleDefinition(definition: PinnedWorkflowDefinition): void {
  for (const step of definition.steps) {
    if (step.title.length > 200) throw new Error(`Workflow step ${step.id} title exceeds the managed task subject limit`)
    if (`Report review: ${step.title}`.length > 16_384) throw new Error(`Workflow step ${step.id} report criteria exceeds the managed task limit`)
  }
}
function excerpt(value: string, limit: number, notice: string): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - notice.length))}${notice}`
}

/** Durable execution/binding view. Workflow step phase remains authoritative in WorkflowStore. */
export interface WorkflowRuntimeView {
  readonly executionId: string
  readonly projectId: string
  readonly teamId: string
  readonly templateId: string
  readonly templateVersion: number
  readonly steps: readonly { stepId: string; taskId?: string; intentId?: string; reportId?: string; phase: WorkflowExecution['steps'][number]['phase'] }[]
}

/**
 * Connects immutable WorkflowStore checkpoints to concrete non-code Team tasks.
 * It owns no model-facing completion method: accepted ReportStore receipts are its
 * only progress input.
 */
export class WorkflowRuntime {
  private constructor(
    private readonly journal: DurableJournal<State, Payload>,
    private readonly workflows: WorkflowStore,
    private readonly reports: ReportStore,
    private readonly tasks: WorkflowTaskHost,
    private readonly templates: Map<string, PinnedWorkflowDefinition>,
  ) {}

  static async open(directory: string, workflows: WorkflowStore, reports: ReportStore, tasks: WorkflowTaskHost, templates: readonly unknown[]): Promise<WorkflowRuntime> {
    const registry = new Map<string, PinnedWorkflowDefinition>()
    for (const candidate of templates) {
      const template = validateReportTemplate(candidate)
      const key = `${template.id}@${template.version}`
      if (registry.has(key)) throw new Error(`Duplicate workflow template ${key}`)
      registry.set(key, template)
    }
    if (![...registry.values()].some(template => template.id === 'investigation-report')) throw new Error('The investigation-report template is required')
    return new WorkflowRuntime(await DurableJournal.open<State, Payload>(join(directory, 'workflow-runtime.jsonl'), { creations: [], bindings: [] }, reduce), workflows, reports, tasks, registry)
  }

  /** Record runtime intent first; a restart can then safely materialize the pinned WorkflowStore execution. */
  async create(request: CreateWorkflowRequest, project: WorkflowRuntimeProject): Promise<WorkflowRuntimeView> {
    const input = createWorkflowRequestSchema.parse(request)
    assertProject(project, input.projectId, input.teamId)
    const template = this.templates.get(`${input.templateId}@${input.templateVersion}`)
    if (!template) throw new Error('Only the investigation-report template is supported by this workflow runtime')
    // This pure validation/substitution precedes the runtime creation intent.
    const definition = pinWorkflowDefinition(template, input.parameters)
    validateTaskCompatibleDefinition(definition)
    const executionId = input.executionId ?? randomUUID()
    const existing = this.creation(executionId)
    if (existing) {
      if (existing.projectId !== input.projectId || existing.teamId !== input.teamId || !isDeepStrictEqual(existing.definition, definition)
        || !isDeepStrictEqual(existing.parameters, input.parameters)) throw new Error('Workflow creation replay has different immutable inputs')
    } else {
      await this.journal.append(() => ({ type: 'workflow-runtime/created', creation: { executionId, projectId: input.projectId, teamId: input.teamId, template, parameters: input.parameters, definition } }))
    }
    await this.ensureWorkflow(this.creation(executionId)!)
    return this.inspect(executionId)!
  }

  /** Reconcile accepted receipts, then create and start every newly eligible bound task. */
  async scan(project: WorkflowRuntimeProject): Promise<WorkflowRuntimeView[]> {
    const dispatched: WorkflowRuntimeView[] = []
    for (const creation of this.journal.snapshot().creations.filter(value => value.projectId === project.id)) {
      assertProject(project, creation.projectId, creation.teamId)
      await this.ensureWorkflow(creation)
      await this.reconcileReceipts(creation)
      const execution = this.workflows.inspect(creation.executionId)!
      const next = this.workflows.resume(execution.id)
      if (!next) continue
      await this.ensureTask(creation, execution, next.id)
      dispatched.push(this.inspect(creation.executionId)!)
    }
    return dispatched
  }

  /** Resume one owned execution after process reconstruction. */
  async resume(executionId: string, project: WorkflowRuntimeProject): Promise<WorkflowRuntimeView | undefined> {
    const creation = this.creation(executionId)
    if (!creation) throw new Error('Workflow runtime execution is missing')
    assertProject(project, creation.projectId, creation.teamId)
    await this.ensureWorkflow(creation)
    await this.reconcileReceipts(creation)
    const next = this.workflows.resume(executionId)
    if (!next) return undefined
    await this.ensureTask(creation, this.workflows.inspect(executionId)!, next.id)
    return this.inspect(executionId)
  }

  inspect(executionId: string): WorkflowRuntimeView | undefined {
    const creation = this.creation(executionId)
    const execution = this.workflows.inspect(executionId)
    if (!creation || !execution) return undefined
    const state = this.journal.snapshot()
    return { executionId, projectId: creation.projectId, teamId: creation.teamId, templateId: execution.definition.id, templateVersion: execution.definition.version,
      steps: execution.steps.map(step => {
        const value = binding(state, executionId, step.id)
        return { stepId: step.id, ...(value?.taskId === undefined ? {} : { taskId: value.taskId }), ...(value?.intent === undefined ? {} : { intentId: value.intent.intentId }),
          ...(value?.reportId === undefined ? {} : { reportId: value.reportId }), phase: step.phase }
      }) }
  }

  close(): Promise<void> { return this.journal.close() }

  private creation(executionId: string): Creation | undefined {
    return this.journal.snapshot().creations.find(value => value.executionId === executionId)
  }

  private async ensureWorkflow(creation: Creation): Promise<void> {
    const existing = this.workflows.inspect(creation.executionId)
    if (existing) {
      if (!isDeepStrictEqual(existing.definition, creation.definition)) throw new Error('Pinned WorkflowStore execution disagrees with runtime intent')
      return
    }
    await this.workflows.create(creation.template, creation.parameters, creation.executionId)
  }

  private async reconcileReceipts(creation: Creation): Promise<void> {
    let execution = this.workflows.inspect(creation.executionId)!
    const state = this.journal.snapshot()
    for (const value of state.bindings.filter(value => value.executionId === execution.id && value.taskId !== undefined && value.reportId === undefined)) {
      const completed = execution.steps.find(step => step.id === value.stepId)
      const report = this.acceptedReport(creation, value.taskId!)
      if (completed?.phase === 'completed' && completed.receipt?.kind === 'report-review' && report && completed.receipt.reference.kind === 'report' && completed.receipt.reference.ref === report.id) {
        await this.journal.append(() => ({ type: 'workflow-runtime/step-receipted', executionId: execution.id, stepId: value.stepId, reportId: report.id }))
      }
    }
    for (const step of execution.steps.filter(value => value.phase === 'running')) {
      const value = binding(state, execution.id, step.id)
      if (!value?.taskId) continue
      const report = this.acceptedReport(creation, value.taskId)
      if (!report) continue
      const reference = { kind: 'report', ref: report.id }
      const artifacts = Object.fromEntries(execution.definition.steps.find(candidate => candidate.id === step.id)!.artifacts.produces.map(name => [name, reference]))
      await this.workflows.completeStep(execution.id, step.id, step.revision, { artifacts,
        receipt: { kind: 'report-review', reviewer: report.reviewerId, decision: 'approved', reference } })
      if (!value.reportId) await this.journal.append(() => ({ type: 'workflow-runtime/step-receipted', executionId: execution.id, stepId: step.id, reportId: report.id }))
      execution = this.workflows.inspect(creation.executionId)!
    }
  }

  private acceptedReport(creation: Creation, taskId: string): ReportAcceptanceRecord | undefined {
    return this.reports.list().find(report => report.phase === 'accepted' && report.projectId === creation.projectId && report.teamId === creation.teamId && report.taskId === taskId)
  }

  private async ensureTask(creation: Creation, execution: WorkflowExecution, stepId: string): Promise<void> {
    let state = this.journal.snapshot()
    let value = binding(state, execution.id, stepId)
    if (!value?.intent) {
      const definition = execution.definition.steps.find(step => step.id === stepId)!
      const evidence = definition.artifacts.requires.map(name => {
        const source = execution.steps.find(step => step.artifacts?.[name] !== undefined)?.artifacts?.[name]
        if (!source) throw new Error(`Workflow input artifact ${name} is missing from completed checkpoints`)
        const accepted = source.kind === 'report' ? this.reports.list().find(report => report.phase === 'accepted' && report.id === source.ref) : undefined
        return accepted
          ? `${name}: report:${accepted.id}\n  Accepted report excerpt: ${excerpt(accepted.report, 8_000, `\n[truncated; durable report receipt ${accepted.id}]`)}\n  Review criteria: ${excerpt(accepted.criteria, 2_000, '\n[criteria truncated]')}\n  Lead rationale: ${excerpt(accepted.rationale, 2_000, '\n[rationale truncated]')}`
          : `${name}: ${source.kind}:${source.ref}`
      })
      const intent: WorkflowTaskCreateIntent = { intentId: `workflow-${randomUUID()}`, projectId: creation.projectId, teamId: creation.teamId, executionId: execution.id, stepId,
        subject: definition.title, description: excerpt(`${definition.title}\n\nPinned workflow ${execution.definition.id}@${execution.definition.version}.\nInput evidence:\n${evidence.length ? evidence.map(item => `- ${item}`).join('\n') : '- none'}\n\nProduce an evidence-backed report for Lead review.`, 16_384, '\n[workflow evidence truncated; use durable report receipt IDs above]'),
        nonCodeCriteria: `Report review: ${definition.title}` }
      await this.journal.append(() => ({ type: 'workflow-runtime/task-intended', executionId: execution.id, stepId, intent }))
      state = this.journal.snapshot(); value = binding(state, execution.id, stepId)!
    }
    if (!value.taskId) {
      const created = await this.tasks.createPinnedTask(value.intent!)
      id.parse(created.taskId)
      await this.journal.append(() => ({ type: 'workflow-runtime/task-created', executionId: execution.id, stepId, taskId: created.taskId }))
      value = binding(this.journal.snapshot(), execution.id, stepId)!
    }
    const current = this.workflows.inspect(execution.id)!.steps.find(step => step.id === stepId)!
    if (current.phase === 'pending') await this.workflows.startStep(execution.id, stepId, current.revision)
  }
}
