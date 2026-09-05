import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const [mode] = process.argv.slice(2)
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
} else if (mode === 'namespace-escape') {
  const escaped = spawn('setsid', [process.execPath, new URL(import.meta.url).pathname, 'silent'], { stdio: 'ignore' })
  escaped.once('spawn', () => process.stdout.write('x'.repeat(16_384)))
  setInterval(() => {}, 1_000)
} else if (mode === 'json') {
  process.stdout.write('{"type":"thread.started","thread_id":"fixture-thread"}\n')
  process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":5}}\n')
} else if (mode === 'side-effect') {
  const counter = process.argv[3]
  if (counter === undefined) throw new Error('side-effect fixture requires a counter path')
  appendFileSync(counter, 'target-started\n')
  process.stdout.write('{"type":"turn.completed"}\n')
} else {
  throw new Error(`Unknown fixture mode ${mode}`)
}
