import z from 'zod'
import { artifactRefSchema, commitSchema, counterSchema, digestSchema, idSchema, revisionSchema, safePathSchema, textSchema, uniqueIds } from './contracts/common.ts'
import { compilerOutcomeSchema, executableSpecPayloadSchema, pinExecutableSpec, verifyExecutableSpec } from './contracts/spec.ts'
import { inboundWorkItemSchema, type InboundWorkItemV1 } from './contracts/ingestion.ts'
import { validateContract } from './contracts/index.ts'
import { canonicalJson, digestJson, parseStrictJson } from './json.ts'

const bounded = <T extends z.ZodType>(schema: T) => z.array(schema).max(256)
const riskSchema = executableSpecPayloadSchema.shape.risk
const controlClassSchema = z.enum(['authorization', 'accounting', 'deployment', 'signing'])
const candidateSchema = z.strictObject({
  objective: textSchema, nonGoals: z.array(textSchema).max(64),
  invariants: bounded(z.strictObject({ id: idSchema, description: textSchema, checkId: idSchema.optional() })),
  acceptanceScenarios: bounded(z.strictObject({
    id: idSchema, description: textSchema, fixtureId: idSchema, assertionIds: uniqueIds(64),
    commandId: idSchema, reproductionId: idSchema.optional(),
  })),
  allowedPathIds: uniqueIds(), requiredCapabilities: uniqueIds(64),
})
/** Model output selects registered identities only; it cannot supply execution or authority fields. */
export const compilerProposalSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('COMPILED'), spec: candidateSchema }),
  z.strictObject({ outcome: z.enum(['AMBIGUOUS', 'CONFLICTING', 'INSUFFICIENT_EVIDENCE', 'UNSUPPORTED']), reasons: z.array(textSchema).min(1).max(32) }),
])
export const compilerHostContextSchema = z.strictObject({
  outcomeId: idSchema, specId: idSchema, ingress: inboundWorkItemSchema,
  priority: executableSpecPayloadSchema.shape.priority, risk: riskSchema, purposeId: idSchema,
  baseCommit: commitSchema, policyDigest: digestSchema, rulesDigest: digestSchema,
  toolchainDigest: digestSchema, workflowDigest: digestSchema, compilerRevision: revisionSchema,
  promptRevision: revisionSchema, modelAssignmentId: idSchema,
  authorityProvenance: z.array(artifactRefSchema).min(1).max(32),
  registries: z.strictObject({
    checks: bounded(z.strictObject({ id: idSchema, commandId: idSchema, conflictsWith: uniqueIds() })),
    commands: bounded(z.strictObject({ id: idSchema, executable: z.string().min(1).max(1024), args: z.array(z.string().max(4096)).max(128), deadlineMs: counterSchema.min(1) })),
    fixtures: bounded(z.strictObject({ id: idSchema, runnable: z.boolean(), commandIds: uniqueIds(), assertionIds: uniqueIds() })),
    assertions: bounded(z.strictObject({ id: idSchema, runnable: z.boolean() })),
    capabilities: uniqueIds(64),
    paths: bounded(z.strictObject({ id: idSchema, path: safePathSchema })),
    controlledPaths: bounded(z.strictObject({ path: safePathSchema, class: controlClassSchema })),
    reproductions: bounded(z.strictObject({ id: idSchema, sourceRevision: digestSchema, artifact: artifactRefSchema, expected: textSchema, actual: textSchema, fixtureId: idSchema, commandId: idSchema })),
  }),
  purposeGrants: bounded(z.strictObject({
    id: idSchema, projectId: idSchema, policyRevision: revisionSchema, purposeId: idSchema,
    sourceRevision: digestSchema, risk: riskSchema, allowedPaths: z.array(safePathSchema).min(1).max(256),
    controlClasses: z.array(controlClassSchema).max(4), evidence: artifactRefSchema,
  })),
})
export type CompilerHostContext = z.input<typeof compilerHostContextSchema>
export const compilerCursorSchema = z.strictObject({
  schemaVersion: z.literal(1), contextDigest: digestSchema,
  malformedAttempts: counterSchema.max(2), phase: z.enum(['initial', 'repair', 'finished']),
}).refine(cursor => cursor.phase === 'initial' ? cursor.malformedAttempts === 0 : cursor.phase !== 'repair' || cursor.malformedAttempts === 1)
export type CompilerCursor = z.output<typeof compilerCursorSchema>
export interface CompilerEvaluation {
  outcome: z.output<typeof compilerOutcomeSchema>
  disposition: 'compiled' | 'schema-repair' | 'quarantined'
  cursor: CompilerCursor
}
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) }
function safeData(raw: unknown): unknown {
  return parseStrictJson(typeof raw === 'string' || raw instanceof Uint8Array ? raw : canonicalJson(raw))
}

