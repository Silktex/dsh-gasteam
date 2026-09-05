/**
 * Read-only preflight for a configured Codex CLI. It proves only the local
 * executable/version/auth-status admission boundary; it never starts a model
 * turn and deliberately does not retain authentication command output.
 */
import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import type { CodexExecutionPolicy, CodexRuntimeConfig } from './codex-runtime.ts'

export interface VerifiedCodexExecutionPolicy extends Omit<CodexExecutionPolicy, 'executable' | 'executableVerification'> {
  readonly executable: string
  readonly configuredExecutable: string
  readonly executableVerification: 'verified'
  readonly authStatus: 'authenticated'
}

export interface CodexAdmission {
  readonly policy: VerifiedCodexExecutionPolicy
}

export interface CodexAdmissionRequest {
  readonly config: CodexRuntimeConfig
  /** The start policy must still be the configured, unverified policy. */
  readonly policy: CodexExecutionPolicy
  readonly maxOutputBytes: number
  readonly timeoutMs: number
}

export interface CodexAdmissionExecutor {
  canonicalExecutable(executable: string): Promise<string>
  version(executable: string, maxBytes: number, timeoutMs: number): Promise<{ exitCode: number | null; text: string; overflowed: boolean; timedOut?: boolean }>
  /** Only exit status and byte bounds escape this probe; never authentication output. */
  authStatus(executable: string, maxBytes: number, timeoutMs: number): Promise<{ exitCode: number | null; overflowed: boolean; outputBytes: number; timedOut?: boolean }>
}

export class CodexAdmissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexAdmissionError'
  }
}

const actualExecutor: CodexAdmissionExecutor = {
  canonicalExecutable: async executable => await realpath(executable),
  version: async (executable, maxBytes, timeoutMs) => {
    const result = await execute(executable, ['--version'], maxBytes, timeoutMs, true)
    return { exitCode: result.exitCode, text: result.text ?? '', overflowed: result.overflowed, ...(result.timedOut ? { timedOut: true } : {}) }
  },
  authStatus: async (executable, maxBytes, timeoutMs) => {
    const result = await execute(executable, ['login', 'status'], maxBytes, timeoutMs, false)
    return { exitCode: result.exitCode, overflowed: result.overflowed, outputBytes: result.outputBytes, ...(result.timedOut ? { timedOut: true } : {}) }
  },
}

/**
 * Rejects configuration/policy disagreement before any command is invoked.
 * Callers must complete this admission before reserving an assignment.
 */
export async function admitCodex(request: CodexAdmissionRequest, executor: CodexAdmissionExecutor = actualExecutor): Promise<CodexAdmission> {
  validate(request)
  const executable = await canonical(executor, request.config.executable)
  const version = await executor.version(executable, request.maxOutputBytes, request.timeoutMs)
  if (version.timedOut) throw new CodexAdmissionError('Codex version probe timed out')
  if (version.overflowed) throw new CodexAdmissionError('Codex version probe exceeded output limit')
  if (version.exitCode !== 0) throw new CodexAdmissionError('Codex version probe failed')
  const observedVersion = parseVersion(version.text)
  if (observedVersion !== request.config.version) throw new CodexAdmissionError('Codex executable version does not match configured policy')
  const auth = await executor.authStatus(executable, request.maxOutputBytes, request.timeoutMs)
  if (auth.timedOut) throw new CodexAdmissionError('Codex authentication status probe timed out')
  if (auth.overflowed || auth.outputBytes > request.maxOutputBytes) throw new CodexAdmissionError('Codex authentication status probe exceeded output limit')
  if (auth.exitCode !== 0) throw new CodexAdmissionError('Codex authentication status probe did not confirm an authenticated session')
  return { policy: {
    executable, configuredExecutable: request.config.executable, version: request.config.version,
    executableVerification: 'verified', cwd: request.policy.cwd, model: request.config.model,
    sandbox: request.config.sandbox, authStatus: 'authenticated',
  } }
}

function validate(request: CodexAdmissionRequest): void {
  if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > 65_536
    || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 30_000) throw new CodexAdmissionError('Invalid Codex admission bounds')
  const { config, policy } = request
  if ([config.executable, config.version, config.model, policy.executable, policy.version, policy.cwd, policy.model].some(value => value.trim() === '')) throw new CodexAdmissionError('Codex admission requires complete configured policy')
  if (policy.executableVerification !== 'configured-unverified'
    || policy.executable !== config.executable || policy.version !== config.version
    || policy.model !== config.model || policy.sandbox !== config.sandbox) {
    throw new CodexAdmissionError('Codex configured policy does not match the durable start policy')
  }
}

async function canonical(executor: CodexAdmissionExecutor, executable: string): Promise<string> {
  try {
    const resolved = await executor.canonicalExecutable(executable)
    if (resolved.trim() === '') throw new Error('empty')
    return resolved
  } catch {
    throw new CodexAdmissionError('Codex executable cannot be canonicalized')
  }
}

function parseVersion(text: string): string {
  // `codex --version` emits the CLI label and exactly one semantic version.
  // Do not accept an unrelated tool banner that merely happens to contain it.
  const match = text.trim().match(/^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/i)
  if (!match) throw new CodexAdmissionError('Codex version probe returned no supported semantic version')
  return match[1]!
}

interface ProbeResult { exitCode: number | null; overflowed: boolean; outputBytes: number; timedOut: boolean; text?: string }

function execute(executable: string, args: readonly string[], maxBytes: number, timeoutMs: number, retainText: boolean): Promise<ProbeResult> {
  return new Promise(resolve => {
    let settled = false
    let outputBytes = 0
    let overflowed = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const chunks: Buffer[] = []
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const detachPipes = () => {
      child.stdout?.removeListener('data', consume)
      child.stderr?.removeListener('data', consume)
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      detachPipes()
      resolve({ exitCode, overflowed, outputBytes, timedOut, ...(retainText ? { text: Buffer.concat(chunks).toString('utf8') } : {}) })
    }
    const consume = (chunk: Buffer) => {
      const remaining = maxBytes - outputBytes
      outputBytes += chunk.byteLength
      if (retainText && remaining > 0) chunks.push(chunk.subarray(0, remaining))
      if (outputBytes > maxBytes && !overflowed) {
        overflowed = true
        try { child.kill('SIGKILL') } finally { finish(null) }
      }
    }
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
    child.once('error', () => finish(null))
    child.once('close', code => finish(code))
    timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } finally { finish(null) }
    }, timeoutMs)
  })
}
