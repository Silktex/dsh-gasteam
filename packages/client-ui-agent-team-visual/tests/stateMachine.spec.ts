/** Actor FSM coverage: creation, reconciliation, stepping, sheet selection. */

import { describe, expect, it } from 'vitest'
import type { SpriteSheet } from '../src/engine/sprites.ts'
import { buildNavGrid, type Point } from '../src/engine/pathfinding.ts'
import { DESK_SLOTS, deskSlotFor, type DeskSlot } from '../src/scenes/layout.ts'
import type { VisualAgent, VisualAgentState, VisualSceneModel } from '../src/client/reconcile.ts'
import { archetypeFor, type Archetype } from '../src/engine/archetypes.ts'
import {
  ARRIVAL_PAUSE_MS, DONE_LINGER_MS, ENTRY_POINT, WALK_SPEED,
  createActor, reconcileActors, sheetForActor, stepActors,
  type Actor, type SheetLibrary,
} from '../src/engine/stateMachine.ts'

const GRID = buildNavGrid(20, 12, [])
const DESK: DeskSlot = DESK_SLOTS[0] as DeskSlot // { x: 0.12, y: 0.55 }
// Settled position is IN FRONT of the desk (sprite bottom 0.10 below the
// desk-top line), clear of the desk obstacle rect so A* can route to it.
const SETTLED: Point = { x: DESK.x, y: DESK.y + 0.10 }

function agent(id: string, state: VisualAgent['state'] = 'idle'): VisualAgent {
  return { id, projectId: 'project-a', taskId: `task-${id}`, state, label: `project-a/task-${id}` }
}

function model(...agents: VisualAgent[]): VisualSceneModel {
  return { projectId: 'project-a', agents, projectCount: 1 }
}

/** Minimal structurally-valid sheet; identity is all sheetForActor cares about. */
function sheet(name: string): SpriteSheet {
  return {
    name, frameWidth: 2, frameHeight: 2, fps: 6,
    legend: { '.': null, X: 'ink' },
    frames: [['XX', 'XX'], ['X.', '.X']],
  }
}

function actorSheets(archetype: string) {
  return {
    idle: sheet(`${archetype}.idle`),
    work: sheet(`${archetype}.work`),
    walk: sheet(`${archetype}.walk`),
  }
}

const LIBRARY: SheetLibrary = {
  teammate: {
    ...actorSheets('teammate'),
    blocked: sheet('teammate.blocked'),
    error: sheet('teammate.error'),
    done: sheet('teammate.done'),
  },
  reviewer: actorSheets('reviewer'),
  coordinator: actorSheets('coordinator'),
}

describe('constants', () => {
  it('exposes the contracted entry point, walk speed, arrival pause, and done linger', () => {
    expect(ENTRY_POINT).toEqual({ x: 0.04, y: 0.3 })
    expect(WALK_SPEED).toBe(0.35)
    expect(ARRIVAL_PAUSE_MS).toBe(400)
    expect(DONE_LINGER_MS).toBe(3000)
  })
})

describe('createActor', () => {
  it('starts arriving at the entry point with an empty path', () => {
    const actor = createActor('a1', 'working', DESK, GRID, 1234)
    expect(actor).toEqual({
      id: 'a1', state: 'working', phase: 'arriving',
      x: ENTRY_POINT.x, y: ENTRY_POINT.y, desk: DESK,
      path: [], pathIndex: 0, phaseStartedAt: 1234,
      archetype: archetypeFor('a1'), doneSince: null,
    })
  })

  it('derives the archetype deterministically from the agent id', () => {
    for (const id of ['attempt-1', 'attempt-2', 'attempt-3', 'attempt-4']) {
      expect(createActor(id, 'idle', DESK, GRID, 0).archetype).toBe(archetypeFor(id))
    }
  })

  it('stamps doneSince when the actor is created already done', () => {
    expect(createActor('a1', 'done', DESK, GRID, 777).doneSince).toBe(777)
    expect(createActor('a1', 'idle', DESK, GRID, 777).doneSince).toBeNull()
  })
})

