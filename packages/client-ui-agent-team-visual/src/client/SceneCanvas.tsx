/** M2 Canvas 2D scene painter: factory floor, plaque, desks, and actor-driven sprites. */

import { useEffect, useRef } from 'react'
import { palette } from './assets/palette.ts'
import { drawSprite, pickFrame, type SpriteSheet } from '../engine/sprites.ts'
import { startLoop } from '../engine/loop.ts'
import type { DeskSlot } from '../scenes/layout.ts'
import { paintAmbient } from '../scenes/ambient.ts'
import { resolveSceneTheme, type SceneTheme, type SceneThemeColors } from '../scenes/theme.ts'
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

/** Paint one simple desk: themed top with themed legs, centered on the slot. */
function paintDesk(
  ctx2d: CanvasRenderingContext2D,
  centerX: number,
  topY: number,
  colors: SceneThemeColors,
): void {
  const deskWidth = 110
  const topHeight = 8
  const left = Math.round(centerX - deskWidth / 2)
  const top = Math.round(topY)
  ctx2d.fillStyle = colors.deskTop
  ctx2d.fillRect(left, top, deskWidth, topHeight)
  ctx2d.fillStyle = colors.deskLeg
  ctx2d.fillRect(left + 6, top + topHeight, 8, 26)
  ctx2d.fillRect(left + deskWidth - 14, top + topHeight, 8, 26)
}

/** Plaque top band: fixed y and height so it stays readable at any canvas height. */
const PLAQUE_TOP_Y = 12
const PLAQUE_HEIGHT = 72

/** Paint the brass porthole-framed engraved plaque pinned to the TOP band (M4). */
function paintPlaque(
  ctx2d: CanvasRenderingContext2D,
  width: number,
  plaqueText: string,
  colors: SceneThemeColors,
): void {
  const plaqueWidth = Math.min(width * 0.62, 460)
  const x = (width - plaqueWidth) / 2
  const y = PLAQUE_TOP_Y
  ctx2d.fillStyle = colors.plaqueFrame
  ctx2d.fillRect(x - 10, y - 10, plaqueWidth + 20, PLAQUE_HEIGHT + 20)
  ctx2d.fillStyle = colors.plaqueFill
  ctx2d.fillRect(x, y, plaqueWidth, PLAQUE_HEIGHT)
  ctx2d.fillStyle = palette.bronze
  for (const [rivetX, rivetY] of [
    [x - 10, y - 10],
    [x + plaqueWidth + 10, y - 10],
    [x - 10, y + PLAQUE_HEIGHT + 10],
    [x + plaqueWidth + 10, y + PLAQUE_HEIGHT + 10],
  ] as const) {
    ctx2d.beginPath()
    ctx2d.arc(rivetX, rivetY, 3, 0, Math.PI * 2)
    ctx2d.fill()
  }
  ctx2d.fillStyle = colors.plaqueText
  ctx2d.font = '16px serif'
  ctx2d.textAlign = 'center'
  ctx2d.textBaseline = 'middle'
  ctx2d.fillText(plaqueText, width / 2, PLAQUE_TOP_Y + PLAQUE_HEIGHT / 2, plaqueWidth - 16)
}

/** Maximum posters on the wanted-board (M4). */
const BOARD_MAX_TASKS = 8
/** TaskId poster truncation length (9px monospace fits the board). */
const BOARD_TASK_CHARS = 14

/**
 * Paint the right-wall wanted-board (M4): bronze-framed board with a WANTED
 * header and one parchment poster per taskId (max 8, truncated to 14 chars);
 * an empty task list renders a single '—' poster.
 */
function paintWantedBoard(
  ctx2d: CanvasRenderingContext2D,
  width: number,
  height: number,
  tasks: readonly string[],
  colors: SceneThemeColors,
): void {
  const boardWidth = Math.min(width * 0.2, 180)
  const boardX = width * 0.88 - boardWidth / 2
  const boardY = height * 0.3
  const headerHeight = 22
  const rowHeight = 18
  const shown = tasks.slice(0, BOARD_MAX_TASKS)
  const posters = shown.length === 0
    ? ['—']
    : shown.map(taskId => taskId.length > BOARD_TASK_CHARS ? taskId.slice(0, BOARD_TASK_CHARS) : taskId)
  const boardHeight = headerHeight + posters.length * rowHeight + 8
  ctx2d.fillStyle = palette.bronze
  ctx2d.fillRect(boardX - 4, boardY - 4, boardWidth + 8, boardHeight + 8)
  ctx2d.fillStyle = colors.boardFill
  ctx2d.fillRect(boardX, boardY, boardWidth, boardHeight)
  ctx2d.fillStyle = colors.boardText
  ctx2d.font = 'bold 12px serif'
  ctx2d.textAlign = 'center'
  ctx2d.textBaseline = 'middle'
  ctx2d.fillText('WANTED', boardX + boardWidth / 2, boardY + headerHeight / 2 + 2)
  ctx2d.font = '9px monospace'
  const posterWidth = boardWidth - 16
  posters.forEach((posterText, index) => {
    const posterY = boardY + headerHeight + index * rowHeight + 2
    ctx2d.fillStyle = palette.parchment
    ctx2d.fillRect(boardX + 8, posterY, posterWidth, rowHeight - 4)
    ctx2d.fillStyle = palette.ink
    ctx2d.fillText(posterText, boardX + boardWidth / 2, posterY + (rowHeight - 4) / 2)
  })
}

