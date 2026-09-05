/** Buffered IPC barriers, crash injection, and awaited process teardown without sleeps. */
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function processFixture(mode: 'seed' | 'seed-repair' | 'seed-report' | 'seed-code-workflow' | 'seed-code-workflow-repair' | 'restore-code-review' | 'restore-code-reject' | 'restore-code-repair-review' | 'restore-repair-crash' | 'restore-repair' | 'seed-dag' | 'seed-paused' | 'restore' | 'restore-execution' | 'restore-worker-crash' | 'restore-worker-recovery' | 'restore-acceptance-crash' | 'restore-promotion-crash' | 'restore-stale-target' | 'restore-ambiguous-promotion' | 'restore-acceptance' | 'restore-dag' | 'restore-report-intent-crash' | 'restore-report-receipt-crash' | 'restore-report' | 'worker' | 'worker-restore' | 'contender' | 'integration-owner', directory: string) {
  const child = fork(fileURLToPath(new URL('../fixtures/restart-team.mjs', import.meta.url)), [mode, directory], {
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, HOME: directory, DSH_HOME: directory, DSH_TELEMETRY_DISABLED: '1' },
  })
  let diagnostics = ''
  child.stdout!.on('data', chunk => { diagnostics += String(chunk) })
  child.stderr!.on('data', chunk => { diagnostics += String(chunk) })
  const messages: unknown[] = []
  let wake: (() => void) | undefined
  let ended = false
  let failure: Error | undefined
  child.on('message', message => { messages.push(message); wake?.() })
  child.on('error', error => { failure = error; wake?.() })
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.on('close', (code, signal) => { ended = true; wake?.(); resolve({ code, signal }) })
  })
  return {
    async barrier<T>(): Promise<T> {
      const deadline = setTimeout(() => { failure = new Error('IPC barrier timed out'); wake?.() }, 10_000)
      try {
        while (!messages.length) {
          if (failure || ended) throw new Error(`${failure?.message ?? 'Process exited before barrier'}\n${diagnostics}`)
          await new Promise<void>(resolve => { wake = resolve })
        }
        return messages.shift() as T
      } finally { clearTimeout(deadline); wake = undefined }
    },
    async stop(crash = false) {
      if (!ended) {
        if (crash) child.kill('SIGKILL')
        else if (child.connected) child.send('stop')
      }
      const deadline = setTimeout(() => { child.kill('SIGKILL') }, 5_000)
      try {
        const result = await closed
        if (crash ? result.signal !== 'SIGKILL' : result.code !== 0) {
          throw new Error(`Unexpected fixture exit ${JSON.stringify(result)}\n${diagnostics}`)
        }
      } finally { clearTimeout(deadline) }
    },
  }
}
