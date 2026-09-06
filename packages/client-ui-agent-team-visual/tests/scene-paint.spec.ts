/** Host-runnable paintScene coverage with a recording stub 2D context. */

import { describe, expect, it } from 'vitest'
import { palette } from '../src/client/assets/palette.ts'
import { paintScene, type SceneAgent } from '../src/client/SceneCanvas.tsx'
import type { SpriteSheet } from '../src/engine/sprites.ts'

interface RecordedRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly style: string
}

interface Stub {
  readonly ctx: CanvasRenderingContext2D
  readonly rects: RecordedRect[]
  readonly texts: string[]
  readonly arcs: number
  readonly strokes: number
}

/** Recording 2D-context stub covering every method paintScene touches. */
function stubContext(): Stub {
  const rects: RecordedRect[] = []
  const texts: string[] = []
  let arcs = 0
  let strokes = 0
  const ctx = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    fillRect(x: number, y: number, w: number, h: number): void {
      rects.push({ x, y, w, h, style: this.fillStyle })
    },
    fillText(text: string): void { texts.push(text) },
    save(): void {},
    restore(): void {},
    beginPath(): void {},
    arc(): void { arcs += 1 },
    fill(): void {},
    moveTo(): void {},
    lineTo(): void {},
    stroke(): void { strokes += 1 },
  } as unknown as CanvasRenderingContext2D
  return {
    ctx, rects, texts,
    get arcs() { return arcs },
    get strokes() { return strokes },
  }
}

/** Two-frame 2x2 sheet: frame 0 fully inked, frame 1 diagonal pixels. */
function tinySheet(): SpriteSheet {
  return {
    name: 'tiny.walk', frameWidth: 2, frameHeight: 2, fps: 6,
    legend: { '.': null, X: 'ink' },
    frames: [['XX', 'XX'], ['X.', '.X']],
  }
}

function agentAt(x: number, y: number, desk = { x: 0.25, y: 0.6 }): SceneAgent {
  return { sheet: tinySheet(), x, y, desk }
}

