import { realpath } from 'node:fs/promises'
import type { RuntimeCapability, RuntimeLaunch, RuntimeProvider, RuntimeProviderCapabilities, RuntimeResumeRequest, RuntimeStartRequest } from './runtime-provider.ts'

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface CodexRuntimeConfig {
  executable: string
  version: string
  model: string
  sandbox: CodexSandbox
}

export interface CodexExecutionPolicy {
  executable: string
  version: string
  /** This planner records configured strings; admission wiring must verify the binary. */
  executableVerification: 'configured-unverified'
  cwd: string
  model: string
  sandbox: CodexSandbox
}
export interface CodexResumeRequest extends RuntimeResumeRequest { priorPolicy: CodexExecutionPolicy }

export type CodexJsonEvent =
  | { type: 'thread.started'; threadId: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: 'turn.failed'; message: string }
  | { type: 'item'; eventType: 'item.started' | 'item.updated' | 'item.completed' }
  | { type: 'error'; message: string }

/**
 * Codex CLI 0.153.4 adapter. It deliberately sends only a structured prompt line;
 * stdout is the CLI's JSONL event stream and is supervised separately.
 */
export class CodexRuntime implements RuntimeProvider {
  readonly id = 'codex-cli'
  readonly capabilities: RuntimeProviderCapabilities = {
    start: { supported: true, conditions: ['canonical cwd', 'pinned model', 'explicit sandbox', 'configured executable/version; binary verification is deferred to admission wiring'] },
    resume: { supported: true, conditions: ['exact durable thread id', 'positive quiescent receipt'] },
    status: { supported: true, conditions: ['owned process identity or durable spool'] },
    cancel: { supported: true, conditions: ['live namespace wrapper handle and strict PID-namespace containment'] },
    message: { supported: false, reason: 'Codex exec JSONL has no documented active-turn message protocol' },
    usage: { supported: true, conditions: ['only provider-reported usage events are attributed'] },
    artifacts: { supported: false, reason: 'Codex exec JSONL exposes no documented artifact submission protocol' },
  }

  constructor(private readonly config: CodexRuntimeConfig) {
    if (config.executable.trim() === '' || config.version.trim() === '' || config.model.trim() === '') throw new Error('Codex executable, version, and model are required')
  }

  async start(request: RuntimeStartRequest): Promise<RuntimeLaunch> {
    const cwd = await canonicalDirectory(request.cwd)
    return {
      argv: [this.config.executable, 'exec', '--json', '--config', 'approval_policy="never"', '--cd', cwd, '--model', this.config.model, '--sandbox', this.config.sandbox, '-'],
      stdin: `${JSON.stringify(request.prompt)}\n`,
      runtimeIdentity: { provider: this.id, kind: 'new', attemptId: request.attemptId, generation: request.generation, ...this.policy(cwd) },
    }
  }

  async resume(request: CodexResumeRequest): Promise<RuntimeLaunch> {
    if (request.threadId.trim() === '') throw new Error('Codex resume requires an exact durable thread id')
    if (request.quiescentReceipt === undefined || request.quiescentReceipt.trim() === '') {
      throw new Error('Codex resume requires a positive quiescent receipt for the previous turn')
    }
    const cwd = await canonicalDirectory(request.cwd)
    if (!samePolicy(request.priorPolicy, this.policy(cwd))) throw new Error('Codex resume policy does not match the pinned start policy')
    // CLI 0.153.4 accepts an exact ID here. It has no --cwd/--sandbox resume flags;
    // the original start pins those values and this method never falls back to --last.
    return {
      argv: [this.config.executable, 'exec', 'resume', request.threadId, '-', '--json', '--config', 'approval_policy="never"', '--model', this.config.model],
      stdin: `${JSON.stringify(request.prompt)}\n`,
      runtimeIdentity: { provider: this.id, kind: 'resume', attemptId: request.attemptId, generation: request.generation, threadId: request.threadId, quiescentReceipt: request.quiescentReceipt, ...this.policy(cwd) },
    }
  }

  private policy(cwd: string): CodexExecutionPolicy {
    // This planner does not execute or inspect the configured binary. Runtime
    // admission must verify its canonical path and version before launching.
    return { executable: this.config.executable, version: this.config.version, executableVerification: 'configured-unverified', cwd, model: this.config.model, sandbox: this.config.sandbox }
  }
}

async function canonicalDirectory(cwd: string): Promise<string> {
  if (cwd.trim() === '') throw new Error('Codex cwd is required')
  return await realpath(cwd)
}

/** Parse only bounded, known events. Unknown protocol records stay durable raw evidence. */
export function parseCodexJsonLine(line: string, limit: number): CodexJsonEvent {
  if (!Number.isSafeInteger(limit) || limit <= 0 || Buffer.byteLength(line) > limit) throw new Error('Codex JSONL record exceeds the configured limit')
  let value: unknown
  try { value = JSON.parse(line) } catch { throw new Error('Invalid Codex JSONL record') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Codex JSONL record')
  const event = value as Record<string, unknown>
  if (event.type === 'thread.started') {
    if (typeof event.thread_id !== 'string' || event.thread_id === '') throw new Error('Codex thread.started event requires a thread_id')
    return { type: 'thread.started', threadId: event.thread_id }
  }
  if (event.type === 'turn.started') return { type: 'turn.started' }
  if (event.type === 'turn.completed') {
    const usage = usageOf(event.usage)
    return usage === undefined ? { type: 'turn.completed' } : { type: 'turn.completed', usage }
  }
  if (event.type === 'turn.failed') return { type: 'turn.failed', message: eventMessage(event, limit) }
  if (event.type === 'error') return { type: 'error', message: eventMessage(event, limit) }
  if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') return { type: 'item', eventType: event.type }
  throw new Error('Unsupported or incomplete Codex JSONL event')
}

function samePolicy(left: CodexExecutionPolicy, right: CodexExecutionPolicy): boolean {
  return left.executable === right.executable && left.version === right.version && left.executableVerification === right.executableVerification && left.cwd === right.cwd && left.model === right.model && left.sandbox === right.sandbox
}

function eventMessage(event: Record<string, unknown>, limit: number): string {
  if (typeof event.message === 'string' && event.message.trim() !== '') return bounded(event.message, limit)
  if (typeof event.error === 'object' && event.error !== null && typeof (event.error as Record<string, unknown>).message === 'string') return bounded((event.error as Record<string, unknown>).message as string, limit)
  throw new Error('Codex failure event requires a message')
}

function usageOf(value: unknown): { inputTokens?: number; outputTokens?: number } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const usage = value as Record<string, unknown>
  const inputTokens = positiveInteger(usage.input_tokens)
  const outputTokens = positiveInteger(usage.output_tokens)
  return inputTokens === undefined && outputTokens === undefined ? undefined : { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function bounded(value: string, limit: number): string {
  return Buffer.byteLength(value) <= limit ? value : Buffer.from(value).subarray(0, limit).toString('utf8')
}
