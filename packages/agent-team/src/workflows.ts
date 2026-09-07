/** Host-only durable workflow definitions and checkpoints. Runtime dispatch stays outside this store. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import z from 'zod'
import { DurableJournal } from './durable-journal.ts'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
const artifactName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const text = z.string().trim().min(1).max(16_384)
const scalar = z.union([z.string().max(16_384), z.number().finite(), z.boolean()])

const parameterSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('string'), required: z.boolean().optional(), default: z.string().max(16_384).optional() }).strict(),
  z.object({ type: z.literal('number'), required: z.boolean().optional(), default: z.number().finite().optional() }).strict(),
  z.object({ type: z.literal('boolean'), required: z.boolean().optional(), default: z.boolean().optional() }).strict(),
])
const referenceSchema = z.object({ kind: id, ref: text }).strict()
export type ArtifactReference = z.output<typeof referenceSchema>

const acceptanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('factory-stage'), stage: z.enum(['reproduction', 'implementation', 'machine-verification', 'integration', 'release-acceptance']) }).strict(),
  z.object({ kind: z.literal('artifact-submitted'), artifact: artifactName }).strict(),
  z.object({ kind: z.literal('checks-passed'), source: artifactName, candidate: artifactName }).strict(),
  z.object({ kind: z.literal('integrated'), source: artifactName, candidate: artifactName }).strict(),
  z.object({ kind: z.literal('report-review') }).strict(),
  z.object({ kind: z.literal('externally-authorized-publication'), authorization: id }).strict(),
])
const retrySchema = z.object({ maxAttempts: z.number().int().min(1).max(10), backoffMs: z.number().int().min(0).max(86_400_000) }).strict()
const artifactsSchema = z.object({
  requires: z.array(artifactName).max(128).default([]), produces: z.array(artifactName).max(128).default([]),
}).strict()
const stepSchema = z.object({
  id, title: text, dependsOn: z.array(id).max(128).default([]), retry: retrySchema, artifacts: artifactsSchema, acceptance: acceptanceSchema,
}).strict()
export const workflowTemplateSchema = z.object({
  format: z.literal('agent-team-workflow/v1'), id, version: positive,
  parameters: z.record(id, parameterSchema).default({}), steps: z.array(stepSchema).min(1).max(256),
}).strict()
export type WorkflowTemplate = z.input<typeof workflowTemplateSchema>
export type PinnedWorkflowDefinition = z.output<typeof workflowTemplateSchema>

const completionReceiptSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artifact-submitted'), submitter: id, artifact: referenceSchema }).strict(),
  z.object({ kind: z.literal('checks-passed'), verifier: id, source: referenceSchema, candidate: referenceSchema, verification: referenceSchema }).strict(),
  z.object({ kind: z.literal('integrated'), integrator: id, source: referenceSchema, candidate: referenceSchema, integration: referenceSchema }).strict(),
  z.object({ kind: z.literal('report-review'), reviewer: id, decision: z.enum(['approved', 'rejected']), reference: referenceSchema }).strict(),
  z.object({ kind: z.literal('externally-authorized-publication'), publisher: id, reference: referenceSchema }).strict(),
])
const completionSchema = z.object({ artifacts: z.record(artifactName, referenceSchema), receipt: completionReceiptSchema }).strict()
export type StepCompletion = z.input<typeof completionSchema>
const failureSchema = z.object({ reason: text, reference: referenceSchema }).strict()
export type StepFailure = z.input<typeof failureSchema>
const authorizationInputSchema = z.object({ actor: id, evidence: referenceSchema }).strict()
export type PublicationAuthorization = z.input<typeof authorizationInputSchema>

const phaseSchema = z.enum(['pending', 'running', 'completed', 'failed'])
const authorizationSchema = authorizationInputSchema.extend({ executionId: id, stepId: id, revision: positive }).strict()
const stepRecordSchema = z.object({
  id, phase: phaseSchema, attempts: z.number().int().min(0).max(10), revision: positive,
  artifacts: z.record(artifactName, referenceSchema).optional(), receipt: completionReceiptSchema.optional(),
  failure: failureSchema.optional(), failedAt: nonnegative.optional(), notBefore: nonnegative.optional(), authorization: authorizationSchema.optional(),
}).strict()
export type WorkflowStepRecord = z.output<typeof stepRecordSchema>
/** Immutable evidence retained whenever a verified candidate is superseded by a new target round. */
const candidateHistorySchema = z.object({
  stepId: id, source: referenceSchema, candidate: referenceSchema, verification: referenceSchema,
  /** Full completed/failed round checkpoints, including the prior review report. */
  priorSteps: z.array(stepRecordSchema).min(1).max(256),
  replacement: z.object({
    integration: referenceSchema, source: referenceSchema, target: referenceSchema, candidate: referenceSchema,
    retryRound: positive, previousCandidates: z.array(referenceSchema).min(1).max(16),
  }).strict(),
  reason: text, at: nonnegative,
}).strict()
const sourceReworkSchema = z.object({ previousAttemptId: id, submissionId: id, sourceCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), round: positive, budget: positive }).strict()
const sourceHistorySchema = z.object({ stepId: id, source: referenceSchema, priorSteps: z.array(stepRecordSchema).min(1).max(256), replacement: referenceSchema, repair: sourceReworkSchema, reason: text, at: nonnegative }).strict()
const executionSchema = z.object({
  id, definition: workflowTemplateSchema, steps: z.array(stepRecordSchema).min(1).max(256), authorizationHistory: z.array(authorizationSchema).max(256),
  /** Superseded candidate evidence is retained; only current step artifacts drive eligibility. */
  candidateHistory: z.array(candidateHistorySchema).max(1_024).default([]),
  sourceHistory: z.array(sourceHistorySchema).max(1_024).default([]),
}).strict()
export type WorkflowExecution = z.output<typeof executionSchema>