describe('paintScene', () => {
  it('paints background, floor grid, two gears, and the plaque text', () => {
    const stub = stubContext()
    paintScene(stub.ctx, 100, 100, 'Project alpha')
    expect(stub.rects[0]).toEqual({ x: 0, y: 0, w: 100, h: 100, style: palette.parchment })
    expect(stub.strokes).toBeGreaterThan(0) // floor grid lines
    expect(stub.arcs).toBeGreaterThanOrEqual(2 * (8 + 2)) // two gears: 8 teeth + ring + hub each
    expect(stub.texts).toEqual(['Project alpha'])
  })

  it('works without agents or timeMs (M0 compatibility)', () => {
    const stub = stubContext()
    expect(() => { paintScene(stub.ctx, 80, 60, 'none') }).not.toThrow()
    expect(stub.texts).toEqual(['none'])
  })

  it('paints exactly one desk per agent at the desk slot', () => {
    const stub = stubContext()
    const agents = [agentAt(0.1, 0.4), agentAt(0.2, 0.4, { x: 0.5, y: 0.7 })]
    paintScene(stub.ctx, 100, 100, 'p', agents, 0)
    const deskTops = stub.rects.filter(rect => rect.style === palette.darkWood && rect.w === 110 && rect.h === 8)
    expect(deskTops).toHaveLength(2)
    expect(deskTops[0]).toMatchObject({ x: Math.round(0.25 * 100 - 55), y: 60 })
    expect(deskTops[1]).toMatchObject({ x: Math.round(0.5 * 100 - 55), y: 70 })
  })

  it('draws sprite pixels bottom-centered at agent x/y', () => {
    const stub = stubContext()
    // 2x2 sheet at scale 2 → 4x4 px; bottom-center at (0.5*100, 0.5*100) = (50, 50).
    paintScene(stub.ctx, 100, 100, 'p', [agentAt(0.5, 0.5)], 0)
    const sprite = stub.rects.filter(rect => rect.style === palette.ink && rect.w === 2 && rect.h === 2)
    expect(sprite).toEqual([
      { x: 48, y: 46, w: 2, h: 2, style: palette.ink },
      { x: 50, y: 46, w: 2, h: 2, style: palette.ink },
      { x: 48, y: 48, w: 2, h: 2, style: palette.ink },
      { x: 50, y: 48, w: 2, h: 2, style: palette.ink },
    ])
  })

  it('animates via timeMs (frame selection follows the sheet fps)', () => {
    const stub = stubContext()
    paintScene(stub.ctx, 100, 100, 'p', [agentAt(0.5, 0.5)], 167) // 6fps → frame 1
    const sprite = stub.rects.filter(rect => rect.style === palette.ink && rect.w === 2 && rect.h === 2)
    expect(sprite).toEqual([
      { x: 48, y: 46, w: 2, h: 2, style: palette.ink },
      { x: 50, y: 48, w: 2, h: 2, style: palette.ink },
    ])
  })

  it('draws the badge above the head, centered at scale 2, when agent.badge is set', () => {
    const stub = stubContext()
    // 2x2 agent sheet at scale 2 → sprite 4x4 at (48,46); center-x = 50, top = 46.
    // Badge: 8x8 sheet at scale 2 → badgeX = 50 - 8 = 42, badgeY = 46 - 20 = 26.
    const badge: SpriteSheet = {
      name: 'badge.done', frameWidth: 8, frameHeight: 8, fps: 4,
      legend: { '.': null, b: 'brass' },
      frames: [
        ['........', '........', '........', '..b.....', '........', '........', '........', '........'],
        ['........', '........', '........', '........', '........', '........', '........', '........'],
      ],
    }
    const agent: SceneAgent = { ...agentAt(0.5, 0.5), badge }
    paintScene(stub.ctx, 100, 100, 'p', [agent], 0)
    const badgePixels = stub.rects.filter(rect => rect.style === palette.brass && rect.w === 2 && rect.h === 2)
    // frame 0: single 'b' pixel at sheet (row 3, col 2) → (42 + 2*2, 26 + 3*2).
    expect(badgePixels).toEqual([{ x: 46, y: 32, w: 2, h: 2, style: palette.brass }])
  })

  it('draws no badge pixels when agent.badge is null or absent', () => {
    const stub = stubContext()
    paintScene(stub.ctx, 100, 100, 'p', [{ ...agentAt(0.5, 0.5), badge: null }, agentAt(0.7, 0.5)], 0)
    const badgePixels = stub.rects.filter(rect => rect.style === palette.brass && rect.w === 2 && rect.h === 2)
    expect(badgePixels).toEqual([])
  })

  it('picks the badge frame from timeMs (badge fps)', () => {
    const stub = stubContext()
    const badge: SpriteSheet = {
      name: 'badge.error', frameWidth: 8, frameHeight: 8, fps: 4,
      legend: { '.': null, r: 'oxide' },
      frames: [
        ['........', '........', '........', '........', '........', '........', '........', '........'],
        ['........', '........', '........', '..r.....', '........', '........', '........', '........'],
      ],
    }
    const agent: SceneAgent = { ...agentAt(0.5, 0.5), badge }
    paintScene(stub.ctx, 100, 100, 'p', [agent], 0) // 4fps → frame 0: no badge pixel
    expect(stub.rects.filter(rect => rect.style === palette.oxide)).toEqual([])
    paintScene(stub.ctx, 100, 100, 'p', [agent], 250) // 4fps → frame 1
    const painted = stub.rects.filter(rect => rect.style === palette.oxide)
    expect(painted).toEqual([{ x: 46, y: 32, w: 2, h: 2, style: palette.oxide }])
  })

  it('applies the agent tint to tint-slot pixels', () => {
    const stub = stubContext()
    const tinted: SceneAgent = {
      sheet: {
        name: 'tiny.walk', frameWidth: 1, frameHeight: 2, fps: 6,
        legend: { '.': null, t: 'copper' },
        frames: [['t', 't'], ['t', '.']],
      },
      x: 0.5, y: 0.5, desk: { x: 0.25, y: 0.6 }, tint: '#123456',
    }
    paintScene(stub.ctx, 100, 100, 'p', [tinted], 0)
    const tintedRects = stub.rects.filter(rect => rect.style === '#123456')
    expect(tintedRects).toHaveLength(2) // frame 0 has two tint pixels
  })
})
