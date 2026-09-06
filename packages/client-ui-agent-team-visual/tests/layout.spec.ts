/** Desk slot layout coverage for the painted agent scene. */

import { describe, expect, it } from 'vitest'
import { DESK_SLOTS, deskSlotFor } from '../src/scenes/layout.ts'

describe('DESK_SLOTS', () => {
  it('provides exactly 8 fixed slots in two rows of four', () => {
    expect(DESK_SLOTS).toHaveLength(8)
    expect(DESK_SLOTS).toEqual([
      { x: 0.12, y: 0.55 },
      { x: 0.37, y: 0.55 },
      { x: 0.62, y: 0.55 },
      { x: 0.87, y: 0.55 },
      { x: 0.12, y: 0.8 },
      { x: 0.37, y: 0.8 },
      { x: 0.62, y: 0.8 },
      { x: 0.87, y: 0.8 },
    ])
  })
})

describe('deskSlotFor', () => {
  it('maps an index to its slot', () => {
    expect(deskSlotFor('attempt-1', 0)).toEqual({ x: 0.12, y: 0.55 })
    expect(deskSlotFor('attempt-1', 5)).toEqual({ x: 0.37, y: 0.8 })
  })

  it('wraps indices around the slot count (index 8 === index 0)', () => {
    expect(deskSlotFor('attempt-1', 8)).toEqual(DESK_SLOTS[0])
    expect(deskSlotFor('attempt-1', 11)).toEqual(DESK_SLOTS[3])
  })

  it('ignores the agent id in M1 (slot depends on index only)', () => {
    expect(deskSlotFor('alpha', 3)).toEqual(deskSlotFor('omega', 3))
    expect(deskSlotFor('alpha', 12)).toEqual(deskSlotFor('omega', 4))
  })
})