const tokenSchema = z.object({ executionId: id, stepId: id, expectedRevision: positive }).strict()
const envelope = { version: z.literal(1), sequence: positive }
const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('workflow/created'), execution: executionSchema }).strict(),
  z.object({ ...envelope, type: z.literal('workflow/step-started'), token: tokenSchema, at: nonnegative }).strict(),
  z.object({ ...envelope, type: z.literal('workflow/step-completed'), token: tokenSchema, completion: completionSchema, at: nonnegative }).strict(),
  z.object({ ...envelope, type: z.literal('workflow/step-failed'), token: tokenSchema, failure: failureSchema, at: nonnegative }).strict(),
  z.object({ ...envelope, type: z.literal('workflow/step-retried'), token: tokenSchema }).strict(),
  z.object({ ...envelope, type: z.literal('workflow/publication-authorized'), token: tokenSchema, authorization: authorizationInputSchema }).strict(),
  z.object({ ...envelope, type: z.literal('workflow/candidate-invalidated'), token: tokenSchema, reason: text,
    replacement: z.object({ integration: referenceSchema, source: referenceSchema, target: referenceSchema, candidate: referenceSchema,
      retryRound: positive, previousCandidates: z.array(referenceSchema).min(1).max(16) }).strict(), at: nonnegative }).strict(),
  z.object({ ...envelope, type: z.literal('workflow/source-reworked'), token: tokenSchema, replacement: referenceSchema, repair: sourceReworkSchema, reason: text, at: nonnegative }).strict(),
])
type Payload =
  | { type: 'workflow/created'; execution: WorkflowExecution }
  | { type: 'workflow/step-started'; token: StepToken; at: number }
  | { type: 'workflow/step-completed'; token: StepToken; completion: StepCompletion; at: number }
  | { type: 'workflow/step-failed'; token: StepToken; failure: StepFailure; at: number }
  | { type: 'workflow/step-retried'; token: StepToken }
  | { type: 'workflow/publication-authorized'; token: StepToken; authorization: PublicationAuthorization }
  | { type: 'workflow/candidate-invalidated'; token: StepToken; reason: string; replacement: CandidateReplacement; at: number }
  | { type: 'workflow/source-reworked'; token: StepToken; replacement: ArtifactReference; repair: SourceRework; reason: string; at: number }
export type StepToken = z.input<typeof tokenSchema>
export interface CandidateReplacement {
  readonly integration: ArtifactReference
  readonly source: ArtifactReference
  readonly target: ArtifactReference
  readonly candidate: ArtifactReference
  readonly retryRound: number
  readonly previousCandidates: readonly ArtifactReference[]
}
export interface SourceRework { readonly previousAttemptId: string; readonly submissionId: string; readonly sourceCommit: string; readonly round: number; readonly budget: number }

