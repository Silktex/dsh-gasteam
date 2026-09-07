/** Built plugins: signed HTTP custody, native provider trust, explicit fixture compiler, real held Team tasks. */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TeamService from '../../packages/agent-team/lib/index.js'
import * as GitWorktrees from '../../packages/agent-team/lib/git-worktrees.js'
import { WorkspaceCoordinator } from '../../packages/agent-team/lib/coordinator.js'
import { pinWorkflowDefinition } from '../../packages/agent-team/lib/types/workflows.js'
import { DarkFactoryCompilationStore, DarkFactoryCompilationController, DarkFactoryAdmissionStore, DarkFactoryAdmissionController,
  DarkFactoryArtifactStore, darkFactoryTemplate, canonicalJson, digestJson } from '../../packages/agent-team/lib/darkfactory.js'

class FixtureQuery extends SessionQueryEngine { searchSessions() { throw new Error('Unexpected search') } searchEvents() { throw new Error('Unexpected search') } }
class NoModel extends LlmAdapter {
  calls = 0
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream() { this.calls++; throw new Error('Unexpected paid/model dispatch') }
}
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()))
process.on('message', () => {})
process.once('message', async ({ directory, mode, scenario, baseCommit }) => {
  const ctx = new Context(), adapter = new NoModel(), workspace = join(directory, 'workspace'), repository = join(directory, 'repository'), rootId = SessionId('source-workflow-lead')
  let coordinator, compilations, admissions, compiler, admissionController, lead, materializations = 0, compilerCalls = 0, recoveryCalls = 0, reproductionCalls = 0, writes = 0, requestError
  const http = []
  const close = async () => { await compiler?.stop(); await admissionController?.settled(); await compilations?.close(); await admissions?.close(); await coordinator?.close(); await ctx.fiber.dispose() }
  try {
    await mountAgentLoopTestDependencies(ctx); await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: join(directory, 'sessions'), compression: 'none' }); await ctx.plugin(FixtureQuery)
    await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(SubagentService); await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(TeamService, { worktreeProvider: 'git' }); await ctx.plugin(GitWorktrees, { directory: join(directory, 'workers') })
    ctx.llm.registerAdapter(['mock'], adapter)
    const policy = JSON.parse(await readFile(join(directory, 'policy.json'), 'utf8')), projectId = policy.projectIds[0]
    const project = { id: projectId, repository, teamIds: [rootId], targetBranch: 'main', capacity: 2,
      verification: { revision: 1, commands: policy.verification.commands.map(command => ({ command: command.executable, args: command.args })) } }
    if (mode !== 'resume') {
      lead = ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' }, { cwd: repository })
      const registration = await WorkspaceCoordinator.open(ctx, { directory: workspace })
      try { await registration.register(lead, project); await ctx.sessionPersistence.ensureMaterialized(lead.session); await ctx.sessions.flush(lead.session) } finally { await registration.close() }
    } else lead = (await ctx.agentLoop.resume(ctx, { resumeSessionId: rootId, agentOptions: { provider: 'mock', model: 'mock' } })).agent
    coordinator = await WorkspaceCoordinator.open(ctx, { directory: workspace, darkFactory: policy, execution: { modelProvider: 'mock', model: 'mock', maxConcurrent: 2 } })
    const observer = coordinator.factoryObserver, ingestion = observer.stores.get(projectId), authority = observer.authority
    const artifacts = await DarkFactoryArtifactStore.open(workspace, [projectId], policy.limits.maxArtifactBytes, policy.limits.maxArtifactTotalBytes)
    if (mode !== 'resume') {
      const body = JSON.stringify({ action: 'opened', repository: { id: 42, full_name: 'owner/repo' }, sender: { id: 12 }, installation: { id: 10 },
        issue: { id: 100, number: 7, title: 'Webhook title must not become the spec source', body: 'RAW_WEBHOOK_NARRATIVE_SENTINEL', user: { id: 12 }, labels: [{ name: 'automate' }], state: 'open', updated_at: '2026-09-06T11:00:00Z' } })
      const post = async delivery => {
        const signature = createHmac('sha256', scenario === 'forged' ? 'incorrect-fixture-secret' : process.env.DF_TEST_SECRET).update(body).digest('hex')
        const response = await fetch(`http://127.0.0.1:${observer.status().port}/darkfactory/v1/ingress/github/route`, { method: 'POST', body,
          signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': delivery, 'x-hub-signature-256': `sha256=${signature}` } })
        http.push({ status: response.status, body: await response.json() })
      }
      await post('delivery-1'); if (scenario === 'replayed') await post('delivery-2')
      // Bounded native drain, independent of timer scheduling; no handcrafted trusted item.
      await observer.reconciler.runOnce(); await observer.reconciler.runOnce()
    }
    await observer.reconciler.close()
    const options = { projectId, registeredLeadId: rootId, workflowTemplates: [darkFactoryTemplate] }
    compilations = await DarkFactoryCompilationStore.open(workspace, options); admissions = await DarkFactoryAdmissionStore.open(workspace, options)
    const policyState = () => authority.snapshot().find(value => value.projectId === projectId)
    const policyRecord = () => policyState().policies.at(-1)
    // Only the explicitly injected deterministic compiler/held-materializer capability is authorized here.
    // An ingress decision is retained as source provenance, never treated as model or activation authority.
    const authorized = record => {
      const state = policyState(), pins = record.intent, spec = pins.spec ?? pins.context?.ingress
      return !state.disabled && !state.revoked && state.pauses.length === 0 && !state.reconciliationRequired &&
        spec?.projectId === projectId && spec.policyRevision === policyRecord().policyRevision && pins.registeredLeadId === rootId &&
        pins.policyRefs.policyRecordId === policyRecord().id && (pins.spec?.policyDigest ?? pins.context.policyDigest) === policyRecord().digest &&
        state.decisions.some(receipt => receipt.id === pins.policyRefs.decisionReceiptId && receipt.policyRevision === spec.policyRevision && receipt.decision === 'allow' && receipt.effect === 'ingress')
    }
    const quarantine = async ({ compilationId, admissionId, itemId, reason, evidenceRefs }) => (await coordinator.execution.raiseFactoryEscalation({ schemaVersion: 1, projectId,
      policyRevision: policyRecord().policyRevision, stage: 'admission', reason, effectId: compilationId ?? admissionId ?? itemId,
      evidenceRefs, severity: 'warning', diagnostics: 'Deterministic source-to-workflow fixture condition' }, Date.now())).id
    const snapshot = async barrier => {
      await ctx.sessions.flush(lead.session)
      const record = admissions.snapshot().admissions[0], stored = await ctx.sessionPersistence.inspect(rootId), view = coordinator.view()
      return { barrier, pid: process.pid, http, requestError, compilations: compilations.snapshot(), admissions: admissions.snapshot(), ingestion: ingestion.snapshot(),
        policy: policyRecord(), decisions: policyState().decisions, requestBudget: observer.requestBudget.snapshot(), inbox: coordinator.healthInbox(lead, projectId), compilerCalls, recoveryCalls, reproductionCalls, materializations, modelCalls: adapter.calls,
        tasks: ctx.agentTeams.listTasks(lead), taskEvents: stored.events.filter(event => event.type === 'team/task'),
        workflow: record ? coordinator.inspectWorkflow(lead, record.intent.workflowId) : null, attempts: view.attempts, readyTasks: view.readyTasks, dispatchStatus: view.dispatchStatus }
    }
    const barrier = async name => { await send(await snapshot(name)); await new Promise(() => {}) }
    if (mode === 'after-compiled') {
      const complete = compilations.completeAttempt.bind(compilations)
      compilations.completeAttempt = async input => { const result = await complete(input); if (result.record.status === 'compiled') await barrier(mode); return result }
    }
    if (mode === 'after-two-tasks') for (const method of ['createPinnedWorkflowTask', 'createPinnedWorkflowCodeTask']) {
      const create = coordinator.execution[method].bind(coordinator.execution)
      coordinator.execution[method] = async input => { const result = await create(input); if (++writes === 2) await barrier(mode); return result }
    }
    admissionController = new DarkFactoryAdmissionController({ admissions, ingestion, authorize: async record => authorized(record), quarantine,
      materialize: async record => { materializations++; return coordinator.workflows.materializeFactoryAdmission(record, project) } })
    compiler = new DarkFactoryCompilationController({ compilations, ingestion, admissions: admissionController, authorize: async ({ record }) => authorized(record), quarantine,
      recover: async () => { recoveryCalls++; return { status: 'unknown' } },
      compile: async ({ context }) => {
        compilerCalls++
        if (scenario === 'malformed') return '{MALFORMED_PRIVATE_SENTINEL'
        if (scenario === 'ambiguous' || scenario === 'conflicting') return { outcome: scenario.toUpperCase(), reasons: ['Synthetic fixed refusal'] }
        return { outcome: 'COMPILED', spec: { objective: 'Repair the current provider issue', nonGoals: ['No deployment'],
          invariants: [{ id: 'invariant', description: 'Registered rule remains true', checkId: context.registries.checks[0].id }],
          acceptanceScenarios: [{ id: 'scenario', description: 'Registered empty request reproducer passes', fixtureId: context.registries.fixtures[0].id,
            assertionIds: context.registries.fixtures[0].assertionIds, commandId: context.registries.commands[0].id, reproductionId: context.registries.reproductions[0].id }],
          allowedPathIds: ['source'], requiredCapabilities: ['typescript'] } }
      },
    })
    if (mode === 'resume') await compiler.resume({ projectId, limit: 1 })
    else if (!['forged', 'replayed'].includes(scenario)) {
      const ingress = ingestion.snapshot().items[0]
      assert.equal(ingress?.trust.decision, 'trusted'); assert.equal(ingress.title, 'Current provider issue')
      const pinned = policyRecord(), registry = JSON.parse(await readFile(join(directory, 'host-registry.json'), 'utf8'))
      const command = pinned.policy.verification.commands[0]
      const output = await promisify(execFile)(command.executable, command.args, { cwd: repository, timeout: command.deadlineMs }); reproductionCalls++
      const reproduction = JSON.parse(output.stdout)
      const reproductionArtifact = await artifacts.persist(projectId, { ...reproduction, sourceRevision: ingress.sourceRevision, command })
      const authorityArtifact = await artifacts.persist(projectId, pinned), registryArtifact = await artifacts.persist(projectId, registry)
      const workflow = { template: darkFactoryTemplate, parameters: { subject: 'current trusted source' } }
      const context = { outcomeId: 'compiler-outcome', specId: 'compiled-spec', ingress, priority: 50, risk: 'low', purposeId: 'repair-source', baseCommit,
        policyDigest: pinned.digest, rulesDigest: digestJson(pinned.policy.verification), toolchainDigest: digestJson(command), workflowDigest: digestJson(pinWorkflowDefinition(workflow.template, workflow.parameters)),
        compilerRevision: 1, promptRevision: 1, modelAssignmentId: registry.modelAssignmentId, authorityProvenance: [authorityArtifact, registryArtifact], purposeGrants: [],
        registries: { commands: [command], checks: [{ id: pinned.policy.verification.checkIds[0], commandId: command.id, conflictsWith: [] }],
          fixtures: [{ id: pinned.policy.verification.fixtureIds[0], runnable: true, commandIds: [command.id], assertionIds: [registry.assertionId] }],
          assertions: [{ id: registry.assertionId, runnable: true }], capabilities: registry.capabilities, paths: registry.paths, controlledPaths: [],
          reproductions: [{ id: 'reproduction', sourceRevision: ingress.sourceRevision, artifact: reproductionArtifact, expected: reproduction.expected, actual: reproduction.actual,
            fixtureId: pinned.policy.verification.fixtureIds[0], commandId: command.id }] } }
      const intent = { context, registeredLeadId: rootId, workflow, policyRefs: { policyRecordId: pinned.id, decisionReceiptId: policyState().decisions.at(-1).id } }
      try { await compiler.compile({ projectId: scenario === 'cross-project' ? 'other-project' : projectId, intent }) }
      catch (error) { if (scenario !== 'cross-project') throw error; requestError = error.message }
    }
    await coordinator.reconcile()
    const record = admissions.snapshot().admissions[0]
    if (record) { await coordinator.resumeWorkflow(lead, record.intent.workflowId); assert.deepEqual(await coordinator.workflows.scan(project), []) }
    const result = await snapshot('complete'); assert.equal(adapter.calls, 0)
    await artifacts.settled(); await close(); await send(result); process.disconnect()
  } catch (error) {
    try { await close() } catch { /* Preserve original fixture failure. */ }
    await send({ barrier: 'error', message: String(error), stack: error?.stack }); process.exitCode = 1; process.disconnect()
  }
})