describe('reconcileActors', () => {
  it('creates arriving actors for new model agents at their index desk', () => {
    const actors = reconcileActors([], model(agent('b'), agent('a')), GRID, 100)
    expect(actors.map(actor => actor.id)).toEqual(['b', 'a'])
    expect(actors[0]?.phase).toBe('arriving')
    expect(actors[0]?.desk).toEqual(deskSlotFor('b', 0))
    expect(actors[1]?.desk).toEqual(deskSlotFor('a', 1))
    expect(actors[0]?.phaseStartedAt).toBe(100)
    expect(actors[0]?.archetype).toBe(archetypeFor('b'))
  })

  it('keeps phase/desk/position for surviving actors and updates state', () => {
    const settled: Actor = {
      id: 'a', state: 'idle', phase: 'settled',
      x: SETTLED.x, y: SETTLED.y, desk: DESK, path: [], pathIndex: 0, phaseStartedAt: 0,
      archetype: 'teammate', doneSince: null,
    }
    const actors = reconcileActors([settled], model(agent('a', 'working')), GRID, 200)
    expect(actors).toHaveLength(1)
    expect(actors[0]).toEqual({ ...settled, state: 'working' })
  })

  it('stamps doneSince when the state becomes done and clears it when done exits', () => {
    const settled: Actor = {
      id: 'a', state: 'working', phase: 'settled',
      x: SETTLED.x, y: SETTLED.y, desk: DESK, path: [], pathIndex: 0, phaseStartedAt: 0,
      archetype: 'reviewer', doneSince: null,
    }
    const done = reconcileActors([settled], model(agent('a', 'done')), GRID, 900)
    expect(done[0]).toEqual({ ...settled, state: 'done', doneSince: 900 })
    // Staying done keeps the original stamp (linger clock is not reset).
    const still = reconcileActors(done, model(agent('a', 'done')), GRID, 1200)
    expect(still[0]).toBe(done[0])
    // Leaving done clears the stamp.
    const back = reconcileActors(done, model(agent('a', 'working')), GRID, 1500)
    expect(back[0]).toEqual({ ...settled, state: 'working', doneSince: null })
  })

  it('marks actors absent from the model as leaving toward the entry point', () => {
    const settled: Actor = {
      id: 'gone', state: 'idle', phase: 'settled',
      x: SETTLED.x, y: SETTLED.y, desk: DESK, path: [], pathIndex: 0, phaseStartedAt: 0,
      archetype: 'teammate', doneSince: null,
    }
    const actors = reconcileActors([settled], model(), GRID, 300)
    expect(actors).toHaveLength(1)
    const leaving = actors[0] as Actor
    expect(leaving.phase).toBe('leaving')
    expect(leaving.pathIndex).toBe(0)
    expect(leaving.phaseStartedAt).toBe(300)
    expect(leaving.path[0]).toEqual({ x: SETTLED.x, y: SETTLED.y })
    expect(leaving.path[leaving.path.length - 1]).toEqual(ENTRY_POINT)
  })

  it('keeps already-leaving actors as-is on repeated reconcile', () => {
    const settled: Actor = {
      id: 'gone', state: 'idle', phase: 'settled',
      x: SETTLED.x, y: SETTLED.y, desk: DESK, path: [], pathIndex: 0, phaseStartedAt: 0,
      archetype: 'teammate', doneSince: null,
    }
    const once = reconcileActors([settled], model(), GRID, 300)
    const twice = reconcileActors(once, model(), GRID, 400)
    expect(twice[0]).toBe(once[0]) // untouched: same object
  })

  it('keeps the leaving phase but updates state when the actor reappears in the model', () => {
    const leaving: Actor = {
      id: 'flap', state: 'idle', phase: 'leaving',
      x: 0.2, y: 0.4, desk: DESK,
      path: [{ x: 0.2, y: 0.4 }, ENTRY_POINT], pathIndex: 0, phaseStartedAt: 50,
      archetype: 'teammate', doneSince: null,
    }
    const actors = reconcileActors([leaving], model(agent('flap', 'working')), GRID, 600)
    expect(actors[0]?.phase).toBe('leaving') // exit in progress is not cancelled
    expect(actors[0]?.state).toBe('working')
    expect(actors[0]?.phaseStartedAt).toBe(50)
  })

  it('orders model actors first (model order), then leaving actors (previous order)', () => {
    const cast: Actor[] = ['a', 'b', 'c'].map((id, index) => ({
      id, state: 'idle' as const, phase: 'settled' as const,
      x: 0.1 * (index + 1), y: 0.5, desk: DESK_SLOTS[index] as DeskSlot,
      path: [], pathIndex: 0, phaseStartedAt: 0,
      archetype: 'teammate' as const, doneSince: null,
    }))
    // model keeps c then a (model order); b drops out → leaving, appended last.
    const actors = reconcileActors(cast, model(agent('c'), agent('a')), GRID, 500)
    expect(actors.map(actor => actor.id)).toEqual(['c', 'a', 'b'])
    expect(actors[2]?.phase).toBe('leaving')
  })
})

