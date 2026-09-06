/** Fixed desk layout for the painted agent scene (normalized 0..1 scene coords). */

/** One desk position in normalized scene coordinates (0..1 on both axes). */
export interface DeskSlot { readonly x: number; readonly y: number }

/**
 * Exactly 8 fixed slots: two rows of four, y rows 0.55 and 0.8,
 * x = 0.12 + col * 0.25 (col 0..3).
 */
export const DESK_SLOTS: readonly DeskSlot[] = [0.55, 0.8].flatMap(y =>
  [0, 1, 2, 3].map(col => ({ x: 0.12 + col * 0.25, y })),
)

/**
 * Pick the desk slot for an agent. M1: `agentId` is accepted for future stable
 * hashing but MUST NOT affect the result — the slot depends on `index` only.
 */
export function deskSlotFor(agentId: string, index: number): DeskSlot {
  void agentId
  return DESK_SLOTS[index % DESK_SLOTS.length] as DeskSlot
}
