/**
 * DF-07: Architecture and AST Path Guard
 * Pre-merge qualification gate verifying architectural invariants, AST imports/exports,
 * path boundaries, symlink escapes, integrity preservation, and target branch freshness.
 */

import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, posix } from 'node:path'
import ts from 'typescript'
import { runGit } from '../git-command.ts'
import { safePathSchema } from './contracts/common.ts'

export interface ArchitectureGuardOptions {
  repoRoot: string
  baseCommit: string
  sourceCommit: string
  targetCommit: string
  candidateCommit: string
  allowedPaths: readonly string[]
  deniedPaths?: readonly string[]
  targetBranch?: string
  timeoutMs?: number
}

export interface ArchitectureViolation {
  file: string
  rule: string
  message: string
  line?: number | undefined
  column?: number | undefined
  specifier?: string | undefined
}

export interface ArchitectureGuardResult {
  passed: boolean
  violations: readonly ArchitectureViolation[]
  scannedFiles: readonly string[]
}

export interface CandidateRetryHistoryItem {
  cwd: string
  targetCommit: string
  candidateCommit: string
  error: string
  reviewReceipt?: unknown
}

export interface TargetAdvanceRetryOptions {
  cwd: string
  targetCommit: string
  candidateCommit: string
  previousCandidates?: readonly CandidateRetryHistoryItem[] | undefined
  maxRetries?: number | undefined
  error?: string | undefined
}

export interface TargetAdvanceRetryResult {
  canRetry: boolean
  retryCount: number
  nextCwd?: string | undefined
  previousCandidates: readonly CandidateRetryHistoryItem[]
  error?: string | undefined
}

export class ArchitectureGuardError extends Error {
  readonly code: string
  readonly violations: readonly ArchitectureViolation[]

  constructor(code: string, message: string, violations: readonly ArchitectureViolation[] = []) {
    super(message)
    this.name = 'ArchitectureGuardError'
    this.code = code
    this.violations = violations
  }
}

export const DEFAULT_PROTECTED_GUARD_PATHS: readonly string[] = [
  'packages/agent-team/src/darkfactory/architecture-guard.ts',
  'packages/agent-team/src/darkfactory/paths.ts',
  'packages/agent-team/src/darkfactory/mutation-runner.ts',
  'packages/agent-team/src/darkfactory/digital-twins.ts',
  'packages/agent-team/src/darkfactory/critics.ts',
  'packages/agent-team/src/darkfactory/verification-evidence.ts',
  'packages/agent-team/src/darkfactory/verification-signer.ts',
  'packages/agent-team/src/darkfactory/policy-store.ts',
  'packages/agent-team/src/darkfactory/contracts/**',
  'src/darkfactory/architecture-guard.ts',
  'src/darkfactory/paths.ts',
  'src/darkfactory/mutation-runner.ts',
  'src/darkfactory/digital-twins.ts',
  'src/darkfactory/critics.ts',
  'src/darkfactory/verification-evidence.ts',
  'src/darkfactory/verification-signer.ts',
  'src/darkfactory/policy-store.ts',
  'src/darkfactory/contracts/**',
  'src/guard/**',
]

export const DEFAULT_PROTECTED_POLICY_PATHS: readonly string[] = [
  'darkfactory.md',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.*.json',
  'packages/*/tsconfig*.json',
  '.gasteam/policy.json',
]

export const DEFAULT_PROTECTED_TEST_HARNESS_PATHS: readonly string[] = [
  'vitest.config.ts',
  'vitest.acceptance.config.ts',
  'packages/*/vitest*.config.ts',
]

const BINARY_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.class',
  '.jar',
  '.wasm',
  '.node',
  '.iso',
  '.dmg',
])

const TS_JS_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
])

export interface GitRawEntry {
  oldMode: string
  newMode: string
  oldSha: string
  newSha: string
  status: string
  score?: number | undefined
  path: string
  oldPath?: string | undefined
}

export function parseGitDiffRaw(raw: string): GitRawEntry[] {
  const tokens = raw.split('\0')
  const entries: GitRawEntry[] = []
  let i = 0
  while (i < tokens.length) {
    const header = tokens[i]?.trim()
    if (!header || !header.startsWith(':')) {
      i++
      continue
    }
    const match = /^:(\d{6})\s+(\d{6})\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([A-Z])(\d+)?$/.exec(header)
    if (!match) {
      i++
      continue
    }
    const [, oldMode, newMode, oldSha, newSha, statusLetter, scoreStr] = match
    const status = scoreStr !== undefined ? `${statusLetter}${scoreStr}` : statusLetter!
    const score = scoreStr ? parseInt(scoreStr, 10) : undefined

    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[i + 1] ?? ''
      const newPath = tokens[i + 2] ?? ''
      entries.push({
        oldMode: oldMode!,
        newMode: newMode!,
        oldSha: oldSha!,
        newSha: newSha!,
        status,
        score,
        oldPath,
        path: newPath,
      })
      i += 3
    } else {
      const filePath = tokens[i + 1] ?? ''
      entries.push({
        oldMode: oldMode!,
        newMode: newMode!,
        oldSha: oldSha!,
        newSha: newSha!,
        status,
        score,
        path: filePath,
      })
      i += 2
    }
  }
  return entries
}

export function matchesPathPatterns(filePath: string, patterns: readonly string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '')
  for (const rawPattern of patterns) {
    const p = rawPattern.replace(/\\/g, '/').replace(/^\.\//, '')
    if (p === '*' || p === '**') return true
    if (p.endsWith('/**')) {
      const prefix = p.slice(0, -3)
      if (normalized === prefix || normalized.startsWith(prefix + '/')) return true
    } else if (p.endsWith('/*')) {
      const dir = p.slice(0, -2)
      const fileDir = posix.dirname(normalized)
      if (fileDir === dir) return true
    } else if (p.includes('*')) {
      const escaped = p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '.*')
        .replace(/(?<!\.)\*/g, '[^/]*')
      const regex = new RegExp(`^${escaped}$`)
      if (regex.test(normalized)) return true
    } else {
      if (normalized === p || (normalized.startsWith(p) && (p.endsWith('/') || normalized[p.length] === '/'))) {
        return true
      }
    }
  }
  return false
}

export function isTestFilePath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/')
  return (
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(norm) ||
    norm.includes('/tests/') ||
    norm.startsWith('tests/')
  )
}

function resolveScriptKind(filePath: string): ts.ScriptKind {
  const ext = posix.extname(filePath).toLowerCase()
  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return ts.ScriptKind.TS
    case '.tsx':
      return ts.ScriptKind.TSX
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS
    case '.jsx':
      return ts.ScriptKind.JSX
    case '.json':
      return ts.ScriptKind.JSON
    default:
      return ts.ScriptKind.Unknown
  }
}

export interface ExtractedSpecifier {
  readonly kind: 'import' | 'export' | 'importEquals' | 'require' | 'dynamicImport'
  readonly isStatic: boolean
  readonly value?: string | undefined
  readonly rawExpression?: string | undefined
  readonly dynamicSyntaxKind?: string | undefined
  readonly line: number
  readonly column: number
  readonly node: ts.Node
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr
  while (current) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression
    } else if (ts.isAsExpression(current)) {
      current = current.expression
    } else if (ts.isTypeAssertionExpression(current)) {
      current = current.expression
    } else if (ts.isNonNullExpression(current)) {
      current = current.expression
    } else if (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current)) {
      current = current.expression
    } else {
      break
    }
  }
  return current
}

function resolveCalleeCandidates(
  expr: ts.Expression,
  constStrings: ReadonlyMap<string, string>,
): ts.Expression[] {
  const candidates: ts.Expression[] = []
  const visited = new Set<ts.Expression>()

  function collect(e: ts.Expression | undefined): void {
    if (!e || visited.has(e)) return
    visited.add(e)
    const unwrapped = unwrapExpression(e)

    // 1. Binary comma expression: (0, require) -> right side is evaluated
    if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      collect(unwrapped.right)
      return
    }

    // 2. Binary logical expressions: (require || null), (false ?? require), (true && require)
    if (
      ts.isBinaryExpression(unwrapped) &&
      (unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    ) {
      collect(unwrapped.left)
      collect(unwrapped.right)
      return
    }

    // 3. Conditional / ternary expression: (true ? require : null)
    if (ts.isConditionalExpression(unwrapped)) {
      collect(unwrapped.whenTrue)
      collect(unwrapped.whenFalse)
      return
    }

    // 4. Array indexing literal: [require][0]
    if (ts.isElementAccessExpression(unwrapped)) {
      const arr = unwrapExpression(unwrapped.expression)
      if (ts.isArrayLiteralExpression(arr)) {
        for (const elem of arr.elements) {
          collect(elem)
        }
        return
      }
    }

    // 5. Object literal property access: ({ req: require }).req
    if (ts.isPropertyAccessExpression(unwrapped)) {
      const obj = unwrapExpression(unwrapped.expression)
      if (ts.isObjectLiteralExpression(obj)) {
        const propName = unwrapped.name.text
        for (const prop of obj.properties) {
          if (ts.isPropertyAssignment(prop)) {
            const name = prop.name.getText()
            if (name === propName || (ts.isIdentifier(prop.name) && prop.name.text === propName)) {
              collect(prop.initializer)
            }
          }
        }
        return
      }
    }

    // 6. IIFE returning require: (() => require)() or (function() { return require })()
    if (ts.isCallExpression(unwrapped)) {
      const innerCallee = unwrapExpression(unwrapped.expression)
      if (ts.isArrowFunction(innerCallee)) {
        if (ts.isBlock(innerCallee.body)) {
          for (const stmt of innerCallee.body.statements) {
            if (ts.isReturnStatement(stmt) && stmt.expression) {
              collect(stmt.expression)
            }
          }
        } else {
          collect(innerCallee.body)
        }
        return
      } else if (ts.isFunctionExpression(innerCallee)) {
        if (innerCallee.body) {
          for (const stmt of innerCallee.body.statements) {
            if (ts.isReturnStatement(stmt) && stmt.expression) {
              collect(stmt.expression)
            }
          }
        }
        return
      }
    }

    candidates.push(unwrapped)
  }

  collect(expr)
  return candidates
}

