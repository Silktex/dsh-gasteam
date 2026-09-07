/**
 * Mutation Policy and Isolated Execution (DF-08)
 *
 * Deterministic AST mutation generation, double baseline execution,
 * disposable isolated worktree sandboxes, process-group timeouts,
 * reproducible kill verification, and strict killed score calculation.
 */

import ts from 'typescript'
import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { join, dirname, basename, posix } from 'node:path'
import { spawn } from 'node:child_process'
import { runGit } from '../git-command.ts'
import { digestJson } from './json.ts'
import type { MutantManifestV1 } from './contracts/verification.ts'

export interface MutableSite {
  id: string
  path: string
  start: number
  end: number
  operatorId: string
  originalText: string
  mutatedText: string
  nodeKind: string
}

export interface MutationExecutionOptions {
  repoRoot: string
  targetCommit: string
  candidateCommit: string
  attemptId: string
  generation: number
  projectId?: string
  policyRevision?: number
  testCommand: {
    executable: string
    args: string[]
    timeoutMs?: number
  }
  sandboxesDir?: string
  perMutantTimeoutMs?: number
  stageTimeoutMs?: number
  terminationGraceMs?: number
  maxMutants?: number
  applicablePaths?: string[]
  docsOnly?: boolean
  signal?: AbortSignal
  gitRunner?: (
    cwd: string,
    args: readonly string[],
    signal: AbortSignal,
    timeout: number,
  ) => Promise<string>
  testRunner?: (
    cwd: string,
    command: { executable: string; args: string[] },
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean; error?: Error }>
}

export interface MutationExecutionResult {
  manifest: MutantManifestV1
  score: number
  decision: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'NOT_APPLICABLE' | 'INSUFFICIENT_EVIDENCE'
  reason?: string
}

export interface SandboxMetadata {
  attemptId: string
  generation: number
  worktreePath: string
  branchName: string
  pid?: number
  createdAt: string
}

const TS_JS_EXTENSIONS = new Set(['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs'])

/**
 * Identify mutable AST sites in executable TypeScript/JavaScript code.
 * Targets equality, relational, logical operators and literal/boolean returns.
 */
