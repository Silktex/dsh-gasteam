/** M2 Canvas 2D scene painter: factory floor, plaque, desks, and actor-driven sprites. */

import { useEffect, useRef } from 'react'
import { palette } from './assets/palette.ts'
import { drawSprite, pickFrame, type SpriteSheet } from '../engine/sprites.ts'
import { startLoop } from '../engine/loop.ts'
import type { DeskSlot } from '../scenes/layout.ts'
import css from './VisualAgentsAction.module.css'

/** One actor-driven agent placement in the scene (normalized 0..1 coords). */
export interface SceneAgent {
  readonly sheet: SpriteSheet
  readonly x: number
  readonly y: number
  readonly desk: DeskSlot
  readonly tint?: string
  /** Optional 8x8 state badge hovering above the head (M3). */
  readonly badge?: SpriteSheet | null
}

/** Pixel scale for a sheet: lead (64px) → 1.5, teammate (48px) → 2 (both → 96px tall). */
function spriteScale(sheet: SpriteSheet): number {
  return sheet.frameHeight >= 64 ? 1.5 : 2
}

/** Paint one simple desk: darkWood top with bronze legs, centered on the slot. */
function paintDesk(
  ctx2d: CanvasRenderingContext2D,
  centerX: number,
  topY: number,
): void {
  const deskWidth = 110
  const topHeight = 8
  const left = Math.round(centerX - deskWidth / 2)
  const top = Math.round(topY)
  ctx2d.fillStyle = palette.darkWood
  ctx2d.fillRect(left, top, deskWidth, topHeight)
  ctx2d.fillStyle = palette.bronze
  ctx2d.fillRect(left + 6, top + topHeight, 8, 26)
  ctx2d.fillRect(left + deskWidth - 14, top + topHeight, 8, 26)
}

/** Paint one static gear silhouette: toothed ring with a parchment hub. */
function paintGear(
  ctx2d: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: string,
): void {
  ctx2d.save()
  ctx2d.fillStyle = color
  const teeth = 8
  for (let index = 0; index < teeth; index += 1) {
    const angle = (index / teeth) * Math.PI * 2
    ctx2d.beginPath()
    ctx2d.arc(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, radius * 0.3, 0, Math.PI * 2)
    ctx2d.fill()
  }
  ctx2d.beginPath()
  ctx2d.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx2d.fill()
  ctx2d.fillStyle = palette.parchment
  ctx2d.beginPath()
  ctx2d.arc(cx, cy, radius * 0.42, 0, Math.PI * 2)
  ctx2d.fill()
  ctx2d.restore()
}

/** Paint the brass porthole-framed engraved plaque with rivets and centered copy. */
function paintPlaque(
  ctx2d: CanvasRenderingContext2D,
  width: number,
  height: number,
  plaqueText: string,
): void {
  const plaqueWidth = Math.min(width * 0.62, 460)
  const plaqueHeight = 72
  const x = (width - plaqueWidth) / 2
  const y = (height - plaqueHeight) / 2
  ctx2d.fillStyle = palette.brass
  ctx2d.fillRect(x - 10, y - 10, plaqueWidth + 20, plaqueHeight + 20)
  ctx2d.fillStyle = palette.bronze
  ctx2d.fillRect(x - 5, y - 5, plaqueWidth + 10, plaqueHeight + 10)
  ctx2d.fillStyle = palette.surface
  ctx2d.fillRect(x, y, plaqueWidth, plaqueHeight)
  ctx2d.fillStyle = palette.darkWood
  for (const [rivetX, rivetY] of [
    [x - 10, y - 10],
    [x + plaqueWidth + 10, y - 10],
    [x - 10, y + plaqueHeight + 10],
    [x + plaqueWidth + 10, y + plaqueHeight + 10],
  ] as const) {
    ctx2d.beginPath()
    ctx2d.arc(rivetX, rivetY, 3, 0, Math.PI * 2)
    ctx2d.fill()
  }
  ctx2d.fillStyle = palette.ink
  ctx2d.font = '16px serif'
  ctx2d.textAlign = 'center'
  ctx2d.textBaseline = 'middle'
  ctx2d.fillText(plaqueText, width / 2, height / 2, plaqueWidth - 16)
}