function getStaticStringValue(
  expr: ts.Expression | undefined,
  constStrings: ReadonlyMap<string, string>,
): string | undefined {
  if (!expr) return undefined
  const unwrapped = unwrapExpression(expr)
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text
  }
  if (ts.isIdentifier(unwrapped) && constStrings.has(unwrapped.text)) {
    return constStrings.get(unwrapped.text)
  }
  // Support string concatenation: 'req' + 'uire'
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = getStaticStringValue(unwrapped.left, constStrings)
    const right = getStaticStringValue(unwrapped.right, constStrings)
    if (left !== undefined && right !== undefined) {
      return left + right
    }
  }
  return undefined
}

function isKnownGlobalOrModuleHolder(node: ts.Node, holderAliases?: ReadonlySet<string>): boolean {
  const unwrapped = unwrapExpression(node as ts.Expression)
  if (ts.isIdentifier(unwrapped)) {
    const text = unwrapped.text
    if (text === 'module' || text === 'globalThis' || text === 'global' || text === 'window') {
      return true
    }
    if (holderAliases && holderAliases.has(text)) {
      return true
    }
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const obj = unwrapExpression(unwrapped.expression)
    if (ts.isIdentifier(obj) && obj.text === 'process' && unwrapped.name.text === 'mainModule') {
      return true
    }
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const obj = unwrapExpression(unwrapped.expression)
    const arg = unwrapExpression(unwrapped.argumentExpression)
    if (
      ts.isIdentifier(obj) &&
      obj.text === 'process' &&
      (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) &&
      arg.text === 'mainModule'
    ) {
      return true
    }
  }
  return false
}

function isImportMeta(node: ts.Node): boolean {
  const unwrapped = unwrapExpression(node as ts.Expression)
  return (
    ts.isMetaProperty(unwrapped) &&
    unwrapped.keywordToken === ts.SyntaxKind.ImportKeyword &&
    unwrapped.name.text === 'meta'
  )
}

function isRequireTarget(
  node: ts.Node,
  requireAliases: ReadonlySet<string>,
  constStrings: ReadonlyMap<string, string>,
  holderAliases?: ReadonlySet<string>,
): boolean {
  const unwrapped = unwrapExpression(node as ts.Expression)

  // 1. Direct identifier or tracked alias
  if (ts.isIdentifier(unwrapped)) {
    if (unwrapped.text === 'require' || requireAliases.has(unwrapped.text)) {
      return true
    }
  }

  // 2. Property access: module.require, globalThis.require, require.resolve, require.bind
  if (ts.isPropertyAccessExpression(unwrapped)) {
    if (unwrapped.name.text === 'require') {
      return isKnownGlobalOrModuleHolder(unwrapped.expression, holderAliases)
    }
    if (unwrapped.name.text === 'resolve' && isRequireTarget(unwrapped.expression, requireAliases, constStrings, holderAliases)) {
      return true
    }
    if (unwrapped.name.text === 'bind' && isRequireTarget(unwrapped.expression, requireAliases, constStrings, holderAliases)) {
      return true
    }
  }

  // 3. Element access: module['require'], globalThis['require'], process.mainModule['require']
  if (ts.isElementAccessExpression(unwrapped)) {
    const propName = getStaticStringValue(unwrapped.argumentExpression, constStrings)
    if (propName === 'require') {
      return isKnownGlobalOrModuleHolder(unwrapped.expression, holderAliases)
    }
    if (propName === 'resolve' && isRequireTarget(unwrapped.expression, requireAliases, constStrings, holderAliases)) {
      return true
    }
    if (propName === 'bind' && isRequireTarget(unwrapped.expression, requireAliases, constStrings, holderAliases)) {
      return true
    }
    // Dynamic bracket call on module or global holder: module[r](...)
    const holder = unwrapExpression(unwrapped.expression)
    if (isKnownGlobalOrModuleHolder(holder, holderAliases)) {
      return true
    }
  }

  // 4. Direct call to createRequire(...) or require.bind(...)
  if (ts.isCallExpression(unwrapped)) {
    const fn = unwrapExpression(unwrapped.expression)
    if (ts.isIdentifier(fn) && fn.text === 'createRequire') {
      return true
    }
    if (ts.isPropertyAccessExpression(fn) && fn.name.text === 'bind' && isRequireTarget(fn.expression, requireAliases, constStrings, holderAliases)) {
      return true
    }
  }

  return false
}

function isImportTarget(node: ts.Node): boolean {
  const unwrapped = unwrapExpression(node as ts.Expression)
  if (unwrapped.kind === ts.SyntaxKind.ImportKeyword) {
    return true
  }
  if (ts.isIdentifier(unwrapped) && unwrapped.text === 'import') {
    return true
  }
  return false
}

interface BindingsContext {
  requireAliases: Set<string>
  computedAliases: Set<string>
  holderAliases: Set<string>
  customHolderAliases: Set<string>
  constStrings: Map<string, string>
}

function collectAliasesAndConstants(sourceFile: ts.SourceFile): BindingsContext {
  const requireAliases = new Set<string>()
  const computedAliases = new Set<string>()
  const holderAliases = new Set<string>(['module', 'globalThis', 'global', 'window'])
  const customHolderAliases = new Set<string>()
  const constStrings = new Map<string, string>()

  function scan(node: ts.Node): void {
    // Variable declarations: const r = require, const r = 'require', const m = module
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrapExpression(node.initializer)

      // String constant tracking
      if (ts.isIdentifier(node.name) && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) {
        constStrings.set(node.name.text, init.text)
      }

      // Variable alias tracking: const r = (0, require), const req = true ? require : null, etc.
      if (ts.isIdentifier(node.name)) {
        const candidates = resolveCalleeCandidates(node.initializer, constStrings)
        const isReq = candidates.some(cand => isRequireTarget(cand, requireAliases, constStrings, holderAliases))
        const isHolder = candidates.some(cand => isKnownGlobalOrModuleHolder(cand, holderAliases))

        if (isReq) {
          requireAliases.add(node.name.text)
          const isSimple =
            ts.isIdentifier(init) &&
            (init.text === 'require' || (requireAliases.has(init.text) && !computedAliases.has(init.text)))
          if (!isSimple) {
            computedAliases.add(node.name.text)
          }
        }
        if (isHolder) {
          holderAliases.add(node.name.text)
          if (!['module', 'globalThis', 'global', 'window'].includes(node.name.text)) {
            customHolderAliases.add(node.name.text)
          }
        }
      }

      // Destructured binding tracking: const { require: r } = globalThis, const { ["require"]: r } = globalThis, const { resolve } = require
      if (ts.isObjectBindingPattern(node.name)) {
        const initCandidates = node.initializer ? resolveCalleeCandidates(node.initializer, constStrings) : []
        const isReq = initCandidates.some(c => isRequireTarget(c, requireAliases, constStrings, holderAliases))
        const isHolder = initCandidates.some(c => isKnownGlobalOrModuleHolder(c, holderAliases))

        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)) {
            let propName: string | undefined
            let isComputedProp = false
            if (element.propertyName) {
              if (ts.isComputedPropertyName(element.propertyName)) {
                isComputedProp = true
                propName = getStaticStringValue(element.propertyName.expression, constStrings)
              } else if (
                ts.isIdentifier(element.propertyName) ||
                ts.isStringLiteral(element.propertyName) ||
                ts.isNoSubstitutionTemplateLiteral(element.propertyName)
              ) {
                propName = element.propertyName.text
              }
            } else {
              propName = element.name.text
            }

            if (propName === 'require') {
              requireAliases.add(element.name.text)
              if (isComputedProp || isHolder) {
                computedAliases.add(element.name.text)
              }
            } else if (propName === 'resolve' && (isReq || isHolder)) {
              requireAliases.add(element.name.text)
              computedAliases.add(element.name.text)
            } else if (propName === 'module' && isHolder) {
              holderAliases.add(element.name.text)
              customHolderAliases.add(element.name.text)
            }
          }
        }
      }
    }

    // Binary assignment expressions: r = (0, require), m = module
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unwrapExpression(node.left)
      if (ts.isIdentifier(left)) {
        const candidates = resolveCalleeCandidates(node.right, constStrings)
        const isReq = candidates.some(cand => isRequireTarget(cand, requireAliases, constStrings, holderAliases))
        const isHolder = candidates.some(cand => isKnownGlobalOrModuleHolder(cand, holderAliases))
        if (isReq) {
          requireAliases.add(left.text)
          const rightInit = unwrapExpression(node.right)
          const isSimple =
            ts.isIdentifier(rightInit) &&
            (rightInit.text === 'require' || (requireAliases.has(rightInit.text) && !computedAliases.has(rightInit.text)))
          if (!isSimple) {
            computedAliases.add(left.text)
          }
        }
        if (isHolder) {
          holderAliases.add(left.text)
          if (!['module', 'globalThis', 'global', 'window'].includes(left.text)) {
            customHolderAliases.add(left.text)
          }
        }
      }
    }

    ts.forEachChild(node, scan)
  }

  // Fixed-point iteration to resolve transitive aliases
  let prevCount = -1
  while (requireAliases.size + holderAliases.size !== prevCount) {
    prevCount = requireAliases.size + holderAliases.size
    scan(sourceFile)
  }

  return { requireAliases, computedAliases, holderAliases, customHolderAliases, constStrings }
}

