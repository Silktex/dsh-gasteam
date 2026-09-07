import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyMutation,
  defaultTestRunner,
  executeMutationStage,
  findMutableSites,
  reapAbandonedSandboxes,
  selectMutantsRoundRobin,
  type MutableSite,
} from '../../src/darkfactory/mutation-engine.ts'
import { gitFixture } from '../git-fixture.ts'

describe('DF-08 Mutation Policy and Isolated Execution', () => {
  const cleanupDirs: string[] = []

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  describe('Suite 1: AST Mutation Operators and Site Detection', () => {
    it('detects and mutates strict and loose equality/inequality operators', () => {
      const code = `
        const a = x === 1;
        const b = y !== 2;
        const c = z == 3;
        const d = w != 4;
      `
      const sites = findMutableSites('test.ts', code)
      expect(sites).toHaveLength(4)
      expect(sites[0]).toMatchObject({
        operatorId: 'equality-strict',
        originalText: '===',
        mutatedText: '!==',
      })
      expect(sites[1]).toMatchObject({
        operatorId: 'inequality-strict',
        originalText: '!==',
        mutatedText: '===',
      })
      expect(sites[2]).toMatchObject({
        operatorId: 'equality-loose',
        originalText: '==',
        mutatedText: '!=',
      })
      expect(sites[3]).toMatchObject({
        operatorId: 'inequality-loose',
        originalText: '!=',
        mutatedText: '==',
      })
    })

    it('detects and mutates relational and logical operators', () => {
      const code = `
        const a = x < 10;
        const b = y <= 20;
        const c = z > 30;
        const d = w >= 40;
        const e = p && q;
        const f = r || s;
      `
      const sites = findMutableSites('test.ts', code)
      expect(sites).toHaveLength(6)
      expect(sites[0]).toMatchObject({ operatorId: 'relational-lt', originalText: '<', mutatedText: '>=' })
      expect(sites[1]).toMatchObject({ operatorId: 'relational-lte', originalText: '<=', mutatedText: '>' })
      expect(sites[2]).toMatchObject({ operatorId: 'relational-gt', originalText: '>', mutatedText: '<=' })
      expect(sites[3]).toMatchObject({ operatorId: 'relational-gte', originalText: '>=', mutatedText: '<' })
      expect(sites[4]).toMatchObject({ operatorId: 'logical-and', originalText: '&&', mutatedText: '||' })
      expect(sites[5]).toMatchObject({ operatorId: 'logical-or', originalText: '||', mutatedText: '&&' })
    })

    it('detects and mutates type-compatible boolean and literal return statements', () => {
      const code = `
        function f1() { return true; }
        function f2() { return false; }
        function f3() { return 0; }
        function f4() { return 1; }
        function f5() { return ""; }
      `
      const sites = findMutableSites('test.ts', code)
      expect(sites).toHaveLength(5)
      expect(sites[0]).toMatchObject({ operatorId: 'boolean-return-false', mutatedText: 'false' })
      expect(sites[1]).toMatchObject({ operatorId: 'boolean-return-true', mutatedText: 'true' })
      expect(sites[2]).toMatchObject({ operatorId: 'literal-return-nonzero', mutatedText: '1' })
      expect(sites[3]).toMatchObject({ operatorId: 'literal-return-zero', mutatedText: '0' })
      expect(sites[4]).toMatchObject({ operatorId: 'literal-return-nonempty', mutatedText: '"mutated"' })
    })

    it('supports TSX syntax when analyzing .tsx files', () => {
      const tsxCode = `
        export function Component(props: { active: boolean }) {
          return props.active === true ? <div>Active</div> : <div>Inactive</div>;
        }
      `
      const sites = findMutableSites('component.tsx', tsxCode)
      expect(sites.length).toBeGreaterThanOrEqual(1)
      expect(sites.some((s) => s.operatorId === 'equality-strict')).toBe(true)
    })
  })

  describe('Suite 2: Code Mutation Patching', () => {
    it('applies exact AST slice replacement without corrupting surrounding code', () => {
      const code = 'const valid = (x === y) && (z > 0);'
      const sites = findMutableSites('test.ts', code)
      const site = sites.find((s) => s.originalText === '===')!
      const mutated = applyMutation(code, site)
      expect(mutated).toBe('const valid = (x !== y) && (z > 0);')
    })
  })

  describe('Suite 3: Deterministic Round-Robin Selection and Sorting', () => {
    it('sorts sites by path, span start offset, and operator ID', () => {
      const sitesA: MutableSite[] = [
        {
          id: '1',
          path: 'b.ts',
          start: 50,
          end: 52,
          operatorId: 'relational-lt',
          originalText: '<',
          mutatedText: '>=',
          nodeKind: 'BinaryExpression',
        },
        {
          id: '2',
          path: 'b.ts',
          start: 10,
          end: 13,
          operatorId: 'equality-strict',
          originalText: '===',
          mutatedText: '!==',
          nodeKind: 'BinaryExpression',
        },
      ]
      const sitesB: MutableSite[] = [
        {
          id: '3',
          path: 'a.ts',
          start: 20,
          end: 22,
          operatorId: 'logical-and',
          originalText: '&&',
          mutatedText: '||',
          nodeKind: 'BinaryExpression',
        },
      ]

      const map = new Map<string, MutableSite[]>([
        ['b.ts', sitesA],
        ['a.ts', sitesB],
      ])

      const { selected, eligible } = selectMutantsRoundRobin(map, 20)
      expect(eligible).toHaveLength(3)
      // File 'a.ts' comes before 'b.ts' alphabetically
      // Round 0: a.ts (start 20), b.ts (start 10)
      // Round 1: b.ts (start 50)
      expect(selected[0]?.path).toBe('a.ts')
      expect(selected[1]?.path).toBe('b.ts')
      expect(selected[1]?.start).toBe(10)
      expect(selected[2]?.path).toBe('b.ts')
      expect(selected[2]?.start).toBe(50)
    })

    it('enforces maximum 20 mutants cap and partitions eligible vs selected', () => {
      const sites: MutableSite[] = []
      for (let i = 0; i < 30; i++) {
        sites.push({
          id: `m-${i}`,
          path: 'large.ts',
          start: i * 10,
          end: i * 10 + 2,
          operatorId: 'equality-strict',
          originalText: '===',
          mutatedText: '!==',
          nodeKind: 'BinaryExpression',
        })
      }
      const map = new Map<string, MutableSite[]>([['large.ts', sites]])
      const { selected, eligible } = selectMutantsRoundRobin(map, 20)
      expect(eligible).toHaveLength(30)
      expect(selected).toHaveLength(20)
      expect(selected[0]?.start).toBe(0)
      expect(selected[19]?.start).toBe(190)
    })
  })

  describe('Suite 4: Sandbox Reaper and Default Runner Isolation', () => {
    it('reaps dead and corrupt sandboxes while preserving live ones', async () => {
      const testDir = join(tmpdir(), `reaper-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      cleanupDirs.push(testDir)
      await mkdir(testDir, { recursive: true })

      // 1. Sandbox with dead PID
      const deadDir = join(testDir, 'sandbox-dead')
      await mkdir(deadDir, { recursive: true })
      await writeFile(
        join(deadDir, 'sandbox.json'),
        JSON.stringify({ attemptId: 'att-1', generation: 1, pid: 9999999, createdAt: new Date().toISOString() }),
      )

      // 2. Corrupt sandbox without json
      const corruptDir = join(testDir, 'sandbox-corrupt')
      await mkdir(corruptDir, { recursive: true })

      // 3. Live sandbox with current process PID
      const liveDir = join(testDir, 'sandbox-live')
      await mkdir(liveDir, { recursive: true })
      await writeFile(
        join(liveDir, 'sandbox.json'),
        JSON.stringify({ attemptId: 'att-2', generation: 1, pid: process.pid, createdAt: new Date().toISOString() }),
      )

      const reaped = await reapAbandonedSandboxes(testDir)
      expect(reaped).toContain('sandbox-dead')
      expect(reaped).toContain('sandbox-corrupt')
      expect(reaped).not.toContain('sandbox-live')
    })

    it('defaultTestRunner runs commands with detached process group and handles success', async () => {
      const res = await defaultTestRunner(
        process.cwd(),
        { executable: process.execPath, args: ['-e', 'process.stdout.write("runner-ok"); process.exit(0)'] },
        10_000,
      )
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toBe('runner-ok')
      expect(res.timedOut).toBeFalsy()
    })

    it('defaultTestRunner terminates processes exceeding timeoutMs', async () => {
      const res = await defaultTestRunner(
        process.cwd(),
        { executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] },
        200,
      )
      expect(res.timedOut).toBe(true)
      expect(res.exitCode).not.toBe(0)
    })
  })

  describe('Suite 5: Double Clean Baseline Execution', () => {
    const defaultOpts = {
      repoRoot: '/fake/repo',
      targetCommit: '0000000000000000000000000000000000000001',
      candidateCommit: '0000000000000000000000000000000000000002',
      attemptId: 'att-test',
      generation: 1,
      testCommand: { executable: 'pnpm', args: ['test'] },
    }

    it('identifies FLAKY_BASELINE when runs diverge and returns INCONCLUSIVE', async () => {
      let runCount = 0
      const mockTestRunner = async () => {
        runCount++
        return { exitCode: runCount === 1 ? 0 : 1, stdout: '', stderr: '' }
      }
      const mockGitRunner = async () => 'M\tsrc/index.ts\0'

      const result = await executeMutationStage({
        ...defaultOpts,
        gitRunner: mockGitRunner,
        testRunner: mockTestRunner,
      })

      expect(result.manifest.baseline).toBe('FLAKY_BASELINE')
      expect(result.decision).toBe('INCONCLUSIVE')
      expect(result.score).toBe(0)
    })

    it('identifies FAILED baseline when both baseline runs fail', async () => {
      const mockTestRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' })
      const mockGitRunner = async () => 'M\tsrc/index.ts\0'

      const result = await executeMutationStage({
        ...defaultOpts,
        gitRunner: mockGitRunner,
        testRunner: mockTestRunner,
      })

      expect(result.manifest.baseline).toBe('FAILED')
      expect(result.decision).toBe('FAILED')
      expect(result.score).toBe(0)
    })

    it('returns NOT_APPLICABLE with score 1 when docsOnly is specified', async () => {
      const result = await executeMutationStage({
        ...defaultOpts,
        docsOnly: true,
      })

      expect(result.decision).toBe('NOT_APPLICABLE')
      expect(result.score).toBe(1)
      expect(result.manifest.baseline).toBe('PASSED_TWICE')
    })
  })

  describe('Suite 6: Mutant Classification, Repeated Kill, and Score Calculation', () => {
    it('requires repeated kill verification for reproducible test assertion failures', async () => {
      const testDir = join(tmpdir(), `kill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      cleanupDirs.push(testDir)
      await mkdir(testDir, { recursive: true })

      const fileContent = 'export function check(x: number) { return x === 1; }\n'
      const changedFile = 'src/check.ts'

      let testCallCount = 0
      const mockTestRunner = async () => {
        testCallCount++
        // Calls 1 & 2: Double baseline -> exit 0
        if (testCallCount <= 2) {
          return { exitCode: 0, stdout: 'ok', stderr: '' }
        }
        // Call 3: Mutant run 1 -> test assertion failure (exit 1)
        // Call 4: Repeated kill run -> test assertion failure (exit 1)
        return { exitCode: 1, stdout: '', stderr: 'AssertionError: expected false to be true' }
      }

      const mockGitRunner = async (cwd: string, args: readonly string[]) => {
        const cmd = args[0]
        if (cmd === 'diff') return `M\t${changedFile}\0`
        if (cmd === 'show') return fileContent
        if (cmd === 'worktree' && args[1] === 'add') {
          const destDir = args[4]!
          await mkdir(join(destDir, 'src'), { recursive: true })
          await writeFile(join(destDir, changedFile), fileContent)
          return ''
        }
        return ''
      }

      const result = await executeMutationStage({
        repoRoot: '/fake/repo',
        targetCommit: '0000000000000000000000000000000000000001',
        candidateCommit: '0000000000000000000000000000000000000002',
        attemptId: 'att-kill',
        generation: 1,
        sandboxesDir: testDir,
        testCommand: { executable: 'test', args: [] },
        gitRunner: mockGitRunner,
        testRunner: mockTestRunner,
      })

      expect(result.decision).toBe('PASSED')
      expect(result.score).toBe(1)
      expect(result.manifest.mutants[0]?.outcome).toBe('KILLED')
      expect(result.manifest.mutants[0]?.repeatedKill).toBe(true)
    })

    it('classifies mutant as SURVIVED if second kill verification fails', async () => {
      const testDir = join(tmpdir(), `survive-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      cleanupDirs.push(testDir)
      await mkdir(testDir, { recursive: true })

      const fileContent = 'export function check(x: number) { return x === 1; }\n'
      const changedFile = 'src/check.ts'

      let testCallCount = 0
      const mockTestRunner = async () => {
        testCallCount++
        if (testCallCount <= 2) return { exitCode: 0, stdout: '', stderr: '' }
        // Call 3: Mutant run 1 -> failed (exit 1)
        if (testCallCount === 3) return { exitCode: 1, stdout: '', stderr: '' }
        // Call 4: Repeated run -> passes (exit 0) => flaked, so survived
        return { exitCode: 0, stdout: '', stderr: '' }
      }

      const mockGitRunner = async (cwd: string, args: readonly string[]) => {
        const cmd = args[0]
        if (cmd === 'diff') return `M\t${changedFile}\0`
        if (cmd === 'show') return fileContent
        if (cmd === 'worktree' && args[1] === 'add') {
          const destDir = args[4]!
          await mkdir(join(destDir, 'src'), { recursive: true })
          await writeFile(join(destDir, changedFile), fileContent)
          return ''
        }
        return ''
      }

      const result = await executeMutationStage({
        repoRoot: '/fake/repo',
        targetCommit: '0000000000000000000000000000000000000001',
        candidateCommit: '0000000000000000000000000000000000000002',
        attemptId: 'att-survive',
        generation: 1,
        sandboxesDir: testDir,
        testCommand: { executable: 'test', args: [] },
        gitRunner: mockGitRunner,
        testRunner: mockTestRunner,
      })

      expect(result.decision).toBe('FAILED')
      expect(result.score).toBe(0)
      expect(result.manifest.mutants[0]?.outcome).toBe('SURVIVED')
      expect(result.manifest.mutants[0]?.repeatedKill).toBe(false)
    })

    it('marks stage INCONCLUSIVE when a TIMEOUT occurs', async () => {
      const testDir = join(tmpdir(), `timeout-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      cleanupDirs.push(testDir)
      await mkdir(testDir, { recursive: true })

      const fileContent = 'export function check(x: number) { return x === 1; }\n'
      const changedFile = 'src/check.ts'

      let testCallCount = 0
      const mockTestRunner = async () => {
        testCallCount++
        if (testCallCount <= 2) return { exitCode: 0, stdout: '', stderr: '' }
        return { exitCode: -1, stdout: '', stderr: '', timedOut: true }
      }

      const mockGitRunner = async (cwd: string, args: readonly string[]) => {
        const cmd = args[0]
        if (cmd === 'diff') return `M\t${changedFile}\0`
        if (cmd === 'show') return fileContent
        if (cmd === 'worktree' && args[1] === 'add') {
          const destDir = args[4]!
          await mkdir(join(destDir, 'src'), { recursive: true })
          await writeFile(join(destDir, changedFile), fileContent)
          return ''
        }
        return ''
      }

      const result = await executeMutationStage({
        repoRoot: '/fake/repo',
        targetCommit: '0000000000000000000000000000000000000001',
        candidateCommit: '0000000000000000000000000000000000000002',
        attemptId: 'att-timeout',
        generation: 1,
        sandboxesDir: testDir,
        testCommand: { executable: 'test', args: [] },
        gitRunner: mockGitRunner,
        testRunner: mockTestRunner,
      })

      expect(result.decision).toBe('INCONCLUSIVE')
      expect(result.manifest.mutants[0]?.outcome).toBe('TIMEOUT')
    })

    it('returns INSUFFICIENT_EVIDENCE when zero valid mutable AST sites exist in executable code', async () => {
      const mockTestRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' })
      const mockGitRunner = async (cwd: string, args: readonly string[]) => {
        if (args[0] === 'diff') return 'M\tsrc/empty.ts\0'
        if (args[0] === 'show') return '// comment only, no executable mutable expressions\n'
        return ''
      }

      const result = await executeMutationStage({
        repoRoot: '/fake/repo',
        targetCommit: '0000000000000000000000000000000000000001',
        candidateCommit: '0000000000000000000000000000000000000002',
        attemptId: 'att-empty',
        generation: 1,
        testCommand: { executable: 'test', args: [] },
        gitRunner: mockGitRunner,
        testRunner: mockTestRunner,
      })

      expect(result.decision).toBe('INSUFFICIENT_EVIDENCE')
      expect(result.score).toBe(0)
    })

    it('enforces score threshold >= 2/3 (passes at 66.7%+, fails below)', async () => {
      const testDir = join(tmpdir(), `threshold-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      cleanupDirs.push(testDir)
      await mkdir(testDir, { recursive: true })

      // File with 3 mutable sites: 2 killed, 1 survived => 2/3 (66.67%) => PASSED
      const fileContent = `
        export function a(x: number) { return x === 1; }
        export function b(y: number) { return y !== 2; }
        export function c(z: number) { return z > 3; }
      `
      const changedFile = 'src/multi.ts'

      let mutantExecutionCount = 0
      const mockTestRunner = async () => {
        mutantExecutionCount++
        // Baselines 1 & 2
        if (mutantExecutionCount <= 2) return { exitCode: 0, stdout: '', stderr: '' }
        // Mutant 1 (runs 3 & 4): KILLED
        if (mutantExecutionCount === 3 || mutantExecutionCount === 4) {
          return { exitCode: 1, stdout: '', stderr: 'Assertion failed' }
        }
        // Mutant 2 (runs 5 & 6): KILLED
        if (mutantExecutionCount === 5 || mutantExecutionCount === 6) {
          return { exitCode: 1, stdout: '', stderr: 'Assertion failed' }
        }
        // Mutant 3 (run 7): SURVIVED (passes)
        return { exitCode: 0, stdout: '', stderr: '' }
      }

      const mockGitRunner = async (cwd: string, args: readonly string[]) => {
        const cmd = args[0]
        if (cmd === 'diff') return `M\t${changedFile}\0`
        if (cmd === 'show') return fileContent
        if (cmd === 'worktree' && args[1] === 'add') {
          const destDir = args[4]!
          await mkdir(join(destDir, 'src'), { recursive: true })
          await writeFile(join(destDir, changedFile), fileContent)
          return ''
        }
        return ''
      }

      const result = await executeMutationStage({
        repoRoot: '/fake/repo',
        targetCommit: '0000000000000000000000000000000000000001',
        candidateCommit: '0000000000000000000000000000000000000002',
        attemptId: 'att-threshold',
        generation: 1,
        sandboxesDir: testDir,
        testCommand: { executable: 'test', args: [] },
        gitRunner: mockGitRunner,
        testRunner: mockTestRunner,
      })

      expect(result.manifest.mutants).toHaveLength(3)
      expect(result.score).toBeCloseTo(2 / 3, 4)
      expect(result.decision).toBe('PASSED')
    })
  })

  describe('Suite 7: Real Git Worktree Integration', () => {
    it('executes mutation stage against real Git repository with worktree isolation', async () => {
      const roots: string[] = []
      const { repository: repoRoot, git } = await gitFixture((r) => roots.push(r))
      cleanupDirs.push(...roots)

      await mkdir(join(repoRoot, 'src'), { recursive: true })
      await writeFile(
        join(repoRoot, 'src', 'calc.ts'),
        'export function calc(a: number, b: number) { return a === b; }\n',
      )
      await git('add', '.')
      await git('commit', '-m', 'Target baseline')
      const targetCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', '-b', 'worker-candidate')
      await writeFile(
        join(repoRoot, 'src', 'calc.ts'),
        'export function calc(a: number, b: number) { return a === b && a > 0; }\n',
      )
      await git('add', '.')
      await git('commit', '-m', 'Candidate implementation')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const sandboxesDir = join(tmpdir(), `real-git-mutants-${Date.now()}`)
      cleanupDirs.push(sandboxesDir)

      let testRuns = 0
      const mockTestRunner = async () => {
        testRuns++
        // Baselines 1 & 2 pass
        if (testRuns <= 2) return { exitCode: 0, stdout: '', stderr: '' }
        // All mutant runs fail assertion (killed)
        return { exitCode: 1, stdout: '', stderr: 'Assertion failure' }
      }

      const result = await executeMutationStage({
        repoRoot,
        targetCommit,
        candidateCommit,
        attemptId: 'att-real-git',
        generation: 1,
        sandboxesDir,
        testCommand: { executable: 'pnpm', args: ['test'] },
        testRunner: mockTestRunner,
      })

      expect(result.manifest.baseline).toBe('PASSED_TWICE')
      expect(result.manifest.mutants.length).toBeGreaterThanOrEqual(1)
      expect(result.decision).toBe('PASSED')
      expect(result.score).toBe(1)
    })
  })
})
