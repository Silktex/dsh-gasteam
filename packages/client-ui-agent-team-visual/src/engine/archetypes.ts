/**
 * Archetype assignment (M3): the RPC exposes no roles yet, so agents are cast
 * into archetypes via a deterministic stable hash of the agent id —
 * 50% teammate, 25% reviewer, 25% coordinator. Pure, no state.
 */

/** Visual archetype of one painted agent actor. */
export type Archetype = 'teammate' | 'reviewer' | 'coordinator'

/** djb2 string hash, kept in uint32 range. */
function djb2(text: string): number {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, 33) + text.charCodeAt(index)) >>> 0
  }
  return hash
}

/**
 * Map an agent id to its archetype: djb2(agentId) % 4 === 0 or 1 → 'teammate',
 * 2 → 'reviewer', 3 → 'coordinator'.
 */
export function archetypeFor(agentId: string): Archetype {
  const mod = djb2(agentId) % 4
  if (mod <= 1) return 'teammate'
  return mod === 2 ? 'reviewer' : 'coordinator'
}