export function extractImportAndExportSpecifiers(sourceFile: ts.SourceFile): ExtractedSpecifier[] {
  const extracted: ExtractedSpecifier[] = []
  const { requireAliases, computedAliases, holderAliases, customHolderAliases, constStrings } =
    collectAliasesAndConstants(sourceFile)

  function evaluateSpecifier(
    expr: ts.Expression | undefined,
    contextNode: ts.Node,
    kind: ExtractedSpecifier['kind'],
  ): ExtractedSpecifier {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(contextNode.getStart(sourceFile))

    if (!expr) {
      return {
        kind,
        isStatic: false,
        dynamicSyntaxKind: 'EmptyArgument',
        line: line + 1,
        column: character + 1,
        node: contextNode,
      }
    }

    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return {
        kind,
        isStatic: true,
        value: expr.text,
        line: line + 1,
        column: character + 1,
        node: contextNode,
      }
    }

    return {
      kind,
      isStatic: false,
      rawExpression: expr.getText(sourceFile),
      dynamicSyntaxKind: ts.SyntaxKind[expr.kind],
      line: line + 1,
      column: character + 1,
      node: contextNode,
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier
      extracted.push(evaluateSpecifier(spec, node, 'import'))
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        extracted.push(evaluateSpecifier(node.moduleSpecifier, node, 'export'))
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        const expr = node.moduleReference.expression
        extracted.push(evaluateSpecifier(expr, node, 'importEquals'))
      }
    } else if (ts.isCallExpression(node)) {
      const unwrappedCallee = unwrapExpression(node.expression)
      // Check Node ESM loader: import.meta.resolve('./evil')
      if (
        ts.isPropertyAccessExpression(unwrappedCallee) &&
        unwrappedCallee.name.text === 'resolve' &&
        isImportMeta(unwrappedCallee.expression)
      ) {
        extracted.push(evaluateSpecifier(node.arguments[0], node, 'dynamicImport'))
      } else if (
        ts.isPropertyAccessExpression(unwrappedCallee) &&
        unwrappedCallee.name.text === 'call' &&
        isRequireTarget(unwrappedCallee.expression, requireAliases, constStrings, holderAliases)
      ) {
        // require.call(thisArg, specifier)
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        extracted.push({
          kind: 'require',
          isStatic: false,
          rawExpression: node.getText(sourceFile),
          dynamicSyntaxKind: 'MethodCallRequire',
          line: line + 1,
          column: character + 1,
          node,
        })
      } else if (
        ts.isPropertyAccessExpression(unwrappedCallee) &&
        unwrappedCallee.name.text === 'apply' &&
        isRequireTarget(unwrappedCallee.expression, requireAliases, constStrings, holderAliases)
      ) {
        // require.apply(thisArg, [specifier])
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        extracted.push({
          kind: 'require',
          isStatic: false,
          rawExpression: node.getText(sourceFile),
          dynamicSyntaxKind: 'MethodApplyRequire',
          line: line + 1,
          column: character + 1,
          node,
        })
      } else if (
        ts.isPropertyAccessExpression(unwrappedCallee) &&
        unwrappedCallee.name.text === 'apply' &&
        ts.isIdentifier(unwrapExpression(unwrappedCallee.expression)) &&
        (unwrapExpression(unwrappedCallee.expression) as ts.Identifier).text === 'Reflect' &&
        node.arguments[0] &&
        isRequireTarget(node.arguments[0], requireAliases, constStrings, holderAliases)
      ) {
        // Reflect.apply(require, thisArg, [specifier])
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        extracted.push({
          kind: 'require',
          isStatic: false,
          rawExpression: node.getText(sourceFile),
          dynamicSyntaxKind: 'ReflectApplyRequire',
          line: line + 1,
          column: character + 1,
          node,
        })
      } else if (
        ts.isPropertyAccessExpression(unwrappedCallee) &&
        unwrappedCallee.name.text === 'require' &&
        ts.isIdentifier(unwrapExpression(unwrappedCallee.expression)) &&
        customHolderAliases.has((unwrapExpression(unwrappedCallee.expression) as ts.Identifier).text)
      ) {
        // Aliased holder call: m.require("./evil"), g.require("./evil")
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        extracted.push({
          kind: 'require',
          isStatic: false,
          rawExpression: node.getText(sourceFile),
          dynamicSyntaxKind: 'AliasedHolderRequire',
          line: line + 1,
          column: character + 1,
          node,
        })
      } else {
        const candidates = resolveCalleeCandidates(node.expression, constStrings)
        for (const cand of candidates) {
          const uCand = unwrapExpression(cand)
          if (ts.isIdentifier(uCand) && computedAliases.has(uCand.text)) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            extracted.push({
              kind: 'require',
              isStatic: false,
              rawExpression: node.getText(sourceFile),
              dynamicSyntaxKind: 'ComputedAliasRequire',
              line: line + 1,
              column: character + 1,
              node,
            })
            break
          } else if (isRequireTarget(cand, requireAliases, constStrings, holderAliases)) {
            extracted.push(evaluateSpecifier(node.arguments[0], node, 'require'))
            break
          } else if (isImportTarget(cand)) {
            extracted.push(evaluateSpecifier(node.arguments[0], node, 'dynamicImport'))
            break
          }
        }
      }
    } else if (ts.isTaggedTemplateExpression(node)) {
      const candidates = resolveCalleeCandidates(node.tag, constStrings)
      for (const cand of candidates) {
        const isReq = isRequireTarget(cand, requireAliases, constStrings, holderAliases)
        const isImp = isImportTarget(cand)
        if (isReq || isImp) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          extracted.push({
            kind: isReq ? 'require' : 'dynamicImport',
            isStatic: false,
            rawExpression: node.getText(sourceFile),
            dynamicSyntaxKind: 'TaggedTemplateExpression',
            line: line + 1,
            column: character + 1,
            node,
          })
          break
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return extracted
}

export interface TestMetrics {
  activeTestCount: number
  skippedCount: number
  assertionCount: number
  meaningfulAssertionCount: number
  dynamicAssertionCount: number
  earlyReturnCount: number
  swallowedAssertionCount: number
  tautologyCount: number
  booleanTautologyCount: number
}

function getStaticLiteralValue(expr: ts.Expression): string | number | boolean | null | undefined {
  const unwrapped = unwrapExpression(expr)
  if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) return true
  if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) return false
  if (unwrapped.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isIdentifier(unwrapped) && unwrapped.text === 'undefined') return undefined
  if (ts.isNumericLiteral(unwrapped)) return Number(unwrapped.text)
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) return unwrapped.text
  if (ts.isPrefixUnaryExpression(unwrapped) && unwrapped.operator === ts.SyntaxKind.MinusToken) {
    if (ts.isNumericLiteral(unwrapped.operand)) {
      return -Number(unwrapped.operand.text)
    }
  }
  return undefined
}

