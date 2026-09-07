import { expect, it } from 'vitest'
import { fork } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { enabledPolicy } from '../packages/agent-team/tests/darkfactory/config-fixture.ts'

const secret = 'isolated-observer-process-secret'
interface Listening { barrier: 'listening'; pid: number; status: { port: number; mode: string }; coordinatorId: string }
interface Snapshot {
  barrier: 'durable-snapshot'; inbox: Array<{ id: string; source: string; reason: string; revision: number; acknowledgement?: { actor: string } }>
  taskEvents: number; tasks: unknown[]; attempts: unknown[]; workflows: unknown[]; readyTasks: unknown[]
  ingress: Array<{ type: string; receipt: { id: string; decision: string }; duplicate: boolean; healthEscalationId?: string }>; healthEventTypes: string[]
}
function observerProcess(mode: 'seed' | 'restore', directory: string) {
  const child = fork(fileURLToPath(new URL('./fixtures/darkfactory-observer.mjs', import.meta.url)), [mode, directory], {
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? '/var/tmp', HOME: directory, DSH_HOME: directory, DSH_TELEMETRY_DISABLED: '1', DF_TEST_SECRET: secret },
  })
  let diagnostics = '', ended = false, failure: Error | undefined, wake: (() => void) | undefined
  const messages: unknown[] = []
  child.stdout!.on('data', bytes => { diagnostics = (diagnostics + String(bytes)).slice(-65_536) })
  child.stderr!.on('data', bytes => { diagnostics = (diagnostics + String(bytes)).slice(-65_536) })
  child.on('message', value => { messages.push(value); wake?.() })
  child.on('error', error => { failure = error; wake?.() })
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => child.on('close', (code, signal) => { ended = true; wake?.(); resolve({ code, signal }) }))
  return {
    async barrier<T>(): Promise<T> {
      const timeout = setTimeout(() => { failure = new Error('Observer IPC deadline exceeded'); wake?.() }, 10_000)
      try {
        while (!messages.length) {
          if (failure || ended) throw new Error(`${failure?.message ?? 'Observer process exited'}\n${diagnostics}`)
          await new Promise<void>(resolve => { wake = resolve })
        }
        return messages.shift() as T
      } finally { clearTimeout(timeout); wake = undefined }
    },
    async send(message: 'snapshot' | 'acknowledge') { await new Promise<void>((resolve, reject) => child.send(message, error => error ? reject(error) : resolve())) },
    async stop(crash = false) {
      if (!ended) { if (crash) child.kill('SIGKILL'); else if (child.connected) child.send('stop') }
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
      try {
        const result = await closed
        if (crash ? result.signal !== 'SIGKILL' : result.code !== 0) throw new Error(`Unexpected observer exit ${JSON.stringify(result)}\n${diagnostics}`)
      } finally { clearTimeout(timeout) }
    },
  }
}
async function persistedText(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? persistedText(join(directory, entry.name)) : readFile(join(directory, entry.name), 'utf8')))).join('\n')
}
function assertNoAdmission(snapshot: Snapshot) {
  expect(snapshot).toMatchObject({ barrier: 'durable-snapshot', taskEvents: 0, tasks: [], attempts: [], workflows: [], readyTasks: [] })
}
it('preserves built DSH observer custody and the existing operator inbox across SIGKILL without admitting work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-observer-restart-'))
  const processes: ReturnType<typeof observerProcess>[] = []
  try {
    const repository = join(directory, 'repository')
    await mkdir(repository)
    const git = (...args: string[]) => execa('git', args, { cwd: repository })
    await git('init', '--initial-branch=main')
    await git('config', 'user.name', 'Observer fixture'); await git('config', 'user.email', 'observer@example.invalid'); await git('config', 'commit.gpgsign', 'false')
    await writeFile(join(repository, 'initial.txt'), 'fixture\n')
    await git('add', 'initial.txt'); await git('commit', '-m', 'fixture')
    const policy = enabledPolicy()
    policy.ingestion.transport = { kind: 'listener', host: '127.0.0.1', port: 0 }
    await writeFile(join(directory, 'policy.json'), JSON.stringify(policy))
    const body = JSON.stringify({ action: 'opened', repository: { id: 'repository', full_name: 'example/service' }, sender: { id: 'sender' }, installation: { id: 10 },
      issue: { id: 42, number: 1, title: 'Observed issue', body: 'narrative-secret-must-not-persist', user: { id: 'sender' }, labels: [{ name: 'automate' }], state: 'open', updated_at: '2026-09-06T11:00:00Z' } })
    const post = async (port: number, payload: string, delivery: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/darkfactory/v1/ingress/github/route`, { method: 'POST', body: payload, signal: AbortSignal.timeout(5000), headers: {
        'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': delivery,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`,
      } })
      return { status: response.status, body: await response.json() as { receipt: { id: string; decision: string } } }
    }
    const initial = observerProcess('seed', directory); processes.push(initial)
    const listening = await initial.barrier<Listening>()
    expect(listening.status.mode).toBe('observe')
    const received = await post(listening.status.port, body, 'delivery-1')
    expect(received).toMatchObject({ status: 202, body: { receipt: { decision: 'received' } } })
    const quarantine = await post(listening.status.port, '{', 'malformed-1')
    expect(quarantine).toMatchObject({ status: 202, body: { receipt: { decision: 'quarantined' } } })
    await initial.send('acknowledge')
    const committed = await initial.barrier<Snapshot>()
    assertNoAdmission(committed)
    expect(committed.ingress.map(event => event.receipt.id)).toEqual([received.body.receipt.id, quarantine.body.receipt.id])
    expect(committed.inbox).toHaveLength(1)
    expect(committed.inbox[0]).toMatchObject({ source: 'darkfactory', reason: 'PAYLOAD_INVALID', acknowledgement: { actor: 'observer-restart-lead' } })
    expect(committed.ingress[1]!.healthEscalationId).toBe(committed.inbox[0]!.id)
    expect(committed.healthEventTypes).toContain('health/factory-escalated')
    // IPC follows direct journal reads and awaited inbox acknowledgement; crash only after that barrier.
    await initial.stop(true); processes.pop()
    const restored = observerProcess('restore', directory); processes.push(restored)
    const restarted = await restored.barrier<Listening>()
    expect(restarted.pid).not.toBe(listening.pid)
    expect(restarted.coordinatorId).toBe(listening.coordinatorId)
    await restored.send('snapshot')
    const replayed = await restored.barrier<Snapshot>()
    assertNoAdmission(replayed)
    expect(replayed.inbox).toEqual(committed.inbox)
    expect(replayed.ingress).toEqual(committed.ingress)
    expect(await post(restarted.status.port, body, 'delivery-new-id')).toEqual({ status: 200, body: expect.objectContaining({ receipt: received.body.receipt }) })
    expect(await post(restarted.status.port, '{', 'malformed-new-id')).toEqual({ status: 200, body: expect.objectContaining({ receipt: quarantine.body.receipt }) })
    await restored.send('snapshot')
    const duplicate = await restored.barrier<Snapshot>()
    assertNoAdmission(duplicate)
    expect(duplicate.inbox).toEqual(committed.inbox)
    expect(duplicate.ingress.slice(2).map(event => ({ id: event.receipt.id, duplicate: event.duplicate }))).toEqual([{ id: received.body.receipt.id, duplicate: true }, { id: quarantine.body.receipt.id, duplicate: true }])
    const persisted = await persistedText(join(directory, 'workspace'))
    expect(persisted).not.toContain('narrative-secret-must-not-persist')
    expect(persisted).not.toContain(secret)
  } finally {
    try { for (const child of processes.reverse()) await child.stop() } finally { await rm(directory, { recursive: true, force: true }) }
  }
}, 30_000)