describe('stepActors', () => {
  it('dtMs <= 0 returns the actors unchanged', () => {
    const cast = [createActor('a', 'idle', DESK, GRID, 0)]
    expect(stepActors(cast, GRID, 0, 1000)).toBe(cast)
    expect(stepActors(cast, GRID, -5, 1000)).toBe(cast)
  })

  it('stays arriving during the pause, then walks with a computed path', () => {
    const actor = createActor('a', 'idle', DESK, GRID, 1000)
    const paused = stepActors([actor], GRID, 16, 1000 + ARRIVAL_PAUSE_MS - 1)
    expect(paused[0]?.phase).toBe('arriving')
    const walking = stepActors([actor], GRID, 16, 1000 + ARRIVAL_PAUSE_MS)
    expect(walking[0]?.phase).toBe('walking')
    expect(walking[0]?.pathIndex).toBe(0)
    expect(walking[0]?.path.length).toBeGreaterThanOrEqual(2)
    expect(walking[0]?.path[0]).toEqual(ENTRY_POINT)
  })

  it('walking advances at WALK_SPEED and settles in front of the desk', () => {
    const walker: Actor = {
      id: 'a', state: 'idle', phase: 'walking',
      x: 0, y: 0, desk: DESK,
      path: [{ x: 0, y: 0 }, { x: 0.4, y: 0 }],
      pathIndex: 0, phaseStartedAt: 0,
      archetype: 'teammate', doneSince: null,
    }
    const step = WALK_SPEED * 1 // one second of travel
    const mid = stepActors([walker], GRID, 1000, 1000)
    expect(mid[0]?.phase).toBe('walking')
    expect(mid[0]?.pathIndex).toBe(1) // first waypoint consumed (distance 0 <= 1e-6)
    expect(mid[0]?.x).toBeCloseTo(step, 9)
    expect(mid[0]?.y).toBe(0)
    const done = stepActors(mid, GRID, 1000, 2000) // remaining 0.05 < 0.35 → path end
    expect(done[0]?.phase).toBe('settled')
    expect(done[0]?.x).toBe(SETTLED.x)
    expect(done[0]?.y).toBe(SETTLED.y)
  })

  it('removes leaving actors once they reach the entry point', () => {
    const leaver: Actor = {
      id: 'a', state: 'idle', phase: 'leaving',
      x: 0.1, y: 0.3, desk: DESK,
      path: [{ x: 0.1, y: 0.3 }, ENTRY_POINT],
      pathIndex: 0, phaseStartedAt: 0,
      archetype: 'teammate', doneSince: null,
    }
    const stillWalking = stepActors([leaver], GRID, 100, 100) // 0.035 of 0.06 travelled
    expect(stillWalking).toHaveLength(1)
    expect(stillWalking[0]?.phase).toBe('leaving')
    const gone = stepActors(stillWalking, GRID, 1000, 1100)
    expect(gone).toEqual([])
  })

  it('keeps settled actors pinned in front of the desk', () => {
    const settled: Actor = {
      id: 'a', state: 'idle', phase: 'settled',
      x: SETTLED.x, y: SETTLED.y, desk: DESK, path: [], pathIndex: 0, phaseStartedAt: 0,
      archetype: 'teammate', doneSince: null,
    }
    expect(stepActors([settled], GRID, 16, 16)[0]).toBe(settled)
  })

  it('lingers a settled done actor for DONE_LINGER_MS, then walks it out to the entry point', () => {
    const celebrant: Actor = {
      id: 'a', state: 'done', phase: 'settled',
      x: SETTLED.x, y: SETTLED.y, desk: DESK, path: [], pathIndex: 0, phaseStartedAt: 0,
      archetype: 'coordinator', doneSince: 1000,
    }
    // Still lingering exactly at the deadline boundary (> DONE_LINGER_MS required).
    const lingering = stepActors([celebrant], GRID, 16, 1000 + DONE_LINGER_MS)
    expect(lingering[0]).toBe(celebrant)
    // Past the linger: transitions to leaving with a fresh path to ENTRY_POINT.
    const leaving = stepActors([celebrant], GRID, 16, 1000 + DONE_LINGER_MS + 1)
    expect(leaving).toHaveLength(1)
    const walker = leaving[0] as Actor
    expect(walker.phase).toBe('leaving')
    expect(walker.pathIndex).toBe(0)
    expect(walker.phaseStartedAt).toBe(1000 + DONE_LINGER_MS + 1)
    expect(walker.path[0]).toEqual({ x: SETTLED.x, y: SETTLED.y })
    expect(walker.path[walker.path.length - 1]).toEqual(ENTRY_POINT)
  })

  it('does not linger-expire settled actors in other states or without a done stamp', () => {
    for (const [state, doneSince] of [['idle', null], ['working', null], ['blocked', null], ['done', null]] as const) {
      const settled: Actor = {
        id: 'a', state: state as VisualAgentState, phase: 'settled',
        x: SETTLED.x, y: SETTLED.y, desk: DESK, path: [], pathIndex: 0, phaseStartedAt: 0,
        archetype: 'teammate', doneSince,
      }
      expect(stepActors([settled], GRID, 16, 999999)[0]).toBe(settled)
    }
  })
})

