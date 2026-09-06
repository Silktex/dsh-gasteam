/** Actor finite-state machine: arriving → walking → settled → leaving. */

import type { DeskSlot } from '../scenes/layout.ts'
import { deskSlotFor } from '../scenes/layout.ts'
import type { VisualAgentState, VisualSceneModel } from '../client/reconcile.ts'
import { findPath, type NavGrid, type Point } from './pathfinding.ts'
import type { SpriteSheet } from './sprites.ts'
import { archetypeFor, type Archetype } from './archetypes.ts'

/** Lifecycle phase of one painted agent actor. */
export type ActorPhase = 'arriving' | 'walking' | 'settled' | 'leaving'

/** One animated agent in the live scene (positions in normalized 0..1 coords). */
export interface Actor {
  readonly id: string
  readonly state: VisualAgentState
  readonly phase: ActorPhase
  readonly x: number
  readonly y: number
  readonly desk: DeskSlot
  readonly path: readonly Point[]
  readonly pathIndex: number
  readonly phaseStartedAt: number
  readonly archetype: Archetype
  /** Wall-clock time the actor entered state 'done'; null otherwise. */
  readonly doneSince: number | null
}

/** Sprite sheets available per actor archetype (idle/work/walk subset). */
export interface ActorSheets {
  readonly idle: SpriteSheet
  readonly work: SpriteSheet
  readonly walk: SpriteSheet
}

/**
 * Full sheet library across all archetypes (M3). Only the teammate carries
 * dedicated blocked/error/done sheets; reviewer/coordinator convey those
 * states via badges instead.
 */
export interface SheetLibrary {
  readonly teammate: ActorSheets & {
    readonly blocked: SpriteSheet
    readonly error: SpriteSheet
    readonly done: SpriteSheet
  }
  readonly reviewer: ActorSheets
  readonly coordinator: ActorSheets
}

/** Scene entry point where actors appear and exit (normalized coords). */
export const ENTRY_POINT: Point = { x: 0.04, y: 0.3 }

/** Walking speed in normalized units per second. */
export const WALK_SPEED = 0.35

/** Pause at the entry point before an actor starts walking to its desk. */
export const ARRIVAL_PAUSE_MS = 400

/** How long a settled done actor celebrates before walking out (ms). */
export const DONE_LINGER_MS = 3000

/** Waypoint reach threshold (normalized units). */
const REACH_EPSILON = 1e-6

/**
 * Exact position of an actor settled at its desk: IN FRONT of the desk, with
 * the sprite bottom 0.10 below the desk-top line so the sprite visually
 * occludes the desk front. This keeps every settle cell clear of the desk
 * obstacle rects ({slot.x-0.06, slot.y-0.02, 0.12x0.06}), so A* can actually
 * route to it instead of falling back to the straight line.
 */
function settledPosition(desk: DeskSlot): Point {
  return { x: desk.x, y: desk.y + 0.10 }
}

/**
 * Create a new actor at the entry point in the arriving phase with an empty
 * path (the walking path is computed by stepActors on the arriving→walking
 * transition). `grid` is accepted for signature stability but unused here.
 */
export function createActor(
  id: string,
  state: VisualAgentState,
  desk: DeskSlot,
  grid: NavGrid,
  now: number,
): Actor {
  void grid
  return {
    id, state, phase: 'arriving',
    x: ENTRY_POINT.x, y: ENTRY_POINT.y,
    desk, path: [], pathIndex: 0, phaseStartedAt: now,
    archetype: archetypeFor(id),
    doneSince: state === 'done' ? now : null,
  }
}

/**
 * Reconcile live actors against the RPC truth (model.agents, sorted).
 * - surviving actors keep phase/desk/position and take the new state;
 * - new model agents spawn arriving actors at deskSlotFor(id, model index);
 * - actors absent from the model start leaving toward ENTRY_POINT (once);
 * Output order: non-leaving actors in model.agents order, then leaving actors
 * in their previous relative order.
 */
export function reconcileActors(
  actors: readonly Actor[],
  model: VisualSceneModel,
  grid: NavGrid,
  now: number,
): readonly Actor[] {
  const byId = new Map(actors.map(actor => [actor.id, actor]))
  const kept: Actor[] = model.agents.map((agent, index) => {
    const existing = byId.get(agent.id)
    if (existing === undefined) {
      return createActor(agent.id, agent.state, deskSlotFor(agent.id, index), grid, now)
    }
    // Surviving actor (any phase): keep phase/desk/position, update state.
    // doneSince is stamped when the state becomes 'done' and cleared on exit.
    if (existing.state === agent.state) return existing
    return {
      ...existing,
      state: agent.state,
      doneSince: agent.state === 'done' ? now : null,
    }
  })
  const modelIds = new Set(model.agents.map(agent => agent.id))
  const leaving: Actor[] = actors
    .filter(actor => !modelIds.has(actor.id))
    .map(actor => actor.phase === 'leaving'
      ? actor
      : {
          ...actor,
          phase: 'leaving' as const,
          path: findPath(grid, { x: actor.x, y: actor.y }, ENTRY_POINT),
          pathIndex: 0,
          phaseStartedAt: now,
        })
  return [...kept, ...leaving]
}

