#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

if (process.argv[2] !== '--version') process.exitCode = 2
else {
  const pidFile = process.env.CODEX_ADMISSION_FIXTURE_PID_FILE
  const readyFile = process.env.CODEX_ADMISSION_FIXTURE_READY_FILE
  const exitFile = process.env.CODEX_ADMISSION_FIXTURE_EXIT_FILE
  const descendant = spawn(process.execPath, ['-e', "const { writeFileSync } = require('node:fs'); setTimeout(() => { writeFileSync(process.env.CODEX_ADMISSION_FIXTURE_EXIT_FILE, 'done'); process.exit(0) }, 350)"], { stdio: 'inherit', env: process.env })
  descendant.once('spawn', () => {
    if (pidFile) writeFileSync(pidFile, String(descendant.pid))
    if (readyFile) writeFileSync(readyFile, 'ready')
    process.stdout.write('codex-cli 0.153.4\n')
    process.exit(0)
  })
}
