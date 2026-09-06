/** Data-driven sprite engine: typed pixel sheets, validation, timing, and Canvas 2D drawing. */

import { palette } from '../client/assets/palette.ts'

/** Palette key union (re-declared here so engine consumers need no client import). */
export type PaletteKey = keyof typeof palette

/** One animated sprite sheet authored as string pixel maps. */
export interface SpriteSheet {
  readonly name: string            // '<archetype>.<state>' e.g. 'lead.idle'
  readonly frameWidth: number
  readonly frameHeight: number
  readonly fps: number             // 4..12
  readonly legend: Readonly<Record<string, PaletteKey | null>>  // char → palette key; null = transparent
  readonly frames: readonly (readonly string[])[]               // frames[f] = frameHeight strings of frameWidth chars
}

/** Legend character whose pixels take the per-agent tint. */
export const TINT_SLOT = 't'

/**
 * Eight distinct clothing tints for the tint slot, in agent arrival order.
 * Every hex is drawn from the shared palette (brass, copper, steel, oxide,
 * highlight, bronze, muted, surfaceDark) so agents stay on-theme.
 */
export const AGENT_TINTS: readonly string[] = [
  palette.brass,
  palette.copper,
  palette.steel,
  palette.oxide,
  palette.highlight,
  palette.bronze,
  palette.muted,
  palette.surfaceDark,
] as const

const NAME_PATTERN = /^[a-z]+\.[a-z]+$/

/**
 * Validate a sheet against the shared rules; returns human-readable violations
 * (empty array = valid). Mirrors scripts/sprites/rules.mjs for the generator.
 */
export function validateSheet(sheet: SpriteSheet): readonly string[] {
  const violations: string[] = []
  if (!NAME_PATTERN.test(sheet.name)) {
    violations.push(`name '${sheet.name}' must match /^[a-z]+\.[a-z]+$/`)
  }
  if (sheet.frames.length < 2) {
    violations.push(`frames.length ${sheet.frames.length} must be >= 2`)
  }
  if (sheet.fps < 4 || sheet.fps > 12) {
    violations.push(`fps ${sheet.fps} must be within [4, 12]`)
  }
  sheet.frames.forEach((frame, frameIndex) => {
    if (frame.length !== sheet.frameHeight) {
      violations.push(`frame ${frameIndex} has ${frame.length} rows, expected frameHeight ${sheet.frameHeight}`)
    }
    let painted = 0
    frame.forEach((row, rowIndex) => {
      if (row.length !== sheet.frameWidth) {
        violations.push(`frame ${frameIndex} row ${rowIndex} has length ${row.length}, expected frameWidth ${sheet.frameWidth}`)
      }
      for (const char of row) {
        if (!(char in sheet.legend)) {
          violations.push(`frame ${frameIndex} row ${rowIndex} uses char '${char}' missing from the legend`)
        } else if (sheet.legend[char] !== null) {
          painted += 1
        }
      }
    })
    if (frame.length === sheet.frameHeight && painted === 0) {
      violations.push(`frame ${frameIndex} is fully transparent`)
    }
    const previous = sheet.frames[frameIndex - 1]
    if (previous !== undefined && frame.length === previous.length && frame.every((row, i) => row === previous[i])) {
      violations.push(`frame ${frameIndex} is identical to frame ${frameIndex - 1}`)
    }
  })
  return violations
}

/** Pick the animation frame for a wall-clock time in milliseconds. */
export function pickFrame(sheet: SpriteSheet, timeMs: number): number {
  return Math.floor(timeMs / 1000 * sheet.fps) % sheet.frames.length
}

/**
 * Draw one frame of a sheet: one fillRect per non-transparent pixel, snapped
 * via Math.round. The tint slot takes `tint` (default palette.copper).
 * Callers guard a null context; an out-of-range frameIndex wraps modulo.
 */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sheet: SpriteSheet,
  frameIndex: number,
  x: number,
  y: number,
  scale: number,
  tint?: string,
): void {
  const frame = sheet.frames[frameIndex % sheet.frames.length]
  if (frame === undefined) return
  const originX = Math.round(x)
  const originY = Math.round(y)
  const size = Math.max(1, Math.round(scale))
  frame.forEach((row, rowIndex) => {
    for (let col = 0; col < row.length; col += 1) {
      const key = sheet.legend[row.charAt(col)]
      if (key === null || key === undefined) continue
      ctx.fillStyle = row.charAt(col) === TINT_SLOT ? (tint ?? palette.copper) : palette[key]
      ctx.fillRect(
        originX + Math.round(col * scale),
        originY + Math.round(rowIndex * scale),
        size,
        size,
      )
    }
  })
}
