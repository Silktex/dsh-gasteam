/** Sprite engine rules, frame timing, drawing, and generated sheet coverage. */

import { describe, expect, it } from 'vitest'
import { palette } from '../src/client/assets/palette.ts'
import {
  AGENT_TINTS, TINT_SLOT, drawSprite, pickFrame, validateSheet, type SpriteSheet,
} from '../src/engine/sprites.ts'
import { leadIdle, leadWalk, leadWork } from '../src/assets/sprites/lead.ts'
import {
  teammateBlocked, teammateDone, teammateError, teammateIdle, teammateWalk, teammateWork,
} from '../src/assets/sprites/teammate.ts'
import { reviewerIdle, reviewerWalk, reviewerWork } from '../src/assets/sprites/reviewer.ts'
import { coordinatorIdle, coordinatorWalk, coordinatorWork } from '../src/assets/sprites/coordinator.ts'
import { blockedBadge, doneBadge, errorBadge } from '../src/engine/badges.ts'

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
  const LEAD = [leadIdle, leadWork, leadWalk]
  const TEAMMATE = [teammateIdle, teammateWork, teammateWalk, teammateBlocked, teammateError, teammateDone]
  const REVIEWER = [reviewerIdle, reviewerWork, reviewerWalk]
  const COORDINATOR = [coordinatorIdle, coordinatorWork, coordinatorWalk]
  const ALL = [...LEAD, ...TEAMMATE, ...REVIEWER, ...COORDINATOR]

  it('validate clean against the shared rules (15 generated sheets)', () => {
    expect(ALL).toHaveLength(15)
    for (const sheet of ALL) {
      expect(validateSheet(sheet)).toEqual([])
    }
  })

  it('badges imported alongside also validate clean', () => {
    for (const badge of [blockedBadge, errorBadge, doneBadge]) {
      expect(validateSheet(badge)).toEqual([])
    }
  })

  it('use the contracted names, dimensions, frame counts, and fps', () => {
    expect([leadIdle.name, leadIdle.frameWidth, leadIdle.frameHeight, leadIdle.frames.length, leadIdle.fps])
      .toEqual(['lead.idle', 64, 64, 4, 6])
    expect([leadWork.name, leadWork.frameWidth, leadWork.frameHeight, leadWork.frames.length, leadWork.fps])
      .toEqual(['lead.work', 64, 64, 4, 6])
    expect([leadWalk.name, leadWalk.frameWidth, leadWalk.frameHeight, leadWalk.frames.length, leadWalk.fps])
      .toEqual(['lead.walk', 64, 64, 4, 6])
    expect([teammateIdle.name, teammateIdle.frameWidth, teammateIdle.frameHeight, teammateIdle.frames.length, teammateIdle.fps])
      .toEqual(['teammate.idle', 48, 48, 4, 6])
    expect([teammateWork.name, teammateWork.frameWidth, teammateWork.frameHeight, teammateWork.frames.length, teammateWork.fps])
      .toEqual(['teammate.work', 48, 48, 4, 6])
    expect([teammateWalk.name, teammateWalk.frameWidth, teammateWalk.frameHeight, teammateWalk.frames.length, teammateWalk.fps])
      .toEqual(['teammate.walk', 48, 48, 4, 6])
    expect([teammateBlocked.name, teammateBlocked.frameWidth, teammateBlocked.frameHeight, teammateBlocked.frames.length, teammateBlocked.fps])
      .toEqual(['teammate.blocked', 48, 48, 4, 6])
    expect([teammateError.name, teammateError.frameWidth, teammateError.frameHeight, teammateError.frames.length, teammateError.fps])
      .toEqual(['teammate.error', 48, 48, 4, 6])
    expect([teammateDone.name, teammateDone.frameWidth, teammateDone.frameHeight, teammateDone.frames.length, teammateDone.fps])
      .toEqual(['teammate.done', 48, 48, 4, 6])
    expect([reviewerIdle.name, reviewerIdle.frameWidth, reviewerIdle.frameHeight, reviewerIdle.frames.length, reviewerIdle.fps])
      .toEqual(['reviewer.idle', 48, 48, 4, 6])
    expect([reviewerWork.name, reviewerWork.frameWidth, reviewerWork.frameHeight, reviewerWork.frames.length, reviewerWork.fps])
      .toEqual(['reviewer.work', 48, 48, 4, 6])
    expect([reviewerWalk.name, reviewerWalk.frameWidth, reviewerWalk.frameHeight, reviewerWalk.frames.length, reviewerWalk.fps])
      .toEqual(['reviewer.walk', 48, 48, 4, 6])
    expect([coordinatorIdle.name, coordinatorIdle.frameWidth, coordinatorIdle.frameHeight, coordinatorIdle.frames.length, coordinatorIdle.fps])
      .toEqual(['coordinator.idle', 48, 48, 4, 6])
    expect([coordinatorWork.name, coordinatorWork.frameWidth, coordinatorWork.frameHeight, coordinatorWork.frames.length, coordinatorWork.fps])
      .toEqual(['coordinator.work', 48, 48, 4, 6])
    expect([coordinatorWalk.name, coordinatorWalk.frameWidth, coordinatorWalk.frameHeight, coordinatorWalk.frames.length, coordinatorWalk.fps])
      .toEqual(['coordinator.walk', 48, 48, 4, 6])
  })

  it('idle frames differ from each other (breathing/blink motion)', () => {
    for (const sheet of [leadIdle, teammateIdle, reviewerIdle, coordinatorIdle]) {
      const distinct = new Set(sheet.frames.map(frame => frame.join('\n')))
      expect(distinct.size).toBe(sheet.frames.length)
    }
  })

  it('walk frames differ from each other (leg alternation, bob, sway)', () => {
    for (const sheet of [leadWalk, teammateWalk, reviewerWalk, coordinatorWalk]) {
      const distinct = new Set(sheet.frames.map(frame => frame.join('\n')))
      expect(distinct.size).toBe(sheet.frames.length)
    }
  })

  it('work frames differ from each other (tool motion)', () => {
    for (const sheet of [leadWork, teammateWork, reviewerWork, coordinatorWork]) {
      const distinct = new Set(sheet.frames.map(frame => frame.join('\n')))
      expect(distinct.size).toBe(sheet.frames.length)
    }
  })

  it('teammate state sheets are pairwise distinct across all four frames', () => {
    for (const sheet of [teammateBlocked, teammateError, teammateDone]) {
      const distinct = new Set(sheet.frames.map(frame => frame.join('\n')))
      expect(distinct.size).toBe(sheet.frames.length)
    }
  })

  it('walk sheets keep the idle head (identical to idle frame 0)', () => {
    // Head block occupies the top 24 rows on the 48px archetypes; walk frames
    // 0/2 are unbobbed, so those rows match idle frame 0 exactly.
    expect(teammateWalk.frames[0]?.slice(0, 24)).toEqual(teammateIdle.frames[0]?.slice(0, 24))
    expect(teammateWalk.frames[2]?.slice(0, 24)).toEqual(teammateIdle.frames[0]?.slice(0, 24))
    expect(reviewerWalk.frames[0]?.slice(0, 24)).toEqual(reviewerIdle.frames[0]?.slice(0, 24))
    expect(reviewerWalk.frames[2]?.slice(0, 24)).toEqual(reviewerIdle.frames[0]?.slice(0, 24))
    expect(coordinatorWalk.frames[0]?.slice(0, 24)).toEqual(coordinatorIdle.frames[0]?.slice(0, 24))
    expect(coordinatorWalk.frames[2]?.slice(0, 24)).toEqual(coordinatorIdle.frames[0]?.slice(0, 24))
    expect(leadWalk.frames[0]?.slice(0, 37)).toEqual(leadIdle.frames[0]?.slice(0, 37))
  })

  it('teammate state sheets derive from idle frame 0 (head/body preserved)', () => {
    // Blocked adds only the watch (rows 37+) and toe taps (rows 44+): the body
    // above the belt is byte-identical to teammateIdle frame 0.
    for (const frame of teammateBlocked.frames) {
      expect(frame.slice(0, 37)).toEqual(teammateIdle.frames[0]?.slice(0, 37))
    }
    // Error/done raise the arms (rows 19+; error frame 3 flicks a paw pixel at
    // row 18) and add the alarm/confetti (rows 0-3); the face band in between
    // stays identical to teammateIdle frame 0.
    for (const frame of teammateError.frames) {
      expect(frame.slice(4, 18)).toEqual(teammateIdle.frames[0]?.slice(4, 18))
    }
    // Done frames 1/3 jump 1px (body rows shift up), so the band compares
    // offset by one row there.
    for (const [index, frame] of teammateDone.frames.entries()) {
      if (index % 2 === 0) {
        expect(frame.slice(4, 19)).toEqual(teammateIdle.frames[0]?.slice(4, 19))
      } else {
        expect(frame.slice(4, 18)).toEqual(teammateIdle.frames[0]?.slice(5, 19))
      }
    }
  })

  it('teammateDone carries at least 5 confetti pixels per frame (h/b/r above the head)', () => {
    for (const frame of teammateDone.frames) {
      const confetti = frame.slice(0, 4).join('').split('').filter(char => 'hbr'.includes(char))
      expect(confetti.length).toBeGreaterThanOrEqual(5)
    }
  })

  it('teammateError flashes the oxide alarm on frames 0/2 only', () => {
    const alarmCount = (frame: readonly string[]): number =>
      frame.slice(0, 4).join('').split('').filter(char => char === 'r').length
    expect(alarmCount(teammateError.frames[0] as string[])).toBeGreaterThan(0)
    expect(alarmCount(teammateError.frames[1] as string[])).toBe(0)
    expect(alarmCount(teammateError.frames[2] as string[])).toBeGreaterThan(0)
    expect(alarmCount(teammateError.frames[3] as string[])).toBe(0)
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
