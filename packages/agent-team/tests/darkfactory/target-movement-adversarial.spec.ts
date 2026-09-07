import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ArchitectureGuardError,
  handleTargetAdvancementRetry,
  inspectArchitectureAndPaths,
  type TargetAdvanceRetryResult,
} from '../../src/darkfactory/architecture-guard.ts'
import { gitFixture } from '../git-fixture.ts'

describe('Adversarial Stress: Git 4-Way Comparison & Target Movement Invalidation', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true })))
  })

  async function createRepoFixture() {
    const fixture = await gitFixture(root => roots.push(root))
    const { repository: repoRoot, git } = fixture

    await mkdir(join(repoRoot, 'src', 'allowed'), { recursive: true })
    await mkdir(join(repoRoot, 'src', 'guard'), { recursive: true })
    await mkdir(join(repoRoot, 'tests'), { recursive: true })

    await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const version = 1;\n')
    await writeFile(join(repoRoot, 'src', 'guard', 'policy.ts'), 'export const MAX_RETRIES = 3;\n')
    await writeFile(
      join(repoRoot, 'tests', 'sample.spec.ts'),
      'import { test, expect } from "vitest";\ntest("sample", () => {\n  expect(1).toBe(1);\n});\n',
    )
    await writeFile(
      join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { test: 'vitest run' } }, null, 2),
    )
    await git('add', '.')
    await git('commit', '-m', 'Initial baseline T0')
    const baseCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

    return { repoRoot, git, baseCommit }
  }

  describe('Dimension 1: Target Branch Movement Scenarios', () => {
    it('reliably detects when target branch advances by 1 commit and invalidates merge candidate', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      // Worker branches from T0
      await git('checkout', '-b', 'worker')
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const version = 2;\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker feature work')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Candidate is merged from worker on top of T0
      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Merge candidate C0')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Concurrent promotion advances main by 1 commit
      await writeFile(join(repoRoot, 'src', 'allowed', 'concurrent.ts'), 'export const concurrent = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Target advances by 1 commit: T1')
      const T1 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Guard evaluation with live targetBranch
      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit,
        targetCommit: T0,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
        targetBranch: 'main',
      })

      expect(result.passed).toBe(false)
      const targetViolations = result.violations.filter(v => v.rule === 'TARGET_ADVANCED')
      expect(targetViolations.length).toBeGreaterThanOrEqual(1)
      expect(targetViolations[0]?.message).toContain(
        `Target branch "main" advanced from ${T0} to ${T1}; candidate evidence invalidated.`,
      )
    })

    it('reliably detects when target branch advances by multiple commits (batch/burst)', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      // Worker commits authored changes
      await git('checkout', '-b', 'worker')
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const version = 10;\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker work')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Candidate C0 built on T0
      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Candidate C0')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Target advances by 4 consecutive commits
      for (let i = 1; i <= 4; i++) {
        await writeFile(join(repoRoot, 'src', 'allowed', `adv-${i}.ts`), `export const c${i} = ${i};\n`)
        await git('add', '.')
        await git('commit', '-m', `Target burst commit ${i}`)
      }
      const T4 = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit,
        targetCommit: T0,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
        targetBranch: 'main',
      })

      expect(result.passed).toBe(false)
      const targetViolation = result.violations.find(v => v.rule === 'TARGET_ADVANCED')
      expect(targetViolation).toBeDefined()
      expect(targetViolation?.message).toContain(`advanced from ${T0} to ${T4}`)
    })

    it('reliably detects when target branch is force-pushed via commit amend (divergent SHA)', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      // Worker branch
      await git('checkout', '-b', 'worker')
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const version = 3;\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker work')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Candidate merge on T0
      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Candidate C0')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Target main amends T0 (rewriting history)
      await git('checkout', 'main')
      await writeFile(join(repoRoot, 'src', 'allowed', 'amended.txt'), 'force amend\n')
      await git('add', '.')
      await git('commit', '--amend', '-m', 'Amended T0')
      const T_amended = (await git('rev-parse', 'HEAD')).stdout.trim()

      expect(T_amended).not.toBe(T0)

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit,
        targetCommit: T0,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
        targetBranch: 'main',
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'TARGET_ADVANCED')).toBe(true)
      expect(result.violations.find(v => v.rule === 'TARGET_ADVANCED')?.message).toContain(
        `advanced from ${T0} to ${T_amended}`,
      )
    })

    it('reliably detects when target branch is force-pushed backwards (rewound to prior commit)', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      // Add a commit T1 on main
      await writeFile(join(repoRoot, 'src', 'allowed', 'step1.ts'), 'export const s = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Target T1')
      const T1 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Worker branches from T1
      await git('checkout', '-b', 'worker')
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const f = 2;\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker feature')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Candidate built on T1
      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Candidate C')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Now target main is rolled back to T0 via force-push / hard reset
      await git('reset', '--hard', T0)
      const currentMain = (await git('rev-parse', 'HEAD')).stdout.trim()
      expect(currentMain).toBe(T0)

      // Guard evaluation: candidate was built for T1, but main is now at T0!
      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T1,
        sourceCommit,
        targetCommit: T1,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
        targetBranch: 'main',
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'TARGET_ADVANCED')).toBe(true)
      expect(result.violations.find(v => v.rule === 'TARGET_ADVANCED')?.message).toContain(
        `advanced from ${T1} to ${T0}`,
      )
    })

    it('detects ancestry invalidation even when targetBranch is omitted if targetCommit is updated', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      // Target advances to T1
      await writeFile(join(repoRoot, 'src', 'allowed', 't1.ts'), 'export const t1 = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Target commit T1')
      const T1 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Stale candidate C0 was merged with T0, not descending from T1
      await git('checkout', '-b', 'stale-worker', T0)
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const f = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Stale candidate')
      const staleCandidate = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Caller passes targetCommit: T1, candidateCommit: staleCandidate, without targetBranch
      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit: staleCandidate,
        targetCommit: T1,
        candidateCommit: staleCandidate,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'TARGET_ADVANCED')).toBe(true)
      expect(result.violations.find(v => v.rule === 'TARGET_ADVANCED')?.message).toContain(
        `is not descended from target commit ${T1}; candidate is stale.`,
      )
    })
  })

  describe('Dimension 2: Candidate Construction: Merge Commit vs Rebase / Fast-Forward', () => {
    it('accepts rebased candidate (fast-forward linear history) when target has not moved', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      // Target advances to T1
      await writeFile(join(repoRoot, 'src', 'allowed', 'advance.ts'), 'export const adv = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Target T1')
      const T1 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Worker authored changes from original T0
      await git('checkout', '-b', 'worker', T0)
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const f = 99;\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker commit S')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Candidate is created via rebase onto T1 (linear fast-forward candidate)
      await git('checkout', '-b', 'candidate', 'worker')
      await git('rebase', 'main')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Verify ancestry: T1 is ancestor of candidateCommit
      const isAncestor = await git('merge-base', '--is-ancestor', T1, candidateCommit)
      expect(isAncestor.exitCode).toBe(0)

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit,
        targetCommit: T1,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
        targetBranch: 'main',
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('rejects rebased candidate when target advances further after rebase', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      // Target advances to T1
      await writeFile(join(repoRoot, 'src', 'allowed', 't1.ts'), 'export const t1 = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Target T1')
      const T1 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Worker rebased onto T1
      await git('checkout', '-b', 'worker', T0)
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const f = 100;\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker work')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', '-b', 'candidate', 'worker')
      await git('rebase', 'main')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Target advances further to T2 while candidate was in transit
      await git('checkout', 'main')
      await writeFile(join(repoRoot, 'src', 'allowed', 't2.ts'), 'export const t2 = 2;\n')
      await git('add', '.')
      await git('commit', '-m', 'Target advances to T2')
      const T2 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Evaluate rebased candidate built for T1 against current target main (now at T2)
      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit,
        targetCommit: T1,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
        targetBranch: 'main',
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'TARGET_ADVANCED')).toBe(true)
      expect(result.violations.find(v => v.rule === 'TARGET_ADVANCED')?.message).toContain(
        `advanced from ${T1} to ${T2}`,
      )
    })

    it('accepts fast-forward candidate when target has not moved from base (T0 === B)', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      // Worker creates commit directly on top of T0
      await git('checkout', '-b', 'worker')
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const ff = true;\n')
      await git('add', '.')
      await git('commit', '-m', 'Direct fast-forward commit')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit: candidateCommit,
        targetCommit: T0,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
        targetBranch: 'main',
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('detects smuggled violations introduced in a merge commit resolution (T..C)', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      // Target advances to T1 modifying allowed file
      await writeFile(join(repoRoot, 'src', 'allowed', 'concurrent.ts'), 'export const a = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Target T1')
      const T1 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Worker branch only modifies allowed file
      await git('checkout', '-b', 'worker', T0)
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const b = 2;\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker clean commit')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Merge commit deliberately smuggles an unauthorized directory traversal import
      await git('checkout', 'main')
      await git('merge', '--no-commit', '--no-ff', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'smuggled.ts'),
        'import shadow from "../../../../etc/passwd";\nexport const x = shadow;\n',
      )
      await git('add', '.')
      await git('commit', '-m', 'Smuggled merge resolution')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit,
        targetCommit: T1,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
        targetBranch: 'main',
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'DIRECTORY_TRAVERSAL')).toBe(true)
    })
  })

  describe('Dimension 3: Bounded Retry Logic (handleTargetAdvancementRetry)', () => {
    it('allocates distinct .retry-1, .retry-2, and .retry-3 locations preserving base cwd', () => {
      const initialCwd = '/var/tmp/dsh-worktrees/task-101'

      // Retry 1: from initial failure
      const retry1 = handleTargetAdvancementRetry({
        cwd: initialCwd,
        targetCommit: 'commit-t0',
        candidateCommit: 'commit-c0',
        error: 'Target moved to t1',
      })

      expect(retry1.canRetry).toBe(true)
      expect(retry1.retryCount).toBe(1)
      expect(retry1.nextCwd).toBe('/var/tmp/dsh-worktrees/task-101.retry-1')
      expect(retry1.previousCandidates).toHaveLength(1)
      expect(retry1.previousCandidates[0]).toEqual({
        cwd: initialCwd,
        targetCommit: 'commit-t0',
        candidateCommit: 'commit-c0',
        error: 'Target moved to t1',
      })

      // Retry 2: when retry-1 also encounters target movement
      const retry2 = handleTargetAdvancementRetry({
        cwd: retry1.nextCwd!,
        targetCommit: 'commit-t1',
        candidateCommit: 'commit-c1',
        previousCandidates: retry1.previousCandidates,
        error: 'Target moved to t2',
      })

      expect(retry2.canRetry).toBe(true)
      expect(retry2.retryCount).toBe(2)
      // Base CWD must be preserved from the original attempt, NOT nested (.retry-1.retry-2)
      expect(retry2.nextCwd).toBe('/var/tmp/dsh-worktrees/task-101.retry-2')
      expect(retry2.previousCandidates).toHaveLength(2)
      expect(retry2.previousCandidates[1]?.cwd).toBe('/var/tmp/dsh-worktrees/task-101.retry-1')

      // Retry 3: when retry-2 encounters target movement
      const retry3 = handleTargetAdvancementRetry({
        cwd: retry2.nextCwd!,
        targetCommit: 'commit-t2',
        candidateCommit: 'commit-c2',
        previousCandidates: retry2.previousCandidates,
        error: 'Target moved to t3',
      })

      expect(retry3.canRetry).toBe(true)
      expect(retry3.retryCount).toBe(3)
      expect(retry3.nextCwd).toBe('/var/tmp/dsh-worktrees/task-101.retry-3')
      expect(retry3.previousCandidates).toHaveLength(3)
      expect(retry3.previousCandidates[2]?.cwd).toBe('/var/tmp/dsh-worktrees/task-101.retry-2')

      // 4th Advance: Must strictly fail, refuse retry, and terminate retry loops
      const retry4 = handleTargetAdvancementRetry({
        cwd: retry3.nextCwd!,
        targetCommit: 'commit-t3',
        candidateCommit: 'commit-c3',
        previousCandidates: retry3.previousCandidates,
        error: 'Target moved to t4',
      })

      expect(retry4.canRetry).toBe(false)
      expect(retry4.retryCount).toBe(3)
      expect(retry4.nextCwd).toBeUndefined()
      expect(retry4.error).toContain('Target movement retry limit reached (3)')
      expect(retry4.error).toContain('Candidate checkouts are retained')
      // All 4 candidate attempts must be retained in history
      expect(retry4.previousCandidates).toHaveLength(4)
      expect(retry4.previousCandidates.map(c => c.candidateCommit)).toEqual([
        'commit-c0',
        'commit-c1',
        'commit-c2',
        'commit-c3',
      ])
    })

    it('strictly halts a simulated retry loop on the 4th advance', async () => {
      let currentTarget = 't0'
      const candidates = ['c0', 'c1', 'c2', 'c3', 'c4']
      let retryState: TargetAdvanceRetryResult | undefined

      let attempts = 0
      let loopTerminatedWithError = false
      let finalErrorMessage = ''

      while (attempts < 10) {
        const candidate = candidates[attempts]!
        attempts++

        // Simulate target advancement on every attempt
        const previousTarget = currentTarget
        currentTarget = `t${attempts}`

        // Simulate guard invalidation
        const targetAdvanced = true
        if (targetAdvanced) {
          const result = handleTargetAdvancementRetry({
            cwd: retryState?.nextCwd ?? '/sandbox/candidate',
            targetCommit: previousTarget,
            candidateCommit: candidate,
            previousCandidates: retryState?.previousCandidates,
            error: `Target advanced from ${previousTarget} to ${currentTarget}`,
          })

          if (!result.canRetry) {
            loopTerminatedWithError = true
            finalErrorMessage = result.error ?? 'Retry limit exceeded'
            break
          }
          retryState = result
        }
      }

      // Loop must have stopped after 4 attempts (1 initial + 3 retries)
      expect(attempts).toBe(4)
      expect(loopTerminatedWithError).toBe(true)
      expect(finalErrorMessage).toContain('Target movement retry limit reached (3)')
    })

    it('honors custom maxRetries parameter', () => {
      const singleRetry = handleTargetAdvancementRetry({
        cwd: '/sandbox/work',
        targetCommit: 't0',
        candidateCommit: 'c0',
        maxRetries: 1,
      })
      expect(singleRetry.canRetry).toBe(true)
      expect(singleRetry.retryCount).toBe(1)

      const secondAttempt = handleTargetAdvancementRetry({
        cwd: singleRetry.nextCwd!,
        targetCommit: 't1',
        candidateCommit: 'c1',
        previousCandidates: singleRetry.previousCandidates,
        maxRetries: 1,
      })
      expect(secondAttempt.canRetry).toBe(false)
      expect(secondAttempt.error).toContain('Target movement retry limit reached (1)')
    })
  })

  describe('Dimension 4: End-to-End Multi-Stage Advancement & Stabilization Lifecycle', () => {
    it('exercises end-to-end multi-stage advancement, retry allocation, and eventual qualification', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      // Worker authors feature
      await git('checkout', '-b', 'worker', T0)
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const value = "v1";\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker initial')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Target advances to T1 (first concurrent merge)
      await git('checkout', 'main')
      await writeFile(join(repoRoot, 'src', 'allowed', 'dep-1.ts'), 'export const d1 = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Target T1')
      const T1 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Attempt 1: Candidate C0 built on T0
      await git('checkout', '-b', 'cand-0', T0)
      await git('merge', '--no-ff', 'worker', '-m', 'Merge on T0')
      const C0 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Guard check for C0: must fail with TARGET_ADVANCED
      const guard0 = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit,
        targetCommit: T0,
        candidateCommit: C0,
        allowedPaths: ['src/allowed/**', 'tests/**'],
        targetBranch: 'main',
      })
      expect(guard0.passed).toBe(false)
      expect(guard0.violations.some(v => v.rule === 'TARGET_ADVANCED')).toBe(true)

      // Allocate Retry 1
      const retry1 = handleTargetAdvancementRetry({
        cwd: repoRoot,
        targetCommit: T0,
        candidateCommit: C0,
        error: guard0.violations[0]?.message,
      })
      expect(retry1.canRetry).toBe(true)
      expect(retry1.retryCount).toBe(1)
      expect(retry1.nextCwd).toContain('.retry-1')

      // Attempt 2: Rebuild candidate against T1 creating C1
      await git('checkout', 'main')
      // While candidate is preparing, target advances AGAIN to T2!
      await writeFile(join(repoRoot, 'src', 'allowed', 'dep-2.ts'), 'export const d2 = 2;\n')
      await git('add', '.')
      await git('commit', '-m', 'Target T2')
      const T2 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Worker built C1 against T1
      await git('checkout', '-b', 'cand-1', T1)
      await git('merge', '--no-ff', 'worker', '-m', 'Merge on T1')
      const C1 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Guard check for C1: must fail because main is now at T2!
      const guard1 = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit,
        targetCommit: T1,
        candidateCommit: C1,
        allowedPaths: ['src/allowed/**', 'tests/**'],
        targetBranch: 'main',
      })
      expect(guard1.passed).toBe(false)
      expect(guard1.violations.some(v => v.rule === 'TARGET_ADVANCED')).toBe(true)

      // Allocate Retry 2
      const retry2 = handleTargetAdvancementRetry({
        cwd: retry1.nextCwd!,
        targetCommit: T1,
        candidateCommit: C1,
        previousCandidates: retry1.previousCandidates,
        error: guard1.violations[0]?.message,
      })
      expect(retry2.canRetry).toBe(true)
      expect(retry2.retryCount).toBe(2)
      expect(retry2.nextCwd).toContain('.retry-2')

      // Attempt 3: Target stabilizes at T2. Worker rebuilds candidate C2 on top of T2
      await git('checkout', '-b', 'cand-2', T2)
      await git('merge', '--no-ff', 'worker', '-m', 'Merge on stabilized T2')
      const C2 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Guard check for C2: target branch main is still at T2!
      const guard2 = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit,
        targetCommit: T2,
        candidateCommit: C2,
        allowedPaths: ['src/allowed/**', 'tests/**'],
        targetBranch: 'main',
      })

      // Verification must now succeed!
      expect(guard2.passed).toBe(true)
      expect(guard2.violations).toHaveLength(0)
    })
  })

  describe('Dimension 5: Ref Format and Edge Cases', () => {
    it('handles full ref names (refs/heads/main) gracefully without false failures', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const ref = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Candidate')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Call inspectArchitectureAndPaths with full ref path 'refs/heads/main'
      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit,
        targetCommit: T0,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
        targetBranch: 'refs/heads/main',
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('falls back to ancestry check when targetBranch does not exist', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit: T0,
        targetCommit: T0,
        candidateCommit: T0,
        allowedPaths: ['src/allowed/**', 'tests/**'],
        targetBranch: 'nonexistent-branch',
      })

      // Nonexistent branch does not throw unhandled exception
      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('does not falsely flag TARGET_ADVANCED if targetBranch already points to candidateCommit', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const fast = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker commit')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Target main fast-forwards directly to candidateCommit
      await git('checkout', 'main')
      await git('merge', '--ff-only', 'worker')
      const currentMain = (await git('rev-parse', 'HEAD')).stdout.trim()
      expect(currentMain).toBe(candidateCommit)

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit: candidateCommit,
        targetCommit: T0,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
        targetBranch: 'main',
      })

      // When targetBranch is already at candidateCommit, target branch check must not invalidate it
      expect(result.violations.filter(v => v.rule === 'TARGET_ADVANCED')).toHaveLength(0)
      expect(result.passed).toBe(true)
    })
  })

  describe('Dimension 6: Complex Git Topologies & Parentage', () => {
    it('handles candidate where target is 2nd parent (git merge target into feature)', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      // Target advances to T1
      await writeFile(join(repoRoot, 'src', 'allowed', 't1.ts'), 'export const t1 = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Target T1')
      const T1 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Worker branched from T0
      await git('checkout', '-b', 'worker', T0)
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const feat = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker feat')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Worker merges target INTO worker branch: parent 1 = worker, parent 2 = T1
      await git('merge', '--no-ff', 'main', '-m', 'Sync main into worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // T1 is parent 2, so T1 is an ancestor of candidateCommit
      const isAncestor = await git('merge-base', '--is-ancestor', T1, candidateCommit)
      expect(isAncestor.exitCode).toBe(0)

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit,
        targetCommit: T1,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
        targetBranch: 'main',
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('handles candidate with empty commit (zero changes against target)', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      // Candidate is created as empty commit on top of T0
      await git('commit', '--allow-empty', '-m', 'Empty candidate commit')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit: candidateCommit,
        targetCommit: T0,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
        targetBranch: 'main',
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('handles candidate with octopus merge (combining multiple worker branches with target)', async () => {
      const { repoRoot, git, baseCommit: T0 } = await createRepoFixture()

      // Worker 1
      await git('checkout', '-b', 'worker-1', T0)
      await writeFile(join(repoRoot, 'src', 'allowed', 'feat-1.ts'), 'export const f1 = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker 1 commit')
      const w1 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Worker 2
      await git('checkout', '-b', 'worker-2', T0)
      await writeFile(join(repoRoot, 'src', 'allowed', 'feat-2.ts'), 'export const f2 = 2;\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker 2 commit')
      const w2 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Octopus merge on main: main merges worker-1 and worker-2
      await git('checkout', 'main')
      await git('merge', 'worker-1', 'worker-2', '-m', 'Octopus candidate')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: T0,
        sourceCommit: w1,
        targetCommit: T0,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
        targetBranch: 'main',
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })
  })

  describe('Dimension 7: Strict Termination, Throw Gate & Evidence Retention', () => {
    it('enforces that 4th advance strictly terminates with throwing wrapper', () => {
      function assertOrThrowTargetRetry(options: Parameters<typeof handleTargetAdvancementRetry>[0]): TargetAdvanceRetryResult {
        const result = handleTargetAdvancementRetry(options)
        if (!result.canRetry) {
          throw new ArchitectureGuardError('TARGET_ADVANCEMENT_EXHAUSTED', result.error ?? 'Retry limit reached')
        }
        return result
      }

      const cwd = '/var/tmp/sandbox/worker-run'

      // Advance 1 -> Retry 1 granted
      const r1 = assertOrThrowTargetRetry({ cwd, targetCommit: 't0', candidateCommit: 'c0' })
      expect(r1.nextCwd).toBe(`${cwd}.retry-1`)

      // Advance 2 -> Retry 2 granted
      const r2 = assertOrThrowTargetRetry({
        cwd: r1.nextCwd!,
        targetCommit: 't1',
        candidateCommit: 'c1',
        previousCandidates: r1.previousCandidates,
      })
      expect(r2.nextCwd).toBe(`${cwd}.retry-2`)

      // Advance 3 -> Retry 3 granted
      const r3 = assertOrThrowTargetRetry({
        cwd: r2.nextCwd!,
        targetCommit: 't2',
        candidateCommit: 'c2',
        previousCandidates: r2.previousCandidates,
      })
      expect(r3.nextCwd).toBe(`${cwd}.retry-3`)

      // Advance 4 -> 4th advance MUST throw ArchitectureGuardError and terminate execution
      expect(() => {
        assertOrThrowTargetRetry({
          cwd: r3.nextCwd!,
          targetCommit: 't3',
          candidateCommit: 'c3',
          previousCandidates: r3.previousCandidates,
        })
      }).toThrowError(ArchitectureGuardError)

      // In addition, verify error code and message
      try {
        assertOrThrowTargetRetry({
          cwd: r3.nextCwd!,
          targetCommit: 't3',
          candidateCommit: 'c3',
          previousCandidates: r3.previousCandidates,
        })
      } catch (err) {
        expect(err).toBeInstanceOf(ArchitectureGuardError)
        const gErr = err as ArchitectureGuardError
        expect(gErr.code).toBe('TARGET_ADVANCEMENT_EXHAUSTED')
        expect(gErr.message).toContain('Target movement retry limit reached (3)')
      }
    })

    it('retains complete candidate history items including review receipts across all retries', () => {
      const historyItem0 = {
        cwd: '/work/job',
        targetCommit: 't0',
        candidateCommit: 'c0',
        error: 'Target moved to t1',
        reviewReceipt: { receiptId: 'rcpt-0', stage: 'critics', verdict: 'INVALIDATED' },
      }

      const retry1 = handleTargetAdvancementRetry({
        cwd: '/work/job.retry-1',
        targetCommit: 't1',
        candidateCommit: 'c1',
        previousCandidates: [historyItem0],
      })

      expect(retry1.previousCandidates).toHaveLength(2)
      expect(retry1.previousCandidates[0]?.reviewReceipt).toEqual({
        receiptId: 'rcpt-0',
        stage: 'critics',
        verdict: 'INVALIDATED',
      })
    })

    it('remains strictly locked in terminal failed state on 5th or higher advance', () => {
      const history4 = [
        { cwd: '/work/job', targetCommit: 't0', candidateCommit: 'c0', error: 'e0' },
        { cwd: '/work/job.retry-1', targetCommit: 't1', candidateCommit: 'c1', error: 'e1' },
        { cwd: '/work/job.retry-2', targetCommit: 't2', candidateCommit: 'c2', error: 'e2' },
        { cwd: '/work/job.retry-3', targetCommit: 't3', candidateCommit: 'c3', error: 'e3' },
      ]

      const retry5 = handleTargetAdvancementRetry({
        cwd: '/work/job.retry-3',
        targetCommit: 't4',
        candidateCommit: 'c4',
        previousCandidates: history4,
      })

      expect(retry5.canRetry).toBe(false)
      expect(retry5.nextCwd).toBeUndefined()
      expect(retry5.previousCandidates).toHaveLength(5)
    })
  })
})
