/** Sprite engine rules, frame timing, drawing, and generated sheet coverage. */

import { describe, expect, it } from 'vitest'
import { palette } from '../src/client/assets/palette.ts'
import {
  AGENT_TINTS, TINT_SLOT, drawSprite, pickFrame, validateSheet, type SpriteSheet,
} from '../src/engine/sprites.ts'
import { leadIdle, leadWork } from '../src/assets/sprites/lead.ts'
import { teammateIdle, teammateWork } from '../src/assets/sprites/teammate.ts'

/** Minimal valid 4x3 two-frame sheet used as the baseline for violation tests. */
function validSheet(overrides: Partial<SpriteSheet> = {}): SpriteSheet {
  return {
    name: 'tiny.idle',
    frameWidth: 4,
    frameHeight: 3,
    fps: 6,
    legend: { '.': null, X: 'ink', t: 'copper' },
    frames: [
      ['XXXX', 'XttX', 'XXXX'],
      ['XXXX', 'Xt.X', 'XXXX'],
    ],
    ...overrides,
  }
}

interface RecordedRect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/** Stub 2D context recording fillStyle/fillRect pairs. */
function stubContext(): {
  ctx: CanvasRenderingContext2D
  rects: readonly RecordedRect[]
  styles: readonly string[]
} {
  const rects: RecordedRect[] = []
  const styles: string[] = []
  const ctx = {
    fillStyle: '#000000',
    fillRect(x: number, y: number, w: number, h: number): void {
      rects.push({ x, y, w, h })
      styles.push(this.fillStyle)
    },
  } as unknown as CanvasRenderingContext2D
  return { ctx, rects, styles }
}

