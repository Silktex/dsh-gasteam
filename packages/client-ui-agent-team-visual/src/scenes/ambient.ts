/**
 * M4 ambient painter: rotating gears, flickering gas lamps, a smoking stack,
 * and a drifting zeppelin. Every motion is a PURE function of `timeMs` —
 * no randomness, no module state — so identical timestamps paint identical
 * frames.
 */

import { palette } from '../client/assets/palette.ts'
import type { SceneThemeColors } from './theme.ts'

const TWO_PI = Math.PI * 2

/** Paint one rotating gear: 8 teeth at rotated angles + ring + parchment hub. */
function paintGear(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: string,
  rotation: number,
): void {
  ctx.save()
  ctx.fillStyle = color
  const teeth = 8
  for (let index = 0; index < teeth; index += 1) {
    const angle = rotation + (index / teeth) * TWO_PI
    ctx.beginPath()
    ctx.arc(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, radius * 0.3, 0, TWO_PI)
    ctx.fill()
  }
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, TWO_PI)
  ctx.fill()
  ctx.fillStyle = palette.parchment
  ctx.beginPath()
  ctx.arc(cx, cy, radius * 0.42, 0, TWO_PI)
  ctx.fill()
  ctx.restore()
}

/** Paint one gas lamp: flickering glow behind a brass post and head. */
function paintLamp(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  height: number,
  timeMs: number,
  lampIndex: number,
  colors: SceneThemeColors,
): void {
  const glowAlpha = 0.25 + 0.15 * Math.sin(timeMs / 400 + lampIndex * 1.7)
  ctx.save()
  ctx.globalAlpha = glowAlpha
  ctx.fillStyle = colors.lampGlow
  ctx.beginPath()
  ctx.arc(x, y, height * 0.032, 0, TWO_PI)
  ctx.fill()
  ctx.restore()
  ctx.fillStyle = palette.brass
  ctx.fillRect(Math.round(x - 2), Math.round(y), 4, Math.round(height * 0.1))
  ctx.beginPath()
  ctx.arc(x, y - 3, 5, 0, TWO_PI)
  ctx.fill()
}

/** Paint the smokestack and its three rising/fading puffs. */
function paintSmokestack(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  timeMs: number,
): void {
  const stackX = width * 0.05
  const stackTop = height * 0.28
  const stackBottom = height * 0.42
  ctx.fillStyle = palette.darkWood
  ctx.fillRect(Math.round(stackX - 7), Math.round(stackTop), 14, Math.round(stackBottom - stackTop))
  ctx.fillStyle = palette.bronze
  ctx.fillRect(Math.round(stackX - 9), Math.round(stackTop - 4), 18, 4)
  ctx.save()
  ctx.fillStyle = palette.muted
  for (let index = 0; index < 3; index += 1) {
    // 6s loop per puff, offset by 2s each; progress in [0, 1).
    const progress = (((timeMs + index * 2000) % 6000) + 6000) / 6000 % 1
    const puffY = stackTop - progress * height * 0.18
    const puffX = stackX + Math.sin(progress * Math.PI) * 8
    ctx.globalAlpha = 0.35 * (1 - progress)
    ctx.beginPath()
    ctx.arc(puffX, puffY, 6 + progress * 8, 0, TWO_PI)
    ctx.fill()
  }
  ctx.restore()
}

/** Paint the zeppelin drifting across the top band (~45s per crossing). */
function paintZeppelin(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  timeMs: number,
): void {
  const x = ((timeMs / 45000) % 1.3 - 0.15) * width
  const y = height * 0.08
  ctx.fillStyle = palette.muted
  ctx.beginPath()
  ctx.ellipse(x, y, 42, 14, 0, 0, TWO_PI)
  ctx.fill()
  ctx.fillStyle = palette.darkWood
  ctx.fillRect(Math.round(x - 48), Math.round(y - 4), 8, 8) // tail fin
  ctx.fillStyle = palette.brass
  ctx.fillRect(Math.round(x - 10), Math.round(y + 12), 20, 8) // gondola
}

/**
 * Paint the ambient decoration layer: two rotating gears (gearA +2π/12s,
 * gearB −2π/9s), two flickering gas lamps, the smokestack puffs, and the
 * drifting zeppelin. Called after background+grid, before plaque and agents.
 */
export function paintAmbient(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  timeMs: number,
  colors: SceneThemeColors,
): void {
  paintGear(ctx, width * 0.12, height * 0.8, Math.max(18, height * 0.07), colors.gearA, (timeMs / 12000) * TWO_PI)
  paintGear(ctx, width * 0.88, height * 0.2, Math.max(14, height * 0.055), colors.gearB, -(timeMs / 9000) * TWO_PI)
  paintLamp(ctx, width * 0.28, height * 0.3, height, timeMs, 0, colors)
  paintLamp(ctx, width * 0.72, height * 0.3, height, timeMs, 1, colors)
  paintSmokestack(ctx, width, height, timeMs)
  paintZeppelin(ctx, width, height, timeMs)
}
