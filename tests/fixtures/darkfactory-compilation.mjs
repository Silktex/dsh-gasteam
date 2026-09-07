/** Built SDK process fixture. Provider lookup and materialization are explicit local simulators. */
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DarkFactoryCompilationStore, DarkFactoryCompilationController, DarkFactoryAdmissionStore, DarkFactoryAdmissionController, DarkFactoryIngestionStore, canonicalJson } from '../../packages/agent-team/lib/darkfactory.js'
import { HealthStore } from '../../packages/agent-team/lib/types/health.js'
process.on('message', () => {})
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()))
process.once('message', async ({ directory, mode, fixture }) => {
  let compilations, ingestion, admissions, controller, admissionController, health
  let calls = [], lookups = [], materializations = 0
  const { input, initial, envelope, proposal } = fixture, projectId = initial.projectId
  const snapshot = () => ({ pid: process.pid, compilations: compilations.snapshot(), ingestion: ingestion.snapshot(), admissions: admissions.snapshot(), inbox: health.listEscalations(), calls, lookups, materializations })
  const barrier = async name => { await send({ barrier: name, ...snapshot() }); await new Promise(() => {}) }
  const synced = async (filename, value) => {
    try {
      const file = await open(filename, 'wx', 0o600)
      try { await file.writeFile(canonicalJson(value)); await file.sync() } finally { await file.close() }
      const parent = await open(directory, 'r'); try { await parent.sync() } finally { await parent.close() }
    } catch (error) {
      if (error.code !== 'EEXIST' || canonicalJson(JSON.parse(await readFile(filename, 'utf8'))) !== canonicalJson(value)) throw new Error('Fixture receipt conflict')
    }
  }
  try {
    const options = { projectId, registeredLeadId: input.registeredLeadId, workflowTemplates: [input.workflow.template] }
    compilations = await DarkFactoryCompilationStore.open(directory, options)
    admissions = await DarkFactoryAdmissionStore.open(directory, options)
    ingestion = await DarkFactoryIngestionStore.open(directory, { projectId })
    health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
    const resume = mode.startsWith('resume')
    if (!resume) {
      await ingestion.recordReceived({ envelope, item: initial, bodySizeBytes: 100 })
      await ingestion.transition({ projectId, expectedRevision: initial.revision, item: input.context.ingress })
    }
    if (mode === 'after-attempt') {
      const original = compilations.startAttempt.bind(compilations)
      compilations.startAttempt = async request => { await original(request); await barrier(mode) }
    }
    if (['after-callback', 'after-malformed', 'after-compiled'].includes(mode)) {
      const original = compilations.completeAttempt.bind(compilations)
      compilations.completeAttempt = async request => {
        if (mode === 'after-callback') await barrier(mode)
        const result = await original(request)
        await barrier(mode)
        return result
      }
    }
    if (mode === 'after-handoff') {
      compilations.recordAdmission = async () => { await barrier(mode) }
    }
    const quarantine = async ({ compilationId, admissionId, itemId, reason, evidenceRefs }) => {
      const incident = await health.raiseFactoryEscalation({ schemaVersion: 1, projectId, policyRevision: input.context.ingress.policyRevision,
        stage: 'admission', reason, effectId: compilationId ?? admissionId ?? itemId,
        evidenceRefs, severity: 'warning', diagnostics: 'Synthetic compiler process condition' }, Date.parse('2026-09-06T12:00:00Z'))
      if (mode === 'resume-health-barrier') await barrier('after-health')
      return incident.id
    }
    admissionController = new DarkFactoryAdmissionController({ admissions, ingestion, authorize: async () => true, quarantine,
      materialize: async record => {
        materializations++
        const receipt = { workflowId: record.intent.workflowId, workflowDigest: record.intent.spec.workflowDigest, taskIds: record.receipt.taskIds }
        await synced(join(directory, 'compiler-materialization.json'), receipt)
        return receipt
      },
    })
    controller = new DarkFactoryCompilationController({ compilations, ingestion, admissions: admissionController,
      authorize: async () => mode !== 'resume-denied', quarantine,
      compile: async ({ attemptId, phase }) => {
        calls.push(attemptId)
        const result = mode === 'after-malformed' && phase === 'initial' || mode === 'resume-malformed' ? 'MALFORMED_PRIVATE_SENTINEL' : proposal
        await synced(join(directory, `${attemptId}.provider-result.json`), { proposal: result })
        return result
      },
      recover: async ({ attemptId }) => {
        lookups.push(attemptId)
        if (mode === 'resume-unknown' || mode === 'resume-health-barrier') return { status: 'unknown' }
        try { return { status: 'completed', ...JSON.parse(await readFile(join(directory, `${attemptId}.provider-result.json`), 'utf8')) } }
        catch (error) { if (error.code === 'ENOENT') return { status: 'definitely-not-started' }; throw error }
      },
    })
    if (resume) await controller.resume({ projectId, limit: 1 })
    else await controller.compile({ projectId, intent: input })
    await send({ barrier: 'recovered', ...snapshot() })
    await controller.settled(); await admissionController.settled()
    await compilations.close(); await admissions.close(); await ingestion.close(); await health.close()
    process.disconnect()
  } catch (error) {
    await send({ barrier: 'error', message: String(error) })
    await compilations?.close(); await admissions?.close(); await ingestion?.close(); await health?.close()
    process.exitCode = 1; process.disconnect()
  }
})
