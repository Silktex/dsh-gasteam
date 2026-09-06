/** Nav-grid construction and deterministic 4-directional A* coverage. */

import { describe, expect, it } from 'vitest'
import { buildNavGrid, findPath, type NavGrid, type Point } from '../src/engine/pathfinding.ts'
import { ENTRY_POINT } from '../src/engine/stateMachine.ts'
import { DESK_SLOTS } from '../src/scenes/layout.ts'

/** Cell-center coordinates for a grid cell. */
function center(grid: NavGrid, col: number, row: number): Point {
  return { x: (col + 0.5) / grid.cols, y: (row + 0.5) / grid.rows }
}

/** True when a waypoint sits in a blocked cell. */
function inBlockedCell(grid: NavGrid, point: Point): boolean {
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor(point.x * grid.cols)))
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor(point.y * grid.rows)))
  return grid.blocked[row * grid.cols + col] === true
}

describe('buildNavGrid', () => {
  it('blocks cells whose center falls inside an obstacle rect (inclusive edges)', () => {
    // 4x4 grid: cell size 0.25; centers at 0.125, 0.375, 0.625, 0.875.
    const grid = buildNavGrid(4, 4, [{ x: 0.25, y: 0.25, w: 0.25, h: 0.25 }])
    expect(grid.cols).toBe(4)
    expect(grid.rows).toBe(4)
    expect(grid.blocked).toHaveLength(16)
    // Centers on the rect edges: (0.375, 0.375) is inside; (0.125, *) and (0.625, *) outside.
    expect(grid.blocked[1 * 4 + 1]).toBe(true) // center (0.375, 0.375)
    expect(grid.blocked[1 * 4 + 0]).toBe(false)
    expect(grid.blocked[1 * 4 + 2]).toBe(false)
    expect(grid.blocked[0 * 4 + 1]).toBe(false)
  })

  it('marks everything free without obstacles', () => {
    const grid = buildNavGrid(3, 2, [])
    expect(grid.blocked).toEqual([false, false, false, false, false, false])
  })
})

