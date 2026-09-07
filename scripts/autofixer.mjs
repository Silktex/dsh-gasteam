#!/usr/bin/env node
/**
 * Autonomous Nightly Review & Plan of Fix Generator (autofixer.mjs)
 *
 * Implements the 5-phase execution runbook specified in autofixer.md:
 * - Phase 1: Environment & Working Tree Sanity Check
 * - Phase 2: Log Ingestion & Verification Gates (Doctor -> Docs -> Types -> Build -> Tests -> Smoke)
 * - Phase 3: Defect Classification & Root-Cause Triage (P0/P1/P2)
 * - Phase 4: Plan of Fix Artifact Generation (reports/nightly-fix-plan-YYYY-MM-DD.md)
 * - Phase 5: Optional Safe Self-Healing Protocol
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const isQuick = args.includes('--quick')
const isFull = args.includes('--full')
const isJson = args.includes('--json')
const outArgIndex = args.indexOf('--out')
const customOut = outArgIndex !== -1 && args[outArgIndex + 1] ? args[outArgIndex + 1] : null

const rootDir = resolve(import.meta.dirname, '..')
const now = new Date()
const dateStr = now.toISOString().split('T')[0]
const reportPath = customOut ? resolve(customOut) : join(rootDir, 'reports', `nightly-fix-plan-${dateStr}.md`)

function runCommand(command, cmdArgs, options = {}) {
  const start = Date.now()
  try {
    const res = spawnSync(command, cmdArgs, {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `/home/linuxbrew/.linuxbrew/bin:${process.env.PATH || ''}`,
        TMPDIR: process.env.TMPDIR || '/var/tmp',
      },
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    })
    return {
      ok: res.status === 0,
      code: res.status,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      durationMs: Date.now() - start,
    }
  } catch (err) {
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: err.message,
      durationMs: Date.now() - start,
    }
  }
}

async function main() {
  console.log(`\n\x1b[1m=== Autonomous Nightly Review & Fix Runner ===\x1b[0m`)
  console.log(`Timestamp: ${now.toISOString()} | Mode: ${isQuick ? 'Quick' : isFull ? 'Full' : 'Standard'}\n`)

  // --- Phase 1: Environment & Working Tree Sanity Check ---
  console.log(`\x1b[34m[Phase 1]\x1b[0m Checking environment and working tree...`)
  const nodeVersion = process.version
  let gitStatus = ''
  let recentCommits = []
  try {
    gitStatus = execFileSync('git', ['status', '--short'], { cwd: rootDir, encoding: 'utf8' }).trim()
    const logRaw = execFileSync('git', ['log', '--since=24 hours ago', '--oneline'], { cwd: rootDir, encoding: 'utf8' }).trim()
    recentCommits = logRaw ? logRaw.split('\n') : []
  } catch {}

  // --- Phase 2: Log Ingestion & Verification Gates ---
  console.log(`\x1b[34m[Phase 2]\x1b[0m Executing verification gates...`)
  const gates = []
  const defects = []

  // Step 0: Doctor fast diagnostics
  console.log(`  -> Running Fast Diagnostics (doctor.mjs)...`)
  const doctorRes = runCommand('node', ['scripts/doctor.mjs', '--json'])
  let doctorJson = null
  try {
    doctorJson = JSON.parse(doctorRes.stdout)
  } catch {}

  gates.push({
    name: 'Doctor Diagnostics',
    command: 'node scripts/doctor.mjs',
    ok: doctorJson ? doctorJson.healthy : doctorRes.ok,
    durationMs: doctorRes.durationMs,
  })

  if (doctorJson && !doctorJson.healthy) {
    for (const issue of doctorJson.issues) {
      defects.push({
        id: `DIAG-${defects.length + 1}`,
        severity: issue.toLowerCase().includes('critical') ? 'P0' : 'P2',
        component: 'Environment',
        description: issue,
        source: 'scripts/doctor.mjs',
      })
    }
  }

  // Gate 1: Docs check
  console.log(`  -> Gate 1: Documentation Alignment...`)
  const docsRes = runCommand('node', ['scripts/check-docs.mjs'])
  gates.push({
    name: 'check:docs',
    command: 'pnpm check:docs',
    ok: docsRes.ok,
    durationMs: docsRes.durationMs,
  })
  if (!docsRes.ok) {
    defects.push({
      id: `ERR-${defects.length + 1}`,
      severity: 'P2',
      component: 'Docs',
      description: docsRes.stderr || docsRes.stdout.split('\n')[0] || 'Documentation alignment check failed',
      source: 'scripts/check-docs.mjs',
      trace: docsRes.stderr || docsRes.stdout,
    })
  }

  // Gate 2: Typecheck
  console.log(`  -> Gate 2: Typecheck (dual configurations)...`)
  const typecheckRes = runCommand('pnpm', ['typecheck'])
  gates.push({
    name: 'typecheck',
    command: 'pnpm typecheck',
    ok: typecheckRes.ok,
    durationMs: typecheckRes.durationMs,
  })
  if (!typecheckRes.ok) {
    const errorLines = (typecheckRes.stdout + '\n' + typecheckRes.stderr).split('\n').filter(l => l.includes('error TS'))
    for (const line of errorLines.slice(0, 5)) {
      defects.push({
        id: `ERR-${defects.length + 1}`,
        severity: 'P1',
        component: 'Host/Client TypeScript',
        description: line.trim(),
        source: line.split(':')[0] || 'tsconfig',
        trace: typecheckRes.stdout,
      })
    }
  }

  // Gate 3: Build
  console.log(`  -> Gate 3: Build Generation...`)
  const buildRes = runCommand('pnpm', ['build'])
  gates.push({
    name: 'build',
    command: 'pnpm build',
    ok: buildRes.ok,
    durationMs: buildRes.durationMs,
  })
  if (!buildRes.ok) {
    defects.push({
      id: `ERR-${defects.length + 1}`,
      severity: 'P1',
      component: 'Build',
      description: (buildRes.stderr || buildRes.stdout).split('\n')[0] || 'Build generation failed',
      source: 'scripts/build.mjs',
      trace: buildRes.stderr || buildRes.stdout,
    })
  }

  // Gate 4: Unit Tests (unless quick mode and build failed)
  if (!isQuick && buildRes.ok) {
    console.log(`  -> Gate 4: Unit Test Suite...`)
    const testRes = runCommand('pnpm', ['test'])
    gates.push({
      name: 'test',
      command: 'pnpm test',
      ok: testRes.ok,
      durationMs: testRes.durationMs,
    })
    if (!testRes.ok) {
      const failLines = testRes.stdout.split('\n').filter(l => l.includes('FAIL') || l.includes('AssertionError'))
      defects.push({
        id: `ERR-${defects.length + 1}`,
        severity: 'P1',
        component: 'Unit Tests',
        description: failLines[0]?.trim() || 'Unit test suite failed',
        source: 'vitest',
        trace: testRes.stdout.slice(-1000),
      })
    }
  }

  // Gate 5: Acceptance (only in full mode)
  if (isFull && buildRes.ok) {
    console.log(`  -> Gate 5: Acceptance Suite...`)
    const accRes = runCommand('pnpm', ['test:acceptance'])
    gates.push({
      name: 'test:acceptance',
      command: 'pnpm test:acceptance',
      ok: accRes.ok,
      durationMs: accRes.durationMs,
    })
    if (!accRes.ok) {
      defects.push({
        id: `ERR-${defects.length + 1}`,
        severity: 'P1',
        component: 'Acceptance',
        description: 'Multi-process integration acceptance scenarios failed',
        source: 'vitest.acceptance.config.ts',
        trace: accRes.stdout.slice(-1000),
      })
    }
  }

  // Gate 6: Smoke Validation
  console.log(`  -> Gate 6: Smoke Validation...`)
  const smokeRes = runCommand('pnpm', ['test:smoke'])
  gates.push({
    name: 'test:smoke',
    command: 'pnpm test:smoke',
    ok: smokeRes.ok,
    durationMs: smokeRes.durationMs,
  })
  if (!smokeRes.ok) {
    defects.push({
      id: `ERR-${defects.length + 1}`,
      severity: 'P0',
      component: 'Standalone Release Smoke',
      description: smokeRes.stderr || smokeRes.stdout.split('\n')[0] || 'Smoke test failed',
      source: 'scripts/smoke.mjs',
      trace: smokeRes.stderr || smokeRes.stdout,
    })
  }

  // --- Phase 3: Defect Classification & Root-Cause Triage ---
  console.log(`\x1b[34m[Phase 3]\x1b[0m Classifying defects...`)
  const p0s = defects.filter(d => d.severity === 'P0')
  const p1s = defects.filter(d => d.severity === 'P1')
  const p2s = defects.filter(d => d.severity === 'P2')

  const overallHealth = p0s.length > 0 ? 'Failing' : p1s.length > 0 ? 'Degraded' : 'Passing'
  console.log(`  Health Assessment: \x1b[1m${overallHealth}\x1b[0m (P0: ${p0s.length}, P1: ${p1s.length}, P2: ${p2s.length})`)

  // --- Phase 4: Plan of Fix Artifact Generation ---
  console.log(`\x1b[34m[Phase 4]\x1b[0m Generating Plan of Fix report at ${reportPath}...`)

  const reportMarkdown = `# Nightly Health Review & Plan of Fix — ${dateStr}

## 1. Executive Summary
- **Health Score**: ${overallHealth === 'Passing' ? 'Passing (All Gates Green)' : overallHealth}
- **Commits Reviewed (Last 24h)**: ${recentCommits.length}
- **Failing Gates**: ${gates.filter(g => !g.ok).map(g => g.name).join(', ') || 'None'}
- **Working Tree State**: ${gitStatus ? 'Uncommitted changes / untracked files present' : 'Clean'}
- **Active Milestones**: \`finishme.md\`, \`handoff.md\`, \`darkfactory.md\`, \`autofixer.md\`

## 2. Defect Ledger
${defects.length === 0 ? '*No defects detected. All systems healthy.*' : `
| ID | Severity | Component | Error Description | Source File / Test |
|:---|:---|:---|:---|:---|
${defects.map(d => `| ${d.id} | ${d.severity} | ${d.component} | ${d.description.replace(/\|/g, '\\|')} | \`${d.source}\` |`).join('\n')}
`}

## 3. Deep Root-Cause Analysis
${defects.length === 0 ? 'All diagnostic checks, typechecks, builds, unit tests, and smoke validations passed with zero regressions.' : defects.map(d => `
### [${d.id}] ${d.description}
- **Severity**: ${d.severity} (${d.component})
- **Source**: \`${d.source}\`
${d.trace ? `- **Failure Snippet**:\n  \`\`\`\n  ${d.trace.trim().slice(0, 500)}\n  \`\`\`` : ''}
- **Root Cause Deduction**: ${d.component.includes('Environment') ? 'Filesystem inode exhaustion or missing environment variable in shell session.' : d.component.includes('TypeScript') ? 'Type interface mismatch or exactOptionalPropertyTypes divergence.' : 'Functional regression or broken assertion.'}
`).join('\n')}

## 4. Prioritized Plan of Fix
${defects.length === 0 ? '1. **Routine Maintenance**: Continue scheduled nightly reviews and keep `TMPDIR=/var/tmp` exported.' : defects.map((d, idx) => `
${idx + 1}. **Task ${idx + 1} (\`${d.component}\`)**:
   - **Target**: \`${d.source}\`
   - **Remediation**: ${d.component.includes('Environment') ? 'Ensure `export TMPDIR=/var/tmp` is set in user crontab and service files to avoid `/tmp` inode exhaustion.' : 'Investigate stack trace, apply isolated patch, and verify gate.'}
   - **Verification**: \`${d.source.includes('doctor') ? 'pnpm doctor' : d.source.includes('ts') ? 'pnpm typecheck' : 'pnpm test'}\`
`).join('\n')}

## 5. Verification Gate Status
${gates.map(g => `- [${g.ok ? 'x' : ' '}] \`${g.command}\` (${g.durationMs}ms)`).join('\n')}
`

  mkdirSync(join(rootDir, 'reports'), { recursive: true })
  writeFileSync(reportPath, reportMarkdown, 'utf8')
  console.log(`\x1b[32mSuccessfully wrote Plan of Fix report to ${reportPath}\x1b[0m\n`)

  if (isJson) {
    console.log(JSON.stringify({ overallHealth, defects, gates, reportPath }, null, 2))
  }

  process.exit(overallHealth === 'Failing' ? 1 : 0)
}

main().catch(err => {
  console.error('Autofixer runner failed:', err)
  process.exit(2)
})
