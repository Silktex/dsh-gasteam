/** Badge sheet coverage: state mapping and hand-authored 8x8 sheet validity. */

import { describe, expect, it } from 'vitest'
import { validateSheet } from '../src/engine/sprites.ts'
import {
  blockedBadge, doneBadge, errorBadge, badgeForState,
} from '../src/engine/badges.ts'
import type { VisualAgentState } from '../src/client/reconcile.ts'

describe('badgeForState', () => {
  it('maps blocked/error/done to their badge sheets', () => {
    expect(badgeForState('blocked')).toBe(blockedBadge)
    expect(badgeForState('error')).toBe(errorBadge)
    expect(badgeForState('done')).toBe(doneBadge)
  })

  it('returns null for idle and working (no badge)', () => {
    const states: VisualAgentState[] = ['idle', 'working']
    for (const state of states) {
      expect(badgeForState(state)).toBeNull()
    }
  })
})

describe('badge sheets', () => {
  it('validate clean against the shared sprite rules', () => {
    for (const badge of [blockedBadge, errorBadge, doneBadge]) {
      expect(validateSheet(badge)).toEqual([])
    }
  })

  it('use the contracted names, 8x8 dimensions, fps 4, and >= 2 frames', () => {
    expect([blockedBadge.name, blockedBadge.frameWidth, blockedBadge.frameHeight, blockedBadge.fps])
      .toEqual(['badge.blocked', 8, 8, 4])
    expect([errorBadge.name, errorBadge.frameWidth, errorBadge.frameHeight, errorBadge.fps])
      .toEqual(['badge.error', 8, 8, 4])
    expect([doneBadge.name, doneBadge.frameWidth, doneBadge.frameHeight, doneBadge.fps])
      .toEqual(['badge.done', 8, 8, 4])
    for (const badge of [blockedBadge, errorBadge, doneBadge]) {
      expect(badge.frames.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('animate (frames are pairwise distinct)', () => {
    for (const badge of [blockedBadge, errorBadge, doneBadge]) {
      const distinct = new Set(badge.frames.map(frame => frame.join('\n')))
      expect(distinct.size).toBe(badge.frames.length)
    }
  })
})
