import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  handleTargetAdvancementRetry,
  inspectArchitectureAndPaths,
} from '../../src/darkfactory/architecture-guard.ts'
import { gitFixture } from '../git-fixture.ts'

describe('DF-07 Architecture and AST Path Guard', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true })))
  })

  async function createFixture() {
    const fixture = await gitFixture(root => roots.push(root))
    const { repository: repoRoot, git } = fixture

    await mkdir(join(repoRoot, 'src', 'allowed'), { recursive: true })
    await mkdir(join(repoRoot, 'src', 'guard'), { recursive: true })
    await mkdir(join(repoRoot, 'tests'), { recursive: true })

    await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const a = 1;\n')
    await writeFile(join(repoRoot, 'src', 'guard', 'policy.ts'), 'export const MAX_RETRIES = 3;\n')
    await writeFile(
      join(repoRoot, 'tests', 'sample.spec.ts'),
      'import { test, expect } from "vitest";\ntest("sample", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n',
    )
    await writeFile(
      join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'test-fixture', scripts: { test: 'vitest run' } }, null, 2),
    )
    await git('add', '.')
    await git('commit', '-m', 'Initial baseline')
    const baseCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

    return { repoRoot, git, baseCommit }
  }

  describe('Suite 1: Static AST Inspection via TypeScript Compiler API', () => {
    it('accepts static ES Module imports and re-exports across all syntactic variants', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'imports.ts'),
        `import def from './feature.js'
import { a, a as aliasA } from './feature.js'
import * as all from './feature.js'
import './feature.js'
import type { T } from './feature.js'
import json from './data.json' with { type: 'json' }
export { a } from './feature.js'
export * from './feature.js'
export * as ns from './feature.js'
export type { T } from './feature.js'
export const used = def || a || aliasA || all || json
`,
      )
      await writeFile(join(repoRoot, 'src', 'allowed', 'data.json'), '{"ok":true}')
      await git('add', '.')
      await git('commit', '-m', 'Add static imports')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
      expect(result.scannedFiles).toContain('src/allowed/imports.ts')
    })

    it('accepts static CommonJS require, require.resolve, and TypeScript import-equals', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'cjs.ts'),
        `const dep = require('./feature.js')
const mod = module.require('./feature.js')
const p = require.resolve('./feature.js')
import feat = require('./feature.js')
export const out = [dep, mod, p, feat]
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Add static require')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('accepts static dynamic imports and no-substitution template literals', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'dyn-static.ts'),
        `export async function load() {
  const d1 = await import('./feature.js')
  const d2 = await import('./feature.js', { with: { type: 'json' } })
  const d3 = await import(\`./feature.js\`)
  const r1 = require(\`./feature.js\`)
  return [d1, d2, d3, r1]
}
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Add static dynamic import')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('exempts internal local exports from external module specifier checks', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'local-exports.ts'),
        `export const num = 42
export function greet() { return 'hello' }
export default function main() { return 0 }
const internalVal = 100
export { internalVal }
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Add local exports')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('rejects dynamic import with computed expression (fail closed)', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'computed-import.ts'),
        `const dyn = './feature.js'
export async function load(name: string) {
  const a = await import(dyn)
  const b = await import('./' + name)
  const c = await import(\`./\${name}\`)
  return [a, b, c]
}
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Add computed imports')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      const computedViolations = result.violations.filter(v => v.rule === 'FORBIDDEN_COMPUTED_IMPORT')
      expect(computedViolations.length).toBeGreaterThanOrEqual(3)
    })

    it('rejects CommonJS require with computed expression (fail closed)', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'computed-require.ts'),
        `const dyn = './feature.js'
export function load(name: string) {
  const a = require(dyn)
  const b = require('./' + name)
  const c = require(\`./\${name}\`)
  const d = module.require(name)
  return [a, b, c, d]
}
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Add computed require')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      const computedViolations = result.violations.filter(v => v.rule === 'FORBIDDEN_COMPUTED_IMPORT')
      expect(computedViolations.length).toBeGreaterThanOrEqual(4)
    })

    it('rejects require.resolve with computed argument and 0-argument calls (fail closed)', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'computed-resolve.ts'),
        `declare const p: string;
export function run() {
  const a = require.resolve(p)
  const b = (require as any)()
  return [a, b]
}
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Add computed resolve')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      const computedViolations = result.violations.filter(v => v.rule === 'FORBIDDEN_COMPUTED_IMPORT')
      expect(computedViolations.length).toBeGreaterThanOrEqual(2)
    })

    it('does not produce false positives on comments or string literals mimicking imports', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'fake-imports.ts'),
        `// import evil from 'evil'
/* require(computedVar) */
const str1 = "import('evil'); require(computed);"
const str2 = \`import(\${variable})\`
export const message = str1 + str2
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Add comments and strings')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('does not produce false positives on JSX attributes named require or import', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'component.tsx'),
        `import React from 'react'
export const Comp = () => {
  return <div id="test" />
}
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Add tsx component')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('fails closed with PARSE_ERROR when a governed TypeScript file has syntax parse errors', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'malformed.ts'),
        `import { from './missing';
function unclosed( {
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Add malformed file')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'PARSE_ERROR')).toBe(true)
    })
  })

  describe('Suite 2: Path Security and Sandboxing', () => {
    it('accepts changes within spec.allowedPaths', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(join(repoRoot, 'src', 'allowed', 'valid.ts'), 'export const valid = true;\n')
      await git('add', '.')
      await git('commit', '-m', 'Valid change')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('rejects changes outside spec.allowedPaths with PATH_NOT_ALLOWED', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await mkdir(join(repoRoot, 'src', 'outside'), { recursive: true })
      await writeFile(join(repoRoot, 'src', 'outside', 'evil.ts'), 'export const evil = true;\n')
      await git('add', '.')
      await git('commit', '-m', 'Unauthorized path')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'PATH_NOT_ALLOWED')).toBe(true)
    })

    it('enforces deniedPaths over allowedPaths prefixes with DENIED_PATH', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await mkdir(join(repoRoot, 'src', 'allowed', 'secrets'), { recursive: true })
      await writeFile(join(repoRoot, 'src', 'allowed', 'secrets', 'leak.ts'), 'export const leak = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Add secrets')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
        deniedPaths: ['src/allowed/secrets/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'DENIED_PATH')).toBe(true)
    })

    it('rejects directory traversal in import specifiers with DIRECTORY_TRAVERSAL', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'traversal.ts'),
        `import shadow from '../../../../etc/passwd'
export const s = shadow
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Traversal import')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'DIRECTORY_TRAVERSAL')).toBe(true)
    })

    it('rejects import specifiers targeting Git metadata directory (.git/)', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'git-meta.ts'),
        `import config from '../../.git/config'
export const c = config
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Git metadata import')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'GIT_METADATA_VIOLATION' || v.rule === 'DIRECTORY_TRAVERSAL')).toBe(true)
    })

    it('rejects tracked Git symlinks pointing to absolute paths (mode 120000 to /etc/passwd)', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await symlink('/etc/passwd', join(repoRoot, 'src', 'allowed', 'abs_link'))
      await git('add', 'src/allowed/abs_link')
      await git('commit', '-m', 'Absolute symlink')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'SYMLINK_ESCAPE')).toBe(true)
    })

    it('rejects tracked Git symlinks pointing to relative paths escaping repo root', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await symlink('../../../../etc/passwd', join(repoRoot, 'src', 'allowed', 'rel_escape'))
      await git('add', 'src/allowed/rel_escape')
      await git('commit', '-m', 'Relative escaping symlink')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'SYMLINK_ESCAPE')).toBe(true)
    })

    it('accepts valid internal symlinks staying strictly within allowedPaths', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await symlink('./feature.ts', join(repoRoot, 'src', 'allowed', 'internal_link.ts'))
      await git('add', 'src/allowed/internal_link.ts')
      await git('commit', '-m', 'Internal symlink')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('validates both old and new paths in Git rename operations (R100)', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await mkdir(join(repoRoot, 'src', 'forbidden'), { recursive: true })
      await git('mv', 'src/allowed/feature.ts', 'src/forbidden/renamed.ts')
      await git('commit', '-m', 'Rename out of bounds')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'PATH_NOT_ALLOWED')).toBe(true)
    })

    it('rejects deletion of files outside allowedPaths', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await git('rm', 'package.json')
      await git('commit', '-m', 'Delete package.json')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'PATH_NOT_ALLOWED' || v.rule === 'POLICY_WEAKENING')).toBe(true)
    })

    it('rejects unauthorized file mode tampering (chmod +x)', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await chmod(join(repoRoot, 'src', 'allowed', 'feature.ts'), 0o755)
      await git('add', 'src/allowed/feature.ts')
      await git('commit', '-m', 'Chmod executable')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'FILE_MODE_TAMPERING')).toBe(true)
    })

    it('rejects introduction of unauthorized binary files', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(join(repoRoot, 'src', 'allowed', 'libnative.so'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      await git('add', 'src/allowed/libnative.so')
      await git('commit', '-m', 'Add binary shared object')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'UNAUTHORIZED_BINARY_FILE')).toBe(true)
    })

    it('inspects both authored changes B..S and promotion changes T..C (catching smuggled changes)', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      // Worker branch only modifies allowed file
      await git('checkout', '-b', 'worker')
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const a = 2;\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker feature update')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // When merging into main, candidate commit smuggles an unauthorized file change
      await git('checkout', 'main')
      await git('merge', '--no-commit', '--no-ff', 'worker')
      await writeFile(join(repoRoot, 'src', 'guard', 'policy.ts'), 'export const MAX_RETRIES = 99;\n')
      await git('add', '.')
      await git('commit', '-m', 'Evil merge with smuggled guard modification')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'GUARD_CODE_TAMPERING' || v.rule === 'PATH_NOT_ALLOWED')).toBe(true)
    })
  })

  describe('Suite 3: Integrity Protection', () => {
    it('rejects candidate changes attempting to modify or delete guard code', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(join(repoRoot, 'src', 'guard', 'policy.ts'), 'export const MAX_RETRIES = 0;\n')
      await git('add', '.')
      await git('commit', '-m', 'Tamper with guard policy')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'GUARD_CODE_TAMPERING')).toBe(true)
    })

    it('rejects candidate changes attempting to weaken package.json test scripts', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'package.json'),
        JSON.stringify({ name: 'test-fixture', scripts: { test: 'exit 0' } }, null, 2),
      )
      await git('add', 'package.json')
      await git('commit', '-m', 'Weaken test script')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['package.json', 'src/allowed/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'POLICY_WEAKENING')).toBe(true)
    })

    it('rejects deletion of pinned test suite files', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await git('rm', 'tests/sample.spec.ts')
      await git('commit', '-m', 'Delete test suite')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'TEST_SUITE_DELETED')).toBe(true)
    })

    it('rejects removal of test cases from existing test suites (N_cand < N_base)', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      // Baseline had sample.spec.ts with 1 test case. Let's add another test in base first.
      await writeFile(
        join(repoRoot, 'tests', 'sample.spec.ts'),
        `import { test, expect } from "vitest";
