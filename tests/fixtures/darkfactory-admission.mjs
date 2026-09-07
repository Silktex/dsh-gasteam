/** Built host SDK crash fixture; materialization is an idempotent, fsynced local receipt. */
import { join } from 'node:path'
import { open, readFile } from 'node:fs/promises'
import { DarkFactoryAdmissionStore, DarkFactoryAdmissionController, DarkFactoryIngestionStore } from '../../packages/agent-team/lib/darkfactory.js'
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()))
process.once('message', async ({ directory, mode, intent, initial, envelope }) => {
  let admissions, ingestion, controller
  let materializations = 0
  const snapshot = () => ({ pid: process.pid, admissions: admissions.snapshot(), ingestion: ingestion.snapshot(), materializations })
  const barrier = async name => { await send({ barrier: name, ...snapshot() }); await new Promise(() => {}) }
  try {
    const projectId = intent.spec.projectId
    admissions = await DarkFactoryAdmissionStore.open(directory, { projectId, registeredLeadId: intent.registeredLeadId, workflowTemplates: [intent.workflow.template] })
    ingestion = await DarkFactoryIngestionStore.open(directory, { projectId })
    if (mode !== 'resume') {
      await ingestion.recordReceived({ envelope, item: initial, bodySizeBytes: 100 })
      await ingestion.transition({ projectId, expectedRevision: 1, item: { ...initial, revision: 2, state: 'trusted', trust: { ...initial.trust, decision: 'trusted' } } })
      if (mode === 'after-intent') {
        const begin = admissions.begin.bind(admissions)
        admissions.begin = async input => { await begin(input); await barrier(mode) }
      } else if (mode === 'after-admission-ack') {
        const acknowledge = admissions.acknowledge.bind(admissions)
        admissions.acknowledge = async input => { await acknowledge(input); await barrier(mode) }
      }
    }
    controller = new DarkFactoryAdmissionController({ admissions, ingestion, authorize: async () => true,
      quarantine: async () => { throw new Error('Unexpected fixture quarantine') },
      materialize: async record => {
        materializations++
        const receipt = { workflowId: record.intent.workflowId, workflowDigest: record.intent.spec.workflowDigest, taskIds: record.receipt.taskIds }
        const filename = join(directory, 'held-materialization.json')
        try {
          const fd = await open(filename, 'wx', 0o600)
          try { await fd.writeFile(JSON.stringify(receipt)); await fd.sync() } finally { await fd.close() }
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
          if (JSON.stringify(JSON.parse(await readFile(filename, 'utf8'))) !== JSON.stringify(receipt)) throw new Error('Conflicting materialization')
        }
        if (mode === 'after-materialization') await barrier(mode)
        return receipt
      },
    })
    if (mode === 'resume') await controller.resume({ projectId, limit: 1 })
    else await controller.admit({ projectId, itemId: initial.id, intent })
    await send({ barrier: 'recovered', ...snapshot() })
    await controller.settled(); await admissions.close(); await ingestion.close(); process.disconnect()
  } catch (error) {
    await send({ barrier: 'error', message: String(error) })
    await admissions?.close(); await ingestion?.close(); process.exitCode = 1; process.disconnect()
  }
})
