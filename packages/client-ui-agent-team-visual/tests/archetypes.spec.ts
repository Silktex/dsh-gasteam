/** Archetype assignment coverage: djb2-hash heuristic, determinism, distribution. */

import { describe, expect, it } from 'vitest'
import { archetypeFor, type Archetype } from '../src/engine/archetypes.ts'

/**
 * Reference djb2 (uint32) restated from the M3 contract — expectations are
 * COMPUTED from the algorithm, never hand-waved.
 */
function djb2(text: string): number {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, 33) + text.charCodeAt(index)) >>> 0
  }
  return hash
}

/** Contracted bucket rule: hash % 4 ∈ {0,1} → teammate; 2 → reviewer; 3 → coordinator. */
function expectedFor(agentId: string): Archetype {
  const mod = djb2(agentId) % 4
  return mod <= 1 ? 'teammate' : mod === 2 ? 'reviewer' : 'coordinator'
}

describe('archetypeFor', () => {
  it('is deterministic and pure: same id maps to the same archetype across calls', () => {
    for (const id of ['attempt-1', 'agent-x', 'p4/task-9', '']) {
      const first = archetypeFor(id)
      expect(first).toBe(archetypeFor(id))
      expect(['teammate', 'reviewer', 'coordinator']).toContain(first)
    }
  })

  it('locks the algorithm with a known vector (explicit hash constant)', () => {
    // djb2('attempt-1') === 4161285570; 4161285570 % 4 === 2 → reviewer.
    expect(djb2('attempt-1')).toBe(4161285570)
    expect(archetypeFor('attempt-1')).toBe('reviewer')
  })

  it('distributes 40 sample ids exactly as the hash semantics predict', () => {
    const ids = Array.from({ length: 40 }, (_, index) => `attempt-${index + 1}`)
    const expected: Record<Archetype, number> = { teammate: 0, reviewer: 0, coordinator: 0 }
    for (const id of ids) expected[expectedFor(id)] += 1
    const actual: Record<Archetype, number> = { teammate: 0, reviewer: 0, coordinator: 0 }
    for (const id of ids) actual[archetypeFor(id)] += 1
    expect(actual).toEqual(expected)
    // 50/25/25 within exact hash semantics: all three appear, teammate = the other two.
    expect(actual.reviewer).toBeGreaterThan(0)
    expect(actual.coordinator).toBeGreaterThan(0)
    expect(actual.teammate).toBe(actual.reviewer + actual.coordinator)
  })

  it('matches the bucket rule on every % 4 residue', () => {
    // Find one sample id per residue and assert the mapping directly.
    const byResidue = new Map<number, string>()
    for (let index = 0; byResidue.size < 4; index += 1) {
      const id = `residue-${index}`
      const residue = djb2(id) % 4
      if (!byResidue.has(residue)) byResidue.set(residue, id)
    }
    for (const [residue, id] of byResidue) {
      expect(archetypeFor(id)).toBe(residue <= 1 ? 'teammate' : residue === 2 ? 'reviewer' : 'coordinator')
    }
  })
})