function definitionStep(execution: WorkflowExecution, stepId: string) {
  const step = execution.definition.steps.find(candidate => candidate.id === stepId)
  if (!step) throw new Error(`Workflow step ${stepId} is missing`)
  return step
}
function recordStep(execution: WorkflowExecution, token: StepToken) {
  const step = execution.steps.find(candidate => candidate.id === token.stepId)
  if (!step || execution.id !== token.executionId) throw new Error('Workflow execution or step is missing')
  if (step.revision !== token.expectedRevision) throw new Error('Stale workflow step revision')
  return step
}
function allDependenciesCompleted(execution: WorkflowExecution, stepId: string): boolean {
  return definitionStep(execution, stepId).dependsOn.every(dependency => execution.steps.find(step => step.id === dependency)?.phase === 'completed')
}
function availableArtifacts(execution: WorkflowExecution): Set<string> {
  return new Set(execution.steps.filter(step => step.phase === 'completed').flatMap(step => Object.keys(step.artifacts ?? {})))
}
function completedArtifact(execution: WorkflowExecution, name: string): ArtifactReference | undefined {
  return execution.steps.find(step => step.phase === 'completed' && step.artifacts?.[name] !== undefined)?.artifacts?.[name]
}
function sameReference(left: ArtifactReference | undefined, right: ArtifactReference): boolean {
  return left?.kind === right.kind && left.ref === right.ref
}
function eligible(execution: WorkflowExecution, step: WorkflowStepRecord, now: number): boolean {
  if (definitionStep(execution, step.id).acceptance.kind === 'factory-stage') return false
  if (step.phase !== 'pending' || (step.notBefore !== undefined && now < step.notBefore) || !allDependenciesCompleted(execution, step.id)) return false
  return definitionStep(execution, step.id).artifacts.requires.every(name => availableArtifacts(execution).has(name))
}
function replaceStep(execution: WorkflowExecution, next: WorkflowStepRecord): WorkflowExecution {
  return { ...execution, steps: execution.steps.map(step => step.id === next.id ? next : step) }
}
function descendantSteps(execution: WorkflowExecution, root: string): Set<string> {
  const affected = new Set([root])
  let changed = true
  while (changed) {
    changed = false
    for (const step of execution.definition.steps) {
      if (affected.has(step.id) || !step.dependsOn.some(dependency => affected.has(dependency))) continue
      affected.add(step.id); changed = true
    }
  }
  return affected
}
function ensureCompletion(execution: WorkflowExecution, step: WorkflowStepRecord, completion: z.output<typeof completionSchema>, at: number): WorkflowStepRecord {
  const definition = definitionStep(execution, step.id)
  const actual = Object.keys(completion.artifacts).sort()
  const expected = [...definition.artifacts.produces].sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) throw new Error(`Workflow step ${step.id} must record exactly its declared artifact references`)
  if (definition.acceptance.kind !== completion.receipt.kind) throw new Error(`Workflow step ${step.id} has the wrong acceptance receipt`)
  if (definition.acceptance.kind === 'artifact-submitted') {
    const receipt = completion.receipt
    if (receipt.kind !== 'artifact-submitted' || !sameReference(completion.artifacts[definition.acceptance.artifact], receipt.artifact)) throw new Error('Submitted artifact receipt must bind the declared output artifact')
  }
  if (definition.acceptance.kind === 'checks-passed') {
    const receipt = completion.receipt
    if (receipt.kind !== 'checks-passed' || !sameReference(completedArtifact(execution, definition.acceptance.source), receipt.source)
      || !sameReference(completion.artifacts[definition.acceptance.candidate], receipt.candidate)) throw new Error('Checks receipt must bind the pinned source and candidate artifacts')
  }
  if (definition.acceptance.kind === 'integrated') {
    const receipt = completion.receipt
    if (receipt.kind !== 'integrated' || !sameReference(completedArtifact(execution, definition.acceptance.source), receipt.source)
      || !sameReference(completedArtifact(execution, definition.acceptance.candidate), receipt.candidate)) throw new Error('Integration receipt must bind the checked source and candidate artifacts')
  }
  if (definition.acceptance.kind === 'externally-authorized-publication') {
    if (!step.authorization || step.authorization.executionId !== execution.id || step.authorization.stepId !== step.id || step.authorization.revision + 1 !== step.revision) throw new Error('Publication requires a current explicit authorization')
    if (step.authorization.actor !== definition.acceptance.authorization) throw new Error('Publication authorization actor does not satisfy the template')
  }
  const next = { ...step, revision: step.revision + 1, artifacts: completion.artifacts, receipt: completion.receipt }
  if (completion.receipt.kind === 'report-review' && completion.receipt.decision === 'rejected') {
    return { ...next, phase: 'failed' as const, failure: { reason: 'Report review rejected', reference: completion.receipt.reference }, failedAt: at, notBefore: at + definition.retry.backoffMs }
  }
  return { ...next, phase: 'completed' as const }
}

