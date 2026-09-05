import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { durableLink, ExternalRuntimeSupervisor, ExternalRuntimeSupervisorClient, ExternalRuntimeSupervisorObserver, inspectProcessIdentity, probePidNamespaceContainment, processBirthIdentity, readSupervisorIdentity, requestExternalSupervisorCancellation } from '../src/external-runtime-supervisor.ts'
import { acquireFileOwnership } from '../src/file-ownership.ts'

const fsyncEvents = vi.hoisted((): string[] => [])
vi.mock('node:fs/promises', async importOriginal => {
  const filesystem = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...filesystem,
    link: async (...args: Parameters<typeof filesystem.link>) => {
      fsyncEvents.push(`link:${String(args[1])}`)
      return await filesystem.link(...args)
    },
    open: async (...args: Parameters<typeof filesystem.open>) => {
      const handle = await filesystem.open(...args)
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        fsyncEvents.push(`sync:${String(args[0])}`)
        await sync()
      }
      return handle
    },
  }
})

const roots: string[] = []
const live: Array<{ pid: number }> = []

afterEach(async () => {
  for (const process of live.splice(0)) {
    try { process.kill(process.pid, 'SIGKILL') } catch { /* already stopped */ }
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function request(directory: string, mode: string, overrides: Partial<{ maxSpoolBytes: number; terminateGraceMs: number }> = {}) {
  return {
    attemptId: 'attempt-a', generation: 1, directory, command: process.execPath,
    args: [resolve('packages/agent-team/tests/fixtures/external-runtime-fixture.mjs'), mode], cwd: process.cwd(), stdin: '{"instruction":"fixture"}\n',
    maxSpoolBytes: overrides.maxSpoolBytes ?? 65_536, terminateGraceMs: overrides.terminateGraceMs ?? 100, containment: 'pid-namespace' as const,
  }
}

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'gasteam-external-supervisor-'))
  roots.push(root)
  return root
}

it('uses Linux process birth identity rather than a bare PID', async () => {
  const identity = await processBirthIdentity(process.pid)
  expect(await inspectProcessIdentity(identity)).toBe('owned')
  expect(await inspectProcessIdentity({ ...identity, birthId: `${identity.birthId}0` })).toBe('mismatch')
})

it('reports the independently probed PID-namespace containment capability without assuming it', async () => {
  await expect(probePidNamespaceContainment()).resolves.toEqual({ supported: true })
})

it('requires strict PID namespace containment before creating a target', async () => {
  const root = await directory()
  const unsafe = await request(root, 'silent')
  await expect(new ExternalRuntimeSupervisor().launch({ ...unsafe, containment: 'process-group' as never })).rejects.toThrow(/invalid external supervisor request/i)
  expect(await readSupervisorIdentity(root)).toBeUndefined()
})

it('fsyncs the parent directory after a successful hard-link claim', async () => {
  const root = await directory()
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await writeFile(source, 'claim')
  fsyncEvents.splice(0)
  await durableLink(source, destination)
  expect(fsyncEvents).toEqual([`link:${destination}`, `sync:${root}`])
})

it('keeps a child-inherited lifetime lock after the actual supervisor is SIGKILLed', async () => {
  const root = await directory()
  const requestFile = join(root, 'request.json')
  await writeFile(requestFile, JSON.stringify({ request: await request(root, 'linger') }))
  const supervisor = spawn(process.execPath, ['--import', 'tsx', resolve('packages/agent-team/src/external-runtime-supervisor.ts'), '--request', requestFile], { detached: true, stdio: 'ignore' })
  await waitFor(async () => (await readSupervisorIdentity(root))?.process !== undefined)
  const identity = (await readSupervisorIdentity(root))!.process!
  live.push({ pid: identity.pid })
  supervisor.kill('SIGKILL')
  await once(supervisor, 'exit')
  const lock = await open(join(root, 'lifetime.lock'), 'a+')
  await expect(acquireFileOwnership(lock)).rejects.toThrow(/already owned/i)
  await lock.close()
  expect(await inspectProcessIdentity(identity)).toBe('owned')
  expect(await new ExternalRuntimeSupervisorObserver().observe(root)).toMatchObject({ state: 'uncertain', reason: expect.stringContaining('wrapper remains live') })
  await waitFor(async () => (await new ExternalRuntimeSupervisorObserver().observe(root)).state === 'stopped')
  live.splice(live.findIndex(item => item.pid === identity.pid), 1)
})