export function findMutableSites(filePath: string, sourceText: string): MutableSite[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const sites: MutableSite[] = []
  let siteIndex = 0

  function visit(node: ts.Node): void {
    // 1. Binary expressions: equality, relational, logical
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind
      const opStart = node.operatorToken.getStart(sourceFile)
      const opEnd = node.operatorToken.getEnd()
      const opText = sourceText.slice(opStart, opEnd)

      let replacement: { operatorId: string; mutatedText: string } | undefined

      switch (op) {
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
          replacement = { operatorId: 'equality-strict', mutatedText: '!==' }
          break
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
          replacement = { operatorId: 'inequality-strict', mutatedText: '===' }
          break
        case ts.SyntaxKind.EqualsEqualsToken:
          replacement = { operatorId: 'equality-loose', mutatedText: '!=' }
          break
        case ts.SyntaxKind.ExclamationEqualsToken:
          replacement = { operatorId: 'inequality-loose', mutatedText: '==' }
          break
        case ts.SyntaxKind.LessThanToken:
          replacement = { operatorId: 'relational-lt', mutatedText: '>=' }
          break
        case ts.SyntaxKind.LessThanEqualsToken:
          replacement = { operatorId: 'relational-lte', mutatedText: '>' }
          break
        case ts.SyntaxKind.GreaterThanToken:
          replacement = { operatorId: 'relational-gt', mutatedText: '<=' }
          break
        case ts.SyntaxKind.GreaterThanEqualsToken:
          replacement = { operatorId: 'relational-gte', mutatedText: '<' }
          break
        case ts.SyntaxKind.AmpersandAmpersandToken:
          replacement = { operatorId: 'logical-and', mutatedText: '||' }
          break
        case ts.SyntaxKind.BarBarToken:
          replacement = { operatorId: 'logical-or', mutatedText: '&&' }
          break
      }

      if (replacement) {
        siteIndex++
        sites.push({
          id: `mutant-${siteIndex}`,
          path: filePath,
          start: opStart,
          end: opEnd,
          operatorId: replacement.operatorId,
          originalText: opText,
          mutatedText: replacement.mutatedText,
          nodeKind: 'BinaryExpression',
        })
      }
    }

    // 2. Return statements with boolean or simple literal returns
    if (ts.isReturnStatement(node) && node.expression) {
      const expr = node.expression
      const exprStart = expr.getStart(sourceFile)
      const exprEnd = expr.getEnd()
      const exprText = sourceText.slice(exprStart, exprEnd)

      let replacement: { operatorId: string; mutatedText: string } | undefined

      if (expr.kind === ts.SyntaxKind.TrueKeyword) {
        replacement = { operatorId: 'boolean-return-false', mutatedText: 'false' }
      } else if (expr.kind === ts.SyntaxKind.FalseKeyword) {
        replacement = { operatorId: 'boolean-return-true', mutatedText: 'true' }
      } else if (ts.isNumericLiteral(expr)) {
        if (expr.text === '0') {
          replacement = { operatorId: 'literal-return-nonzero', mutatedText: '1' }
        } else if (expr.text === '1') {
          replacement = { operatorId: 'literal-return-zero', mutatedText: '0' }
        }
      } else if (ts.isStringLiteral(expr) && expr.text === '') {
        replacement = { operatorId: 'literal-return-nonempty', mutatedText: '"mutated"' }
      }

      if (replacement) {
        siteIndex++
        sites.push({
          id: `mutant-${siteIndex}`,
          path: filePath,
          start: exprStart,
          end: exprEnd,
          operatorId: replacement.operatorId,
          originalText: exprText,
          mutatedText: replacement.mutatedText,
          nodeKind: 'ReturnStatement',
        })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return sites
}

/**
 * Apply a mutation site to file source text.
 */
export function applyMutation(sourceText: string, site: MutableSite): string {
  return sourceText.slice(0, site.start) + site.mutatedText + sourceText.slice(site.end)
}

/**
 * Select mutable sites across files using recorded deterministic round-robin ordering.
 * Sites per file are sorted by (path, start, end, operatorId).
 */
export function selectMutantsRoundRobin(
  sitesByFile: Map<string, MutableSite[]>,
  maxCount = 20,
): { selected: MutableSite[]; eligible: MutableSite[] } {
  // Deterministically sort file paths
  const sortedFiles = Array.from(sitesByFile.keys()).sort()

  // Deterministically sort sites per file
  const queuesByFile: MutableSite[][] = []
  const allEligible: MutableSite[] = []

  for (const f of sortedFiles) {
    const list = [...(sitesByFile.get(f) ?? [])]
    list.sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path)
      if (a.start !== b.start) return a.start - b.start
      if (a.end !== b.end) return a.end - b.end
      return a.operatorId.localeCompare(b.operatorId)
    })
    queuesByFile.push(list)
    allEligible.push(...list)
  }

  const selected: MutableSite[] = []
  let round = 0
  let added = true

  while (selected.length < maxCount && added) {
    added = false
    for (const queue of queuesByFile) {
      if (round < queue.length) {
        selected.push(queue[round]!)
        added = true
        if (selected.length >= maxCount) break
      }
    }
    round++
  }

  return { selected, eligible: allEligible }
}

/**
 * Default process runner executing child processes in their own process groups with strict timeouts.
 */
export async function defaultTestRunner(
  cwd: string,
  command: { executable: string; args: string[] },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean; error?: Error }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const proc = spawn(command.executable, command.args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `/home/linuxbrew/.linuxbrew/bin:${process.env.PATH ?? ''}`,
        TMPDIR: '/var/tmp',
      },
    })

    proc.stdout?.on('data', (d) => { stdout += d.toString() })
    proc.stderr?.on('data', (d) => { stderr += d.toString() })

    let timer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        try {
          if (proc.pid) process.kill(-proc.pid, 'SIGTERM')
        } catch {
          // Process might already be dead
        }
        killTimer = setTimeout(() => {
          try {
            if (proc.pid) process.kill(-proc.pid, 'SIGKILL')
          } catch {
            // Process might already be dead
          }
        }, 5000)
      }, timeoutMs)
    }

    if (signal) {
      signal.addEventListener('abort', () => {
        try {
          if (proc.pid) process.kill(-proc.pid, 'SIGKILL')
        } catch {
          // ignore
        }
      })
    }

    proc.on('error', (err) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ exitCode: -1, stdout, stderr, timedOut, error: err })
    })

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ exitCode: code ?? (timedOut ? -1 : 0), stdout, stderr, timedOut })
    })
  })
}