/** Host-owned, side-effect-free compiler validation session. Persist each returned cursor
 * before another model request; cursor storage and provider budgeting belong to the coordinator.
 * Registry executables/arguments and scope classification must come from pinned host policy.
 */
export class SpecCompilerSession {
  private readonly host: z.output<typeof compilerHostContextSchema>
  private state: CompilerCursor
  constructor(context: CompilerHostContext, cursor?: CompilerCursor) {
    try {
      this.host = compilerHostContextSchema.parse(safeData(context))
      validateContract('InboundWorkItemV1', this.host.ingress)
      if (this.host.ingress.state !== 'trusted') throw new Error()
      for (const registry of [this.host.registries.checks, this.host.registries.commands, this.host.registries.fixtures, this.host.registries.assertions, this.host.registries.paths, this.host.registries.reproductions, this.host.purposeGrants]) {
        if (new Set(registry.map(item => item.id)).size !== registry.length) throw new Error()
      }
      for (const reproduction of this.host.registries.reproductions) if (reproduction.artifact.projectId !== this.host.ingress.projectId) throw new Error()
      for (const artifact of this.host.authorityProvenance) if (artifact.projectId !== this.host.ingress.projectId) throw new Error()
      for (const grant of this.host.purposeGrants) if (grant.evidence.projectId !== grant.projectId) throw new Error()
      const contextDigest = digestJson(this.host)
      this.state = cursor ? compilerCursorSchema.parse(cursor) : { schemaVersion: 1, contextDigest, malformedAttempts: 0, phase: 'initial' }
      if (this.state.contextDigest !== contextDigest) throw new Error()
    } catch { throw new Error('Invalid or changed compiler host context/cursor') }
  }

  get cursor(): CompilerCursor { return { ...this.state } }

