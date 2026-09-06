/** M0 static Canvas 2D scene painter for the visual agents overlay (no sprites yet). */

import { useEffect, useRef } from 'react'
import { palette } from './assets/palette.ts'
import type { VisualSceneModel } from './reconcile.ts'
import css from './VisualAgentsAction.module.css'

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
 * Paint the static M0 factory-floor scene.
 * @param ctx2d - Canvas 2D context already scaled for the device pixel ratio.
 * @param width - CSS-pixel scene width.
 * @param height - CSS-pixel scene height.
 * @param plaqueText - engraved plaque copy (selected project id or the no-project notice).
 */
export function paintScene(
  ctx2d: CanvasRenderingContext2D,
  width: number,
  height: number,
  plaqueText: string,
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
}

/** Props of the static scene canvas. */
export interface SceneCanvasProps {
  scene: VisualSceneModel
  plaqueText: string
}

/** devicePixelRatio-aware canvas repainting the static scene on prop or window-size changes. */
export function SceneCanvas({ scene, plaqueText }: SceneCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
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
      paintScene(ctx2d, cssWidth, cssHeight, plaqueText)
    }
    repaint()
    window.addEventListener('resize', repaint)
    return () => { window.removeEventListener('resize', repaint) }
  }, [scene, plaqueText])
  return <canvas ref={canvasRef} className={css.canvas} data-team-visual-scene />
}