/**
 * Paint the factory-floor scene: background, gears, plaque, then each agent's
 * desk (at agent.desk) and animated sprite, bottom-centered at
 * (agent.x * width, agent.y * height) — the actor FSM places settled actors
 * 0.10 in front of the desk line, so no extra offset is applied here.
 * @param ctx2d - Canvas 2D context already scaled for the device pixel ratio.
 * @param width - CSS-pixel scene width.
 * @param height - CSS-pixel scene height.
 * @param plaqueText - engraved plaque copy (selected project id or the no-project notice).
 * @param agents - actor-driven agents to paint (M2); optional for M0 compatibility.
 * @param timeMs - wall-clock milliseconds driving `pickFrame` animation.
 */
export function paintScene(
  ctx2d: CanvasRenderingContext2D,
  width: number,
  height: number,
  plaqueText: string,
  agents?: readonly SceneAgent[],
  timeMs?: number,
): void {
  ctx2d.fillStyle = palette.parchment
  ctx2d.fillRect(0, 0, width, height)

  ctx2d.save()
  ctx2d.strokeStyle = palette.muted
  ctx2d.globalAlpha = 0.3
  ctx2d.lineWidth = 1
  const grid = 32
  for (let x = grid; x < width; x += grid) {
    ctx2d.beginPath()
    ctx2d.moveTo(x, 0)
    ctx2d.lineTo(x, height)
    ctx2d.stroke()
  }
  for (let y = grid; y < height; y += grid) {
    ctx2d.beginPath()
    ctx2d.moveTo(0, y)
    ctx2d.lineTo(width, y)
    ctx2d.stroke()
  }
  ctx2d.restore()

  paintGear(ctx2d, width * 0.12, height * 0.8, Math.max(18, height * 0.07), palette.brass)
  paintGear(ctx2d, width * 0.88, height * 0.2, Math.max(14, height * 0.055), palette.copper)

  paintPlaque(ctx2d, width, height, plaqueText)

  const now = timeMs ?? 0
  for (const agent of agents ?? []) {
    paintDesk(ctx2d, agent.desk.x * width, agent.desk.y * height)
    const scale = spriteScale(agent.sheet)
    const spriteWidth = agent.sheet.frameWidth * scale
    const spriteHeight = agent.sheet.frameHeight * scale
    const spriteX = agent.x * width - spriteWidth / 2
    const spriteY = agent.y * height - spriteHeight
    drawSprite(
      ctx2d,
      agent.sheet,
      pickFrame(agent.sheet, now),
      spriteX,
      spriteY,
      scale,
      agent.tint,
    )
    // State badge (M3): 8px sheet at scale 2 → 16px wide, centered on the
    // sprite's center-x (center - 8), hovering 20px above the sprite top.
    if (agent.badge != null) {
      drawSprite(
        ctx2d,
        agent.badge,
        pickFrame(agent.badge, now),
        spriteX + spriteWidth / 2 - 8,
        spriteY - 20,
        2,
      )
    }
  }
}

/** Props of the scene canvas. */
export interface SceneCanvasProps {
  plaqueText: string
  /** Actor getter read every frame (actors live outside React state at 60fps). */
  getAgents: () => readonly SceneAgent[]
  /** Called inside the RAF loop BEFORE painting (actor stepping hook). */
  onFrame?: (timeMs: number, dtMs: number) => void
}

/**
 * devicePixelRatio-aware canvas repainting the scene via a single RAF loop
 * (setTimeout fallback in jsdom): each frame calls onFrame (actor stepping)
 * then repaints with timeMs = now(). The loop stops on unmount; a missing 2D
 * context (jsdom) skips painting but keeps the loop alive.
 */
export function SceneCanvas({ plaqueText, getAgents, onFrame }: SceneCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const repaint = (timeMs: number, dtMs: number): void => {
      onFrame?.(timeMs, dtMs)
      const ratio = window.devicePixelRatio || 1
      const cssWidth = canvas.clientWidth > 0 ? canvas.clientWidth : 640
      const cssHeight = canvas.clientHeight > 0 ? canvas.clientHeight : 360
      canvas.width = Math.max(1, Math.round(cssWidth * ratio))
      canvas.height = Math.max(1, Math.round(cssHeight * ratio))
      const ctx2d = canvas.getContext('2d')
      if (ctx2d === null) return
      ctx2d.setTransform(ratio, 0, 0, ratio, 0, 0)
      paintScene(ctx2d, cssWidth, cssHeight, plaqueText, getAgents(), timeMs)
    }
    const handle = startLoop(repaint)
    const onResize = (): void => { repaint(Date.now(), 0) }
    window.addEventListener('resize', onResize)
    return () => {
      handle.stop()
      window.removeEventListener('resize', onResize)
    }
  }, [plaqueText, getAgents, onFrame])
  return <canvas ref={canvasRef} className={css.canvas} data-team-visual-scene />
}