  evaluate(proposal: unknown, currentIngress: InboundWorkItemV1): CompilerEvaluation {
    if (this.state.phase === 'finished') throw new Error('Compiler outcome is terminal; resampling is not permitted')
    const host = this.host, ingress = host.ingress
    const source = { envelopeId: ingress.envelopeId, source: ingress.source, sourceEntityId: ingress.sourceEntityId, sourceRevision: ingress.sourceRevision }
    const base = { schemaVersion: 1 as const, id: host.outcomeId, projectId: ingress.projectId, policyRevision: ingress.policyRevision, source }
    const finish = (outcome: 'AMBIGUOUS' | 'CONFLICTING' | 'INSUFFICIENT_EVIDENCE' | 'UNSUPPORTED', reason: string, disposition: 'schema-repair' | 'quarantined' = 'quarantined'): CompilerEvaluation => {
      this.state.phase = disposition === 'schema-repair' ? 'repair' : 'finished'
      return { outcome: compilerOutcomeSchema.parse({ ...base, outcome, reasons: [reason] }), disposition, cursor: this.cursor }
    }
    try {
      const current = validateContract('InboundWorkItemV1', safeData(currentIngress))
      if (canonicalJson(current) !== canonicalJson(ingress)) return finish('UNSUPPORTED', 'SOURCE_OR_AUTHORITY_CHANGED')
    } catch { return finish('UNSUPPORTED', 'SOURCE_OR_AUTHORITY_CHANGED') }
    let parsed: z.output<typeof compilerProposalSchema>
    try { parsed = compilerProposalSchema.parse(safeData(proposal)) } catch {
      this.state.malformedAttempts++
      return finish('UNSUPPORTED', 'MALFORMED_COMPILER_OUTPUT', this.state.malformedAttempts === 1 ? 'schema-repair' : 'quarantined')
    }
    if (parsed.outcome !== 'COMPILED') return finish(parsed.outcome, `MODEL_REPORTED_${parsed.outcome}`)
    const candidate = parsed.spec, registries = host.registries
    if (!candidate.invariants.length || !candidate.acceptanceScenarios.length || !candidate.allowedPathIds.length) return finish('UNSUPPORTED', 'RUNNABLE_CRITERIA_AND_SCOPE_REQUIRED')
    for (const entries of [candidate.invariants, candidate.acceptanceScenarios]) if (new Set(entries.map(entry => entry.id)).size !== entries.length) return finish('CONFLICTING', 'DUPLICATE_CRITERION_IDENTITY')
    const selectedChecks = candidate.invariants.map(invariant => registries.checks.find(check => check.id === invariant.checkId))
    if (selectedChecks.some(check => !check || !registries.commands.some(command => command.id === check.commandId))) return finish('UNSUPPORTED', 'UNREGISTERED_INVARIANT_CHECK')
    if (selectedChecks.some(check => check!.conflictsWith.some(id => selectedChecks.some(other => other!.id === id)))) return finish('CONFLICTING', 'CONFLICTING_REGISTERED_INVARIANTS')
    if (candidate.requiredCapabilities.some(capability => !registries.capabilities.includes(capability))) return finish('UNSUPPORTED', 'UNAVAILABLE_CAPABILITY')
    const selectedPaths = candidate.allowedPathIds.map(id => registries.paths.find(path => path.id === id))
    if (selectedPaths.some(path => !path)) return finish('UNSUPPORTED', 'UNREGISTERED_SCOPE')
    const paths = selectedPaths.map(path => path!.path)
    if (new Set(paths).size !== paths.length) return finish('UNSUPPORTED', 'DUPLICATE_SCOPE')
    const controlled = registries.controlledPaths.filter(control => paths.some(path => overlaps(path, control.path)))
    const provenance = [...ingress.provenance, ...host.authorityProvenance]
    if (host.risk === 'high' || host.risk === 'critical' || controlled.length) {
      const granted = host.purposeGrants.find(grant => grant.projectId === ingress.projectId && grant.policyRevision === ingress.policyRevision &&
        grant.purposeId === host.purposeId && grant.sourceRevision === ingress.sourceRevision && grant.risk === host.risk &&
        paths.every(path => grant.allowedPaths.includes(path)) && controlled.every(control => grant.controlClasses.includes(control.class)))
      if (!granted) return finish('UNSUPPORTED', 'PURPOSE_SPECIFIC_AUTHORITY_REQUIRED')
      provenance.push(granted.evidence)
    }
    const scenarios: z.input<typeof executableSpecPayloadSchema>['acceptanceScenarios'] = []
    for (const scenario of candidate.acceptanceScenarios) {
      const fixture = registries.fixtures.find(fixture => fixture.id === scenario.fixtureId)
      if (!fixture?.runnable || !fixture.commandIds.includes(scenario.commandId) || !registries.commands.some(command => command.id === scenario.commandId) ||
        !scenario.assertionIds.length || scenario.assertionIds.some(id => !fixture.assertionIds.includes(id) || !registries.assertions.some(assertion => assertion.id === id && assertion.runnable))) return finish('UNSUPPORTED', 'UNREGISTERED_RUNNABLE_ACCEPTANCE')
      const reproduction = registries.reproductions.find(item => item.id === scenario.reproductionId)
      if (!reproduction || reproduction.sourceRevision !== ingress.sourceRevision || reproduction.fixtureId !== fixture.id || reproduction.commandId !== scenario.commandId || reproduction.expected === reproduction.actual) return finish('INSUFFICIENT_EVIDENCE', 'HOST_REPRODUCTION_REQUIRED')
      scenarios.push({ id: scenario.id, description: scenario.description, fixtureId: scenario.fixtureId, assertionIds: scenario.assertionIds, commandId: scenario.commandId, reproduction: reproduction.artifact, expected: reproduction.expected, actual: reproduction.actual })
    }
    const { registries: _registries, ingress: _ingress, authorityProvenance: _authority, purposeGrants: _grants, purposeId: _purpose, outcomeId: _outcome, specId, ...pins } = host
    try {
      const spec = verifyExecutableSpec(pinExecutableSpec({ ...pins, ...base, id: specId, objective: candidate.objective, nonGoals: candidate.nonGoals,
        invariants: candidate.invariants, acceptanceScenarios: scenarios, allowedPaths: paths,
        requiredCapabilities: candidate.requiredCapabilities, provenance }))
      const outcome = validateContract('CompilerOutcomeV1', { ...base, outcome: 'COMPILED', reasons: ['HOST_VALIDATED_COMPILER_PROPOSAL'], spec })
      this.state.phase = 'finished'
      return { outcome, disposition: 'compiled', cursor: this.cursor }
    } catch { return finish('UNSUPPORTED', 'INVALID_EXECUTABLE_SPEC') }
  }
}
