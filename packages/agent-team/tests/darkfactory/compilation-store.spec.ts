import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DarkFactoryCompilationStore, CompilationConflictError, normalizeCompilerResult, type CompilationStoreOptions } from '../../src/darkfactory/compilation-store.ts'
import { DarkFactoryAdmissionStore } from '../../src/darkfactory/admission-store.ts'
import { SpecCompilerSession } from '../../src/darkfactory/spec-compiler.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
import { HealthStore } from '../../src/health.ts'
import { compilationFixture } from './compilation-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture(extra: Partial<CompilationStoreOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'factory-compilation-')), data = compilationFixture()
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const options = { projectId: data.input.context.ingress.projectId, registeredLeadId: data.input.registeredLeadId, workflowTemplates: [data.input.workflow.template], ...extra }
  let store = await DarkFactoryCompilationStore.open(directory, options, () => '2026-09-06T12:00:00Z')
  cleanups.push(() => store.close())
  const fence = () => ({ projectId: options.projectId, expectedRevision: store.snapshot().revision })
  const record = () => store.snapshot().compilations[0]!
  return { ...data, directory, options, filename: join(directory, 'darkfactory', options.projectId, 'compilation.jsonl'),
    get store() { return store }, fence, record,
    async begin() { return store.begin({ ...fence(), intent: data.input }) },
    async start() { return store.startAttempt({ ...fence(), compilationId: record().id }) },
    async complete(proposal: unknown = data.proposal) { return store.completeAttempt({ ...fence(), compilationId: record().id, attemptId: record().attempts.at(-1)!.id, result: normalizeCompilerResult(proposal) }) },
    async reopen() { const snapshot = store.snapshot(); await store.close(); store = await DarkFactoryCompilationStore.open(directory, options, () => '2026-09-06T12:00:00Z'); expect(store.snapshot()).toEqual(snapshot) },
  }
}
function encodedEvent(event: Record<string, unknown>) {
  const { hash: _hash, ...unsigned } = event
  for (;;) {
    const updated = { ...unsigned, hash: digestJson(unsigned) }, bytes = JSON.stringify(updated) + '\n'
    if (Buffer.byteLength(bytes) === unsigned.storageBytes) return bytes
    unsigned.storageBytes = Buffer.byteLength(bytes)
  }
}

