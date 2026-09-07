import { spawn, type ChildProcess } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { enabledPolicy } from '../packages/agent-team/tests/darkfactory/config-fixture.ts'

const entry = pathToFileURL(resolve('packages/agent-team/lib/darkfactory.js')).href
const script = `
import { DarkFactoryPolicyStore } from ${JSON.stringify(entry)};
process.once('message', async ({directory, write, policy}) => {
  let store;
  try {
    store = await DarkFactoryPolicyStore.open(directory, {
      grants: [{projectId:'project',operatorIds:['operator'],authorizationRefs:['host-grant']}],
      effectGrants: [{projectId:'project',effect:'ingress',authorizationRef:'ingress-grant'}],
      implementedEffects:['ingress'],
    }, () => '2026-09-06T12:00:00.000Z');
    if (write) {
      const host = {projectId:'project',operatorId:'operator',authorizationRef:'host-grant'};
      await store.installPolicy({...host,expectedRevision:0,policy});
      await store.recordGate({...host,expectedRevision:1,policyRevision:1,gate:'observe',evidenceRefs:['rollout-evidence']});
      await store.control({...host,expectedRevision:2,action:'pause',reason:'manual'});
      await store.decideEffect({projectId:'project',expectedRevision:3,policyRevision:1,effect:'ingress',effectId:'received-delivery'});
    }
    process.send({kind:'synced',snapshot:store.snapshot()});
    if (!write) {await store.close(); process.disconnect();}
    else process.on('message', () => {});
  } catch(error) {
    await store?.close();
    process.send({kind:'error',message:String(error)});
    process.disconnect();
  }
});`
interface Message { kind: 'synced' | 'error'; snapshot?: unknown; message?: string }
const children: ChildProcess[] = []
const directories: string[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const exit = exited(child); child.kill('SIGKILL'); await exit }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => child.once('exit', () => resolve()))
}
function launch(directory: string, write = false) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.push(child)
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr += String(chunk) })
  const message = new Promise<Message>((resolve, reject) => {
    child.once('message', value => resolve(value as Message))
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`Fixture exited before receipt (${code}): ${stderr}`)))
  })
  child.send({ directory, write, policy: enabledPolicy() })
  return { child, message }
}

it('restores synced policy receipts after SIGKILL and from an exact backup copy in fresh processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-policy-restart-'))
  const backup = await mkdtemp(join(tmpdir(), 'factory-policy-restore-'))
  directories.push(directory, backup)
  const writer = launch(directory, true)
  const barrier = await writer.message
  expect(barrier.kind).toBe('synced')
  expect(barrier.snapshot).toMatchObject([{ revision: 4, pauses: ['manual'], decisions: [{ id: 'decision:4', decision: 'deny', reasons: ['paused:manual'] }] }])
  // The writer has acknowledged fsync; no further writes are scheduled at this barrier.
  const filename = join(directory, 'darkfactory-policy.jsonl')
  const original = await readFile(filename)
  await copyFile(filename, join(backup, 'darkfactory-policy.jsonl'))
  const contender = launch(directory)
  expect((await contender.message).kind).toBe('error')
  await exited(contender.child)
  const killed = exited(writer.child)
  writer.child.kill('SIGKILL')
  await killed
  expect(writer.child.signalCode).toBe('SIGKILL')
  for (const restoredDirectory of [directory, backup]) {
    const reader = launch(restoredDirectory)
    expect(await reader.message).toEqual(barrier)
    await exited(reader.child)
    expect(reader.child.exitCode).toBe(0)
    expect(await readFile(join(restoredDirectory, 'darkfactory-policy.jsonl'))).toEqual(original)
  }
}, 15_000)