/** Validate a workflow before an execution can be created or scheduled. */
export function validateWorkflowTemplate(value: unknown): PinnedWorkflowDefinition {
  const template = workflowTemplateSchema.parse(value)
  const byId = new Map(template.steps.map(step => [step.id, step]))
  if (byId.size !== template.steps.length) throw new Error('Workflow graph has duplicate step IDs')
  for (const step of template.steps) {
    if (new Set(step.dependsOn).size !== step.dependsOn.length) throw new Error(`Workflow step ${step.id} repeats a dependency`)
    for (const dependency of step.dependsOn) if (!byId.has(dependency)) throw new Error(`Workflow step ${step.id} has missing dependency ${dependency}`)
    if (new Set(step.artifacts.requires).size !== step.artifacts.requires.length || new Set(step.artifacts.produces).size !== step.artifacts.produces.length) throw new Error(`Workflow step ${step.id} repeats an artifact reference`)
    if (step.acceptance.kind === 'artifact-submitted' && !step.artifacts.produces.includes(step.acceptance.artifact)) throw new Error(`Workflow step ${step.id} must submit a declared output artifact`)
    if (step.acceptance.kind === 'checks-passed' && (!step.artifacts.requires.includes(step.acceptance.source) || !step.artifacts.produces.includes(step.acceptance.candidate))) throw new Error(`Workflow step ${step.id} checks receipt must bind a required source and produced candidate`)
    if (step.acceptance.kind === 'integrated' && (!step.artifacts.requires.includes(step.acceptance.source) || !step.artifacts.requires.includes(step.acceptance.candidate))) throw new Error(`Workflow step ${step.id} integration receipt must bind required source and candidate`)
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  const ancestors = (stepId: string, result = new Set<string>()): Set<string> => {
    for (const dependency of byId.get(stepId)!.dependsOn) {
      if (!result.has(dependency)) { result.add(dependency); ancestors(dependency, result) }
    }
    return result
  }
  const visit = (stepId: string): void => {
    if (visiting.has(stepId)) throw new Error('Workflow step dependency graph contains a cycle')
    if (visited.has(stepId)) return
    visiting.add(stepId)
    for (const dependency of byId.get(stepId)!.dependsOn) visit(dependency)
    visiting.delete(stepId); visited.add(stepId)
  }
  for (const step of template.steps) visit(step.id)
  const producedBy = new Map<string, string>()
  for (const step of template.steps) for (const artifact of step.artifacts.produces) {
    if (producedBy.has(artifact)) throw new Error(`Workflow artifact ${artifact} has multiple producers`)
    producedBy.set(artifact, step.id)
  }
  for (const step of template.steps) for (const artifact of step.artifacts.requires) {
    const producer = producedBy.get(artifact)
    if (!producer || !ancestors(step.id).has(producer)) throw new Error(`Workflow step ${step.id} requires artifact ${artifact} outside its dependency graph`)
  }
  return template
}

function substituteTemplate(template: PinnedWorkflowDefinition, values: Record<string, string | number | boolean>): PinnedWorkflowDefinition {
  const replace = (input: unknown): unknown => {
    if (typeof input === 'string') return input.replace(/{{([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})}}/g, (_match, name: string) => {
      const value = Object.hasOwn(values, name) ? values[name] : undefined
      if (value === undefined) throw new Error(`Missing workflow parameter ${name}`)
      return String(value)
    })
    if (Array.isArray(input)) return input.map(replace)
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, replace(value)]))
    return input
  }
  return validateWorkflowTemplate(replace(template))
}
/** Validate and substitute immutable parameters before any runtime side effect or journal intent. */
export function pinWorkflowDefinition(value: unknown, parameters: unknown): PinnedWorkflowDefinition {
  const template = validateWorkflowTemplate(value)
  const supplied = z.record(id, scalar).parse(parameters)
  const values: Record<string, string | number | boolean> = {}
  for (const key of Object.keys(supplied)) if (!Object.hasOwn(template.parameters, key)) throw new Error(`Unknown workflow parameter ${key}`)
  for (const [name, parameter] of Object.entries(template.parameters)) {
    const value = Object.hasOwn(supplied, name) ? supplied[name] : parameter.default
    if (value === undefined && parameter.required) throw new Error(`Missing required workflow parameter ${name}`)
    if (value !== undefined && typeof value !== parameter.type) throw new Error(`Workflow parameter ${name} must be a ${parameter.type}`)
    if (value !== undefined) values[name] = value
  }
  return substituteTemplate(template, values)
}