describe('sheetForActor', () => {
  const base = createActor('a', 'idle', DESK, GRID, 0)
  const phases = ['arriving', 'walking', 'leaving'] as const
  const archetypes: Archetype[] = ['teammate', 'reviewer', 'coordinator']

  it('maps arriving/walking/leaving to the archetype walk sheet (all archetypes)', () => {
    for (const archetype of archetypes) {
      for (const phase of phases) {
        expect(sheetForActor({ ...base, archetype, phase }, LIBRARY)).toBe(LIBRARY[archetype].walk)
      }
    }
  })

  it('maps settled working → work and settled idle → idle for every archetype', () => {
    for (const archetype of archetypes) {
      expect(sheetForActor({ ...base, archetype, phase: 'settled', state: 'working' }, LIBRARY))
        .toBe(LIBRARY[archetype].work)
      expect(sheetForActor({ ...base, archetype, phase: 'settled', state: 'idle' }, LIBRARY))
        .toBe(LIBRARY[archetype].idle)
    }
  })

  it('maps settled blocked/error/done to the dedicated teammate sheets', () => {
    expect(sheetForActor({ ...base, archetype: 'teammate', phase: 'settled', state: 'blocked' }, LIBRARY))
      .toBe(LIBRARY.teammate.blocked)
    expect(sheetForActor({ ...base, archetype: 'teammate', phase: 'settled', state: 'error' }, LIBRARY))
      .toBe(LIBRARY.teammate.error)
    expect(sheetForActor({ ...base, archetype: 'teammate', phase: 'settled', state: 'done' }, LIBRARY))
      .toBe(LIBRARY.teammate.done)
  })

  it('maps settled blocked/error/done to idle for reviewer/coordinator (badge conveys state)', () => {
    for (const archetype of ['reviewer', 'coordinator'] as const) {
      for (const state of ['blocked', 'error', 'done'] as const) {
        expect(sheetForActor({ ...base, archetype, phase: 'settled', state }, LIBRARY))
          .toBe(LIBRARY[archetype].idle)
      }
    }
  })
})