it('keeps the detached helper and its target alive when the launcher client is SIGKILLed', async () => {
  const root = await directory()
  const requestFile = join(root, 'request.json')
  await writeFile(requestFile, JSON.stringify({ request: await request(root, 'linger') }))
  const client = spawn(process.execPath, ['--import', 'tsx', resolve('packages/agent-team/src/external-runtime-supervisor.ts'), '--launch-helper', '--request', requestFile], { detached: true, stdio: 'ignore' })
  await waitFor(async () => (await readSupervisorIdentity(root))?.process !== undefined)
  const identity = (await readSupervisorIdentity(root))!.process!
  live.push({ pid: identity.pid })
  client.kill('SIGKILL')
  await new Promise(resolveWait => setTimeout(resolveWait, 50))
  expect(await inspectProcessIdentity(identity)).toBe('owned')
  const lock = await open(join(root, 'lifetime.lock'), 'a+')
  await expect(acquireFileOwnership(lock)).rejects.toThrow(/already owned/i)
  await lock.close()
  await waitFor(async () => (await new ExternalRuntimeSupervisorObserver().observe(root)).state === 'stopped')
  live.splice(live.findIndex(item => item.pid === identity.pid), 1)
})

it('tears down a PID namespace after spool overflow and leaves a host-wrapper receipt for a read-only observer', async () => {
  const root = await directory()
  const requestFile = join(root, 'request.json')
  await writeFile(requestFile, JSON.stringify({ request: await request(root, 'overflow-storm', { maxSpoolBytes: 128, terminateGraceMs: 50 }) }))
  const helper = spawn(process.execPath, ['--import', 'tsx', resolve('packages/agent-team/src/external-runtime-supervisor.ts'), '--request', requestFile], { detached: true, stdio: 'ignore' })
  const exited = once(helper, 'exit')
  await waitFor(async () => (await readSupervisorIdentity(root))?.process !== undefined)
  const identity = await readSupervisorIdentity(root)
  expect(identity?.containment).toEqual({ kind: 'pid-namespace', innerInitPid: 1 })
  await exited
  const proof = JSON.parse(await readFile(join(root, 'stop-proof.json'), 'utf8'))
  expect(proof).toMatchObject({ containment: 'pid-namespace', hostWrapper: identity?.process, innerInitPid: 1, signals: expect.arrayContaining(['SIGTERM']), spool: { stdout: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } } })
  // A stop proof is final only after the ChildProcess close event has drained
  // its pipes; exit alone must not certify the spool.
  expect(proof.exit).toBeDefined()
  expect(proof.spool.stdout.bytes + proof.spool.stderr.bytes).toBeLessThanOrEqual(128 + 1_024)
  expect(await new ExternalRuntimeSupervisorObserver().observe(root)).toEqual({ state: 'stopped' })
})

it('consumes a durable cancellation request only through the live helper handle', async () => {
  const root = await directory()
  const requestFile = join(root, 'request.json')
  await writeFile(requestFile, JSON.stringify({ request: await request(root, 'silent', { terminateGraceMs: 50 }) }))
  const helper = spawn(process.execPath, ['--import', 'tsx', resolve('packages/agent-team/src/external-runtime-supervisor.ts'), '--request', requestFile], { detached: true, stdio: 'ignore' })
  const exited = once(helper, 'exit')
  await waitFor(async () => (await readSupervisorIdentity(root))?.process !== undefined)
  await requestExternalSupervisorCancellation(root, 'attempt-a', 1, 'operator requested cancellation')
  await exited
  expect(JSON.parse(await readFile(join(root, 'stop-proof.json'), 'utf8'))).toMatchObject({ signals: expect.arrayContaining(['SIGTERM']), containment: 'pid-namespace' })
  expect(await new ExternalRuntimeSupervisorObserver().observe(root)).toEqual({ state: 'stopped' })
})

