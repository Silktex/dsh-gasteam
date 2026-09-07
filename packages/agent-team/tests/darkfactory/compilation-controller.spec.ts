import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DarkFactoryCompilationController, type CompilationCallbackInput, type CompilationControllerHost, type CompilationRecovery } from '../../src/darkfactory/compilation-controller.ts'
import { DarkFactoryCompilationStore } from '../../src/darkfactory/compilation-store.ts'
import { DarkFactoryIngestionStore } from '../../src/darkfactory/ingestion-store.ts'
import { DarkFactoryAdmissionStore } from '../../src/darkfactory/admission-store.ts'
import { DarkFactoryAdmissionController } from '../../src/darkfactory/admission-controller.ts'
import { HealthStore } from '../../src/health.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
import { compilationFixture } from './compilation-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function fixture(deadline = 1000) {
  const directory = await mkdtemp(join(tmpdir(), 'factory-compile-controller-')), data = compilationFixture()
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const options = { projectId: 'project-1', registeredLeadId: 'lead', workflowTemplates: [data.input.workflow.template] }
  let compilations = await DarkFactoryCompilationStore.open(directory, options)
  let ingestion = await DarkFactoryIngestionStore.open(directory, { projectId: 'project-1' })
  let admissions = await DarkFactoryAdmissionStore.open(directory, options)
  const health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
  await ingestion.recordReceived({ envelope: data.envelope, item: data.initial, bodySizeBytes: 100 })
  await ingestion.transition({ projectId: 'project-1', expectedRevision: 1, item: data.input.context.ingress })
  const calls: CompilationCallbackInput[] = [], recoveries: CompilationCallbackInput[] = []
  let compileHook: (input: CompilationCallbackInput) => Promise<unknown> = async () => data.proposal
  let recoverHook: (input: CompilationCallbackInput) => Promise<CompilationRecovery> = async () => ({ status: 'unknown' })
  let authorizeHook: CompilationControllerHost['authorize'] = async () => true
  let materializeCalls = 0
  const openAdmission = () => new DarkFactoryAdmissionController({ admissions, ingestion, authorize: async () => true,
    quarantine: async input => (await health.raiseFactoryEscalation({ schemaVersion: 1, projectId: input.projectId, policyRevision: 1, stage: 'admission', reason: input.reason, effectId: input.admissionId, evidenceRefs: input.evidenceRefs, severity: 'warning', diagnostics: input.reason }, Date.now())).id,
    materialize: async record => { materializeCalls++; return { workflowId: record.intent.workflowId, workflowDigest: record.intent.spec.workflowDigest, taskIds: record.receipt.taskIds } },
  })
  let admissionController = openAdmission()
  const openController = () => new DarkFactoryCompilationController({ compilations, ingestion, admissions: admissionController,
    authorize: input => authorizeHook(input),
    compile: async input => {
      calls.push(input)
      expect(compilations.snapshot().compilations.some(record => record.attempts.at(-1)?.id === input.attemptId)).toBe(true)
      expect(await readFile(join(directory, 'darkfactory/project-1/compilation.jsonl'), 'utf8')).toContain(input.attemptId)
      return compileHook(input)
    },
    recover: async input => { recoveries.push(input); return recoverHook(input) },
    quarantine: async input => (await health.raiseFactoryEscalation({ schemaVersion: 1, projectId: input.projectId, policyRevision: 1, stage: 'trust', reason: input.reason, effectId: input.itemId, evidenceRefs: input.evidenceRefs, severity: 'warning', diagnostics: input.reason }, Date.now())).id,
  }, { callbackDeadlineMs: deadline, maxQueued: 2 })
  let controller = openController()
  cleanups.push(async () => { await controller.stop(); await admissionController.settled(); await compilations.close(); await admissions.close(); await ingestion.close(); await health.close() })
  return { directory, data, calls, recoveries, health, request: { projectId: 'project-1', intent: data.input },
    get compilations() { return compilations }, get ingestion() { return ingestion }, get admissions() { return admissions }, get controller() { return controller }, get materializeCalls() { return materializeCalls },
    setCompile(value: typeof compileHook) { compileHook = value }, setRecover(value: typeof recoverHook) { recoverHook = value }, setAuthorize(value: typeof authorizeHook) { authorizeHook = value },
    async addSource(sameEntity: boolean) {
      const next = structuredClone(data), sourceRevision = digestJson('next immutable source revision')
      next.initial.id = 'next-item'; next.initial.envelopeId = 'next-envelope'; next.initial.sourceRevision = sourceRevision
      next.initial.trust.entityRevision = sourceRevision
      if (!sameEntity) next.initial.sourceEntityId = 'unrelated-source-entity'
      next.envelope.id = next.initial.envelopeId; next.envelope.deliveryId = 'next-delivery'; next.envelope.bodyDigest = digestJson('next body')
      next.input.context.ingress = { ...next.initial, state: 'trusted', revision: 2, trust: { ...next.initial.trust, decision: 'trusted' } }
      next.input.context.specId = 'next-spec'; next.input.context.outcomeId = 'next-outcome'
      for (const reproduction of next.input.context.registries.reproductions) reproduction.sourceRevision = sourceRevision
      await ingestion.recordReceived({ envelope: next.envelope, item: next.initial, bodySizeBytes: 100 })
      await ingestion.transition({ projectId: 'project-1', expectedRevision: 1, item: next.input.context.ingress })
      return { projectId: 'project-1', intent: next.input }
    },
    async seedAttempt() {
      const { record } = await compilations.begin({ projectId: 'project-1', expectedRevision: compilations.snapshot().revision, intent: data.input })
      await compilations.startAttempt({ projectId: 'project-1', expectedRevision: compilations.snapshot().revision, compilationId: record.id })
      return compilations.snapshot().compilations[0]!
    },
    async reopen() {
      await controller.stop(); await admissionController.settled(); await compilations.close(); await admissions.close(); await ingestion.close()
      compilations = await DarkFactoryCompilationStore.open(directory, options); admissions = await DarkFactoryAdmissionStore.open(directory, options); ingestion = await DarkFactoryIngestionStore.open(directory, { projectId: 'project-1' })
      admissionController = openAdmission(); controller = openController()
    },
  }
}

