#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

if (process.argv[2] !== '--version') process.exitCode = 2
else {
  const pidFile = process.env.CODEX_ADMISSION_FIXTURE_PID_FILE
  const readyFile = process.env.CODEX_ADMISSION_FIXTURE_READY_FILE
  const exitFile = process.env.CODEX_ADMISSION_FIXTURE_EXIT_FILE
  const releaseFile = process.env.CODEX_ADMISSION_FIXTURE_RELEASE_FILE
  const descendant = spawn(process.execPath, ['-e', "const { existsSync, writeFileSync } = require('node:fs'); const release = process.env.CODEX_ADMISSION_FIXTURE_RELEASE_FILE; const exit = process.env.CODEX_ADMISSION_FIXTURE_EXIT_FILE; const finish = () => { if (exit) writeFileSync(exit, 'done'); process.exit(0) }; const poll = setInterval(() => { if (release && existsSync(release)) { clearInterval(poll); finish() } }, 10); setTimeout(() => { clearInterval(poll); finish() }, 10000)"], { stdio: 'inherit', env: process.env })
  // spawn() has returned the child identity and inherited pipes. Publish this
  // barrier before scheduling any child callback so a loaded test worker does
  // not race the deliberately short-lived probe leader.
  if (pidFile) writeFileSync(pidFile, String(descendant.pid))
  if (readyFile) writeFileSync(readyFile, 'ready')
  process.stdout.write('codex-cli 0.153.4\n')
  process.exit(0)
}
