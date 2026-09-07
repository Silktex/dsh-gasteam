#!/usr/bin/env node
/**
 * GasTeam Doctor — Ultra-fast (<500ms) autonomous system & triage diagnostic tool.
 *
 * Audits:
 * 1. Disk & Inode saturation (/tmp, /var/tmp, workspace)
 * 2. Linux flock locks & integration contention (.git/gasteam-integration-locks)
 * 3. Leaked candidate directories and worktrees (/var/tmp/team-workers, /tmp, /var/tmp)
 * 4. Durable health escalations (health.jsonl)
 * 5. Structured runtime errors (/var/tmp/gasteam-errors.jsonl)
 * 6. Toolchain & shell environment (node, pnpm, git, flock, TMPDIR)
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const pruneMode = args.includes('--prune')
const helpMode = args.includes('--help') || args.includes('-h')

if (helpMode) {
  console.log(`Usage: node scripts/doctor.mjs [options]

Options:
  --json       Output machine-readable JSON summary (<100ms)
  --prune      Safely prune abandoned candidate worktrees older than 24 hours
  --help, -h   Show this help message
`)
  process.exit(0)
}

const rootDir = resolve(import.meta.dirname, '..')

function checkToolchain() {
  const issues = []
  const nodeVersion = process.version
  const major = parseInt(nodeVersion.replace(/^v/, '').split('.')[0], 10)
  const minor = parseInt(nodeVersion.replace(/^v/, '').split('.')[1] || '0', 10)

  const nodeValid = (major === 22 && minor >= 19) || major >= 24
  if (!nodeValid) {
    issues.push(`Node.js version ${nodeVersion} does not satisfy ^22.19 || >=24`)
  }

  let pnpmVersion = 'unknown'
  try {
    pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
  } catch {
    issues.push('pnpm binary is missing or not in PATH')
  }

  let gitVersion = 'unknown'
  try {
    gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
  } catch {
    issues.push('git binary is missing or not in PATH')
  }

  let flockAvailable = false
  try {
    execFileSync('flock', ['--help'], { stdio: ['pipe', 'ignore', 'ignore'] })
    flockAvailable = true
  } catch {
    issues.push('Linux util-linux flock is missing or unavailable')
  }

  const tmpdirEnv = process.env.TMPDIR || '/tmp'
  const isVarTmp = tmpdirEnv.startsWith('/var/tmp')

  return {
    status: issues.length === 0 ? (isVarTmp ? 'ok' : 'warn') : 'fail',
    nodeVersion,
    pnpmVersion,
    gitVersion,
    flockAvailable,
    tmpdir: tmpdirEnv,
    issues: isVarTmp ? issues : [...issues, 'TMPDIR is not set to /var/tmp; /tmp may face inode exhaustion'],
  }
}

function checkStorageAndInodes() {
  const issues = []
  const drives = ['/tmp', '/var/tmp', rootDir]
  const stats = []

  for (const dir of drives) {
    try {
      const output = execFileSync('df', ['-P', '-k', dir], { encoding: 'utf8' }).trim().split('\n')
      const inodeOutput = execFileSync('df', ['-P', '-i', dir], { encoding: 'utf8' }).trim().split('\n')
      if (output.length >= 2 && inodeOutput.length >= 2) {
        const spaceParts = output[1].split(/\s+/)
        const inodeParts = inodeOutput[1].split(/\s+/)
        const diskPercent = parseInt(spaceParts[4].replace('%', ''), 10)
        const inodePercent = parseInt(inodeParts[4].replace('%', ''), 10)

        const item = {
          mount: dir,
          diskPercent,
          inodePercent,
          diskAvailKb: parseInt(spaceParts[3], 10),
          inodesFree: parseInt(inodeParts[3], 10),
        }
        stats.push(item)

        if (inodePercent >= 90) {
          if (dir === '/tmp' && (process.env.TMPDIR || '').startsWith('/var/tmp')) {
            issues.push(`High inode usage on /tmp: ${inodePercent}% used (${item.inodesFree} free; mitigated: TMPDIR=/var/tmp is active)`)
          } else {
            issues.push(`Critical inode saturation on ${dir}: ${inodePercent}% used (${item.inodesFree} free)`)
          }
        } else if (inodePercent >= 80) {
          issues.push(`High inode usage on ${dir}: ${inodePercent}% used`)
        }

        if (diskPercent >= 90) {
          issues.push(`Critical disk space saturation on ${dir}: ${diskPercent}% used`)
        }
      }
    } catch {
      // df failed for directory
    }
  }

  return {
    status: issues.some(i => i.startsWith('Critical')) ? 'fail' : issues.length > 0 ? 'warn' : 'ok',
    drives: stats,
    issues,
  }
}

function checkGitAndWorktrees() {
  const issues = []
  let worktrees = []
  try {
    const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: rootDir, encoding: 'utf8' })
    const blocks = raw.split('\n\n').filter(Boolean)
    for (const b of blocks) {
      const lines = b.split('\n')
      const wtLine = lines.find(l => l.startsWith('worktree '))
      const branchLine = lines.find(l => l.startsWith('branch '))
      const detached = lines.includes('detached')
      const prunable = lines.find(l => l.startsWith('prunable'))
      if (wtLine) {
        worktrees.push({
          path: wtLine.replace('worktree ', ''),
          branch: branchLine ? branchLine.replace('branch ', '') : (detached ? 'detached' : 'unknown'),
          prunable: Boolean(prunable),
        })
      }
    }
  } catch (err) {
    issues.push(`Failed to list git worktrees: ${err.message}`)
  }

  // Audit leaked worker worktrees in /var/tmp/team-workers and /tmp
  const workerDirs = ['/var/tmp/team-workers', '/tmp/team-workers']
  const leaked = []
  const now = Date.now()
  const oneDayAgo = now - 24 * 60 * 60 * 1000

  for (const base of workerDirs) {
    if (existsSync(base)) {
      try {
        const entries = readdirSync(base)
        for (const entry of entries) {
          const fullPath = join(base, entry)
          try {
            const st = statSync(fullPath)
            const ageHours = ((now - st.mtimeMs) / (1000 * 60 * 60)).toFixed(1)
            const isOld = st.mtimeMs < oneDayAgo
            const isTracked = worktrees.some(w => w.path === fullPath)
            leaked.push({
              path: fullPath,
              ageHours: parseFloat(ageHours),
              tracked: isTracked,
              prunable: isOld && !isTracked,
            })
          } catch {}
        }
      } catch {}
    }
  }

  const prunableCount = leaked.filter(l => l.prunable).length + worktrees.filter(w => w.prunable).length
  if (prunableCount > 0) {
    issues.push(`${prunableCount} prunable candidate directories / worktrees detected`)
  }

  return {
    status: prunableCount > 5 ? 'warn' : 'ok',
    worktrees,
    candidateDirectories: leaked,
    issues,
  }
}

function checkIntegrationLocks() {
  const issues = []
  let lockDir = ''
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: rootDir, encoding: 'utf8' }).trim()
    lockDir = join(commonDir, 'gasteam-integration-locks')
  } catch {}

  const activeLocks = []
  if (lockDir && existsSync(lockDir)) {
    try {
      const files = readdirSync(lockDir).filter(f => f.endsWith('.lock'))
      for (const file of files) {
        const filePath = join(lockDir, file)
        // Check if lock is actively held using non-blocking flock
        const res = spawnSync('flock', ['-n', filePath, '-c', 'true'])
        const held = res.status !== 0
        activeLocks.push({ file, held })
        if (held) {
          issues.push(`Integration lock actively held: ${file}`)
        }
      }
    } catch {}
  }

  return {
    status: activeLocks.some(l => l.held) ? 'warn' : 'ok',
    lockDir,
    locks: activeLocks,
    issues,
  }
}

function checkStructuredErrors() {
  const issues = []
  const sinkPath = process.env.GASTEAM_ERROR_SINK || (process.env.TMPDIR ? join(process.env.TMPDIR, 'gasteam-errors.jsonl') : '/var/tmp/gasteam-errors.jsonl')
  const recentErrors = []

  if (existsSync(sinkPath)) {
    try {
      const content = readFileSync(sinkPath, 'utf8')
      const lines = content.split('\n').filter(l => l.trim().length > 0)
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
      for (const line of lines) {
        try {
          const rec = JSON.parse(line)
          const time = new Date(rec.timestamp).getTime()
          if (time >= oneDayAgo) {
            recentErrors.push(rec)
          }
        } catch {}
      }
    } catch {}
  }

  if (recentErrors.length > 0) {
    issues.push(`${recentErrors.length} structured errors logged in the last 24h`)
  }

  return {
    status: recentErrors.length > 5 ? 'fail' : recentErrors.length > 0 ? 'warn' : 'ok',
    sinkPath,
    countLast24h: recentErrors.length,
    recent: recentErrors.slice(-5),
    issues,
  }
}

function checkHealthEscalations() {
  const issues = []
  const escalations = []
  // Check common coordinator journal locations
  const searchDirs = [
    join(rootDir, '.coordinator'),
    join(process.env.TMPDIR || '/var/tmp', 'coordinator'),
    '/var/tmp/coordinator',
  ]

  for (const dir of searchDirs) {
    if (existsSync(dir)) {
      try {
        const projects = readdirSync(dir)
        for (const proj of projects) {
          const healthFile = join(dir, proj, 'health.jsonl')
          if (existsSync(healthFile)) {
            const lines = readFileSync(healthFile, 'utf8').split('\n').filter(Boolean)
            for (const l of lines) {
              try {
                const event = JSON.parse(l)
                if (event.type === 'health/escalated') {
                  escalations.push({ project: proj, ...event })
                }
              } catch {}
            }
          }
        }
      } catch {}
    }
  }

  if (escalations.length > 0) {
    issues.push(`${escalations.length} durable health escalation(s) recorded`)
  }

  return {
    status: escalations.length > 0 ? 'warn' : 'ok',
    escalations,
    issues,
  }
}

async function runPrune(audit) {
  let pruned = 0
  for (const item of audit.git.candidateDirectories) {
    if (item.prunable) {
      try {
        await rm(item.path, { recursive: true, force: true })
        pruned++
      } catch {}
    }
  }
  return pruned
}

async function main() {
  const startTime = Date.now()
  const toolchain = checkToolchain()
  const storage = checkStorageAndInodes()
  const git = checkGitAndWorktrees()
  const locks = checkIntegrationLocks()
  const errors = checkStructuredErrors()
  const health = checkHealthEscalations()

  let prunedCount = 0
  if (pruneMode) {
    prunedCount = await runPrune({ git })
  }

  const allIssues = [
    ...toolchain.issues,
    ...storage.issues,
    ...git.issues,
    ...locks.issues,
    ...errors.issues,
    ...health.issues,
  ]

  const overallHealthy = !allIssues.some(i => i.toLowerCase().includes('critical') || i.toLowerCase().includes('fail'))
  const durationMs = Date.now() - startTime

  const report = {
    healthy: overallHealthy,
    durationMs,
    summary: {
      toolchain: toolchain.status,
      storage: storage.status,
      git: git.status,
      locks: locks.status,
      errors: errors.status,
      health: health.status,
    },
    prunedCount,
    toolchain,
    storage,
    git,
    locks,
    errors,
    health,
    issues: allIssues,
  }

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2))
    process.exit(overallHealthy ? 0 : 1)
  }

  // Pretty human terminal output
  const badge = s => s === 'ok' ? '\x1b[32m[PASS]\x1b[0m' : s === 'warn' ? '\x1b[33m[WARN]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m'
  console.log(`\n\x1b[1m=== GasTeam System Doctor ===\x1b[0m (${durationMs}ms)`)
  console.log(`Overall Health: ${overallHealthy ? '\x1b[32mHEALTHY\x1b[0m' : '\x1b[31mATTENTION REQUIRED\x1b[0m'}\n`)

  console.log(`${badge(toolchain.status)} Toolchain: Node ${toolchain.nodeVersion}, pnpm ${toolchain.pnpmVersion}, flock: ${toolchain.flockAvailable ? 'available' : 'missing'}`)
  console.log(`${badge(storage.status)} Storage: ${storage.drives.map(d => `${d.mount} (inodes: ${d.inodePercent}%, disk: ${d.diskPercent}%)`).join(' | ')}`)
  console.log(`${badge(git.status)} Worktrees: ${git.worktrees.length} active worktree(s), ${git.candidateDirectories.length} worker candidate(s)`)
  console.log(`${badge(locks.status)} Flock Locks: ${locks.locks.length} lock file(s), ${locks.locks.filter(l => l.held).length} held`)
  console.log(`${badge(errors.status)} Error Sink: ${errors.countLast24h} error(s) logged in last 24h`)
  console.log(`${badge(health.status)} Health Escalations: ${health.escalations.length} escalation(s)`)

  if (pruneMode) {
    console.log(`\n\x1b[36mPrune Action:\x1b[0m Removed ${prunedCount} orphaned candidate directory/worktrees.`)
  }

  if (allIssues.length > 0) {
    console.log(`\n\x1b[1mIdentified Issues / Recommendations:\x1b[0m`)
    for (const issue of allIssues) {
      console.log(`  - ${issue}`)
    }
  } else {
    console.log(`\n\x1b[32mAll fast-path triage checks passed cleanly.\x1b[0m`)
  }
  console.log()
  process.exit(overallHealthy ? 0 : 1)
}

main().catch(err => {
  console.error('Doctor failed:', err)
  process.exit(2)
})