it('syncs the stable attempt before compile, persists exact handoff, and admits once across restart', async () => {
  const f = await fixture(), result = await f.controller.compile(f.request)
  expect(result.status).toBe('admitted'); expect(f.calls).toHaveLength(1); expect(f.materializeCalls).toBe(1)
  expect(result.admissionIntent).toEqual(f.admissions.snapshot().admissions[0]!.intent ? (() => { const { workKey: _workKey, intentDigest: _digest, admissionId: _id, workflowId: _workflowId, definition: _definition, plannedSteps: _steps, ...intent } = f.admissions.snapshot().admissions[0]!.intent; return intent })() : undefined)
  expect(f.ingestion.snapshot().items[0]!.state).toBe('acknowledged')
  expect(await f.controller.compile(f.request)).toEqual(result)
  await f.reopen(); expect(await f.controller.resume({ projectId: 'project-1', limit: 10 })).toEqual([])
  expect(f.calls).toHaveLength(1); expect(f.materializeCalls).toBe(1)
})
it('persists malformed evaluation before exactly one repair and never journals malformed secrets', async () => {
  const f = await fixture()
  f.setCompile(async input => {
    if (input.phase === 'initial') return '{"secret":"provider-secret-value"'
    const record = f.compilations.snapshot().compilations[0]!
    expect(record.cursor).toMatchObject({ phase: 'repair', malformedAttempts: 1 })
    expect(record.attempts[0]!.status).toBe('evaluated')
    return f.data.proposal
  })
  expect((await f.controller.compile(f.request)).status).toBe('admitted')
  expect(f.calls.map(call => call.phase)).toEqual(['initial', 'repair'])
  expect(new Set(f.calls.map(call => call.attemptId)).size).toBe(2)
  expect(await readFile(join(f.directory, 'darkfactory/project-1/compilation.jsonl'), 'utf8')).not.toContain('provider-secret-value')
})
it.each(['AMBIGUOUS', 'CONFLICTING', 'INSUFFICIENT_EVIDENCE', 'UNSUPPORTED'] as const)('quarantines %s without resampling and uses the real durable inbox', async outcome => {
  const f = await fixture(); f.setCompile(async () => ({ outcome, reasons: ['provider-secret-value'] }))
  const result = await f.controller.compile(f.request)
  expect(result.status).toBe('quarantined'); expect(f.calls).toHaveLength(1)
  expect(f.ingestion.snapshot().items[0]).toMatchObject({ state: 'quarantined', healthEscalationId: result.healthEscalationId })
  expect(f.health.listEscalations().map(value => value.id)).toContain(result.healthEscalationId)
  expect(await readFile(join(f.directory, 'darkfactory/project-1/compilation.jsonl'), 'utf8')).not.toContain('provider-secret-value')
  await f.reopen(); expect(await f.controller.resume({ projectId: 'project-1', limit: 10 })).toEqual([]); expect(f.calls).toHaveLength(1)
})
it('a second malformed result is terminal and cannot create a third attempt', async () => {
  const f = await fixture(); f.setCompile(async () => ({}))
  const result = await f.controller.compile(f.request)
  expect(result).toMatchObject({ status: 'quarantined', cursor: { malformedAttempts: 2, phase: 'finished' } })
  expect(f.calls).toHaveLength(2); await f.controller.compile(f.request); expect(f.calls).toHaveLength(2)
})
it('recovers a completed pending callback without another invocation', async () => {
  const f = await fixture(), pending = await f.seedAttempt(); await f.reopen()
  f.setRecover(async () => ({ status: 'completed', proposal: f.data.proposal }))
  expect((await f.controller.resume({ projectId: 'project-1', limit: 10 }))[0]!.status).toBe('admitted')
  expect(f.calls).toHaveLength(0); expect(f.recoveries[0]!.attemptId).toBe(pending.attempts[0]!.id)
})
it('retries only a definitely-not-started attempt with the identical stable ID', async () => {
  const f = await fixture(), pending = await f.seedAttempt(); await f.reopen()
  f.setRecover(async () => ({ status: 'definitely-not-started' }))
  expect((await f.controller.resume({ projectId: 'project-1', limit: 10 }))[0]!.status).toBe('admitted')
  expect(f.calls).toHaveLength(1); expect(f.calls[0]!.attemptId).toBe(pending.attempts[0]!.id)
})
it('quarantines an unknown recovered attempt without a second callback', async () => {
  const f = await fixture(); await f.seedAttempt(); await f.reopen()
  const [record] = await f.controller.resume({ projectId: 'project-1', limit: 10 })
  expect(record).toMatchObject({ status: 'quarantined', quarantineReason: 'COMPILER_ATTEMPT_UNCERTAIN' })
  expect(f.calls).toHaveLength(0); expect(f.health.listEscalations()).toHaveLength(1)
})
it('bounds repeated definitely-not-started recovery when compiler failures persist', async () => {
  const f = await fixture(); f.setCompile(async () => { throw new Error('secret provider failure') }); f.setRecover(async () => ({ status: 'definitely-not-started' }))
  expect((await f.controller.compile(f.request)).status).toBe('quarantined')
  expect(f.calls).toHaveLength(2); expect(f.recoveries).toHaveLength(1)
  expect(new Set(f.calls.map(call => call.attemptId)).size).toBe(1)
  expect(await readFile(join(f.directory, 'darkfactory/project-1/compilation.jsonl'), 'utf8')).not.toContain('secret provider failure')
})
it('rechecks exact source and authority after callback completion before persisting a result', async () => {
  const f = await fixture()
  f.setCompile(async () => {
    const current = f.ingestion.snapshot().items[0]!
    await f.ingestion.transition({ projectId: current.projectId, expectedRevision: current.revision, item: { ...current, state: 'compiled', revision: current.revision + 1 } })
    return f.data.proposal
  })
  const result = await f.controller.compile(f.request)
  expect(result).toMatchObject({ status: 'quarantined', quarantineReason: 'SOURCE_CHANGED' })
  expect(result.attempts[0]!.status).toBe('intended'); expect(f.materializeCalls).toBe(0)
})
it('denied authority prevents invocation and revoked result authority prevents admission', async () => {
  const first = await fixture(); first.setAuthorize(async () => false)
  expect((await first.controller.compile(first.request)).status).toBe('quarantined'); expect(first.calls).toHaveLength(0)
  const second = await fixture(); second.setAuthorize(async input => input.stage !== 'result')
  expect((await second.controller.compile(second.request)).status).toBe('quarantined'); expect(second.calls).toHaveLength(1); expect(second.materializeCalls).toBe(0)
})
it('timeouts abort the callback and retain the invocation fence until its actual promise settles', async () => {
  const f = await fixture(20), callback = deferred<unknown>(); f.setCompile(() => callback.promise)
  const result = await f.controller.compile(f.request)
  expect(result).toMatchObject({ status: 'quarantined', quarantineReason: 'COMPILER_ATTEMPT_UNCERTAIN' })
  expect(f.calls[0]!.signal.aborted).toBe(true); expect(f.recoveries).toHaveLength(0)
  await f.controller.compile(f.request); expect(f.calls).toHaveLength(1)
  callback.resolve(f.data.proposal); await f.controller.settled()
  expect(f.compilations.snapshot().compilations[0]!.status).toBe('quarantined')
})
it('stop aborts outstanding work, bounds the queue, and leaves an attempt for explicit recovery', async () => {
  const f = await fixture(1000), callback = deferred<unknown>(), entered = deferred<void>()
  f.setCompile(async () => { entered.resolve(); return callback.promise })
  const first = f.controller.compile(f.request); void first.catch(() => {})
  await entered.promise
  const queued = f.controller.compile(f.request); void queued.catch(() => {})
  await expect(f.controller.compile(f.request)).rejects.toMatchObject({ code: 'COMPILATION_PENDING' })
  await f.controller.stop()
  await expect(first).rejects.toMatchObject({ code: 'COMPILATION_STOPPED' }); await expect(queued).rejects.toMatchObject({ code: 'COMPILATION_STOPPED' })
  expect(f.calls[0]!.signal.aborted).toBe(true); expect(f.compilations.snapshot().compilations[0]!.status).toBe('attempting')
  callback.resolve(f.data.proposal)
})
it('reconciles acknowledged ingestion after admission succeeded but compilation receipt persistence failed', async () => {
  const f = await fixture(), original = f.compilations.recordAdmission.bind(f.compilations)
  f.compilations.recordAdmission = async () => { throw new Error('simulated interruption') }
  await expect(f.controller.compile(f.request)).rejects.toThrow('simulated interruption')
  expect(f.ingestion.snapshot().items[0]!.state).toBe('acknowledged'); expect(f.compilations.snapshot().compilations[0]!.status).toBe('compiled')
  f.compilations.recordAdmission = original; await f.reopen()
  expect((await f.controller.resume({ projectId: 'project-1', limit: 10 }))[0]!.status).toBe('admitted')
  expect(f.calls).toHaveLength(1); expect(f.materializeCalls).toBe(1)
})

