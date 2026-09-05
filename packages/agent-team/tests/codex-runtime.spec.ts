import { expect, it } from 'vitest'
import { CodexRuntime, parseCodexJsonLine } from '../src/codex-runtime.ts'

const runtime = new CodexRuntime({ executable: '/opt/codex', version: '0.153.4', model: 'gpt-5.6-codex', sandbox: 'workspace-write' })

it('pins canonical cwd, model, sandbox and a JSON prompt for a new Codex execution', async () => {
  const launch = await runtime.start({ attemptId: 'attempt-a', generation: 2, cwd: process.cwd(), prompt: { instruction: 'write a report' } })
  expect(launch.argv).toEqual(['/opt/codex', 'exec', '--json', '--config', 'approval_policy="never"', '--cd', await (await import('node:fs/promises')).realpath(process.cwd()), '--model', 'gpt-5.6-codex', '--sandbox', 'workspace-write', '-'])
  expect(launch.stdin).toBe('{"instruction":"write a report"}\n')
  expect(launch.runtimeIdentity).toMatchObject({ provider: 'codex-cli', kind: 'new', attemptId: 'attempt-a', generation: 2, executable: '/opt/codex', version: '0.153.4', executableVerification: 'configured-unverified', model: 'gpt-5.6-codex', sandbox: 'workspace-write' })
  expect(launch.argv).not.toContain('--last')
  expect(launch.argv).not.toContain('--ephemeral')
  expect(launch.argv).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  expect(runtime.capabilities.cancel).toEqual({ supported: true, conditions: ['live namespace wrapper handle and strict PID-namespace containment'] })
})

it('resumes only an exact durable thread after positive quiescence', async () => {
  const priorPolicy = { executable: '/opt/codex', version: '0.153.4', executableVerification: 'configured-unverified' as const, cwd: await (await import('node:fs/promises')).realpath(process.cwd()), model: 'gpt-5.6-codex', sandbox: 'workspace-write' as const }
  await expect(runtime.resume({ attemptId: 'attempt-a', generation: 2, threadId: 'thread-123', cwd: process.cwd(), prompt: { instruction: 'continue' }, quiescentReceipt: undefined, priorPolicy })).rejects.toThrow(/quiescent/i)
  await expect(runtime.resume({ attemptId: 'attempt-a', generation: 2, threadId: 'thread-123', cwd: process.cwd(), prompt: { instruction: 'continue' }, quiescentReceipt: 'exit:0', priorPolicy: { ...priorPolicy, model: 'other' } })).rejects.toThrow(/policy/i)
  const launch = await runtime.resume({ attemptId: 'attempt-a', generation: 2, threadId: 'thread-123', cwd: process.cwd(), prompt: { instruction: 'continue' }, quiescentReceipt: 'exit:0', priorPolicy })
  expect(launch.argv).toEqual(['/opt/codex', 'exec', 'resume', 'thread-123', '-', '--json', '--config', 'approval_policy="never"', '--model', 'gpt-5.6-codex'])
  expect(launch.runtimeIdentity).toMatchObject({ kind: 'resume', threadId: 'thread-123', quiescentReceipt: 'exit:0' })
})

it('bounds and rejects malformed CLI JSONL events', () => {
  expect(parseCodexJsonLine('{"type":"thread.started","thread_id":"thread-123"}', 1024)).toEqual({ type: 'thread.started', threadId: 'thread-123' })
  expect(parseCodexJsonLine('{"type":"turn.started"}', 1024)).toEqual({ type: 'turn.started' })
  expect(parseCodexJsonLine('{"type":"item.updated","item":{"type":"agent_message"}}', 1024)).toEqual({ type: 'item', eventType: 'item.updated' })
  expect(parseCodexJsonLine('{"type":"turn.failed","error":{"message":"fixture failed"}}', 1024)).toEqual({ type: 'turn.failed', message: 'fixture failed' })
  expect(() => parseCodexJsonLine('not json', 1024)).toThrow(/JSON/i)
  expect(() => parseCodexJsonLine('{"type":"thread.started"}', 1024)).toThrow(/thread/i)
  expect(() => parseCodexJsonLine('x'.repeat(1025), 1024)).toThrow(/limit/i)
})