/** Advance a walking/leaving actor along its remaining path by `travel` units. */
function advance(actor: Actor, travel: number, now: number): Actor | null {
  let { x, y } = actor
  let index = actor.pathIndex
  let remaining = travel
  while (index < actor.path.length) {
    const target = actor.path[index] as Point
    const dx = target.x - x
    const dy = target.y - y
    const distance = Math.hypot(dx, dy)
    if (distance <= REACH_EPSILON) {
      index += 1 // waypoint reached — consume it
      continue
    }
    if (distance <= remaining) {
      x = target.x
      y = target.y
      remaining -= distance
      index += 1
      continue
    }
    x += (dx / distance) * remaining
    y += (dy / distance) * remaining
    remaining = 0
    break
  }
  if (index < actor.path.length) {
    return { ...actor, x, y, pathIndex: index }
  }
  if (actor.phase === 'leaving') return null // exited the scene
  const settledAt = settledPosition(actor.desk)
  return {
    ...actor, phase: 'settled', x: settledAt.x, y: settledAt.y,
    pathIndex: index, phaseStartedAt: now,
  }
}

/**
 * Step every actor forward by dtMs (milliseconds) at wall-clock `now`.
 * arriving → walking after ARRIVAL_PAUSE_MS (path computed here via findPath);
 * walking/leaving advance along their path at WALK_SPEED (walking settles at
 * {desk.x, desk.y + 0.10} — in front of the desk — at path end; leaving
 * actors are removed); settled actors stay pinned, except settled done actors
 * whose linger exceeded DONE_LINGER_MS walk out to ENTRY_POINT. dtMs <= 0
 * returns the input unchanged.
 */
export function stepActors(
  actors: readonly Actor[],
  grid: NavGrid,
  dtMs: number,
  now: number,
): readonly Actor[] {
  if (dtMs <= 0) return actors
  const travel = WALK_SPEED * dtMs / 1000
  const next: Actor[] = []
  for (const actor of actors) {
    switch (actor.phase) {
      case 'arriving': {
        if (now - actor.phaseStartedAt < ARRIVAL_PAUSE_MS) {
          next.push(actor)
          break
        }
        // Transition only — the consumed dtMs paid for the arrival pause;
        // movement along the fresh path starts on the next step.
        const path = findPath(grid, { x: actor.x, y: actor.y }, settledPosition(actor.desk))
        next.push({ ...actor, phase: 'walking', path, pathIndex: 0, phaseStartedAt: now })
        break
      }
      case 'walking':
      case 'leaving': {
        const advanced = advance(actor, travel, now)
        if (advanced !== null) next.push(advanced)
        break
      }
      case 'settled': {
        const pinned = settledPosition(actor.desk)
        const settled = actor.x === pinned.x && actor.y === pinned.y
          ? actor
          : { ...actor, x: pinned.x, y: pinned.y }
        // Done linger: celebrate DONE_LINGER_MS, then walk out to the entry.
        if (settled.state === 'done'
          && settled.doneSince !== null
          && now - settled.doneSince > DONE_LINGER_MS) {
          next.push({
            ...settled,
            phase: 'leaving' as const,
            path: findPath(grid, { x: settled.x, y: settled.y }, ENTRY_POINT),
            pathIndex: 0,
            phaseStartedAt: now,
          })
          break
        }
        next.push(settled)
        break
      }
    }
  }
  return next
}

/**
 * Pick the sheet for an actor from the SheetLibrary (M3: BREAKING — was
 * ActorSheets in M2): walk while arriving/walking/leaving; settled working →
 * work, settled idle → idle; settled blocked/error/done → the teammate's
 * dedicated sheet, or idle for reviewer/coordinator (the BADGE conveys the
 * state there).
 */
export function sheetForActor(actor: Actor, library: SheetLibrary): SpriteSheet {
  const sheets = library[actor.archetype]
  if (actor.phase !== 'settled') return sheets.walk
  switch (actor.state) {
    case 'working': return sheets.work
    case 'idle': return sheets.idle
    case 'blocked':
    case 'error':
    case 'done':
      return actor.archetype === 'teammate' ? library.teammate[actor.state] : sheets.idle
  }
}