/**
 * Reap abandoned sandboxes in the given directory.
 */
export async function reapAbandonedSandboxes(sandboxesDir: string): Promise<string[]> {
  const reaped: string[] = []
  try {
    const entries = await readdir(sandboxesDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = join(sandboxesDir, entry.name)
        const metaPath = join(dirPath, 'sandbox.json')
        try {
          const raw = await readFile(metaPath, 'utf8')
          const meta = JSON.parse(raw) as SandboxMetadata
          if (meta.pid) {
            try {
              process.kill(meta.pid, 0)
              // Still running, skip
              continue
            } catch {
              // Not running, safe to reap
            }
          }
          await rm(dirPath, { recursive: true, force: true })
          reaped.push(entry.name)
        } catch {
          // Malformed or abandoned dir without meta
          await rm(dirPath, { recursive: true, force: true })
          reaped.push(entry.name)
        }
      }
    }
  } catch {
    // Directory might not exist yet
  }
  return reaped
}

/**
 * Execute the Dark Factory Gate 2 Mutation Policy Stage (DF-08).
 */
export async function executeMutationStage(
  options: MutationExecutionOptions,
): Promise<MutationExecutionResult> {
  const {
    repoRoot,
    targetCommit,
    candidateCommit,
    attemptId,
    generation,
    projectId = 'project-1',
    policyRevision = 1,
    testCommand,
    sandboxesDir = join('/var/tmp', `gasteam-mutants-${attemptId}`),
    perMutantTimeoutMs = 120_000,
    stageTimeoutMs = 1_200_000,
    maxMutants = 20,
    applicablePaths,
    docsOnly = false,
    signal,
    gitRunner = runGit,
    testRunner = defaultTestRunner,
  } = options

  const gitSignal = signal ?? new AbortController().signal
  const gitTimeout = 30_000
  const stageStartTime = Date.now()
  const baseRecord = {
    schemaVersion: 1 as const,
    id: `mutant-manifest-${attemptId}`,
    projectId,
    policyRevision,
    attemptId,
    generation,
    candidateCommit,
  }

  // 1. Check for docs-only / non-executable exemption
  if (docsOnly) {
    const manifest: MutantManifestV1 = {
      ...baseRecord,
      eligibleCount: 0,
      selectedCount: 0,
      selectionRevision: 1,
      baseline: 'PASSED_TWICE',
      mutants: [],
    }
    return {
      manifest,
      score: 1,
      decision: 'NOT_APPLICABLE',
      reason: 'Docs-only / non-executable change qualifies for NOT_APPLICABLE rule',
    }
  }

  // 2. Identify changed files between target T and candidate C (T..C)
  const diffOutput = await gitRunner(
    repoRoot,
    ['diff', '--name-status', '-z', targetCommit, candidateCommit],
    gitSignal,
    gitTimeout,
  )
  const diffEntries = diffOutput.split('\0').filter(Boolean)
  const changedFiles: string[] = []

  for (let i = 0; i < diffEntries.length; i++) {
    const entry = diffEntries[i]!
    if (entry.includes('\t')) {
      const parts = entry.split('\t')
      const status = parts[0]!
      if (status.startsWith('R')) {
        const newPath = parts[2] ?? parts[1]
        if (newPath) changedFiles.push(newPath)
      } else if (!status.startsWith('D')) {
        const filePath = parts[1]
        if (filePath) changedFiles.push(filePath)
      }
    } else {
      const status = entry
      if (status.startsWith('R')) {
        i += 2 // skip old and new paths
        const newPath = diffEntries[i]
        if (newPath) changedFiles.push(newPath)
      } else {
        i++
        const filePath = diffEntries[i]
        if (filePath && !status.startsWith('D')) {
          changedFiles.push(filePath)
        }
      }
    }
  }

  // Filter executable TS/JS files
  const executableFiles = changedFiles.filter((p) => {
    const ext = posix.extname(p).toLowerCase()
    if (!TS_JS_EXTENSIONS.has(ext)) return false
    // Skip test files from mutation target
    if (p.includes('.spec.') || p.includes('.test.') || p.startsWith('tests/') || p.startsWith('test/')) {
      return false
    }
    if (applicablePaths && applicablePaths.length > 0) {
      return applicablePaths.some((ap) => p === ap || p.startsWith(ap.replace(/\/?\*+$/, '')))
    }
    return true
  })

  // 3. Double Clean Baseline Execution
  const baselineRun1 = await testRunner(repoRoot, testCommand, perMutantTimeoutMs, signal)
  const baselineRun2 = await testRunner(repoRoot, testCommand, perMutantTimeoutMs, signal)

  const pass1 = baselineRun1.exitCode === 0 && !baselineRun1.timedOut
  const pass2 = baselineRun2.exitCode === 0 && !baselineRun2.timedOut

  let baseline: MutantManifestV1['baseline']

  if (pass1 && pass2) {
    baseline = 'PASSED_TWICE'
  } else if ((pass1 && !pass2) || (!pass1 && pass2)) {
    baseline = 'FLAKY_BASELINE'
  } else {
    baseline = 'FAILED'
  }

  if (baseline !== 'PASSED_TWICE') {
    const manifest: MutantManifestV1 = {
      ...baseRecord,
      eligibleCount: 0,
      selectedCount: 0,
      selectionRevision: 1,
      baseline,
      mutants: [],
    }
    return {
      manifest,
      score: 0,
      decision: baseline === 'FLAKY_BASELINE' ? 'INCONCLUSIVE' : 'FAILED',
      reason: `Double clean baseline check resulted in ${baseline}`,
    }
  }

  // 4. Collect mutable AST sites across changed executable files
  const sitesByFile = new Map<string, MutableSite[]>()

  for (const file of executableFiles) {
    try {
      const content = await gitRunner(repoRoot, ['show', `${candidateCommit}:${file}`], gitSignal, gitTimeout)
      const sites = findMutableSites(file, content)
      if (sites.length > 0) {
        sitesByFile.set(file, sites)
      }
    } catch {
      // File could not be retrieved from commit
    }
  }

  const { selected, eligible } = selectMutantsRoundRobin(sitesByFile, maxMutants)

  if (eligible.length === 0) {
    const manifest: MutantManifestV1 = {
      ...baseRecord,
      eligibleCount: 0,
      selectedCount: 0,
      selectionRevision: 1,
      baseline,
      mutants: [],
    }
    return {
      manifest,
      score: 0,
      decision: 'INSUFFICIENT_EVIDENCE',
      reason: 'Zero valid mutable AST sites found in changed executable code',
    }
  }

  // 5. Evaluate mutants in disposable isolated sandboxes
  await mkdir(sandboxesDir, { recursive: true })
  await reapAbandonedSandboxes(sandboxesDir)

  const evaluatedMutants: MutantManifestV1['mutants'] = []
  const remainingCandidates = [...eligible.filter((s) => !selected.includes(s))]
  const candidatePool = [...selected]

  let mutantIndex = 0

  while (candidatePool.length > 0 && evaluatedMutants.length < maxMutants) {
    // Check total stage timeout
    if (Date.now() - stageStartTime > stageTimeoutMs) {
      break
    }

    const site = candidatePool.shift()!
    mutantIndex++
    const mutantId = `mutant-${mutantIndex}`
    const sandboxPath = join(sandboxesDir, mutantId)
    const branchName = `df-mutant/${attemptId}/${mutantId}`

    let outcome: MutantManifestV1['mutants'][number]['outcome'] = 'SURVIVED'
    let repeatedKill = false

    try {
      await mkdir(sandboxPath, { recursive: true })
      // Create separate disposable candidate worktree
      await gitRunner(
        repoRoot,
        ['worktree', 'add', '-b', branchName, sandboxPath, candidateCommit],
        gitSignal,
        gitTimeout,
      )

      // Persist sandbox ownership metadata
      const meta: SandboxMetadata = {
        attemptId,
        generation,
        worktreePath: sandboxPath,
        branchName,
        createdAt: new Date().toISOString(),
      }
      await writeFile(join(sandboxPath, 'sandbox.json'), JSON.stringify(meta))

      // Apply mutation
      const originalFileContent = await readFile(join(sandboxPath, site.path), 'utf8')
      const mutatedFileContent = applyMutation(originalFileContent, site)

      // Check if mutation causes a syntax/compile error (INVALID mutant)
      const sourceFile = ts.createSourceFile(
        site.path,
        mutatedFileContent,
        ts.ScriptTarget.Latest,
        true,
        site.path.endsWith('.tsx') || site.path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      )
      const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []
      if (parseDiagnostics.length > 0) {
        outcome = 'INVALID'
      } else {
        await writeFile(join(sandboxPath, site.path), mutatedFileContent)

        // Run test in disposable isolated sandbox
        const runRes = await testRunner(sandboxPath, testCommand, perMutantTimeoutMs, signal)

        if (runRes.timedOut) {
          outcome = 'TIMEOUT'
        } else if (runRes.error) {
          outcome = 'INFRA_ERROR'
        } else if (runRes.exitCode === 0) {
          // Tests passed: mutant survived or was not covered
          outcome = 'SURVIVED'
        } else {
          // Tests failed with reproducible assertion failure: verify kill once more
          const rerunRes = await testRunner(sandboxPath, testCommand, perMutantTimeoutMs, signal)
          if (rerunRes.exitCode !== 0 && !rerunRes.timedOut) {
            outcome = 'KILLED'
            repeatedKill = true
          } else {
            outcome = 'SURVIVED'
            repeatedKill = false
          }
        }
      }
    } catch (err) {
      outcome = 'INFRA_ERROR'
    } finally {
      // Disposable cleanup: remove worktree and delete branch
      try {
        await gitRunner(repoRoot, ['worktree', 'remove', '--force', sandboxPath], gitSignal, gitTimeout)
      } catch {
        // ignore
      }
      try {
        await gitRunner(repoRoot, ['branch', '-D', branchName], gitSignal, gitTimeout)
      } catch {
        // ignore
      }
      try {
        await rm(sandboxPath, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }

    // If mutant is INVALID, replace from remaining eligible sites within the cap
    if (outcome === 'INVALID' && remainingCandidates.length > 0) {
      const replacement = remainingCandidates.shift()!
      candidatePool.push(replacement)
    }

    const artifactRef = {
      id: `${mutantId}-artifact`,
      projectId,
      mediaType: 'application/json',
      sizeBytes: 128,
      digest: digestJson({ mutantId, outcome }),
    }

    evaluatedMutants.push({
      id: mutantId,
      path: site.path,
      start: site.start,
      end: site.end,
      operatorId: site.operatorId,
      outcome,
      repeatedKill,
      artifacts: [artifactRef],
    })
  }

  // 6. Calculate mutation score
  let killed = 0
  let survived = 0
  let noCoverage = 0
  let hasTimeoutOrInfra = false

  for (const m of evaluatedMutants) {
    if (m.outcome === 'KILLED') killed++
    else if (m.outcome === 'SURVIVED') survived++
    else if (m.outcome === 'NO_COVERAGE') noCoverage++
    else if (m.outcome === 'TIMEOUT' || m.outcome === 'INFRA_ERROR') {
      hasTimeoutOrInfra = true
    }
  }

  const denominator = killed + survived + noCoverage
  const score = denominator > 0 ? killed / denominator : 0

  let decision: MutationExecutionResult['decision']
  let reason: string | undefined

  if (hasTimeoutOrInfra) {
    decision = 'INCONCLUSIVE'
    reason = 'Stage contains TIMEOUT or INFRA_ERROR outcomes; requires infrastructure retry or quarantine'
  } else if (denominator === 0) {
    decision = 'INSUFFICIENT_EVIDENCE'
    reason = 'No valid resolved mutants evaluated'
  } else if (score >= 2 / 3) {
    decision = 'PASSED'
    reason = `Mutation score ${(score * 100).toFixed(1)}% (killed: ${killed}, survived: ${survived}) meets >= 2/3 threshold`
  } else {
    decision = 'FAILED'
    reason = `Mutation score ${(score * 100).toFixed(1)}% (killed: ${killed}, survived: ${survived}) failed to meet 2/3 threshold`
  }

  const manifest: MutantManifestV1 = {
    ...baseRecord,
    eligibleCount: eligible.length,
    selectedCount: evaluatedMutants.length,
    selectionRevision: 1,
    baseline,
    mutants: evaluatedMutants,
  }

  return {
    manifest,
    score,
    decision,
    reason,
  }
}