/** Optional paint knobs (M4): theme selection and wanted-board task list. */
export interface ScenePaintOptions {
  readonly theme?: SceneTheme
  readonly tasks?: readonly string[]
}

/**
 * Paint the factory-floor scene: themed background and grid, ambient
 * decoration (gears/lamps/smoke/zeppelin), the top-band plaque, the optional
 * right-wall wanted-board, then each agent's desk (at agent.desk) and
 * animated sprite, bottom-centered at (agent.x * width, agent.y * height) —
 * the actor FSM places settled actors 0.10 in front of the desk line, so no
 * extra offset is applied here.
 * @param ctx2d - Canvas 2D context already scaled for the device pixel ratio.
 * @param width - CSS-pixel scene width.
 * @param height - CSS-pixel scene height.
 * @param plaqueText - engraved plaque copy (selected project id or the no-project notice).
 * @param agents - actor-driven agents to paint (M2); optional for M0 compatibility.
 * @param timeMs - wall-clock milliseconds driving `pickFrame` animation.
 * @param options - M4 paint options; theme defaults to 'light', tasks omit the board.
 */
export function paintScene(
  ctx2d: CanvasRenderingContext2D,
  width: number,
  height: number,
  plaqueText: string,
  agents?: readonly SceneAgent[],
  timeMs?: number,
  options?: ScenePaintOptions,
): void {
  const colors = resolveSceneTheme(options?.theme ?? 'light')
  const now = timeMs ?? 0
  ctx2d.fillStyle = colors.background
  ctx2d.fillRect(0, 0, width, height)

  ctx2d.save()
  ctx2d.strokeStyle = colors.grid
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

  paintAmbient(ctx2d, width, height, now, colors)

  paintPlaque(ctx2d, width, plaqueText, colors)

  if (options?.tasks !== undefined) {
    paintWantedBoard(ctx2d, width, height, options.tasks, colors)
  }

  for (const agent of agents ?? []) {
    paintDesk(ctx2d, agent.desk.x * width, agent.desk.y * height, colors)
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
  /** Scene theme (M4); defaults to 'light' inside paintScene. */
  theme?: SceneTheme
  /** TaskIds for the right-wall wanted-board (M4); omitted → no board. */
  tasks?: readonly string[]
}

/**
 * devicePixelRatio-aware canvas repainting the scene via a single RAF loop
 * (setTimeout fallback in jsdom): each frame calls onFrame (actor stepping)
 * then repaints with timeMs = now(). The loop stops on unmount; a missing 2D
 * context (jsdom) skips painting but keeps the loop alive.
 */
export function SceneCanvas({ plaqueText, getAgents, onFrame, theme, tasks }: SceneCanvasProps) {
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
      // Optional diagnostics hook used by the scratch perf harness
      // (window.__gasviewPaintProbe receives each paintScene duration in ms).
      const probe = (window as unknown as {
        __gasviewPaintProbe?: (durationMs: number) => void
      }).__gasviewPaintProbe
      if (probe === undefined) {
        paintScene(ctx2d, cssWidth, cssHeight, plaqueText, getAgents(), timeMs, { theme, tasks })
      } else {
        const paintStart = performance.now()
        paintScene(ctx2d, cssWidth, cssHeight, plaqueText, getAgents(), timeMs, { theme, tasks })
        probe(performance.now() - paintStart)
      }
    }
    const handle = startLoop(repaint)
    const onResize = (): void => { repaint(Date.now(), 0) }
    window.addEventListener('resize', onResize)
    return () => {
      handle.stop()
      window.removeEventListener('resize', onResize)
    }
  }, [plaqueText, getAgents, onFrame, theme, tasks])
  return <canvas ref={canvasRef} className={css.canvas} data-team-visual-scene />
}
