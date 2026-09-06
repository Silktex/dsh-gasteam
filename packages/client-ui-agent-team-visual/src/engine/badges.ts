/**
 * Badge system (M3): archetype-independent state indicators — hand-authored
 * 8x8 mini-sheets drawn above the actor's head for blocked/error/done, so
 * reviewer/coordinator (which have no dedicated state sheets) still show all
 * five states, and the teammate gets both pose + badge. Tiny and stable: these
 * are SpriteSheet literals here, NOT generated.
 */

import type { VisualAgentState } from '../client/reconcile.ts'
import type { SpriteSheet } from './sprites.ts'

/** States that carry a badge. */
export type BadgeState = 'blocked' | 'error' | 'done'

const BADGE_LEGEND = {
  '.': null, X: 'ink', z: 'bronze', r: 'oxide', b: 'brass', h: 'highlight', m: 'muted',
} as const

/** blockedBadge: bronze clock face; the tick hand alternates 12 → 3 o'clock. */
export const blockedBadge: SpriteSheet = {
  name: 'badge.blocked',
  frameWidth: 8,
  frameHeight: 8,
  fps: 4,
  legend: BADGE_LEGEND,
  frames: [
    [
      '..XXXX..',
      '.XzzzzX.',
      'XzzXzzzX',
      'XzzXzzzX',
      'XzzzzzzX',
      '.XzzzzX.',
      '..XXXX..',
      '........',
    ],
    [
      '..XXXX..',
      '.XzzzzX.',
      'XzzzzzzX',
      'XzzzXXzX',
      'XzzzzzzX',
      '.XzzzzX.',
      '..XXXX..',
      '........',
    ],
  ],
}

/** errorBadge: oxide alarm diamond; flashes bright oxide ↔ dim muted. */
export const errorBadge: SpriteSheet = {
  name: 'badge.error',
  frameWidth: 8,
  frameHeight: 8,
  fps: 4,
  legend: BADGE_LEGEND,
  frames: [
    [
      '...XX...',
      '..XrrX..',
      '.XrrrrX.',
      'XrrhXrrX',
      '.XrrrrX.',
      '..XrrX..',
      '...XX...',
      '........',
    ],
    [
      '...XX...',
      '..XmmX..',
      '.XmmmmX.',
      'XmmmXmmX',
      '.XmmmmX.',
      '..XmmX..',
      '...XX...',
      '........',
    ],
  ],
}

/** doneBadge: brass star; twinkles via moving highlight pixels. */
export const doneBadge: SpriteSheet = {
  name: 'badge.done',
  frameWidth: 8,
  frameHeight: 8,
  fps: 4,
  legend: BADGE_LEGEND,
  frames: [
    [
      '...bb...',
      '...bb...',
      'bbbbbbbb',
      '.bhhbbb.',
      '..bbbb..',
      '..b..b..',
      '.b....b.',
      '........',
    ],
    [
      '...bb...',
      '...bb...',
      'bbbbbbbb',
      '.bbbbhb.',
      '..bbbb..',
      '..b..b..',
      '.b....b.',
      '........',
    ],
  ],
}

/**
 * Badge for a visual state: 'blocked' → blockedBadge, 'error' → errorBadge,
 * 'done' → doneBadge; 'idle'/'working' → null (no badge).
 */
export function badgeForState(state: VisualAgentState): SpriteSheet | null {
  switch (state) {
    case 'blocked': return blockedBadge
    case 'error': return errorBadge
    case 'done': return doneBadge
    default: return null
  }
}