function reduce(state: WorkflowExecution[], raw: unknown): WorkflowExecution[] {
  const event = eventSchema.parse(raw)
  if (event.type === 'workflow/created') {
    if (state.some(execution => execution.id === event.execution.id)) throw new Error('Workflow execution already exists')
    validateWorkflowTemplate(event.execution.definition)
    if (event.execution.authorizationHistory.length !== 0 || event.execution.candidateHistory.length !== 0 || event.execution.sourceHistory.length !== 0 || event.execution.steps.length !== event.execution.definition.steps.length || event.execution.steps.some((step, index) => step.id !== event.execution.definition.steps[index]?.id || step.phase !== 'pending' || step.attempts !== 0 || step.revision !== 1 || step.artifacts !== undefined || step.receipt !== undefined || step.failure !== undefined || step.failedAt !== undefined || step.notBefore !== undefined || step.authorization !== undefined)) throw new Error('Workflow creation must start with empty pending steps')
    return [...state, event.execution]
  }
  const executionIndex = state.findIndex(execution => execution.id === event.token.executionId)
  const execution = state[executionIndex]
  if (!execution) throw new Error('Workflow execution is missing')
  const current = recordStep(execution, event.token)
  const definition = definitionStep(execution, current.id)
  let next: WorkflowStepRecord
  switch (event.type) {
    case 'workflow/step-started':
      if (!eligible(execution, current, event.at) || current.attempts >= definition.retry.maxAttempts) throw new Error('Workflow step is not eligible to start')
      next = { ...current, phase: 'running', attempts: current.attempts + 1, revision: current.revision + 1, notBefore: undefined }
      break
    case 'workflow/step-completed':
      if (current.phase !== 'running') throw new Error('Workflow completion requires a running step')
      next = ensureCompletion(execution, current, event.completion, event.at)
      break
    case 'workflow/step-failed':
      if (current.phase !== 'running') throw new Error('Workflow failure requires a running step')
      next = { ...current, phase: 'failed', revision: current.revision + 1, failure: event.failure, failedAt: event.at, notBefore: event.at + definition.retry.backoffMs }
      break
    case 'workflow/step-retried':
      if (current.phase !== 'failed' || current.attempts >= definition.retry.maxAttempts) throw new Error('Workflow step has no retry attempt remaining')
      next = { ...current, phase: 'pending', revision: current.revision + 1, failure: undefined, receipt: undefined, artifacts: undefined, authorization: undefined }
      break
    case 'workflow/publication-authorized':
      if (current.phase !== 'running' || definition.acceptance.kind !== 'externally-authorized-publication') throw new Error('Publication authorization requires a running publication step')
      if (current.authorization) throw new Error('Publication authorization is already recorded for this step')
      if (event.authorization.actor !== definition.acceptance.authorization) throw new Error('Publication authorization actor does not satisfy the template')
      if (state.flatMap(candidate => candidate.authorizationHistory).some(authorization => authorization.actor === event.authorization.actor
        && authorization.evidence.kind === event.authorization.evidence.kind && authorization.evidence.ref === event.authorization.evidence.ref)) throw new Error('Publication authorization evidence is already bound to another step')
      next = { ...current, revision: current.revision + 1, authorization: { ...event.authorization, executionId: execution.id, stepId: current.id, revision: current.revision } }
      break
    case 'workflow/candidate-invalidated': {
      if (definition.acceptance.kind !== 'checks-passed' || current.phase !== 'completed' || current.receipt?.kind !== 'checks-passed') {
        throw new Error('Only a completed checks-passed candidate can be invalidated')
      }
      const source = completedArtifact(execution, definition.acceptance.source)
      const candidate = current.artifacts?.[definition.acceptance.candidate]
      if (!source || !candidate || !sameReference(current.receipt.source, source) || !sameReference(current.receipt.candidate, candidate)) {
        throw new Error('Candidate invalidation requires current source and candidate evidence')
      }
      const affected = descendantSteps(execution, current.id)
      if (execution.steps.some(step => affected.has(step.id) && step.phase === 'completed' && step.receipt?.kind === 'integrated')) {
        throw new Error('An integrated workflow candidate cannot be invalidated')
      }
      if (!sameReference(event.replacement.source, source)) throw new Error('Candidate replacement changes the immutable submitted source')
      if (sameReference(event.replacement.candidate, candidate)) throw new Error('Candidate replacement must differ from the current candidate')
      if (!event.replacement.previousCandidates.some(previous => sameReference(previous, candidate))) {
        throw new Error('Candidate replacement must retain the current candidate in its integration history')
      }
      if (event.replacement.retryRound !== execution.candidateHistory.length + 1) throw new Error('Candidate replacement retry round is not the next pinned round')
      const priorSteps = execution.steps.filter(step => affected.has(step.id))
      const reset = execution.steps.map(step => !affected.has(step.id) ? step : {
        id: step.id, phase: 'pending' as const, attempts: 0, revision: step.revision + 1,
      })
      const updated: WorkflowExecution = {
        ...execution,
        steps: reset,
        candidateHistory: [...execution.candidateHistory, { stepId: current.id, source, candidate,
          verification: current.receipt.verification, priorSteps, replacement: event.replacement, reason: event.reason, at: event.at }],
      }
      return state.map((candidate, index) => index === executionIndex ? updated : candidate)
    }
    case 'workflow/source-reworked': {
      if (definition.acceptance.kind !== 'artifact-submitted' || current.phase !== 'completed' || current.receipt?.kind !== 'artifact-submitted') throw new Error('Only a completed submitted source can be reworked')
      const source = current.artifacts?.[definition.acceptance.artifact]
      if (!source || sameReference(source, event.replacement)) throw new Error('Source rework requires a different pinned replacement source')
      if (execution.steps.some(step => step.phase === 'completed' && step.receipt?.kind === 'integrated')) throw new Error('An integrated workflow source cannot be reworked')
      const pinnedBudget = execution.sourceHistory[0]?.repair.budget ?? event.repair.budget
      if (source.kind !== 'commit' || source.ref !== event.repair.sourceCommit || event.repair.round !== execution.sourceHistory.length + 1
        || event.repair.budget !== pinnedBudget || event.repair.round > pinnedBudget || event.repair.round > definition.retry.maxAttempts - 1 || pinnedBudget > 10) throw new Error('Source rework repair lineage or budget is invalid')
      const affected = descendantSteps(execution, current.id)
      const priorSteps = execution.steps.filter(step => affected.has(step.id))
      const updated: WorkflowExecution = { ...execution, steps: execution.steps.map(step => !affected.has(step.id) ? step : { id: step.id, phase: 'pending' as const, attempts: 0, revision: step.revision + 1 }),
        sourceHistory: [...execution.sourceHistory, { stepId: current.id, source, priorSteps, replacement: event.replacement, repair: event.repair, reason: event.reason, at: event.at }] }
      return state.map((candidate, index) => index === executionIndex ? updated : candidate)
    }
  }
  const updated = event.type === 'workflow/publication-authorized'
    ? { ...replaceStep(execution, next), authorizationHistory: [...execution.authorizationHistory, next.authorization!] }
    : replaceStep(execution, next)
  return state.map((candidate, index) => index === executionIndex ? updated : candidate)
}

