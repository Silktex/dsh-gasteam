import { fork } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { ProviderRequestReceipt, ProviderRequestState } from '../packages/agent-team/src/darkfactory/provider-request-store.ts'

const token = 'private-provider-budget-process-token'
interface Snapshot {
  barrier: string; pid: number; state: ProviderRequestState; receipt?: ProviderRequestReceipt
  availability: { available: number; nextAttemptAt?: string }; transportCalls: number
}
function launch(mode: 'seed' | 'resume' | 'replay', directory: string) {
  const child = fork(fileURLToPath(new URL('./fixtures/darkfactory-provider-budget.mjs', import.meta.url)), [mode, directory], {
    execPath: process.execPath, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? '/var/tmp', PROVIDER_BUDGET_FIXTURE_TOKEN: token },
  })
  const messages: unknown[] = []
  let diagnostics = '', ended = false, failure: Error | undefined, wake: (() => void) | undefined
  child.stderr!.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4096) })
  child.on('message', value => { messages.push(value); wake?.() })
  child.on('error', error => { failure = error; wake?.() })
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('close', (code, signal) => { ended = true; wake?.(); resolve({ code, signal }) }))
  return {
    async barrier(): Promise<Snapshot> {
      const timeout = setTimeout(() => { failure = new Error('Provider budget IPC deadline exceeded'); wake?.() }, 10_000)
      try {
        while (!messages.length) {
          if (failure || ended) throw new Error(`${failure?.message ?? 'Fixture exited before barrier'}: ${diagnostics}`)
          await new Promise<void>(resolve => { wake = resolve })
        }
        const value = messages.shift() as Snapshot & { message?: string }
        if (value.barrier === 'error') throw new Error(value.message)
        return value
      } finally { clearTimeout(timeout); wake = undefined }
    },
    async send(command: 'retry' | 'stop') { await new Promise<void>((resolve, reject) => child.send(command, error => error ? reject(error) : resolve())) },
    async stop(crash = false) {
      if (!ended) { if (crash) child.kill('SIGKILL'); else if (child.connected) child.send('stop') }
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
      try { return await closed } finally { clearTimeout(timeout) }
    },
  }
}

it('retains a built SDK charge after SIGKILL before transport, charges retry anew, and replays without appending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-provider-budget-restart-')), children: ReturnType<typeof launch>[] = []
  try {
    const filename = join(directory, 'darkfactory-provider-requests.jsonl')
    const writer = launch('seed', directory); children.push(writer)
    const first = await writer.barrier()
    expect(first).toMatchObject({ barrier: 'reserved-before-transport', transportCalls: 0, availability: { available: 1 }, state: { revision: 1 } })
    expect(first.state.charges).toEqual([first.receipt])
    const original = await readFile(filename)
    expect(JSON.parse(original.toString('utf8')).receiptId).toBe(first.receipt!.id)
    expect(await writer.stop(true)).toEqual({ code: null, signal: 'SIGKILL' })

    const retry = launch('resume', directory); children.push(retry)
    const recovered = await retry.barrier()
    expect(recovered.pid).not.toBe(first.pid)
    expect(recovered).toMatchObject({ barrier: 'recovered-before-retry', state: first.state, availability: { available: 1 }, transportCalls: 0 })
    expect(await readFile(filename)).toEqual(original)
    await retry.send('retry')
    const second = await retry.barrier()
    expect(second).toMatchObject({ barrier: 'retry-transport-complete', transportCalls: 1, state: { revision: 2 }, availability: { available: 0, nextAttemptAt: '2026-09-06T12:01:00.000Z' } })
    expect(second.receipt!.id).not.toBe(first.receipt!.id)
    expect(second.state.charges).toEqual([first.receipt, second.receipt])
    expect(second.receipt).toMatchObject({ projectId: first.receipt!.projectId, routeId: first.receipt!.routeId, at: first.receipt!.at })
    expect(await retry.stop()).toEqual({ code: 0, signal: null })
    const acknowledged = await readFile(filename)
    expect(acknowledged.subarray(0, original.length)).toEqual(original)
    expect(acknowledged.toString('utf8').trim().split('\n')).toHaveLength(2)
    expect(acknowledged.toString('utf8')).not.toContain(token)

    const reader = launch('replay', directory); children.push(reader)
    const replay = await reader.barrier()
    expect([first.pid, second.pid]).not.toContain(replay.pid)
    expect(replay).toMatchObject({ barrier: 'read-only-replay', state: second.state, availability: second.availability, transportCalls: 0 })
    expect(await reader.stop()).toEqual({ code: 0, signal: null })
    expect(await readFile(filename)).toEqual(acknowledged)
  } finally {
    await Promise.all(children.map(child => child.stop(true)))
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
