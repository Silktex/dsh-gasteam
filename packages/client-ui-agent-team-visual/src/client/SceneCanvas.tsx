/** M1 Canvas 2D scene painter: factory floor, plaque, desks, and animated agent sprites. */

import { useEffect, useRef } from 'react'
import { palette } from './assets/palette.ts'
import { drawSprite, pickFrame, type SpriteSheet } from '../engine/sprites.ts'
import type { DeskSlot } from '../scenes/layout.ts'
import type { VisualSceneModel } from './reconcile.ts'
import css from './VisualAgentsAction.module.css'

/** One animated agent placed at a desk slot in the scene. */
export interface SceneAgent {
  readonly sheet: SpriteSheet
  readonly slot: DeskSlot
  readonly tint?: string
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
 * desk and animated sprite (sprite bottom aligned just above the desk top).
 * @param ctx2d - Canvas 2D context already scaled for the device pixel ratio.
 * @param width - CSS-pixel scene width.
 * @param height - CSS-pixel scene height.
 * @param plaqueText - engraved plaque copy (selected project id or the no-project notice).
 * @param agents - animated agents to paint at their desk slots (M1).
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
    const centerX = agent.slot.x * width
    const deskTop = agent.slot.y * height
    paintDesk(ctx2d, centerX, deskTop)
    const scale = spriteScale(agent.sheet)
    const spriteWidth = agent.sheet.frameWidth * scale
    const spriteHeight = agent.sheet.frameHeight * scale
    drawSprite(
      ctx2d,
      agent.sheet,
      pickFrame(agent.sheet, now),
      centerX - spriteWidth / 2,
      deskTop - spriteHeight - 2,
      scale,
      agent.tint,
    )
  }
}

/** Props of the scene canvas. */
export interface SceneCanvasProps {
  scene: VisualSceneModel
  plaqueText: string
  agents?: readonly SceneAgent[]
}

/**
 * devicePixelRatio-aware canvas repainting the scene on prop or window-size
 * changes. With agents present, a ~150ms interval repaints the animation
 * (M1 interim; a RAF loop lands in M2). Interval is cleaned up on
 * unmount/props change; a missing 2D context (jsdom) is a safe no-op.
 */
export function SceneCanvas({ scene, plaqueText, agents }: SceneCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animated = (agents?.length ?? 0) > 0
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const repaint = (): void => {
      const ratio = window.devicePixelRatio || 1
      const cssWidth = canvas.clientWidth > 0 ? canvas.clientWidth : 640
      const cssHeight = canvas.clientHeight > 0 ? canvas.clientHeight : 360
      canvas.width = Math.max(1, Math.round(cssWidth * ratio))
      canvas.height = Math.max(1, Math.round(cssHeight * ratio))
      const ctx2d = canvas.getContext('2d')
      if (ctx2d === null) return
      ctx2d.setTransform(ratio, 0, 0, ratio, 0, 0)
      paintScene(ctx2d, cssWidth, cssHeight, plaqueText, agents, animated ? Date.now() : 0)
    }
    repaint()
    window.addEventListener('resize', repaint)
    const interval = animated ? window.setInterval(repaint, 150) : null
    return () => {
      window.removeEventListener('resize', repaint)
      if (interval !== null) window.clearInterval(interval)
    }
  }, [scene, plaqueText, agents, animated])
  return <canvas ref={canvasRef} className={css.canvas} data-team-visual-scene />
}