it('quarantines a newer source revision and preserves an earlier active compilation through restart order', async () => {
  const f = await fixture(), original = f.compilations.recordAdmission.bind(f.compilations)
  f.compilations.recordAdmission = async () => { throw new Error('receipt interruption') }
  await expect(f.controller.compile(f.request)).rejects.toThrow('receipt interruption')
  f.compilations.recordAdmission = original
  const prior = f.compilations.snapshot().compilations[0]!, next = await f.addSource(true)
  await f.compilations.begin({ projectId: 'project-1', expectedRevision: f.compilations.snapshot().revision, intent: next.intent })
  await f.reopen()
  const results = await f.controller.resume({ projectId: 'project-1', limit: 10 })
  expect(results.map(record => record.status)).toEqual(['admitted', 'quarantined'])
  expect(results[0]).toMatchObject({ id: prior.id, intent: prior.intent })
  expect(results[1]).toMatchObject({ quarantineReason: 'SOURCE_CHANGED', attempts: [] })
  expect(f.calls).toHaveLength(1); expect(f.recoveries).toHaveLength(0); expect(f.materializeCalls).toBe(1)
  expect(f.ingestion.snapshot().items.find(item => item.id === prior.intent.context.ingress.id)!.state).toBe('acknowledged')
  expect(f.ingestion.snapshot().items.find(item => item.id === next.intent.context.ingress.id)!.state).toBe('quarantined')
  const admitted = structuredClone(results[0]!)
  await f.controller.compile(next)
  expect(f.compilations.snapshot().compilations[0]).toEqual(admitted)
})
it('allows a different source entity while an earlier admitted workflow remains held', async () => {
  const f = await fixture(), prior = await f.controller.compile(f.request), next = await f.addSource(false)
  expect((await f.controller.compile(next)).status).toBe('admitted')
  expect(f.calls).toHaveLength(2); expect(f.materializeCalls).toBe(2)
  expect(f.compilations.snapshot().compilations[0]).toEqual(prior)
  expect(f.health.listEscalations()).toHaveLength(0)
})