describe('durable native compiler evaluation', () => {
  it('replays every compiler boundary and records the exact real held-admission receipt without activation', async () => {
    const f = await fixture()
    const begun = await f.begin()
    expect(begun.record).toMatchObject({ status: 'ready', intent: f.input, attempts: [], cursor: { phase: 'initial', malformedAttempts: 0 } })
    await f.reopen()
    const started = await f.start(), attempt = started.record.attempts[0]!
    expect(attempt).toMatchObject({ number: 1, phase: 'initial', status: 'intended' })
    expect((await readFile(f.filename, 'utf8'))).toContain(attempt.id)
    await f.reopen()
    expect((await f.start()).record.attempts).toEqual([attempt])
    const evaluated = await f.complete(), native = new SpecCompilerSession(f.input.context).evaluate(f.proposal, f.input.context.ingress)
    expect(evaluated.record).toMatchObject({ status: 'compiled', attempts: [{ id: attempt.id, evaluation: native }], cursor: native.cursor })
    expect(evaluated.record.admissionIntent).toMatchObject({ compilerOutcome: native.outcome, compilerCursor: native.cursor, workflow: f.input.workflow, policyRefs: f.input.policyRefs })
    const line = (await readFile(f.filename, 'utf8')).trim().split('\n').at(-1)!
    expect(JSON.parse(line)).toMatchObject({ evaluation: native, admissionIntent: evaluated.record.admissionIntent })
    await f.reopen()

    const admissions = await DarkFactoryAdmissionStore.open(f.directory, f.options)
    cleanups.push(() => admissions.close())
    const { record } = await admissions.begin({ projectId: f.options.projectId, expectedRevision: 0, intent: f.record().admissionIntent! })
    await admissions.recordMaterialized({ projectId: f.options.projectId, expectedRevision: 1, admissionId: record.id, workflowId: record.intent.workflowId, workflowDigest: record.intent.spec.workflowDigest, taskIds: record.receipt.taskIds })
    const ack = await admissions.acknowledge({ projectId: f.options.projectId, expectedRevision: 2, admissionId: record.id })
    expect(ack.record).toMatchObject({ barrier: 'closed', status: 'acknowledged' })
    expect(ack.record.receipt.taskIds).toHaveLength(5)
    const request = () => ({ ...f.fence(), compilationId: f.record().id, receipt: ack.record.receipt })
    const before = await readFile(f.filename)
    await expect(f.store.recordAdmission({ ...request(), receipt: { ...ack.record.receipt, id: 'wrong-receipt' } })).rejects.toBeInstanceOf(CompilationConflictError)
    await expect(f.store.recordAdmission({ ...request(), receipt: { ...ack.record.receipt, taskIds: ['wrong-task'] } })).rejects.toBeInstanceOf(CompilationConflictError)
    expect(await readFile(f.filename)).toEqual(before)
    expect((await f.store.recordAdmission(request())).record).toMatchObject({ status: 'admitted', admissionReceipt: ack.record.receipt })
    await f.reopen()
    expect((await f.store.recordAdmission(request())).duplicate).toBe(true)
    expect((await f.complete()).duplicate).toBe(true)
    const final = f.record()
    await expect(f.start()).rejects.toThrow(/resampled/)
    await expect(f.store.quarantine({ ...f.fence(), compilationId: final.id, reason: 'AUTHORITY_DENIED', healthEscalationId: 'health' })).rejects.toThrow(/immutable/)
    expect(f.record()).toEqual(final)
    expect((await readFile(f.filename)).byteLength).toBe(f.store.snapshot().journalBytes)
  })

  it('retains exactly one schema repair after restart and quarantines only with the shared health inbox receipt', async () => {
    const f = await fixture(), secret = 'raw-malformed-provider-secret'
    await f.begin(); await f.start()
    const first = await f.complete(`{"credential":"${secret}"`)
    expect(first.record).toMatchObject({ status: 'repair', cursor: { malformedAttempts: 1, phase: 'repair' }, attempts: [{ result: { kind: 'malformed' } }] })
    expect(await readFile(f.filename, 'utf8')).not.toContain(secret)
    await f.reopen(); await f.start()
    const secondId = f.record().attempts[1]!.id
    expect(secondId).not.toBe(f.record().attempts[0]!.id)
    await f.reopen()
    expect((await f.start()).record.attempts).toHaveLength(2)
    const rejected = await f.complete('not JSON')
    expect(rejected.record).toMatchObject({ status: 'rejected', cursor: { malformedAttempts: 2, phase: 'finished' } })
    expect(rejected.record.healthEscalationId).toBeUndefined()
    await f.reopen()
    await expect(f.start()).rejects.toThrow(/resampled/)
    const health = await HealthStore.open(f.directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
    cleanups.push(() => health.close())
    const incident = await health.raiseFactoryEscalation({ schemaVersion: 1, projectId: f.options.projectId, policyRevision: 1, stage: 'trust', reason: 'COMPILER_REJECTED', effectId: f.record().id, evidenceRefs: [f.input.context.ingress.envelopeId], severity: 'warning', diagnostics: 'COMPILER_REJECTED' }, Date.now())
    const quarantine = () => ({ ...f.fence(), compilationId: f.record().id, reason: 'COMPILER_REJECTED' as const, healthEscalationId: incident.id })
    expect((await f.store.quarantine(quarantine())).record).toMatchObject({ status: 'quarantined', healthEscalationId: incident.id })
    await f.reopen()
    expect((await f.store.quarantine(quarantine())).duplicate).toBe(true)
    await expect(f.store.quarantine({ ...quarantine(), healthEscalationId: 'other' })).rejects.toThrow(/immutable/)
    expect(f.record().attempts.map(attempt => attempt.status)).toEqual(['evaluated', 'evaluated'])
  })

  it('compiles the single repaired proposal and refuses a changed result for either completed attempt', async () => {
    const f = await fixture(); await f.begin(); await f.start()
    const malformed = normalizeCompilerResult('invalid JSON'), firstId = f.record().attempts[0]!.id
    await f.complete('invalid JSON'); await f.reopen(); await f.start(); await f.complete()
    const record = f.record(), bytes = await readFile(f.filename)
    expect(record).toMatchObject({ status: 'compiled', cursor: { malformedAttempts: 1, phase: 'finished' } })
    await expect(f.complete({ outcome: 'AMBIGUOUS', reasons: ['changed'] })).rejects.toBeInstanceOf(CompilationConflictError)
    expect(await readFile(f.filename)).toEqual(bytes)
    expect((await f.store.completeAttempt({ ...f.fence(), compilationId: record.id, attemptId: firstId, result: malformed })).duplicate).toBe(true)
    expect(f.record()).toEqual(record)
  })

  it('leaves an uncertain callback intent durable with the same identity and no implicit repair or resampling', async () => {
    const f = await fixture(); await f.begin(); await f.start()
    const snapshot = f.record()
    await f.reopen(); expect((await f.start()).record).toEqual(snapshot)
    await f.reopen(); expect((await f.start()).record).toEqual(snapshot)
    expect(snapshot.attempts).toHaveLength(1)
    expect(snapshot.cursor.phase).toBe('initial')
    await f.store.quarantine({ ...f.fence(), compilationId: snapshot.id, reason: 'COMPILER_ATTEMPT_UNCERTAIN', healthEscalationId: 'actual-host-inbox-receipt' })
    await expect(f.complete()).rejects.toThrow(/immutable/)
    await f.reopen()
    expect(f.record()).toMatchObject({ status: 'quarantined', attempts: [{ status: 'intended' }] })
  })

  it('fences source, registration, workflow, CAS, and raw unknown fields without changing the journal', async () => {
    const f = await fixture(), empty = await readFile(f.filename)
    await expect(f.store.begin({ ...f.fence(), expectedRevision: 1, intent: f.input })).rejects.toThrow(/Stale/)
    await expect(f.store.begin({ ...f.fence(), projectId: 'other', intent: f.input })).rejects.toThrow(/Cross-project/)
    for (const input of [
      { ...f.input, registeredLeadId: 'wrong' },
      { ...f.input, context: { ...f.input.context, ingress: { ...f.input.context.ingress, state: 'received' } } },
      { ...f.input, context: { ...f.input.context, workflowDigest: digestJson('wrong') } },
      { ...f.input, workflow: { ...f.input.workflow, template: { ...f.input.workflow.template, version: 2 } } },
    ]) await expect(f.store.begin({ ...f.fence(), intent: input } as never)).rejects.toThrow(/binding/)
    await expect(f.store.begin({ ...f.fence(), intent: f.input, ['secret-bearing-unknown-key']: 'secret' } as never)).rejects.toThrow(/^Invalid compilation authority input: strict bounded JSON required$/)
    expect(await readFile(f.filename)).toEqual(empty)
    const begun = await f.begin()
    expect((await f.begin()).record).toEqual(begun.record)
    const bytes = await readFile(f.filename)
    await expect(f.store.begin({ ...f.fence(), intent: { ...f.input, policyRefs: { ...f.input.policyRefs, decisionReceiptId: 'changed' } } })).rejects.toBeInstanceOf(CompilationConflictError)
    expect(await readFile(f.filename)).toEqual(bytes)
    const request = { ...f.fence(), compilationId: f.record().id }
    const concurrent = await Promise.allSettled([f.store.startAttempt(request), f.store.startAttempt(request)])
    expect(concurrent.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  })

  it('does not persist negative explanation text, malformed payloads, or caller-supplied native outcomes', async () => {
    const f = await fixture(); await f.begin(); await f.start()
    const secret = 'provider-secret-do-not-store'
    const result = normalizeCompilerResult({ outcome: 'AMBIGUOUS', reasons: [secret] })
    expect(result).toEqual({ kind: 'proposal', proposal: { outcome: 'AMBIGUOUS', reasons: ['MODEL_REPORTED_AMBIGUOUS'] } })
    const before = await readFile(f.filename)
    await expect(f.store.completeAttempt({ ...f.fence(), compilationId: f.record().id, attemptId: f.record().attempts[0]!.id, result,
      evaluation: { outcome: { outcome: 'COMPILED' }, cursor: { phase: 'finished' } } } as never)).rejects.toThrow(/^Invalid compilation authority input/)
    expect(await readFile(f.filename)).toEqual(before)
    await f.complete({ outcome: 'AMBIGUOUS', reasons: [secret] })
    expect(f.record()).toMatchObject({ status: 'rejected', cursor: { malformedAttempts: 0, phase: 'finished' } })
    expect(await readFile(f.filename, 'utf8')).not.toContain(secret)
    expect(() => normalizeCompilerResult('x'.repeat(1_048_577))).toThrow(/^Invalid bounded compiler response$/)
    let invoked = false
    expect(() => normalizeCompilerResult({ get secret() { invoked = true; return secret } })).toThrow(/^Invalid bounded compiler response$/)
    expect(invoked).toBe(false)
  })

  it.each(['evaluation', 'admissionIntent', 'attemptId'] as const)('rejects rehashed %s tampering by native semantic replay, preserving every byte', async kind => {
    const f = await fixture(); await f.begin(); await f.start(); await f.complete(); await f.store.close()
    const events = (await readFile(f.filename, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    if (kind === 'evaluation') events[2].evaluation.cursor.malformedAttempts = 1
    if (kind === 'admissionIntent') events[2].admissionIntent.policyRefs.decisionReceiptId = 'forged'
    if (kind === 'attemptId') events[1].attemptId = 'forged'
    for (let index = 0; index < events.length; index++) {
      if (index > 0) events[index].previousHash = events[index - 1].hash
      events[index] = JSON.parse(encodedEvent(events[index]))
    }
    const bytes = events.map(event => JSON.stringify(event)).join('\n') + '\n'
    await writeFile(f.filename, bytes)
    await expect(DarkFactoryCompilationStore.open(f.directory, f.options)).rejects.toThrow()
    expect(await readFile(f.filename, 'utf8')).toBe(bytes)
  })

  it('enforces per-record, journal and intent caps before acknowledgement', async () => {
    const small = await fixture({ maxRecordBytes: 1024, maxJournalBytes: 2048 })
    await expect(small.begin()).rejects.toThrow(/capacity/)
    expect(await readFile(small.filename, 'utf8')).toBe('')
    const f = await fixture({ maxRecordBytes: 9201, maxJournalBytes: 9201, maxIntents: 1 })
    await f.begin()
    await expect(f.start()).rejects.toThrow(/capacity/)
    const before = await readFile(f.filename)
    await expect(f.store.begin({ ...f.fence(), intent: { ...f.input, context: { ...f.input.context, ingress: { ...f.input.context.ingress, sourceEntityId: 'another-source' } } } })).rejects.toThrow(/capacity/)
    let writes = 0
    for (; writes < 100; writes++) { try { await f.begin() } catch (error) { expect(String(error)).toContain('capacity'); break } }
    expect(writes).toBeLessThan(100)
    const capped = await readFile(f.filename)
    expect(capped.byteLength).toBeLessThanOrEqual(9201)
    expect(capped.subarray(0, before.byteLength)).toEqual(before)
    await f.reopen()
    await expect(f.start()).rejects.toThrow(/capacity/)
  })

  it('reserves completion and terminal space against unrelated begins and duplicate writes', async () => {
    const f = await fixture({ maxRecordBytes: 12_000, maxJournalBytes: 32_000 })
    await f.begin(); await f.start()
    const before = await readFile(f.filename)
    await expect(f.store.begin({ ...f.fence(), intent: { ...f.input, context: { ...f.input.context, ingress: { ...f.input.context.ingress, sourceEntityId: 'unrelated' } } } })).rejects.toThrow(/capacity/)
    expect(await readFile(f.filename)).toEqual(before)
    let duplicates = 0
    for (; duplicates < 100; duplicates++) { try { await f.start() } catch (error) { expect(String(error)).toContain('capacity'); break } }
    expect(duplicates).toBeLessThan(100)
    await f.reopen()
    expect((await f.complete()).record.status).toBe('compiled')
    expect((await f.store.quarantine({ ...f.fence(), compilationId: f.record().id, reason: 'AUTHORITY_DENIED', healthEscalationId: 'actual-health-reference' })).record.status).toBe('quarantined')
    await f.reopen()
  })

  it('records a digest-only repair marker when a valid proposal cannot fit a result record', async () => {
    const f = await fixture({ maxRecordBytes: 6000, maxJournalBytes: 24_000 })
    await f.begin(); await f.start()
    const result = await f.complete()
    expect(result.record).toMatchObject({ status: 'repair', attempts: [{ result: { kind: 'malformed', digest: digestJson(f.proposal) } }], cursor: { phase: 'repair', malformedAttempts: 1 } })
    expect(await readFile(f.filename, 'utf8')).not.toContain(f.proposal.spec.objective)
    await f.reopen()
    expect((await f.complete()).duplicate).toBe(true)
    await f.start(); await f.complete()
    expect(f.record()).toMatchObject({ status: 'rejected', cursor: { malformedAttempts: 2, phase: 'finished' } })
    await f.reopen()
  })

  it('retains exclusive ownership, rejects symlink and partial input, and migrates with native replay', async () => {
    const f = await fixture(); await f.begin(); await f.start(); await f.complete()
    await expect(DarkFactoryCompilationStore.open(f.directory, f.options)).rejects.toThrow()
    await expect(DarkFactoryCompilationStore.migrate(f.directory, f.options, { migrationId: 'owned', validateReferences: async () => {} })).rejects.toThrow()
    const snapshot = f.store.snapshot(), bytes = await readFile(f.filename)
    await f.store.close()
    let calls = 0
    const result = await DarkFactoryCompilationStore.migrate(f.directory, f.options, { migrationId: 'compiler-layout', validateReferences: async state => { calls++; expect(state).toEqual(snapshot) } })
    expect(calls).toBe(2); expect(await readFile(result.backup)).toEqual(bytes)
    await f.reopen()
    expect((await f.complete()).duplicate).toBe(true)
    expect(await readFile(result.backup)).toEqual(bytes)

    const broken = await fixture(); await broken.begin(); await broken.store.close()
    await appendFile(broken.filename, '{"version":1')
    const partial = await readFile(broken.filename)
    await expect(DarkFactoryCompilationStore.open(broken.directory, broken.options)).rejects.toThrow(/Incomplete/)
    expect(await readFile(broken.filename)).toEqual(partial)
    await rm(broken.filename)
    const outside = join(broken.directory, 'outside.jsonl'); await writeFile(outside, 'retained')
    await symlink(outside, broken.filename)
    await expect(DarkFactoryCompilationStore.open(broken.directory, broken.options)).rejects.toThrow()
    expect(await readFile(outside, 'utf8')).toBe('retained')
  })
})
