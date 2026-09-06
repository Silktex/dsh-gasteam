/** Actor FSM coverage: creation, reconciliation, stepping, sheet selection. */

import { describe, expect, it } from 'vitest'
import type { SpriteSheet } from '../src/engine/sprites.ts'
import { buildNavGrid, type Point } from '../src/engine/pathfinding.ts'
import { DESK_SLOTS, deskSlotFor, type DeskSlot } from '../src/scenes/layout.ts'
import type { VisualAgent, VisualSceneModel } from '../src/client/reconcile.ts'
import {
  ARRIVAL_PAUSE_MS, ENTRY_POINT, WALK_SPEED,
  createActor, reconcileActors, sheetForActor, stepActors,
  type Actor, type ActorSheets,
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

const SHEETS: ActorSheets = { idle: sheet('tiny.idle'), work: sheet('tiny.work'), walk: sheet('tiny.walk') }

describe('constants', () => {
  it('exposes the contracted entry point, walk speed, and arrival pause', () => {
    expect(ENTRY_POINT).toEqual({ x: 0.04, y: 0.3 })
    expect(WALK_SPEED).toBe(0.35)
    expect(ARRIVAL_PAUSE_MS).toBe(400)
  })
})

describe('createActor', () => {
  it('starts arriving at the entry point with an empty path', () => {
    const actor = createActor('a1', 'working', DESK, GRID, 1234)
    expect(actor).toEqual({
      id: 'a1', state: 'working', phase: 'arriving',
      x: ENTRY_POINT.x, y: ENTRY_POINT.y, desk: DESK,
      path: [], pathIndex: 0, phaseStartedAt: 1234,
    })
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
  })

  it('keeps phase/desk/position for surviving actors and updates state', () => {
    const settled: Actor = {
      id: 'a', state: 'idle', phase: 'settled',
      x: SETTLED.x, y: SETTLED.y, desk: DESK, path: [], pathIndex: 0, phaseStartedAt: 0,
    }
    const actors = reconcileActors([settled], model(agent('a', 'working')), GRID, 200)
    expect(actors).toHaveLength(1)
    expect(actors[0]).toEqual({ ...settled, state: 'working' })
  })

  it('marks actors absent from the model as leaving toward the entry point', () => {
    const settled: Actor = {
      id: 'gone', state: 'idle', phase: 'settled',
      x: SETTLED.x, y: SETTLED.y, desk: DESK, path: [], pathIndex: 0, phaseStartedAt: 0,
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
    }
    expect(stepActors([settled], GRID, 16, 16)[0]).toBe(settled)
  })
})

describe('sheetForActor', () => {
  const base = createActor('a', 'idle', DESK, GRID, 0)

  it('maps arriving/walking/leaving to the walk sheet', () => {
    for (const phase of ['arriving', 'walking', 'leaving'] as const) {
      expect(sheetForActor({ ...base, phase }, SHEETS)).toBe(SHEETS.walk)
    }
  })

  it('maps settled working to work and every other settled state to idle (M2)', () => {
    expect(sheetForActor({ ...base, phase: 'settled', state: 'working' }, SHEETS)).toBe(SHEETS.work)
    for (const state of ['idle', 'blocked', 'error', 'done'] as const) {
      expect(sheetForActor({ ...base, phase: 'settled', state }, SHEETS)).toBe(SHEETS.idle)
    }
  })
})
