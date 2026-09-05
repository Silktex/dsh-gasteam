import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compiledExternalRuntimeSupervisorClient, ExternalRuntimeSupervisorObserver, readSupervisorIdentity } from '../../lib/external-runtime-supervisor.js'

const root = await mkdtemp(join(tmpdir(), 'gasteam-m9-namespace-evidence-'))
const fixture = resolve(process.argv[2] ?? '')
const request = {
  attemptId: 'namespace-evidence', generation: 1, directory: root,
  args: [fixture, 'namespace-escape'], command: process.execPath, cwd: process.cwd(), stdin: '{"instruction":"namespace fixture"}\n', maxSpoolBytes: 128, terminateGraceMs: 250, containment: 'pid-namespace',
}
await compiledExternalRuntimeSupervisorClient().launch(request)
const observer = new ExternalRuntimeSupervisorObserver()
const deadline = Date.now() + 3_000
let state
while (Date.now() < deadline) {
  state = await observer.observe(root)
  if (state.state === 'stopped') break
  await new Promise(resolveWait => setTimeout(resolveWait, 25))
}
const identity = await readSupervisorIdentity(root)
const stdout = await stat(join(root, 'stdout.log')).catch(() => ({ size: 0 }))
const stderr = await stat(join(root, 'stderr.log')).catch(() => ({ size: 0 }))
const proof = JSON.parse(await readFile(join(root, 'stop-proof.json'), 'utf8'))
if (state?.state !== 'stopped' || proof.exit === undefined || proof.spool === undefined) throw new Error(`namespace helper did not produce final stop proof: ${JSON.stringify({ state, proof })}`)
if (proof.spool.stdout.bytes !== stdout.size || proof.spool.stderr.bytes !== stderr.size) throw new Error('final spool proof does not match retained artifacts')
console.log(JSON.stringify({ version: 1, containment: 'pid-namespace', hostWrapper: identity?.process, helper: identity?.supervisor, innerInitPid: identity?.containment?.innerInitPid, phase: state.state, spoolBytes: { stdout: stdout.size, stderr: stderr.size }, stopProof: { signals: proof.signals, exit: proof.exit, spool: proof.spool } }))