it('kills a setsid-escaped descendant when the namespace wrapper is cancelled', async () => {
  const root = await directory()
  const requestFile = join(root, 'request.json')
  await writeFile(requestFile, JSON.stringify({ request: await request(root, 'namespace-escape', { maxSpoolBytes: 128, terminateGraceMs: 250 }) }))
  const helper = spawn(process.execPath, ['--import', 'tsx', resolve('packages/agent-team/src/external-runtime-supervisor.ts'), '--request', requestFile], { detached: true, stdio: 'ignore' })
  const exited = once(helper, 'exit')
  await waitFor(async () => (await readSupervisorIdentity(root))?.process !== undefined)
  const wrapper = (await readSupervisorIdentity(root))!.process!
  let escaped: Array<{ pid: number; birthId: string }> = []
  await waitFor(async () => {
    escaped = await Promise.all((await descendants(wrapper.pid)).map(async pid => await processBirthIdentity(pid).catch(() => undefined))).then(items => items.filter((item): item is { pid: number; birthId: string } => item !== undefined))
    return escaped.length >= 2
  })
  await exited
  await waitFor(async () => (await Promise.all(escaped.map(identity => inspectProcessIdentity(identity)))).every(state => state === 'missing'))
  expect(await new ExternalRuntimeSupervisorObserver().observe(root)).toEqual({ state: 'stopped' })
})

it('makes a helper launch manifest immutable across altered replays', async () => {
  const root = await directory()
  const client = new ExternalRuntimeSupervisorClient({ executable: process.execPath, helperArgs: ['--import', 'tsx', resolve('packages/agent-team/src/external-runtime-supervisor.ts')] })
  const first = await request(root, 'linger')
  await client.launch(first)
  await waitFor(async () => (await readSupervisorIdentity(root))?.process !== undefined)
  const identity = (await readSupervisorIdentity(root))!.process!
  live.push({ pid: identity.pid })
  await expect(client.launch({ ...first, args: [...first.args, 'changed'] })).rejects.toThrow(/immutable/i)
  await waitFor(async () => (await new ExternalRuntimeSupervisorObserver().observe(root)).state === 'stopped')
  live.splice(live.findIndex(item => item.pid === identity.pid), 1)
})

it('executes an identical concurrent or completed replay only once', async () => {
  const root = await directory()
  const counter = join(root, 'target-starts.log')
  const client = new ExternalRuntimeSupervisorClient({ executable: process.execPath, helperArgs: ['--import', 'tsx', resolve('packages/agent-team/src/external-runtime-supervisor.ts')] })
  const first = await request(root, 'side-effect')
  const exact = { ...first, args: [...first.args, counter] }
  const launches = await Promise.all([client.launch(exact), client.launch({ ...exact, args: [...exact.args] })])
  expect(launches).toHaveLength(2)
  await waitFor(async () => (await readFile(counter, 'utf8').catch(() => '')).split('\n').filter(Boolean).length === 1)
  const observer = new ExternalRuntimeSupervisorObserver()
  await waitFor(async () => (await observer.observe(root)).state === 'stopped')
  await expect(client.launch({ ...exact, args: [...exact.args] })).resolves.toEqual({ supervisorPid: launches[0]!.supervisorPid })
  expect((await readFile(counter, 'utf8')).split('\n').filter(Boolean)).toEqual(['target-started'])
})

it('refuses a direct helper re-execution after its under-lock target claim', async () => {
  const root = await directory()
  const counter = join(root, 'direct-target-starts.log')
  const base = await request(root, 'side-effect')
  const exact = { ...base, args: [...base.args, counter] }
  await new ExternalRuntimeSupervisor().launch(exact).then(process => process.finished)
  await expect(new ExternalRuntimeSupervisor().launch({ ...exact, args: [...exact.args] })).rejects.toThrow(/already claimed; preserve capacity/i)
  expect((await readFile(counter, 'utf8')).split('\n').filter(Boolean)).toEqual(['target-started'])
})

async function waitFor(condition: () => Promise<boolean>, timeout = 3_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for fixture')
}

async function descendants(root: number): Promise<number[]> {
  const entries = await (await import('node:fs/promises')).readdir('/proc', { withFileTypes: true })
  const parents = new Map<number, number[]>()
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue
    try {
      const line = await readFile(`/proc/${entry.name}/stat`, 'utf8')
      const fields = line.slice(line.lastIndexOf(')') + 1).trim().split(/\s+/)
      const parent = Number(fields[1])
      const pid = Number(entry.name)
      const children = parents.get(parent) ?? []
      children.push(pid)
      parents.set(parent, children)
    } catch { /* process exited during inspection */ }
  }
  const result: number[] = []
  const queue = [...(parents.get(root) ?? [])]
  while (queue.length > 0) {
    const pid = queue.shift()!
    result.push(pid)
    queue.push(...(parents.get(pid) ?? []))
  }
  return result
}
