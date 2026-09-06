#!/usr/bin/env node
/**
 * Verify the generated sprite sheets under
 * packages/client-ui-agent-team-visual/src/assets/sprites/.
 * Extracts each `export const <name>: SpriteSheet =` JSON block (balanced-brace,
 * string-aware scan), JSON.parses it, and runs the shared rules from rules.mjs.
 * Prints one line per sheet and a summary; exits 1 on any violation.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateSheetRules } from './rules.mjs'

const spritesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../packages/client-ui-agent-team-visual/src/assets/sprites',
)

/** Extract the balanced-brace JSON object starting at index `start` (a '{'). */
function extractJsonBlock(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced JSON block in generated sheet')
}

/** Find every exported SpriteSheet JSON block in one generated module. */
function extractSheets(text, file) {
  const sheets = []
  const pattern = /export const (\w+): SpriteSheet =/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const exportName = match[1]
    let cursor = pattern.lastIndex
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1
    if (text[cursor] !== '{') {
      throw new Error(`${file}: export ${exportName} is not followed by a JSON block`)
    }
    sheets.push([exportName, JSON.parse(extractJsonBlock(text, cursor))])
  }
  return sheets
}

let sheetCount = 0
let violationCount = 0
const files = readdirSync(spritesDir).filter(file => file.endsWith('.ts')).sort()
for (const file of files) {
  const text = readFileSync(join(spritesDir, file), 'utf8')
  for (const [exportName, sheet] of extractSheets(text, file)) {
    sheetCount += 1
    const violations = validateSheetRules(sheet)
    if (violations.length === 0) {
      console.log(`✓ ${sheet.name} ${sheet.frameWidth}x${sheet.frameHeight} ${sheet.frames.length}f @${sheet.fps}fps`)
    } else {
      violationCount += violations.length
      console.error(`✗ ${sheet.name} (${file} → ${exportName})`)
      for (const violation of violations) console.error(`    ${violation}`)
    }
  }
}

if (sheetCount === 0) {
  console.error('verify: no sprite sheets found')
  process.exit(1)
}
if (violationCount > 0) {
  console.error(`verify: ${sheetCount} sheets, ${violationCount} violations`)
  process.exit(1)
}
console.log(`verify: ${sheetCount} sheets OK`)
