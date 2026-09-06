/**
 * Shared sprite sheet validation rules for scripts/sprites/generate.mjs and
 * scripts/sprites/verify.mjs. Mirrors validateSheet in
 * packages/client-ui-agent-team-visual/src/engine/sprites.ts — keep in sync.
 */

const NAME_PATTERN = /^[a-z]+\.[a-z]+$/

/**
 * Validate a parsed sheet object; returns human-readable violation strings
 * (empty array = valid).
 */
export function validateSheetRules(sheet) {
  const violations = []
  if (typeof sheet !== 'object' || sheet === null) return ['sheet is not an object']
  const { name, frameWidth, frameHeight, fps, legend, frames } = sheet
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    violations.push(`name '${name}' must match /^[a-z]+\\.[a-z]+$/`)
  }
  if (!Array.isArray(frames) || frames.length < 2) {
    violations.push(`frames.length ${Array.isArray(frames) ? frames.length : '?'} must be >= 2`)
  }
  if (typeof fps !== 'number' || fps < 4 || fps > 12) {
    violations.push(`fps ${fps} must be within [4, 12]`)
  }
  if (typeof legend !== 'object' || legend === null) {
    violations.push('legend must be an object')
    return violations
  }
  if (!Array.isArray(frames)) return violations
  frames.forEach((frame, frameIndex) => {
    if (!Array.isArray(frame)) {
      violations.push(`frame ${frameIndex} is not a row array`)
      return
    }
    if (frame.length !== frameHeight) {
      violations.push(`frame ${frameIndex} has ${frame.length} rows, expected frameHeight ${frameHeight}`)
    }
    let painted = 0
    frame.forEach((row, rowIndex) => {
      if (typeof row !== 'string' || row.length !== frameWidth) {
        violations.push(`frame ${frameIndex} row ${rowIndex} has length ${typeof row === 'string' ? row.length : '?'}, expected frameWidth ${frameWidth}`)
        return
      }
      for (const char of row) {
        if (!(char in legend)) {
          violations.push(`frame ${frameIndex} row ${rowIndex} uses char '${char}' missing from the legend`)
        } else if (legend[char] !== null) {
          painted += 1
        }
      }
    })
    if (frame.length === frameHeight && painted === 0) {
      violations.push(`frame ${frameIndex} is fully transparent`)
    }
    const previous = frames[frameIndex - 1]
    if (Array.isArray(previous) && frame.length === previous.length && frame.every((row, i) => row === previous[i])) {
      violations.push(`frame ${frameIndex} is identical to frame ${frameIndex - 1}`)
    }
  })
  return violations
}