/** Durable workflow journal. It validates and records obligations; callers own all runtime effects. */
export class WorkflowStore {
  private constructor(private readonly journal: DurableJournal<WorkflowExecution[], Payload>, private readonly now: () => number) {}

  static async open(directory: string, now: () => number = Date.now): Promise<WorkflowStore> {
    return new WorkflowStore(await DurableJournal.open(join(directory, 'workflows.jsonl'), [], reduce), now)
  }

  async create(template: unknown, parameters: unknown, executionId: string = randomUUID()): Promise<WorkflowExecution> {
    const definition = pinWorkflowDefinition(template, parameters)
    id.parse(executionId)
    const existing = this.inspect(executionId)
    if (existing) throw new Error('Workflow execution already exists')
    const execution: WorkflowExecution = { id: executionId, definition,
      steps: definition.steps.map(step => ({ id: step.id, phase: 'pending', attempts: 0, revision: 1 })), authorizationHistory: [], candidateHistory: [], sourceHistory: [] }
    return (await this.journal.append(() => ({ type: 'workflow/created', execution }))).find(candidate => candidate.id === executionId)!
  }

  inspect(executionId: string): WorkflowExecution | undefined { return this.journal.snapshot().find(execution => execution.id === executionId) }
  list(): WorkflowExecution[] { return this.journal.snapshot() }
  /** The next step that can be assigned after a session reconstruction, if any. */
  resume(executionId: string): WorkflowStepRecord | undefined {
    const execution = this.inspect(executionId)
    if (!execution) throw new Error('Workflow execution is missing')
    return execution.steps.find(step => eligible(execution, step, this.timestamp()))
  }
  async startStep(executionId: string, stepId: string, expectedRevision: number): Promise<WorkflowStepRecord> {
    return this.mutate({ type: 'workflow/step-started', token: { executionId, stepId, expectedRevision, }, at: this.timestamp() }, executionId, stepId)
  }
  async completeStep(executionId: string, stepId: string, expectedRevision: number, completion: StepCompletion): Promise<WorkflowStepRecord> {
    completionSchema.parse(completion)
    return this.mutate({ type: 'workflow/step-completed', token: { executionId, stepId, expectedRevision }, completion, at: this.timestamp() }, executionId, stepId)
  }
  async failStep(executionId: string, stepId: string, expectedRevision: number, failure: StepFailure): Promise<WorkflowStepRecord> {
    failureSchema.parse(failure)
    return this.mutate({ type: 'workflow/step-failed', token: { executionId, stepId, expectedRevision }, failure, at: this.timestamp() }, executionId, stepId)
  }
  async retryStep(executionId: string, stepId: string, expectedRevision: number): Promise<WorkflowStepRecord> {
    return this.mutate({ type: 'workflow/step-retried', token: { executionId, stepId, expectedRevision } }, executionId, stepId)
  }
  async authorizePublication(executionId: string, stepId: string, expectedRevision: number, authorization: PublicationAuthorization): Promise<WorkflowStepRecord> {
    authorizationInputSchema.parse(authorization)
    return this.mutate({ type: 'workflow/publication-authorized', token: { executionId, stepId, expectedRevision }, authorization }, executionId, stepId)
  }
  /**
   * Begin a fresh verification/review/integration round after the pinned target
   * moved. This is deliberately limited to a completed checks receipt: callers
   * cannot reopen implementation or erase an arbitrary review.
   */
  async invalidateCandidate(executionId: string, stepId: string, expectedRevision: number, replacement: CandidateReplacement, reason: string): Promise<WorkflowExecution> {
    const message = text.parse(reason)
    const inputs = z.object({ integration: referenceSchema, source: referenceSchema, target: referenceSchema, candidate: referenceSchema,
      retryRound: positive, previousCandidates: z.array(referenceSchema).min(1).max(16) }).strict().parse(replacement)
    return (await this.journal.append(() => ({ type: 'workflow/candidate-invalidated', token: { executionId, stepId, expectedRevision }, reason: message, replacement: inputs, at: this.timestamp() })))
      .find(execution => execution.id === executionId)!
  }
  async reworkSource(executionId: string, stepId: string, expectedRevision: number, replacement: ArtifactReference, repair: SourceRework, reason: string): Promise<WorkflowExecution> {
    return (await this.journal.append(() => ({ type: 'workflow/source-reworked', token: { executionId, stepId, expectedRevision }, replacement: referenceSchema.parse(replacement), repair: sourceReworkSchema.parse(repair), reason: text.parse(reason), at: this.timestamp() }))).find(execution => execution.id === executionId)!
  }
  close(): Promise<void> { return this.journal.close() }

  private timestamp(): number { return nonnegative.parse(this.now()) }

  private async mutate(event: Exclude<Payload, { type: 'workflow/created' }>, executionId: string, stepId: string): Promise<WorkflowStepRecord> {
    const next = await this.journal.append(() => event)
    return next.find(execution => execution.id === executionId)!.steps.find(step => step.id === stepId)!
  }
}