test("test1", () => { expect(1).toBe(1); });
test("test2", () => { expect(2).toBe(2); });
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Base with 2 tests')
      const targetCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Worker removes 1 test case
      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'tests', 'sample.spec.ts'),
        `import { test, expect } from "vitest";
test("test1", () => { expect(1).toBe(1); });
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Remove 1 test case')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: targetCommit,
        sourceCommit,
        targetCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'TEST_CASES_REMOVED')).toBe(true)
    })

    it('rejects introduction of test skipping (.skip or xit)', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'tests', 'sample.spec.ts'),
        `import { test, expect } from "vitest";
test.skip("sample", () => {
  expect(1).toBe(1);
});
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Skip test')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'TEST_SKIPPED')).toBe(true)
    })

    it('rejects removal or weakening of expect assertions', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      // Base had 2 expect calls. Worker removes 1 expect call.
      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'tests', 'sample.spec.ts'),
        `import { test, expect } from "vitest";
test("sample", () => {
  expect(1).toBe(1);
});
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Drop 1 expect call')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'TEST_ASSERTION_WEAKENED')).toBe(true)
    })

    it('permits candidates to add new test files and supplement test suites without weakening', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      // Supplement existing test file with additional test and assertions
      await writeFile(
        join(repoRoot, 'tests', 'sample.spec.ts'),
        `import { test, expect } from "vitest";
