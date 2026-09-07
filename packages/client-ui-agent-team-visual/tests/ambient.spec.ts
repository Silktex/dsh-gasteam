/** Host-runnable coverage for the M4 ambient painter (pure timeMs motion). */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { palette } from '../src/client/assets/palette.ts'
import { paintAmbient } from '../src/scenes/ambient.ts'
import { resolveSceneTheme } from '../src/scenes/theme.ts'

interface RecordedArc {
  readonly x: number
  readonly y: number
  readonly r: number
  readonly style: string
  readonly alpha: number
}

interface Stub {
  readonly ctx: CanvasRenderingContext2D
  readonly arcs: RecordedArc[]
  readonly log: string[]
}

/** Recording 2D-context stub covering every method paintAmbient touches. */
function stubContext(): Stub {
  const arcs: RecordedArc[] = []
  const log: string[] = []
  const round = (value: number): number => Math.round(value * 1000) / 1000
  const ctx = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    fillRect(x: number, y: number, w: number, h: number): void {
      log.push(`fillRect ${this.fillStyle} ${round(x)} ${round(y)} ${round(w)} ${round(h)}`)
    },
    fillText(text: string, x: number, y: number): void {
      log.push(`fillText ${this.fillStyle} ${text} ${round(x)} ${round(y)}`)
    },
    save(): void {},
    restore(): void {},
    beginPath(): void {},
    arc(x: number, y: number, r: number): void {
      arcs.push({ x: round(x), y: round(y), r: round(r), style: this.fillStyle, alpha: this.globalAlpha })
      log.push(`arc ${this.fillStyle}@${this.globalAlpha} ${round(x)} ${round(y)} ${round(r)}`)
    },
    ellipse(x: number, y: number, rx: number, ry: number): void {
      log.push(`ellipse ${this.fillStyle}@${this.globalAlpha} ${round(x)} ${round(y)} ${round(rx)} ${round(ry)}`)
    },
    fill(): void {},
    moveTo(): void {},
    lineTo(): void {},
    stroke(): void {},
  } as unknown as CanvasRenderingContext2D
  return { ctx, arcs, log }
}

const LIGHT = resolveSceneTheme('light')

describe('paintAmbient', () => {
  it('draws the two gears as toothed arcs', () => {
    const stub = stubContext()
    paintAmbient(stub.ctx, 200, 100, 0, LIGHT)
    const gearTeethA = stub.arcs.filter(arc => arc.style === LIGHT.gearA)
    const gearTeethB = stub.arcs.filter(arc => arc.style === LIGHT.gearB)
    expect(gearTeethA.length).toBeGreaterThanOrEqual(9) // 8 teeth + ring (+ hub)
    expect(gearTeethB.length).toBeGreaterThanOrEqual(9)
  })

  it('rotates the gears with timeMs (different call sequences at different times)', () => {
    const first = stubContext()
    const second = stubContext()
    paintAmbient(first.ctx, 200, 100, 0, LIGHT)
    paintAmbient(second.ctx, 200, 100, 1000, LIGHT)
    expect(second.log).not.toEqual(first.log)
    // The gear tooth arcs specifically must have moved.
    const teethAt = (stub: Stub): readonly RecordedArc[] =>
      stub.arcs.filter(arc => arc.style === LIGHT.gearA || arc.style === LIGHT.gearB)
    expect(teethAt(second)).not.toEqual(teethAt(first))
  })

  it('oscillates the lamp glow alpha between two sample times', () => {
    const glowAt = (timeMs: number): readonly number[] => {
      const stub = stubContext()
      paintAmbient(stub.ctx, 200, 100, timeMs, LIGHT)
      return stub.arcs.filter(arc => arc.style === LIGHT.lampGlow).map(arc => arc.alpha)
    }
    const atZero = glowAt(0)
    const atLater = glowAt(628)
    expect(atZero).toHaveLength(2) // two gas lamps
    expect(atLater).toHaveLength(2)
    expect(atLater).not.toEqual(atZero)
    for (const alpha of [...atZero, ...atLater]) {
      expect(alpha).toBeGreaterThan(0)
      expect(alpha).toBeLessThanOrEqual(0.4)
    }
  })

  it('draws exactly 3 smoke puffs with alpha in (0, 0.35]', () => {
    const stub = stubContext()
    paintAmbient(stub.ctx, 200, 100, 1234, LIGHT)
    const puffs = stub.arcs.filter(arc => arc.style === palette.muted && arc.alpha <= 0.35)
    expect(puffs).toHaveLength(3)
    for (const puff of puffs) {
      expect(puff.alpha).toBeGreaterThan(0)
      expect(puff.alpha).toBeLessThanOrEqual(0.35)
      expect(puff.r).toBeGreaterThanOrEqual(6)
      expect(puff.r).toBeLessThanOrEqual(14)
    }
  })

  it('moves the zeppelin purely as a function of timeMs', () => {
    const a1 = stubContext()
    const a2 = stubContext()
    paintAmbient(a1.ctx, 200, 100, 5000, LIGHT)
    paintAmbient(a2.ctx, 200, 100, 5000, LIGHT)
    // Same timeMs → byte-identical call log (no hidden state, no randomness).
    expect(a2.log).toEqual(a1.log)
    const b = stubContext()
    paintAmbient(b.ctx, 200, 100, 9000, LIGHT)
    // Different timeMs → the blimp moved.
    expect(b.log).not.toEqual(a1.log)
    const blimpX = (stub: Stub): number => {
      const entry = stub.log.find(line => line.startsWith('ellipse'))
      expect(entry).toBeDefined()
      return Number((entry as string).split(' ')[2])
    }
    expect(blimpX(b)).not.toBe(blimpX(a1))
  })

  it('uses no Math.random or other non-time randomness in the source', () => {
    const source = readFileSync(new URL('../src/scenes/ambient.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/Math\.random/)
    expect(source).not.toMatch(/Date\.now/)
  })
})