function isTautologicalAssertion(node: ts.CallExpression): boolean {
  const unwrapped = unwrapExpression(node.expression)
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const prop = unwrapped.name.text
    if (['toBe', 'toEqual', 'toStrictEqual'].includes(prop)) {
      const innerCall = unwrapExpression(unwrapped.expression)
      if (ts.isCallExpression(innerCall)) {
        const innerFn = unwrapExpression(innerCall.expression)
        if (ts.isIdentifier(innerFn) && innerFn.text === 'expect') {
          const expectArg = innerCall.arguments[0]
          const matcherArg = node.arguments[0]
          if (expectArg && matcherArg) {
            const v1 = getStaticLiteralValue(expectArg)
            const v2 = getStaticLiteralValue(matcherArg)
            if (v1 !== undefined && v2 !== undefined && v1 === v2) {
              return true
            }
            const uExpect = unwrapExpression(expectArg)
            const uMatcher = unwrapExpression(matcherArg)
            if (
              (uExpect.kind === ts.SyntaxKind.TrueKeyword && uMatcher.kind === ts.SyntaxKind.TrueKeyword) ||
              (uExpect.kind === ts.SyntaxKind.FalseKeyword && uMatcher.kind === ts.SyntaxKind.FalseKeyword) ||
              (uExpect.kind === ts.SyntaxKind.NullKeyword && uMatcher.kind === ts.SyntaxKind.NullKeyword)
            ) {
              return true
            }
            if (
              ts.isIdentifier(uExpect) &&
              ts.isIdentifier(uMatcher) &&
              uExpect.text === 'undefined' &&
              uMatcher.text === 'undefined'
            ) {
              return true
            }
          }
        }
      }
    } else if (['toBeTruthy', 'toBeFalsy'].includes(prop)) {
      const innerCall = unwrapExpression(unwrapped.expression)
      if (ts.isCallExpression(innerCall)) {
        const innerFn = unwrapExpression(innerCall.expression)
        if (ts.isIdentifier(innerFn) && innerFn.text === 'expect') {
          const expectArg = innerCall.arguments[0]
          if (expectArg) {
            const uExpect = unwrapExpression(expectArg)
            if (
              (prop === 'toBeTruthy' && uExpect.kind === ts.SyntaxKind.TrueKeyword) ||
              (prop === 'toBeFalsy' && uExpect.kind === ts.SyntaxKind.FalseKeyword)
            ) {
              return true
            }
          }
        }
      }
    }
  }
  return false
}

function isBooleanTautology(node: ts.CallExpression): boolean {
  const unwrapped = unwrapExpression(node.expression)
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const prop = unwrapped.name.text
    if (['toBe', 'toEqual', 'toStrictEqual'].includes(prop)) {
      const innerCall = unwrapExpression(unwrapped.expression)
      if (ts.isCallExpression(innerCall)) {
        const innerFn = unwrapExpression(innerCall.expression)
        if (ts.isIdentifier(innerFn) && innerFn.text === 'expect') {
          const expectArg = innerCall.arguments[0]
          const matcherArg = node.arguments[0]
          if (expectArg && matcherArg) {
            const uExpect = unwrapExpression(expectArg)
            const uMatcher = unwrapExpression(matcherArg)
            if (
              (uExpect.kind === ts.SyntaxKind.TrueKeyword && uMatcher.kind === ts.SyntaxKind.TrueKeyword) ||
              (uExpect.kind === ts.SyntaxKind.FalseKeyword && uMatcher.kind === ts.SyntaxKind.FalseKeyword) ||
              (uExpect.kind === ts.SyntaxKind.NullKeyword && uMatcher.kind === ts.SyntaxKind.NullKeyword)
            ) {
              return true
            }
            if (
              ts.isIdentifier(uExpect) &&
              ts.isIdentifier(uMatcher) &&
              uExpect.text === 'undefined' &&
              uMatcher.text === 'undefined'
            ) {
              return true
            }
          }
        }
      }
    } else if (['toBeTruthy', 'toBeFalsy'].includes(prop)) {
      const innerCall = unwrapExpression(unwrapped.expression)
      if (ts.isCallExpression(innerCall)) {
        const innerFn = unwrapExpression(innerCall.expression)
        if (ts.isIdentifier(innerFn) && innerFn.text === 'expect') {
          const expectArg = innerCall.arguments[0]
          if (expectArg) {
            const uExpect = unwrapExpression(expectArg)
            if (
              (prop === 'toBeTruthy' && uExpect.kind === ts.SyntaxKind.TrueKeyword) ||
              (prop === 'toBeFalsy' && uExpect.kind === ts.SyntaxKind.FalseKeyword)
            ) {
              return true
            }
          }
        }
      }
    }
  }
  return false
}

