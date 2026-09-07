/** Built SDK process fixture; transport is a counted local callback, never an external request. */
import { DarkFactoryProviderRequestStore } from '../../packages/agent-team/lib/darkfactory.js'

const [mode, directory] = process.argv.slice(2)
const at = '2026-09-06T12:00:00.000Z'
const route = { projectId: 'budget-project', routeId: 'github-route' }
let store, transportCalls = 0, retryUsed = false, queue = Promise.resolve()
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()))
const snapshot = barrier => ({ barrier, pid: process.pid, state: store.snapshot(), availability: store.availability(at), transportCalls })
const transport = () => {
  if (!process.env.PROVIDER_BUDGET_FIXTURE_TOKEN) throw new Error('Fixture credential is absent')
  transportCalls++
}
async function fail() {
  await send({ barrier: 'error', message: 'Provider budget fixture failed' }).catch(() => {})
  await store?.close().catch(() => {})
  process.exitCode = 1
  if (process.connected) process.disconnect()
}
try {
  if (!['seed', 'resume', 'replay'].includes(mode)) throw new Error('Invalid fixture mode')
  store = await DarkFactoryProviderRequestStore.open(directory, { routes: [route], requestsPerMinute: 2 })
  // Install the persistent command listener before publishing any barrier.
  process.on('message', command => {
    queue = queue.then(async () => {
      if (command === 'stop') {
        await store.close()
        process.disconnect()
      } else if (command === 'retry' && mode === 'resume' && !retryUsed) {
        retryUsed = true
        // Identical route/time to the interrupted GET still consumes a NEW charge.
        const receipt = await store.reserve({ ...route, at, expectedRevision: store.snapshot().revision })
        transport()
        await send({ ...snapshot('retry-transport-complete'), receipt })
      } else if (command === 'transport' && mode === 'seed' && !retryUsed) {
        retryUsed = true
        transport()
        await send(snapshot('seed-transport-complete'))
      } else throw new Error('Invalid fixture command')
    }).catch(fail)
  })
  if (mode === 'seed') {
    const receipt = await store.reserve({ ...route, at, expectedRevision: 0 })
    // No transport callback runs until the parent explicitly permits it. The test kills here.
    await send({ ...snapshot('reserved-before-transport'), receipt })
  } else await send(snapshot(mode === 'resume' ? 'recovered-before-retry' : 'read-only-replay'))
} catch { await fail() }