test("sample", () => {
  expect(1).toBe(1);
  expect(2).toBe(2);
});
test("sample addition", () => {
  expect(3).toBe(3);
});
`,
      )
      // Add a brand new test file
      await writeFile(
        join(repoRoot, 'tests', 'new-feature.spec.ts'),
        `import { test, expect } from "vitest";
test("new feature", () => {
  expect(true).toBe(true);
});
`,
      )
      await git('add', '.')
      await git('commit', '-m', 'Supplement tests')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })
  })

  describe('Suite 4: Target Branch Advancement and Bounded Retry', () => {
    it('detects when target branch commit has advanced (T !== T_prev)', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      // Worker branches from baseCommit
      await git('checkout', '-b', 'worker')
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const a = 42;\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker commit')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Candidate was built on baseCommit
      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Integrate on base')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Main branch advances further with another commit (simulating concurrent promotion)
      await writeFile(join(repoRoot, 'src', 'allowed', 'concurrent.ts'), 'export const conc = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Target branch advances')
      const newTargetCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Guard checks candidate built against baseCommit, but targetBranch main is now at newTargetCommit
      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**'],
        targetBranch: 'main',
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'TARGET_ADVANCED')).toBe(true)
      expect(result.violations.find(v => v.rule === 'TARGET_ADVANCED')?.message).toContain(
        `Target branch "main" advanced from ${baseCommit} to ${newTargetCommit}`,
      )
    })

    it('detects when candidate is not descended from target commit', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      // Advance target branch
      await writeFile(join(repoRoot, 'src', 'allowed', 'other.ts'), 'export const x = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Advance main')
      const advancedTarget = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Stale candidate built from baseCommit without merging advancedTarget
      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit: baseCommit,
        targetCommit: advancedTarget,
        candidateCommit: baseCommit,
        allowedPaths: ['src/allowed/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'TARGET_ADVANCED')).toBe(true)
    })

    it('handleTargetAdvancementRetry allocates isolated retry workspace at deterministic path <cwd>.retry-N', () => {
      const retry1 = handleTargetAdvancementRetry({
        cwd: '/work/job-1',
        targetCommit: 'target-1',
        candidateCommit: 'cand-1',
      })

      expect(retry1.canRetry).toBe(true)
      expect(retry1.retryCount).toBe(1)
      expect(retry1.nextCwd).toBe('/work/job-1.retry-1')
      expect(retry1.previousCandidates).toHaveLength(1)
      expect(retry1.previousCandidates[0]?.cwd).toBe('/work/job-1')

      const retry2 = handleTargetAdvancementRetry({
        cwd: '/work/job-1.retry-1',
        targetCommit: 'target-2',
        candidateCommit: 'cand-2',
        previousCandidates: retry1.previousCandidates,
      })

      expect(retry2.canRetry).toBe(true)
      expect(retry2.retryCount).toBe(2)
      expect(retry2.nextCwd).toBe('/work/job-1.retry-2')
      expect(retry2.previousCandidates).toHaveLength(2)
    })

    it('handleTargetAdvancementRetry enforces bounded retry limit of at most 3 retries, failing on the 4th advance', () => {
      const history = [
        { cwd: '/work/job-1', targetCommit: 't1', candidateCommit: 'c1', error: 'stale 1' },
        { cwd: '/work/job-1.retry-1', targetCommit: 't2', candidateCommit: 'c2', error: 'stale 2' },
        { cwd: '/work/job-1.retry-2', targetCommit: 't3', candidateCommit: 'c3', error: 'stale 3' },
      ]

      const retry4 = handleTargetAdvancementRetry({
        cwd: '/work/job-1.retry-3',
        targetCommit: 't4',
        candidateCommit: 'c4',
        previousCandidates: history,
        maxRetries: 3,
      })

      expect(retry4.canRetry).toBe(false)
      expect(retry4.retryCount).toBe(3)
      expect(retry4.error).toContain('Target movement retry limit reached (3)')
      expect(retry4.previousCandidates).toHaveLength(4)
    })

    it('successfully validates candidate when target branch stabilizes after retry', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      // Target advances to T2
      await writeFile(join(repoRoot, 'src', 'allowed', 'update.ts'), 'export const u = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Target commit T2')
      const targetT2 = (await git('rev-parse', 'HEAD')).stdout.trim()

      // Worker integrates on top of T2 creating C2
      await git('checkout', '-b', 'worker-retry')
      await writeFile(join(repoRoot, 'src', 'allowed', 'feature.ts'), 'export const a = 999;\n')
      await git('add', '.')
      await git('commit', '-m', 'Worker commit on retry')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker-retry', '-m', 'Integrate candidate C2')
      const candidateC2 = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: targetT2,
        candidateCommit: candidateC2,
        allowedPaths: ['src/allowed/**'],
        targetBranch: 'main',
      })

      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })
  })

  describe('Suite 5: Hardened Evasion Protection (DF-07 It2)', () => {
    it('rejects tagged template require expressions like (require)`./evil`', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'tagged.ts'),
        'export const a = (require)`./feature.js`;\n',
      )
      await git('add', '.')
      await git('commit', '-m', 'Tagged template require')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Merge worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'FORBIDDEN_COMPUTED_IMPORT')).toBe(true)
    })

    it('rejects dynamic element access require like module["require"]("../guard/policy.js")', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'element.ts'),
        'export const a = module["require"]("../guard/policy.js");\n',
      )
      await git('add', '.')
      await git('commit', '-m', 'Element access require')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Merge worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'PATH_NOT_ALLOWED')).toBe(true)
    })

    it('rejects comma-expression-wrapped require calls like (0, require)("../guard/policy.js")', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'comma.ts'),
        'export const a = (0, require)("../guard/policy.js");\n',
      )
      await git('add', '.')
      await git('commit', '-m', 'Comma require')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Merge worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'PATH_NOT_ALLOWED')).toBe(true)
    })

    it('rejects aliased require variables like const r = require; r("../guard/policy.js")', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'alias.ts'),
        'const r = require;\nexport const a = r("../guard/policy.js");\n',
      )
      await git('add', '.')
      await git('commit', '-m', 'Aliased require')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Merge worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'PATH_NOT_ALLOWED')).toBe(true)
    })

    it('rejects backslash directory traversal in import specifiers', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'backslash.ts'),
        'import x from ".\\\\..\\\\..\\\\etc\\\\passwd";\n',
      )
      await git('add', '.')
      await git('commit', '-m', 'Backslash import')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Merge worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'DIRECTORY_TRAVERSAL')).toBe(true)
    })

    it('rejects backslashes in tracked symlink targets', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await symlink('subdir\\..\\..\\..\\..\\etc\\passwd', join(repoRoot, 'src', 'allowed', 'link'))
      await git('add', 'src/allowed/link')
      await git('commit', '-m', 'Backslash symlink')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Merge worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'SYMLINK_ESCAPE')).toBe(true)
    })

    it('rejects URL-encoded path traversal in import specifiers', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'url.ts'),
        'import x from "%2e%2e/%2e%2e/etc/passwd";\n',
      )
      await git('add', '.')
      await git('commit', '-m', 'URL encoded import')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Merge worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'DIRECTORY_TRAVERSAL')).toBe(true)
    })

    it('rejects relative imports that resolve outside allowedPaths', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await mkdir(join(repoRoot, 'src', 'secret'), { recursive: true })
      await writeFile(join(repoRoot, 'src', 'secret', 'key.ts'), 'export const KEY = 1;\n')
      await git('add', '.')
      await git('commit', '-m', 'Add secret')
      const updatedBase = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'leak.ts'),
        'import { KEY } from "../secret/key.js";\n',
      )
      await git('add', '.')
      await git('commit', '-m', 'Import secret outside allowedPaths')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Merge worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: updatedBase,
        sourceCommit,
        targetCommit: updatedBase,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'PATH_NOT_ALLOWED')).toBe(true)
    })

    it('rejects file:/// URL import specifiers', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'src', 'allowed', 'file-url.ts'),
        'import x from "file:///etc/passwd";\n',
      )
      await git('add', '.')
      await git('commit', '-m', 'file url import')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Merge worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'DIRECTORY_TRAVERSAL')).toBe(true)
    })

    it('rejects test weakening when test files are renamed via Git (status R)', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      const baseTests = Array.from({ length: 10 }, (_, i) => `test("t${i}", () => { expect(${i}).toBe(${i}); });`).join('\n')
      await writeFile(join(repoRoot, 'tests', 'large.spec.ts'), `import { test, expect } from "vitest";\n${baseTests}\n`)
      await git('add', '.')
      await git('commit', '-m', 'Add large test suite')
      const updatedBase = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', '-b', 'worker')
      await git('mv', 'tests/large.spec.ts', 'tests/large-renamed.spec.ts')
      const remainingTests = Array.from({ length: 6 }, (_, i) => `test("t${i}", () => { expect(${i}).toBe(${i}); });`).join('\n')
      await writeFile(join(repoRoot, 'tests', 'large-renamed.spec.ts'), `import { test, expect } from "vitest";\n${remainingTests}\n`)
      await git('add', '.')
      await git('commit', '-m', 'Rename and drop 4 tests')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Merge worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit: updatedBase,
        sourceCommit,
        targetCommit: updatedBase,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'TEST_CASES_REMOVED' || v.rule === 'TEST_ASSERTION_WEAKENED')).toBe(true)
    })

    it('rejects early return in test callbacks that disable subsequent assertions', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'tests', 'sample.spec.ts'),
        'import { test, expect } from "vitest";\ntest("sample", () => {\n  return;\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n',
      )
      await git('add', '.')
      await git('commit', '-m', 'Early return in test')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Merge worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'TEST_EARLY_RETURN' || v.rule === 'TEST_ASSERTION_WEAKENED')).toBe(true)
    })

    it('rejects dynamic test skipping via ctx.skip() and test.skipIf()', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'tests', 'sample.spec.ts'),
        'import { test, expect } from "vitest";\ntest("sample", (ctx) => {\n  ctx.skip();\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n',
      )
      await git('add', '.')
      await git('commit', '-m', 'ctx.skip() in test')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Merge worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'TEST_SKIPPED')).toBe(true)
    })

    it('rejects assertion failure swallowing inside empty try/catch blocks', async () => {
      const { repoRoot, git, baseCommit } = await createFixture()

      await git('checkout', '-b', 'worker')
      await writeFile(
        join(repoRoot, 'tests', 'sample.spec.ts'),
        'import { test, expect } from "vitest";\ntest("sample", () => {\n  try {\n    expect(1).toBe(999);\n  } catch {}\n});\n',
      )
      await git('add', '.')
      await git('commit', '-m', 'Swallow assertion failure')
      const sourceCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      await git('checkout', 'main')
      await git('merge', '--no-ff', 'worker', '-m', 'Merge worker')
      const candidateCommit = (await git('rev-parse', 'HEAD')).stdout.trim()

      const result = await inspectArchitectureAndPaths({
        repoRoot,
        baseCommit,
        sourceCommit,
        targetCommit: baseCommit,
        candidateCommit,
        allowedPaths: ['src/allowed/**', 'tests/**'],
      })

      expect(result.passed).toBe(false)
      expect(result.violations.some(v => v.rule === 'TEST_ASSERTION_SWALLOWED' || v.rule === 'TEST_ASSERTION_WEAKENED')).toBe(true)
    })
  })
})