function extractTestMetrics(sourceFile: ts.SourceFile): TestMetrics {
  let activeTestCount = 0
  let skippedCount = 0
  let assertionCount = 0
  let meaningfulAssertionCount = 0
  let dynamicAssertionCount = 0
  let earlyReturnCount = 0
  let swallowedAssertionCount = 0
  let tautologyCount = 0
  let booleanTautologyCount = 0

  const deadOrSwallowedAssertionNodes = new Set<ts.Node>()
  const tautologicalExpectCalls = new Set<ts.Node>()

  function containsAssertion(node: ts.Node): boolean {
    let found = false
    function search(n: ts.Node) {
      if (found) return
      if (ts.isCallExpression(n)) {
        const unwrapped = unwrapExpression(n.expression)
        if (ts.isIdentifier(unwrapped) && (unwrapped.text === 'expect' || unwrapped.text === 'assert')) {
          found = true
          return
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
          const root = unwrapExpression(unwrapped.expression)
          if (ts.isIdentifier(root) && (root.text === 'assert' || root.text === 'expect')) {
            found = true
            return
          }
        }
      }
      ts.forEachChild(n, search)
    }
    search(node)
    return found
  }

  function catchBlockRethrowsOrAsserts(block: ts.Block): boolean {
    let rethrowsOrAsserts = false
    function search(n: ts.Node) {
      if (rethrowsOrAsserts) return
      if (ts.isThrowStatement(n)) {
        rethrowsOrAsserts = true
        return
      }
      if (ts.isCallExpression(n)) {
        const unwrapped = unwrapExpression(n.expression)
        if (ts.isIdentifier(unwrapped) && (unwrapped.text === 'expect' || unwrapped.text === 'assert')) {
          rethrowsOrAsserts = true
          return
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
          const root = unwrapExpression(unwrapped.expression)
          if (ts.isIdentifier(root) && (root.text === 'assert' || root.text === 'expect')) {
            rethrowsOrAsserts = true
            return
          }
        }
      }
      ts.forEachChild(n, search)
    }
    search(block)
    return rethrowsOrAsserts
  }

  function isStaticallyFalsy(expr: ts.Expression): boolean {
    const unwrapped = unwrapExpression(expr)
    if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) return true
    if (unwrapped.kind === ts.SyntaxKind.NullKeyword) return true
    if (ts.isIdentifier(unwrapped) && unwrapped.text === 'undefined') return true
    if (ts.isNumericLiteral(unwrapped) && unwrapped.text === '0') return true
    if (ts.isStringLiteral(unwrapped) && unwrapped.text === '') return true
    if (ts.isPrefixUnaryExpression(unwrapped) && unwrapped.operator === ts.SyntaxKind.ExclamationToken) {
      return isStaticallyTruthy(unwrapped.operand)
    }
    return false
  }

  function isStaticallyTruthy(expr: ts.Expression): boolean {
    const unwrapped = unwrapExpression(expr)
    if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) return true
    if (ts.isNumericLiteral(unwrapped) && unwrapped.text !== '0') return true
    if (ts.isStringLiteral(unwrapped) && unwrapped.text.length > 0) return true
    if (ts.isPrefixUnaryExpression(unwrapped) && unwrapped.operator === ts.SyntaxKind.ExclamationToken) {
      return isStaticallyFalsy(unwrapped.operand)
    }
    return false
  }

  function scanBlockForDeadCodeAndSwallowing(statements: readonly ts.Statement[]): void {
    let encounteredUnconditionalExit = false

    function markAllAssertionsDead(n: ts.Node) {
      if (ts.isCallExpression(n)) {
        const u = unwrapExpression(n.expression)
        if (
          (ts.isIdentifier(u) && (u.text === 'expect' || u.text === 'assert')) ||
          (ts.isPropertyAccessExpression(u) &&
            ts.isIdentifier(unwrapExpression(u.expression)) &&
            (unwrapExpression(u.expression) as ts.Identifier).text === 'assert')
        ) {
          deadOrSwallowedAssertionNodes.add(n)
        }
      }
      ts.forEachChild(n, markAllAssertionsDead)
    }

    function hasUnconditionalReturn(s: ts.Statement): boolean {
      if (ts.isReturnStatement(s)) return true
      if (ts.isBlock(s)) {
        for (const inner of s.statements) {
          if (hasUnconditionalReturn(inner)) return true
        }
      }
      return false
    }

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i]!

      if (encounteredUnconditionalExit) {
        markAllAssertionsDead(stmt)
        continue
      }

      if (ts.isReturnStatement(stmt)) {
        encounteredUnconditionalExit = true
        let subsequentHasAssertion = false
        for (let j = i + 1; j < statements.length; j++) {
          if (containsAssertion(statements[j]!)) {
            subsequentHasAssertion = true
            break
          }
        }
        if (subsequentHasAssertion) {
          earlyReturnCount++
        }
      }

      if (ts.isWhileStatement(stmt)) {
        if (isStaticallyFalsy(stmt.expression)) {
          markAllAssertionsDead(stmt.statement)
        }
      }

      if (ts.isForStatement(stmt)) {
        if (stmt.condition && isStaticallyFalsy(stmt.condition)) {
          markAllAssertionsDead(stmt.statement)
        }
      }

      if (ts.isSwitchStatement(stmt)) {
        const switchVal = getStaticLiteralValue(stmt.expression)
        if (switchVal !== undefined) {
          for (const clause of stmt.caseBlock.clauses) {
            if (ts.isCaseClause(clause)) {
              const caseVal = getStaticLiteralValue(clause.expression)
              if (caseVal !== undefined && caseVal !== switchVal) {
                for (const s of clause.statements) {
                  markAllAssertionsDead(s)
                }
              }
            }
          }
        }
      }

      if (ts.isTryStatement(stmt)) {
        if (stmt.catchClause) {
          const rethrows = catchBlockRethrowsOrAsserts(stmt.catchClause.block)
          if (!rethrows && containsAssertion(stmt.tryBlock)) {
            swallowedAssertionCount++
            markAllAssertionsDead(stmt.tryBlock)
          }
        }
      }

      if (ts.isIfStatement(stmt)) {
        if (isStaticallyFalsy(stmt.expression)) {
          markAllAssertionsDead(stmt.thenStatement)
        } else if (isStaticallyTruthy(stmt.expression)) {
          if (stmt.elseStatement) {
            markAllAssertionsDead(stmt.elseStatement)
          }
          if (hasUnconditionalReturn(stmt.thenStatement)) {
            encounteredUnconditionalExit = true
            let subsequentHasAssertion = false
            for (let j = i + 1; j < statements.length; j++) {
              if (containsAssertion(statements[j]!)) {
                subsequentHasAssertion = true
                break
              }
            }
            if (subsequentHasAssertion) {
              earlyReturnCount++
            }
          }
        }
      }
    }
  }

  function getCallChain(expr: ts.Expression): string[] {
    const chain: string[] = []
    let curr: ts.Expression = expr
    while (curr) {
      curr = unwrapExpression(curr)
      if (ts.isPropertyAccessExpression(curr)) {
        chain.unshift(curr.name.text)
        curr = curr.expression
      } else if (ts.isIdentifier(curr)) {
        chain.unshift(curr.text)
        break
      } else if (curr.kind === ts.SyntaxKind.ThisKeyword) {
        chain.unshift('this')
        break
      } else if (ts.isCallExpression(curr)) {
        const innerChain = getCallChain(curr.expression)
        chain.unshift(...innerChain)
        break
      } else {
        break
      }
    }
    return chain
  }

  function preVisit(node: ts.Node): void {
    if (ts.isBlock(node)) {
      scanBlockForDeadCodeAndSwallowing(node.statements)
    }
    ts.forEachChild(node, preVisit)
  }
  preVisit(sourceFile)

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const chain = getCallChain(node.expression)
      const root = chain[0] ?? ''

      if (chain.length === 2 && (root === 'ctx' || root === 'this' || root === 'context') && chain[1] === 'skip') {
        skippedCount++
      } else if (root === 'xit' || root === 'xtest' || root === 'xdescribe') {
        skippedCount++
      } else if (root === 'it' || root === 'test' || root === 'describe') {
        const isSkipModifier = chain.some(p => ['skip', 'skipIf', 'runIf', 'only', 'todo', 'fails'].includes(p))
        const isInnerCall = ts.isCallExpression(node.parent) && (node.parent as ts.CallExpression).expression === node

        if (isSkipModifier) {
          if (!isInnerCall) {
            skippedCount++
          }
        } else if (root === 'it' || root === 'test') {
          if (!isInnerCall) {
            activeTestCount++
          }
        }
      }

      if (isBooleanTautology(node)) {
        booleanTautologyCount++
      }
      if (isTautologicalAssertion(node)) {
        tautologyCount++
        const unwrapped = unwrapExpression(node.expression)
        if (ts.isPropertyAccessExpression(unwrapped)) {
          const innerCall = unwrapExpression(unwrapped.expression)
          if (ts.isCallExpression(innerCall)) {
            tautologicalExpectCalls.add(innerCall)
          }
        }
      }

      const unwrappedExpr = unwrapExpression(node.expression)
      let isAssertion = false
      if (ts.isIdentifier(unwrappedExpr)) {
        if (unwrappedExpr.text === 'expect' || unwrappedExpr.text === 'assert') {
          isAssertion = true
        }
      } else if (ts.isPropertyAccessExpression(unwrappedExpr)) {
        const obj = unwrapExpression(unwrappedExpr.expression)
        if (ts.isIdentifier(obj) && (obj.text === 'assert' || obj.text === 'expect')) {
          isAssertion = true
        }
      }

      if (isAssertion) {
        if (!deadOrSwallowedAssertionNodes.has(node)) {
          assertionCount++
          if (!tautologicalExpectCalls.has(node)) {
            meaningfulAssertionCount++
          }
          if (node.arguments[0]) {
            const firstArg = unwrapExpression(node.arguments[0])
            if (ts.isCallExpression(firstArg)) {
              dynamicAssertionCount++
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return {
    activeTestCount,
    skippedCount,
    assertionCount,
    meaningfulAssertionCount,
    dynamicAssertionCount,
    earlyReturnCount,
    swallowedAssertionCount,
    tautologyCount,
    booleanTautologyCount,
  }
}

function decodeUrlSpecifier(input: string): { decoded: string; wasEncoded: boolean; error?: string } {
  if (!input.includes('%')) {
    return { decoded: input, wasEncoded: false }
  }
  let current = input
  let iterations = 0
  while (current.includes('%') && iterations < 3) {
    try {
      const next = decodeURIComponent(current)
      if (next === current) break
      current = next
      iterations++
    } catch {
      return { decoded: input, wasEncoded: true, error: 'Malformed percent-encoding' }
    }
  }
  return { decoded: current, wasEncoded: true }
}

function matchesAllowedPath(resolvedPath: string, allowedPatterns: readonly string[]): boolean {
  if (matchesPathPatterns(resolvedPath, allowedPatterns)) return true
  const withoutExt = resolvedPath.replace(/\.[cm]?[jt]sx?$/, '')
  if (matchesPathPatterns(withoutExt, allowedPatterns)) return true
  for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '/index.ts', '/index.js']) {
    if (matchesPathPatterns(withoutExt + ext, allowedPatterns)) return true
  }
  return false
}

export function handleTargetAdvancementRetry(options: TargetAdvanceRetryOptions): TargetAdvanceRetryResult {
  const history = options.previousCandidates ?? []
  const maxRetries =
    typeof options.maxRetries === 'number' && Number.isFinite(options.maxRetries) && options.maxRetries >= 0
      ? Math.floor(options.maxRetries)
      : 3
  const errorMsg = options.error ?? `Target advanced from ${options.targetCommit}; candidate evidence invalidated.`

  const updatedHistory: CandidateRetryHistoryItem[] = [
    ...history,
    {
      cwd: options.cwd,
      targetCommit: options.targetCommit,
      candidateCommit: options.candidateCommit,
      error: errorMsg,
    },
  ]

  if (history.length >= maxRetries) {
    return {
      canRetry: false,
      retryCount: history.length,
      previousCandidates: updatedHistory,
      error: `Target movement retry limit reached (${maxRetries}): ${errorMsg}. Candidate checkouts are retained.`,
    }
  }

  const rawBaseCwd = history[0]?.cwd ?? options.cwd
  const baseCwd = rawBaseCwd.replace(/\.retry-\d+$/, '')
  const nextCwd = `${baseCwd}.retry-${history.length + 1}`

  return {
    canRetry: true,
    retryCount: history.length + 1,
    nextCwd,
    previousCandidates: updatedHistory,
  }
}

export async function inspectArchitectureAndPaths(
  options: ArchitectureGuardOptions,
  signal: AbortSignal = new AbortController().signal,
): Promise<ArchitectureGuardResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const violations: ArchitectureViolation[] = []
  const scannedFilesSet = new Set<string>()

  // 1. Target Branch Freshness Check
  if (options.targetBranch) {
    let currentTarget: string | undefined
    try {
      currentTarget = (
        await runGit(options.repoRoot, ['rev-parse', '--verify', `refs/heads/${options.targetBranch}^{commit}`], signal, timeoutMs)
      ).trim()
    } catch {
      try {
        currentTarget = (
          await runGit(options.repoRoot, ['rev-parse', '--verify', `${options.targetBranch}^{commit}`], signal, timeoutMs)
        ).trim()
      } catch {
        // ref not found, ignore
      }
    }

    if (
      currentTarget !== undefined &&
      currentTarget !== options.targetCommit.trim() &&
      currentTarget !== options.candidateCommit.trim()
    ) {
      violations.push({
        file: `refs/heads/${options.targetBranch}`,
        rule: 'TARGET_ADVANCED',
        message: `Target branch "${options.targetBranch}" advanced from ${options.targetCommit} to ${currentTarget}; candidate evidence invalidated.`,
      })
    }
  }

  // 2. Ancestry Invariant Check
  if (options.targetCommit !== options.candidateCommit) {
    try {
      await runGit(options.repoRoot, ['merge-base', '--is-ancestor', options.targetCommit, options.candidateCommit], signal, timeoutMs)
    } catch {
      violations.push({
        file: '',
        rule: 'TARGET_ADVANCED',
        message: `Candidate commit ${options.candidateCommit} is not descended from target commit ${options.targetCommit}; candidate is stale.`,
      })
    }
  }

  // 3. Diff Enumeration: B -> S (Authored changes) and T -> C (Promotion changes)
  let bsDiffRaw = ''
  let tcDiffRaw = ''
  try {
    bsDiffRaw = await runGit(
      options.repoRoot,
      ['diff-tree', '-r', '--raw', '-z', '-M', '--no-commit-id', options.baseCommit, options.sourceCommit],
      signal,
      timeoutMs,
    )
  } catch (error) {
    violations.push({
      file: '',
      rule: 'GIT_ERROR',
      message: `Failed to diff base ${options.baseCommit} to source ${options.sourceCommit}: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  try {
    tcDiffRaw = await runGit(
      options.repoRoot,
      ['diff-tree', '-r', '--raw', '-z', '-M', '--no-commit-id', options.targetCommit, options.candidateCommit],
      signal,
      timeoutMs,
    )
  } catch (error) {
    violations.push({
      file: '',
      rule: 'GIT_ERROR',
      message: `Failed to diff target ${options.targetCommit} to candidate ${options.candidateCommit}: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const bsEntries = parseGitDiffRaw(bsDiffRaw)
  const tcEntries = parseGitDiffRaw(tcDiffRaw)
  const allDiffEntries = [...bsEntries, ...tcEntries]

  // Track all changed paths
  for (const entry of allDiffEntries) {
    scannedFilesSet.add(entry.path)
    if (entry.oldPath) scannedFilesSet.add(entry.oldPath)
  }

  // 4. Path Validation & Integrity Check on Diff Entries
  for (const entry of allDiffEntries) {
    const pathsToCheck: Array<{ path: string; isOld: boolean }> = [
      { path: entry.path, isOld: false },
    ]
    if (entry.oldPath) {
      pathsToCheck.push({ path: entry.oldPath, isOld: true })
    }

    for (const { path: p } of pathsToCheck) {
      // Lexical traversal checks
      if (
        p.includes('..') ||
        p.startsWith('/') ||
        p.includes('\\') ||
        p.includes('%2e%2e') ||
        p.includes('%2E%2E')
      ) {
        violations.push({
          file: p,
          rule: 'DIRECTORY_TRAVERSAL',
          message: `Directory traversal sequence in path "${p}" is strictly prohibited.`,
        })
        continue
      }

      // Git metadata protection
      if (p === '.git' || p.startsWith('.git/') || p.includes('/.git/') || p.endsWith('/.git')) {
        violations.push({
          file: p,
          rule: 'GIT_METADATA_VIOLATION',
          message: `Targeting Git metadata directory is strictly prohibited: "${p}".`,
        })
        continue
      }

      // Safe path schema
      const safeParse = safePathSchema.safeParse(p)
      if (!safeParse.success) {
        violations.push({
          file: p,
          rule: 'DIRECTORY_TRAVERSAL',
          message: safeParse.error.issues[0]?.message ?? `Unsafe path syntax: "${p}".`,
        })
      }

      // Guard code tampering protection
      if (matchesPathPatterns(p, DEFAULT_PROTECTED_GUARD_PATHS)) {
        violations.push({
          file: p,
          rule: 'GUARD_CODE_TAMPERING',
          message: `Modification or deletion of guard code is prohibited: "${p}".`,
        })
      }

      // Policy configuration weakening protection
      if (matchesPathPatterns(p, DEFAULT_PROTECTED_POLICY_PATHS)) {
        violations.push({
          file: p,
          rule: 'POLICY_WEAKENING',
          message: `Modification or weakening of policy configuration is prohibited: "${p}".`,
        })
      }

      // Test harness configuration weakening protection
      if (matchesPathPatterns(p, DEFAULT_PROTECTED_TEST_HARNESS_PATHS)) {
        violations.push({
          file: p,
          rule: 'TEST_HARNESS_WEAKENING',
          message: `Modification of test runner harness configuration is prohibited: "${p}".`,
        })
      }

      // Path allowlist enforcement
      if (!matchesPathPatterns(p, options.allowedPaths)) {
        violations.push({
          file: p,
          rule: 'PATH_NOT_ALLOWED',
          message: `Path "${p}" is outside the allowedPaths scope.`,
        })
      }

      // Explicit denied paths
      if (options.deniedPaths && matchesPathPatterns(p, options.deniedPaths)) {
        violations.push({
          file: p,
          rule: 'DENIED_PATH',
          message: `Path "${p}" matches deniedPaths specification.`,
        })
      }
    }

    // File mode tampering check
    if (entry.oldMode !== '000000' && entry.newMode !== '000000' && entry.oldMode !== entry.newMode) {
      violations.push({
        file: entry.path,
        rule: 'FILE_MODE_TAMPERING',
        message: `Unauthorized file mode mutation from ${entry.oldMode} to ${entry.newMode} on "${entry.path}".`,
      })
    }

    // Binary blob introduction check
    if (entry.status === 'A') {
      const ext = posix.extname(entry.path).toLowerCase()
      if (BINARY_EXTENSIONS.has(ext)) {
        violations.push({
          file: entry.path,
          rule: 'UNAUTHORIZED_BINARY_FILE',
          message: `Introduction of unauthorized binary file is prohibited: "${entry.path}".`,
        })
      }
    }

    // Symlink escape check (Git mode 120000)
    if (entry.newMode === '120000') {
      try {
        const rawSymlinkTarget = (
          await runGit(options.repoRoot, ['show', `${options.candidateCommit}:${entry.path}`], signal, timeoutMs)
        ).trim()

        // 1. Backslash detection
        if (rawSymlinkTarget.includes('\\')) {
          violations.push({
            file: entry.path,
            rule: 'SYMLINK_ESCAPE',
            message: `Backslash in symlink target "${rawSymlinkTarget}" is strictly prohibited.`,
          })
        }

        // 2. URL decoding detection
        const { decoded: decodedTarget, wasEncoded, error: urlError } = decodeUrlSpecifier(rawSymlinkTarget)
        if (urlError) {
          violations.push({
            file: entry.path,
            rule: 'SYMLINK_ESCAPE',
            message: `Malformed URL encoding in symlink target "${rawSymlinkTarget}": ${urlError}`,
          })
        } else if (
          wasEncoded &&
          (decodedTarget.includes('..') || decodedTarget.includes('/') || decodedTarget.includes('\\'))
        ) {
          violations.push({
            file: entry.path,
            rule: 'SYMLINK_ESCAPE',
            message: `URL-encoded path traversal in symlink target "${rawSymlinkTarget}" (decodes to "${decodedTarget}").`,
          })
        }

        const symlinkTarget = decodedTarget.replace(/\\/g, '/')

        if (symlinkTarget.startsWith('/') || isAbsolute(symlinkTarget)) {
          violations.push({
            file: entry.path,
            rule: 'SYMLINK_ESCAPE',
            message: `Absolute symlink target "${rawSymlinkTarget}" is prohibited.`,
          })
        } else {
          const resolvedRel = posix.normalize(posix.join(posix.dirname(entry.path), symlinkTarget))
          if (resolvedRel.startsWith('..') || resolvedRel === '..' || posix.isAbsolute(resolvedRel)) {
            violations.push({
              file: entry.path,
              rule: 'SYMLINK_ESCAPE',
              message: `Symlink target "${rawSymlinkTarget}" traverses outside repository root.`,
            })
          } else if (resolvedRel === '.git' || resolvedRel.startsWith('.git/')) {
            violations.push({
              file: entry.path,
              rule: 'SYMLINK_ESCAPE',
              message: `Symlink target "${rawSymlinkTarget}" points to Git metadata.`,
            })
          } else if (!matchesPathPatterns(resolvedRel, options.allowedPaths)) {
            violations.push({
              file: entry.path,
              rule: 'SYMLINK_ESCAPE',
              message: `Symlink target "${rawSymlinkTarget}" resolves outside allowedPaths: "${resolvedRel}".`,
            })
          } else if (options.deniedPaths && matchesPathPatterns(resolvedRel, options.deniedPaths)) {
            violations.push({
              file: entry.path,
              rule: 'SYMLINK_ESCAPE',
              message: `Symlink target "${rawSymlinkTarget}" resolves to denied path: "${resolvedRel}".`,
            })
          }
        }
      } catch {
        violations.push({
          file: entry.path,
          rule: 'SYMLINK_ESCAPE',
          message: `Failed to inspect symlink blob for "${entry.path}".`,
        })
      }

      // Real filesystem lstat & realpath verification if repository has checked-out files
      try {
        const fullLocalPath = join(options.repoRoot, entry.path)
        const stat = await lstat(fullLocalPath)
        if (stat.isSymbolicLink()) {
          try {
            const real = await realpath(fullLocalPath)
            const canonicalRepo = await realpath(options.repoRoot)
            if (!real.startsWith(canonicalRepo + '/') && real !== canonicalRepo) {
              violations.push({
                file: entry.path,
                rule: 'SYMLINK_ESCAPE',
                message: `Filesystem symlink resolves outside repository root to "${real}".`,
              })
            }
          } catch (err: any) {
            if (
              err?.code === 'ELOOP' ||
              err?.message?.includes('ELOOP') ||
              err?.message?.includes('too many symbolic links')
            ) {
              violations.push({
                file: entry.path,
                rule: 'SYMLINK_ESCAPE',
                message: `Symlink loop detected on filesystem for "${entry.path}": ${err?.message ?? String(err)}`,
              })
            } else if (err?.code !== 'ENOENT') {
              violations.push({
                file: entry.path,
                rule: 'SYMLINK_ESCAPE',
                message: `Failed to resolve filesystem symlink for "${entry.path}": ${err?.message ?? String(err)}`,
              })
            }
          }
        }
      } catch {
        // file may only exist as git commit blob
      }
    }

    // Test suite deletion check (handles D and R where old was test and new is not)
    if ((entry.status === 'D' || entry.status.startsWith('D')) && isTestFilePath(entry.path)) {
      violations.push({
        file: entry.path,
        rule: 'TEST_SUITE_DELETED',
        message: `Deletion of test suite "${entry.path}" is strictly prohibited.`,
      })
    }
    if (
      (entry.status === 'R' || entry.status.startsWith('R')) &&
      entry.oldPath &&
      isTestFilePath(entry.oldPath) &&
      !isTestFilePath(entry.path)
    ) {
      violations.push({
        file: entry.oldPath,
        rule: 'TEST_SUITE_DELETED',
        message: `Test suite "${entry.oldPath}" was renamed to non-test file "${entry.path}", effectively removing test suite.`,
      })
    }

    // Package.json script weakening check
    if (entry.path.endsWith('package.json') && (entry.status === 'M' || entry.status.startsWith('M'))) {
      try {
        const [oldRaw, newRaw] = await Promise.all([
          runGit(options.repoRoot, ['show', `${options.targetCommit}:${entry.path}`], signal, timeoutMs),
          runGit(options.repoRoot, ['show', `${options.candidateCommit}:${entry.path}`], signal, timeoutMs),
        ])
        const oldPkg = JSON.parse(oldRaw)
        const newPkg = JSON.parse(newRaw)
        if (oldPkg.scripts && newPkg.scripts) {
          for (const [scriptName, oldScript] of Object.entries(oldPkg.scripts)) {
            const newScript = newPkg.scripts[scriptName]
            if (newScript === undefined) {
              violations.push({
                file: entry.path,
                rule: 'POLICY_WEAKENING',
                message: `Package script "${scriptName}" was deleted in candidate.`,
              })
            } else if (
              typeof newScript === 'string' &&
              (newScript.trim() === 'exit 0' || newScript.trim() === 'true' || newScript.trim() === '')
            ) {
              violations.push({
                file: entry.path,
                rule: 'POLICY_WEAKENING',
                message: `Package script "${scriptName}" was replaced with no-op "${newScript}".`,
              })
            }
          }
        }
      } catch {
        // json parse error will be flagged or handled
      }
    }
  }

  // 5. Test Weakening Verification (Ast comparison for modified and renamed test files)
  interface TestFileComparison {
    oldCommit: string
    newCommit: string
    oldPath: string
    newPath: string
  }

  const comparisons: TestFileComparison[] = []
  const seenComparisons = new Set<string>()

  function addComparison(oldCommit: string, newCommit: string, oldPath: string, newPath: string) {
    const key = `${oldCommit}:${oldPath}->${newCommit}:${newPath}`
    if (seenComparisons.has(key)) return
    seenComparisons.add(key)
    comparisons.push({ oldCommit, newCommit, oldPath, newPath })
  }

  // Promotion changes: target -> candidate
  for (const entry of tcEntries) {
    const isModified = entry.status === 'M' || entry.status.startsWith('M')
    const isRenamed = entry.status === 'R' || entry.status.startsWith('R')

    if (isModified && isTestFilePath(entry.path)) {
      addComparison(options.targetCommit, options.candidateCommit, entry.path, entry.path)
    } else if (isRenamed && entry.oldPath && isTestFilePath(entry.oldPath) && isTestFilePath(entry.path)) {
      addComparison(options.targetCommit, options.candidateCommit, entry.oldPath, entry.path)
    }
  }

  // Authored changes: base -> source
  for (const entry of bsEntries) {
    const isModified = entry.status === 'M' || entry.status.startsWith('M')
    const isRenamed = entry.status === 'R' || entry.status.startsWith('R')

    if (isModified && isTestFilePath(entry.path)) {
      addComparison(options.baseCommit, options.sourceCommit, entry.path, entry.path)
    } else if (isRenamed && entry.oldPath && isTestFilePath(entry.oldPath) && isTestFilePath(entry.path)) {
      addComparison(options.baseCommit, options.sourceCommit, entry.oldPath, entry.path)
    }
  }

  for (const { oldCommit, newCommit, oldPath, newPath } of comparisons) {
    try {
      const [oldContent, newContent] = await Promise.all([
        runGit(options.repoRoot, ['show', `${oldCommit}:${oldPath}`], signal, timeoutMs),
        runGit(options.repoRoot, ['show', `${newCommit}:${newPath}`], signal, timeoutMs),
      ])

      const oldSource = ts.createSourceFile(oldPath, oldContent, ts.ScriptTarget.Latest, true, resolveScriptKind(oldPath))
      const newSource = ts.createSourceFile(newPath, newContent, ts.ScriptTarget.Latest, true, resolveScriptKind(newPath))

      const oldMetrics = extractTestMetrics(oldSource)
      const newMetrics = extractTestMetrics(newSource)

      const fileLabel = oldPath === newPath ? newPath : `${oldPath} -> ${newPath}`

      if (newMetrics.skippedCount > oldMetrics.skippedCount) {
        violations.push({
          file: newPath,
          rule: 'TEST_SKIPPED',
          message: `Candidate introduced skipped or disabled tests in "${fileLabel}" (skipped count increased from ${oldMetrics.skippedCount} to ${newMetrics.skippedCount}).`,
        })
      }

      if (newMetrics.activeTestCount < oldMetrics.activeTestCount) {
        violations.push({
          file: newPath,
          rule: 'TEST_CASES_REMOVED',
          message: `Test cases removed from test suite "${fileLabel}" (active count decreased from ${oldMetrics.activeTestCount} to ${newMetrics.activeTestCount}).`,
        })
      }

      if (newMetrics.assertionCount < oldMetrics.assertionCount) {
        violations.push({
          file: newPath,
          rule: 'TEST_ASSERTION_WEAKENED',
          message: `Test assertions removed or weakened in "${fileLabel}" (assertion count decreased from ${oldMetrics.assertionCount} to ${newMetrics.assertionCount}).`,
        })
      }

      if (newMetrics.meaningfulAssertionCount < oldMetrics.meaningfulAssertionCount) {
        violations.push({
          file: newPath,
          rule: 'TEST_ASSERTION_WEAKENED',
          message: `Meaningful test assertions replaced with tautologies in "${fileLabel}" (meaningful assertion count decreased from ${oldMetrics.meaningfulAssertionCount} to ${newMetrics.meaningfulAssertionCount}).`,
        })
      }

      if (newMetrics.dynamicAssertionCount < oldMetrics.dynamicAssertionCount) {
        violations.push({
          file: newPath,
          rule: 'TEST_ASSERTION_WEAKENED',
          message: `Dynamic test assertions replaced with static literal tautologies in "${fileLabel}" (dynamic count decreased from ${oldMetrics.dynamicAssertionCount} to ${newMetrics.dynamicAssertionCount}).`,
        })
      }

      if (newMetrics.booleanTautologyCount > oldMetrics.booleanTautologyCount) {
        violations.push({
          file: newPath,
          rule: 'TEST_ASSERTION_WEAKENED',
          message: `Tautological assertion expect(true).toBe(true) detected in "${fileLabel}".`,
        })
      }

      if (newMetrics.earlyReturnCount > oldMetrics.earlyReturnCount) {
        violations.push({
          file: newPath,
          rule: 'TEST_EARLY_RETURN',
          message: `Early return in test callback disables subsequent assertions in "${fileLabel}".`,
        })
      }

      if (newMetrics.swallowedAssertionCount > oldMetrics.swallowedAssertionCount) {
        violations.push({
          file: newPath,
          rule: 'TEST_ASSERTION_SWALLOWED',
          message: `Assertion swallowed by try/catch without rethrow in "${fileLabel}".`,
        })
      }
    } catch (error) {
      violations.push({
        file: newPath,
        rule: 'TEST_WEAKENING_ERROR',
        message: `Failed to compare test metrics for "${oldPath} -> ${newPath}": ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  // 6. AST Inspection on Added / Modified TypeScript & JavaScript Files in Candidate
  const tsFilesToInspect = Array.from(scannedFilesSet).filter(p => {
    const ext = posix.extname(p).toLowerCase()
    return TS_JS_EXTENSIONS.has(ext)
  })

  for (const filePath of tsFilesToInspect) {
    // Skip files deleted in candidate
    const tcEntry = tcEntries.find(e => e.path === filePath)
    if (tcEntry && (tcEntry.status === 'D' || tcEntry.status.startsWith('D'))) continue

    // Skip symlinks (their blob is the symlink target path, not TypeScript source code)
    const isSymlink = allDiffEntries.some(
      e => (e.path === filePath || e.oldPath === filePath) && e.newMode === '120000',
    )
    if (isSymlink) continue

    let content: string
    try {
      content = await runGit(options.repoRoot, ['show', `${options.candidateCommit}:${filePath}`], signal, timeoutMs)
    } catch {
      continue
    }

    const scriptKind = resolveScriptKind(filePath)
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    )

    // Check syntax parse diagnostics
    const sourceWithDiags = sourceFile as unknown as { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }
    if (sourceWithDiags.parseDiagnostics && sourceWithDiags.parseDiagnostics.length > 0) {
      for (const diag of sourceWithDiags.parseDiagnostics) {
        if (diag.category === ts.DiagnosticCategory.Error) {
          const { line, character } =
            diag.file && diag.start !== undefined
              ? diag.file.getLineAndCharacterOfPosition(diag.start)
              : { line: 0, character: 0 }
          const msg = typeof diag.messageText === 'string' ? diag.messageText : diag.messageText.messageText
          violations.push({
            file: filePath,
            rule: 'PARSE_ERROR',
            message: `Syntax parse error: ${msg}`,
            line: line + 1,
            column: character + 1,
          })
        }
      }
    }

    // If new test file was added, check that it contains no skipped tests, early returns, or swallowed assertions
    const isNewTest = tcEntry && (tcEntry.status === 'A' || tcEntry.status.startsWith('A')) && isTestFilePath(filePath)
    if (isNewTest) {
      const metrics = extractTestMetrics(sourceFile)
      if (metrics.skippedCount > 0) {
        violations.push({
          file: filePath,
          rule: 'TEST_SKIPPED',
          message: `Newly added candidate test file contains ${metrics.skippedCount} skipped tests.`,
        })
      }
      if (metrics.earlyReturnCount > 0) {
        violations.push({
          file: filePath,
          rule: 'TEST_EARLY_RETURN',
          message: `Newly added candidate test file contains early return disabling assertions.`,
        })
      }
      if (metrics.swallowedAssertionCount > 0) {
        violations.push({
          file: filePath,
          rule: 'TEST_ASSERTION_SWALLOWED',
          message: `Newly added candidate test file contains swallowed assertions in try/catch.`,
        })
      }
    }

    // Extract all module specifiers
    const specifiers = extractImportAndExportSpecifiers(sourceFile)
    for (const spec of specifiers) {
      if (!spec.isStatic) {
        // Fail closed on unsupported computed imports
        violations.push({
          file: filePath,
          rule: 'FORBIDDEN_COMPUTED_IMPORT',
          message: `Computed dynamic ${spec.kind} (${spec.dynamicSyntaxKind ?? 'expression'}): "${spec.rawExpression ?? 'unknown'}". Computed imports are strictly prohibited in governed files.`,
          line: spec.line,
          column: spec.column,
          specifier: spec.rawExpression,
        })
      } else if (spec.value) {
        // Check static specifiers
        const rawVal = spec.value

        // 1. URL scheme detection
        if (/^file:/i.test(rawVal)) {
          violations.push({
            file: filePath,
            rule: 'DIRECTORY_TRAVERSAL',
            message: `file:/// URL import specifier "${rawVal}" is strictly prohibited.`,
            line: spec.line,
            column: spec.column,
            specifier: rawVal,
          })
          continue
        }
        if (/^(data|javascript):/i.test(rawVal)) {
          violations.push({
            file: filePath,
            rule: 'FORBIDDEN_COMPUTED_IMPORT',
            message: `Inline executable URL import specifier "${rawVal}" is strictly prohibited.`,
            line: spec.line,
            column: spec.column,
            specifier: rawVal,
          })
          continue
        }
        if (/^(http|https|blob|ftp):/i.test(rawVal)) {
          violations.push({
            file: filePath,
            rule: 'PATH_NOT_ALLOWED',
            message: `Remote URL import specifier "${rawVal}" is strictly prohibited.`,
            line: spec.line,
            column: spec.column,
            specifier: rawVal,
          })
          continue
        }

        // 2. Backslash detection
        if (rawVal.includes('\\')) {
          violations.push({
            file: filePath,
            rule: 'DIRECTORY_TRAVERSAL',
            message: `Backslash in import specifier "${rawVal}" is strictly prohibited; module specifiers must use forward slashes.`,
            line: spec.line,
            column: spec.column,
            specifier: rawVal,
          })
        }

        // 3. URL percent-decoding detection
        const { decoded: decodedVal, wasEncoded, error: urlError } = decodeUrlSpecifier(rawVal)
        if (urlError) {
          violations.push({
            file: filePath,
            rule: 'DIRECTORY_TRAVERSAL',
            message: `Malformed URL encoding in import specifier "${rawVal}": ${urlError}`,
            line: spec.line,
            column: spec.column,
            specifier: rawVal,
          })
        } else if (
          wasEncoded &&
          (decodedVal.includes('..') ||
            decodedVal.startsWith('.') ||
            decodedVal.startsWith('/') ||
            decodedVal.includes('\\'))
        ) {
          violations.push({
            file: filePath,
            rule: 'DIRECTORY_TRAVERSAL',
            message: `URL-encoded path traversal in import specifier "${rawVal}" (decodes to "${decodedVal}").`,
            line: spec.line,
            column: spec.column,
            specifier: rawVal,
          })
        }

        const val = decodedVal.replace(/\\/g, '/')

        // 4. Absolute path detection
        if (val.startsWith('/') || posix.isAbsolute(val)) {
          violations.push({
            file: filePath,
            rule: 'DIRECTORY_TRAVERSAL',
            message: `Absolute import specifier "${rawVal}" is prohibited.`,
            line: spec.line,
            column: spec.column,
            specifier: rawVal,
          })
        } else if (val.startsWith('.')) {
          // 5. Relative path resolution & boundary checks
          const resolvedRel = posix.normalize(posix.join(posix.dirname(filePath), val))
          if (resolvedRel.startsWith('..') || resolvedRel === '..' || posix.isAbsolute(resolvedRel)) {
            violations.push({
              file: filePath,
              rule: 'DIRECTORY_TRAVERSAL',
              message: `Import specifier "${rawVal}" traverses outside repository root.`,
              line: spec.line,
              column: spec.column,
              specifier: rawVal,
            })
          } else if (resolvedRel === '.git' || resolvedRel.startsWith('.git/')) {
            violations.push({
              file: filePath,
              rule: 'GIT_METADATA_VIOLATION',
              message: `Import specifier "${rawVal}" targets Git metadata directory.`,
              line: spec.line,
              column: spec.column,
              specifier: rawVal,
            })
          } else if (options.deniedPaths && matchesPathPatterns(resolvedRel, options.deniedPaths)) {
            violations.push({
              file: filePath,
              rule: 'DENIED_PATH',
              message: `Import specifier "${rawVal}" resolves to denied path: "${resolvedRel}".`,
              line: spec.line,
              column: spec.column,
              specifier: rawVal,
            })
          } else if (!matchesAllowedPath(resolvedRel, options.allowedPaths)) {
            violations.push({
              file: filePath,
              rule: 'PATH_NOT_ALLOWED',
              message: `Import specifier "${rawVal}" resolves outside allowedPaths: "${resolvedRel}".`,
              line: spec.line,
              column: spec.column,
              specifier: rawVal,
            })
          }
        } else {
          // 6. Bare package or node: specifier traversal check
          if (val.includes('/../') || val.endsWith('/..') || val.startsWith('../') || val === '..') {
            violations.push({
              file: filePath,
              rule: 'DIRECTORY_TRAVERSAL',
              message: `Directory traversal in package specifier "${rawVal}" is strictly prohibited.`,
              line: spec.line,
              column: spec.column,
              specifier: rawVal,
            })
          }
        }
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    scannedFiles: Array.from(scannedFilesSet).sort(),
  }
}