describe('findPath', () => {
  it('returns a straight-ish path on an open grid, endpoints included', () => {
    const grid = buildNavGrid(5, 5, [])
    const from: Point = { x: 0.1, y: 0.1 } // cell (0,0)
    const to: Point = { x: 0.9, y: 0.3 }   // cell (4,1)
    const path = findPath(grid, from, to)
    expect(path[0]).toEqual(from)
    expect(path[path.length - 1]).toEqual(to)
    // Interior waypoints are cell centers; Manhattan length = dx + dy + 1 cells.
    expect(path).toHaveLength(4 + 1 + 1) // 4 col steps + 1 row step + endpoints share cells
    for (const waypoint of path.slice(1, -1)) {
      expect(inBlockedCell(grid, waypoint)).toBe(false)
    }
  })

  it('detours around obstacles without crossing blocked cells', () => {
    // Wall across rows 1..3 at col 2, gap at row 0 (centers: col 2 → x 0.4167,
    // rows 1..3 → y 0.375/0.625/0.875 all inside [0.25, 1.0] inclusive).
    const obstacles = [{ x: 0.34, y: 0.25, w: 0.17, h: 0.75 }]
    const grid = buildNavGrid(6, 4, obstacles)
    expect(grid.blocked[1 * 6 + 2]).toBe(true)
    expect(grid.blocked[2 * 6 + 2]).toBe(true)
    expect(grid.blocked[3 * 6 + 2]).toBe(true)
    expect(grid.blocked[0 * 6 + 2]).toBe(false)
    const from: Point = { x: 0.08, y: 0.5 } // cell (0,2)
    const to: Point = { x: 0.92, y: 0.5 }   // cell (5,2)
    const path = findPath(grid, from, to)
    expect(path.length).toBeGreaterThan(2) // real detour, not the fallback
    expect(path[0]).toEqual(from)
    expect(path[path.length - 1]).toEqual(to)
    for (const waypoint of path) {
      expect(inBlockedCell(grid, waypoint)).toBe(false)
    }
    // The detour must pass through the gap row (row 0 centers y = 0.125).
    expect(path.some(point => Math.abs(point.y - 0.125) < 1e-9)).toBe(true)
  })

  it('returns the [from, to] fallback when an endpoint cell is blocked', () => {
    const grid = buildNavGrid(4, 4, [{ x: 0.25, y: 0.25, w: 0.25, h: 0.25 }])
    const from: Point = { x: 0.375, y: 0.375 } // blocked cell (1,1)
    const to: Point = { x: 0.875, y: 0.875 }
    expect(findPath(grid, from, to)).toEqual([from, to])
    expect(findPath(grid, to, from)).toEqual([to, from])
  })

  it('returns the [from, to] fallback when no path exists', () => {
    // Full vertical wall at col 1 (no gap).
    const grid = buildNavGrid(4, 4, [{ x: 0.25, y: 0, w: 0.25, h: 1 }])
    const from: Point = { x: 0.125, y: 0.125 }
    const to: Point = { x: 0.875, y: 0.875 }
    expect(findPath(grid, from, to)).toEqual([from, to])
  })

  it('is deterministic: identical calls produce identical arrays', () => {
    const grid = buildNavGrid(8, 6, [
      { x: 0.3, y: 0.2, w: 0.2, h: 0.5 },
      { x: 0.6, y: 0.4, w: 0.15, h: 0.4 },
    ])
    const from: Point = { x: 0.06, y: 0.92 }
    const to: Point = { x: 0.94, y: 0.08 }
    const first = findPath(grid, from, to)
    const second = findPath(grid, from, to)
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
  })

  it('breaks ties by neighbor order up, left, right, down', () => {
    // From cell (1,1) to cell (2,2) on an open grid: two optimal first steps
    // (right or down). 'right' precedes 'down' in the neighbor order, so the
    // path moves right first.
    const grid = buildNavGrid(4, 4, [])
    const from = center(grid, 1, 1)
    const to = center(grid, 2, 2)
    const path = findPath(grid, from, to)
    expect(path).toEqual([from, center(grid, 2, 1), to])
    // Vertical analogue: 'up' precedes everything, so (2,2) → (1,1) via (2,1).
    const up = findPath(grid, center(grid, 2, 2), center(grid, 1, 1))
    expect(up).toEqual([center(grid, 2, 2), center(grid, 2, 1), center(grid, 1, 1)])
  })

  it('routes from the entry point to real settle cells around the desk obstacles', () => {
    // The REAL desk obstacles used by VisualAgentsAction; actors settle in
    // front of desks at { slot.x, slot.y + 0.10 }, below the obstacle rect.
    const obstacles = DESK_SLOTS.map(slot => ({ x: slot.x - 0.06, y: slot.y - 0.02, w: 0.12, h: 0.06 }))
    const grid = buildNavGrid(20, 12, obstacles)
    // Every settle cell must be unblocked (else A* degenerates to the
    // straight-line fallback for every actor).
    for (const slot of DESK_SLOTS) {
      expect(inBlockedCell(grid, { x: slot.x, y: slot.y + 0.10 })).toBe(false)
    }
    // A* must produce a real multi-waypoint route to the farthest row-2 desk
    // settle cell, never stepping on a blocked cell.
    const farthest = DESK_SLOTS[DESK_SLOTS.length - 1] as (typeof DESK_SLOTS)[number] // { x: 0.87, y: 0.8 }
    const target: Point = { x: farthest.x, y: farthest.y + 0.10 }
    const path = findPath(grid, ENTRY_POINT, target)
    expect(path.length).toBeGreaterThan(2) // real route, not the fallback
    expect(path[0]).toEqual(ENTRY_POINT)
    expect(path[path.length - 1]).toEqual(target)
    for (const waypoint of path) {
      expect(inBlockedCell(grid, waypoint)).toBe(false)
    }
  })

  it('handles from === to with a trivial two-point path', () => {
    const grid = buildNavGrid(3, 3, [])
    const from: Point = { x: 0.5, y: 0.5 }
    expect(findPath(grid, from, from)).toEqual([from, from])
  })
})