describe('sprite constants', () => {
  it('exposes the tint slot legend character', () => {
    expect(TINT_SLOT).toBe('t')
  })

  it('provides exactly 8 distinct tints drawn from the palette', () => {
    expect(AGENT_TINTS).toHaveLength(8)
    expect(new Set(AGENT_TINTS).size).toBe(8)
    const paletteHexes = new Set(Object.values(palette))
    for (const tint of AGENT_TINTS) {
      expect(tint).toMatch(/^#[0-9a-f]{6}$/)
      expect(paletteHexes.has(tint)).toBe(true)
    }
  })
})

describe('validateSheet', () => {
  it('accepts a well-formed sheet', () => {
    expect(validateSheet(validSheet())).toEqual([])
  })

  it('rejects names outside the <archetype>.<state> shape', () => {
    expect(validateSheet(validSheet({ name: 'Lead.idle' }))).not.toEqual([])
    expect(validateSheet(validSheet({ name: 'leadidle' }))).not.toEqual([])
    expect(validateSheet(validSheet({ name: 'lead.idle.extra' }))).not.toEqual([])
  })

  it('rejects sheets with fewer than two frames', () => {
    expect(validateSheet(validSheet({ frames: [['XXXX', 'XttX', 'XXXX']] }))).not.toEqual([])
  })

  it('rejects fps outside the 4..12 range', () => {
    expect(validateSheet(validSheet({ fps: 3 }))).not.toEqual([])
    expect(validateSheet(validSheet({ fps: 13 }))).not.toEqual([])
    expect(validateSheet(validSheet({ fps: 4 }))).toEqual([])
    expect(validateSheet(validSheet({ fps: 12 }))).toEqual([])
  })

  it('rejects frames whose row count differs from frameHeight', () => {
    expect(validateSheet(validSheet({
      frames: [
        ['XXXX', 'XttX'],
        ['XXXX', 'Xt.X', 'XXXX'],
      ],
    }))).not.toEqual([])
  })

  it('rejects rows whose length differs from frameWidth', () => {
    expect(validateSheet(validSheet({
      frames: [
        ['XXXX', 'XttX', 'XXXX'],
        ['XXXX', 'Xt.XX', 'XXXX'],
      ],
    }))).not.toEqual([])
  })

  it('rejects characters missing from the legend', () => {
    expect(validateSheet(validSheet({
      frames: [
        ['XXXX', 'XttX', 'XXXX'],
        ['XXXX', 'Xt?X', 'XXXX'],
      ],
    }))).not.toEqual([])
  })

  it('rejects a fully transparent frame', () => {
    expect(validateSheet(validSheet({
      frames: [
        ['XXXX', 'XttX', 'XXXX'],
        ['....', '....', '....'],
      ],
    }))).not.toEqual([])
  })

  it('rejects two consecutive identical frames', () => {
    expect(validateSheet(validSheet({
      frames: [
        ['XXXX', 'XttX', 'XXXX'],
        ['XXXX', 'XttX', 'XXXX'],
      ],
    }))).not.toEqual([])
  })
})

describe('generated sheets', () => {
  it('validate clean against the shared rules', () => {
    for (const sheet of [leadIdle, leadWork, teammateIdle, teammateWork]) {
      expect(validateSheet(sheet)).toEqual([])
    }
  })

  it('use the contracted names, dimensions, frame counts, and fps', () => {
    expect([leadIdle.name, leadIdle.frameWidth, leadIdle.frameHeight, leadIdle.frames.length, leadIdle.fps])
      .toEqual(['lead.idle', 64, 64, 4, 6])
    expect([leadWork.name, leadWork.frameWidth, leadWork.frameHeight, leadWork.frames.length, leadWork.fps])
      .toEqual(['lead.work', 64, 64, 4, 6])
    expect([teammateIdle.name, teammateIdle.frameWidth, teammateIdle.frameHeight, teammateIdle.frames.length, teammateIdle.fps])
      .toEqual(['teammate.idle', 48, 48, 4, 6])
    expect([teammateWork.name, teammateWork.frameWidth, teammateWork.frameHeight, teammateWork.frames.length, teammateWork.fps])
      .toEqual(['teammate.work', 48, 48, 4, 6])
  })

  it('idle frames differ from each other (breathing/blink motion)', () => {
    for (const sheet of [leadIdle, teammateIdle]) {
      const distinct = new Set(sheet.frames.map(frame => frame.join('\n')))
      expect(distinct.size).toBe(sheet.frames.length)
    }
  })
})

describe('pickFrame', () => {
  const sheet = validSheet() // 2 frames @ 6fps

  it('advances frames at the sheet fps', () => {
    expect(pickFrame(sheet, 0)).toBe(0)
    expect(pickFrame(sheet, 166)).toBe(0)
    expect(pickFrame(sheet, 167)).toBe(1)
    expect(pickFrame(sheet, 333)).toBe(1)
    expect(pickFrame(sheet, 334)).toBe(0)
  })

  it('wraps around the frame count', () => {
    const four = validSheet({ frames: [
      ['XXXX', 'XttX', 'XXXX'],
      ['XXXX', 'Xt.X', 'XXXX'],
      ['XXXX', 'X.tX', 'XXXX'],
      ['XXXX', 'X..X', 'XXXX'],
    ] })
    expect(pickFrame(four, 500)).toBe(3)
    expect(pickFrame(four, 667)).toBe(0)
  })
})

describe('drawSprite', () => {
  it('draws one rect per non-transparent pixel with palette colors', () => {
    const { ctx, rects, styles } = stubContext()
    const sheet = validSheet({
      legend: { '.': null, X: 'ink', t: 'copper', h: 'highlight' },
      frames: [
        ['X..h', '.tt.', 'XXXX'],
        ['XXXX', '....', 'XXXX'],
      ],
    })
    drawSprite(ctx, sheet, 0, 10, 20, 2)
    // frame 0: X + h + tt + XXXX = 8 painted cells
    expect(rects).toHaveLength(8)
    expect(rects[0]).toEqual({ x: 10, y: 20, w: 2, h: 2 })
    expect(styles[0]).toBe(palette.ink)
    expect(styles[1]).toBe(palette.highlight)
    expect(styles[2]).toBe(palette.copper) // tint slot defaults to copper
    expect(rects[4]).toEqual({ x: 10, y: 24, w: 2, h: 2 })
  })

  it('applies the tint hex to tint-slot pixels and snaps positions', () => {
    const { ctx, rects, styles } = stubContext()
    const sheet = validSheet({ frames: [['X.tX', '....', '....'], ['XXXX', '....', 'XXXX']] })
    drawSprite(ctx, sheet, 0, 3.4, 7.6, 2, '#123456')
    expect(styles.filter(style => style === '#123456')).toHaveLength(1)
    expect(rects[1]).toEqual({ x: 7, y: 8, w: 2, h: 2 })
  })

  it('wraps an out-of-range frame index modulo the frame count', () => {
    const { ctx, rects } = stubContext()
    const sheet = validSheet({
      frames: [
        ['XXXX', 'XXXX', 'XXXX'],
        ['X...', '....', '....'],
      ],
    })
    drawSprite(ctx, sheet, 3, 0, 0, 1) // 3 % 2 → frame 1 (single pixel)
    expect(rects).toHaveLength(1)
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })
})
