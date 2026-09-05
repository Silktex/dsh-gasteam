#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

let [mode] = process.argv.slice(2)
let input
if (mode === '--version') {
  process.stdout.write('codex 0.153.4\n')
  process.exit(0)
}
if (mode === 'login' && process.argv[3] === 'status') process.exit(0)
if (mode === 'exec') {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  mode = input.mode ?? input.checkpoint?.task?.subject
}
if (mode === 'silent') {
  setInterval(() => {}, 1_000)
} else if (mode === 'linger') {
  setTimeout(() => process.exit(0), 750)
} else if (mode === 'descendant') {
  spawn(process.execPath, [new URL(import.meta.url).pathname, 'silent'], { stdio: 'ignore' })
  setInterval(() => {}, 1_000)
} else if (mode === 'overflow') {
  process.stdout.write('x'.repeat(16_384))
  setInterval(() => {}, 1_000)
} else if (mode === 'overflow-storm') {
  for (let index = 0; index < 256; index += 1) process.stdout.write('x'.repeat(16_384))
  setInterval(() => {}, 1_000)
} else if (mode === 'namespace-escape') {
  const escaped = spawn('setsid', [process.execPath, new URL(import.meta.url).pathname, 'silent'], { stdio: 'ignore' })
  escaped.once('spawn', () => process.stdout.write('x'.repeat(16_384)))
  setInterval(() => {}, 1_000)
} else if (mode === 'json') {
  process.stdout.write('{"type":"thread.started","thread_id":"fixture-thread"}\n')
  process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":5}}\n')
} else if (mode === 'codex-report') {
  process.stdout.write('{"type":"thread.started","thread_id":"fixture-thread"}\n')
  process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"fixture external report"}}\n')
  process.stdout.write('{"type":"turn.completed"}\n')
} else if (mode === 'codex-usage-report') {
  process.stdout.write('{"type":"thread.started","thread_id":"fixture-usage-thread"}\n')
  process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"fixture usage report"}}\n')
  process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":101,"cached_input_tokens":23,"output_tokens":37,"reasoning_output_tokens":11}}\n')
} else if (mode === 'codex-malformed-usage-report') {
  process.stdout.write('{"type":"thread.started","thread_id":"fixture-malformed-usage-thread"}\n')
  process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"fixture malformed usage report"}}\n')
  process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":-1,"cached_input_tokens":"23","output_tokens":3.5}}\n')
} else if (mode === 'codex-multi-report') {
  process.stdout.write('{"type":"turn.started"}\n')
  process.stdout.write('{"type":"thread.started","thread_id":"fixture-thread"}\n')
  process.stdout.write('{"type":"item.completed","item":{"id":"progress-item","type":"agent_message","text":"fixture progress"}}\n')
  process.stdout.write('{"type":"item.completed","item":{"id":"final-item","type":"agent_message","text":"fixture final report"}}\n')
  process.stdout.write('{"type":"turn.completed"}\n')
} else if (mode === 'codex-code-commit') {
  appendFileSync('external-code.txt', 'external provider committed evidence\n')
  execFileSync('git', ['add', 'external-code.txt'])
  execFileSync('git', ['-c', 'user.name=External Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'external provider change'])
  process.stdout.write('{"type":"thread.started","thread_id":"fixture-code-thread"}\n')
  process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"Committed external-code.txt and verified the pinned checkout"}}\n')
  process.stdout.write('{"type":"turn.completed"}\n')
} else if (mode === 'side-effect') {
  const counter = input?.counter ?? process.argv[3]
  if (counter === undefined) throw new Error('side-effect fixture requires a counter path')
  appendFileSync(counter, 'target-started\n')
  process.stdout.write('{"type":"turn.completed"}\n')
} else if (mode === 'side-effect-silent') {
  const counter = input?.counter ?? process.argv[3]
  if (counter === undefined) throw new Error('side-effect-silent fixture requires a counter path')
  appendFileSync(counter, 'target-started\n')
  setInterval(() => {}, 1_000)
} else if (mode === 'side-effect-late-output') {
  const counter = input?.counter ?? process.argv[3]
  if (counter === undefined) throw new Error('side-effect-late-output fixture requires a counter path')
  appendFileSync(counter, 'target-started\n')
  process.on('SIGTERM', () => process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"late report"}}\n'))
  setInterval(() => {}, 1_000)
} else if (typeof mode === 'string' && mode.includes('real Codex restart cancellation marker')) {
  appendFileSync('REAL_CODEX_RESTART_MARKER.txt', 'real-codex-restart-cancel\n')
  execFileSync('git', ['add', 'REAL_CODEX_RESTART_MARKER.txt'])
  execFileSync('git', ['-c', 'user.name=External Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'restart cancellation marker'])
  process.stdout.write('{"type":"thread.started","thread_id":"fixture-restart-thread"}\n')
  setInterval(() => {}, 1_000)
} else {
  throw new Error(`Unknown fixture mode ${mode}`)
}
