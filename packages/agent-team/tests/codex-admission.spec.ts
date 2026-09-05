import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CodexAdmissionError, admitCodex } from '../src/codex-admission.ts'
import type { CodexExecutionPolicy, CodexRuntimeConfig } from '../src/codex-runtime.ts'

const config: CodexRuntimeConfig = { executable: '/configured/codex', version: '0.153.4', model: 'gpt-5.6-codex', sandbox: 'workspace-write' }
const policy: CodexExecutionPolicy = { executable: '/configured/codex', version: '0.153.4', executableVerification: 'configured-unverified', cwd: process.cwd(), model: 'gpt-5.6-codex', sandbox: 'workspace-write' }

function fixture(overrides: Partial<{ canonicalExecutable: string; version: { exitCode: number | null; text: string; overflowed?: boolean }; auth: { exitCode: number | null; overflowed?: boolean; outputBytes?: number } }> = {}) {
  const calls: Array<{ operation: string; executable: string; maxBytes: number }> = []
  return {
    calls,
    executor: {
      canonicalExecutable: async (executable: string) => overrides.canonicalExecutable ?? `${executable}.real`,
      version: async (executable: string, maxBytes: number) => {
        calls.push({ operation: 'version', executable, maxBytes })
        return { exitCode: overrides.version?.exitCode ?? 0, text: overrides.version?.text ?? 'codex-cli 0.153.4', overflowed: overrides.version?.overflowed ?? false }
      },
      authStatus: async (executable: string, maxBytes: number) => {
        calls.push({ operation: 'auth', executable, maxBytes })
        return { exitCode: overrides.auth?.exitCode ?? 0, overflowed: overrides.auth?.overflowed ?? false, outputBytes: overrides.auth?.outputBytes ?? 17 }
      },
    },
  }
}

it('verifies canonical executable, exact version, and auth status without returning auth output', async () => {
  const probe = fixture()
  const admission = await admitCodex({ config, policy, maxOutputBytes: 128, timeoutMs: 100 }, probe.executor)
  expect(probe.calls).toEqual([
    { operation: 'version', executable: '/configured/codex.real', maxBytes: 128 },
    { operation: 'auth', executable: '/configured/codex.real', maxBytes: 128 },
  ])
  expect(admission).toEqual({
    policy: { executable: '/configured/codex.real', configuredExecutable: '/configured/codex', version: '0.153.4', executableVerification: 'verified', cwd: process.cwd(), model: 'gpt-5.6-codex', sandbox: 'workspace-write', authStatus: 'authenticated' },
  })
  expect(JSON.stringify(admission)).not.toContain('credential')
})

it('rejects configured policy disagreement before probing or reserving work', async () => {
  const probe = fixture()
  await expect(admitCodex({ config, policy: { ...policy, version: '0.153.3' }, maxOutputBytes: 128, timeoutMs: 100 }, probe.executor)).rejects.toThrow(/policy/i)
  expect(probe.calls).toEqual([])
})

it('rejects version/auth failures and bounded-output overflow without retaining status text', async () => {
  await expect(admitCodex({ config, policy, maxOutputBytes: 128, timeoutMs: 100 }, fixture({ version: { exitCode: 0, text: 'codex-cli 0.153.3' } }).executor)).rejects.toThrow(/version/i)
  await expect(admitCodex({ config, policy, maxOutputBytes: 128, timeoutMs: 100 }, fixture({ version: { exitCode: 0, text: 'unrelated-tool 0.153.4' } }).executor)).rejects.toThrow(/semantic version/i)
  await expect(admitCodex({ config, policy, maxOutputBytes: 128, timeoutMs: 100 }, fixture({ auth: { exitCode: 1, outputBytes: 12 } }).executor)).rejects.toThrow(CodexAdmissionError)
  await expect(admitCodex({ config, policy, maxOutputBytes: 128, timeoutMs: 100 }, fixture({ auth: { exitCode: 0, overflowed: true, outputBytes: 129 } }).executor)).rejects.toThrow(/output limit/i)
})

it('returns at its timeout when a killed probe leader leaves an inherited pipe open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gasteam-codex-admission-pipe-'))
  const pidFile = join(root, 'descendant.pid')
  const readyFile = join(root, 'ready')
  const exitFile = join(root, 'exited')
  const prior = process.env.CODEX_ADMISSION_FIXTURE_PID_FILE
  const priorReady = process.env.CODEX_ADMISSION_FIXTURE_READY_FILE
  const priorExit = process.env.CODEX_ADMISSION_FIXTURE_EXIT_FILE
  process.env.CODEX_ADMISSION_FIXTURE_PID_FILE = pidFile
  process.env.CODEX_ADMISSION_FIXTURE_READY_FILE = readyFile
  process.env.CODEX_ADMISSION_FIXTURE_EXIT_FILE = exitFile
  const executable = resolve('packages/agent-team/tests/fixtures/codex-admission-inherited-pipe.mjs')
  const pipedConfig = { ...config, executable }
  const pipedPolicy = { ...policy, executable }
  try {
    await expect(admitCodex({ config: pipedConfig, policy: pipedPolicy, maxOutputBytes: 128, timeoutMs: 100 })).rejects.toThrow(/timed out/i)
    await waitForFile(readyFile)
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).not.toThrow()
    await waitForFile(exitFile)
  } finally {
    if (prior === undefined) delete process.env.CODEX_ADMISSION_FIXTURE_PID_FILE
    else process.env.CODEX_ADMISSION_FIXTURE_PID_FILE = prior
    if (priorReady === undefined) delete process.env.CODEX_ADMISSION_FIXTURE_READY_FILE
    else process.env.CODEX_ADMISSION_FIXTURE_READY_FILE = priorReady
    if (priorExit === undefined) delete process.env.CODEX_ADMISSION_FIXTURE_EXIT_FILE
    else process.env.CODEX_ADMISSION_FIXTURE_EXIT_FILE = priorExit
    // The fixture-owned descendant self-terminates. No persisted PID is ever signalled.
    await rm(root, { recursive: true, force: true })
  }
})

it.runIf(Boolean(process.env.GASTEAM_CODEX_ADMISSION_EXECUTABLE))('uses read-only installed CLI version and login-status probes without a model call', async () => {
  const executable = process.env.GASTEAM_CODEX_ADMISSION_EXECUTABLE!
  const actual = { ...config, executable }
  const actualPolicy = { ...policy, executable }
  const admission = await admitCodex({ config: actual, policy: actualPolicy, maxOutputBytes: 4_096, timeoutMs: 5_000 })
  expect(admission.policy).toMatchObject({ executableVerification: 'verified', version: '0.153.4', authStatus: 'authenticated' })
})

async function waitForFile(filename: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (await readFile(filename, 'utf8').catch(() => undefined) !== undefined) return
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
  throw new Error(`Timed out waiting for fixture barrier ${filename}`)
}
