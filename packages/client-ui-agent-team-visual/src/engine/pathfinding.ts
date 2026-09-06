/** Obstacle-aware A* pathfinding over a normalized (0..1) scene grid. */

/** A point in normalized scene coordinates (0..1 on both axes). */
export interface Point { readonly x: number; readonly y: number }

/** An axis-aligned obstacle rectangle in normalized scene coordinates. */
export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/** A coarse navigation grid: row-major blocked flags, length cols*rows. */
export interface NavGrid {
  readonly cols: number
  readonly rows: number
  readonly blocked: readonly boolean[]
}

/** Normalized center of grid cell (col, row). */
function cellCenter(grid: NavGrid, col: number, row: number): Point {
  return { x: (col + 0.5) / grid.cols, y: (row + 0.5) / grid.rows }
}

/** Grid cell containing a normalized point, clamped to the grid bounds. */
function cellOf(grid: NavGrid, point: Point): { col: number; row: number } {
  return {
    col: Math.min(grid.cols - 1, Math.max(0, Math.floor(point.x * grid.cols))),
    row: Math.min(grid.rows - 1, Math.max(0, Math.floor(point.y * grid.rows))),
  }
}

/**
 * Build a navigation grid. A cell is blocked when its center falls inside any
 * obstacle rect (inclusive edges).
 */
export function buildNavGrid(cols: number, rows: number, obstacles: readonly Rect[]): NavGrid {
  const blocked: boolean[] = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const center = cellCenter({ cols, rows, blocked: [] }, col, row)
      blocked.push(obstacles.some(rect =>
        center.x >= rect.x && center.x <= rect.x + rect.w
        && center.y >= rect.y && center.y <= rect.y + rect.h))
    }
  }
  return { cols, rows, blocked }
}

/** Neighbor deltas in the contracted deterministic order: up, left, right, down. */
const NEIGHBORS = [
  { dc: 0, dr: -1 },
  { dc: -1, dr: 0 },
  { dc: 1, dr: 0 },
  { dc: 0, dr: 1 },
] as const

interface SearchNode {
  readonly col: number
  readonly row: number
  readonly g: number
  readonly f: number
  readonly parent: SearchNode | null
}

/**
 * A* over the nav grid: 4-directional movement, Manhattan heuristic, uniform
 * cost, deterministic tie-breaking (neighbor order up, left, right, down;
 * equal-f nodes expand in insertion order). Returns normalized waypoints from
 * `from` to `to` inclusive — the exact endpoints, with cell centers in
 * between. If either endpoint's cell is blocked, or no path exists, returns
 * the straight two-point fallback [from, to].
 */
export function findPath(grid: NavGrid, from: Point, to: Point): readonly Point[] {
  const fallback: readonly Point[] = [from, to]
  const start = cellOf(grid, from)
  const goal = cellOf(grid, to)
  const isBlocked = (col: number, row: number): boolean =>
    grid.blocked[row * grid.cols + col] === true
  if (isBlocked(start.col, start.row) || isBlocked(goal.col, goal.row)) return fallback

  const heuristic = (col: number, row: number): number =>
    Math.abs(col - goal.col) + Math.abs(row - goal.row)

  const startNode: SearchNode = { col: start.col, row: start.row, g: 0, f: heuristic(start.col, start.row), parent: null }
  const open: SearchNode[] = [startNode]
  const bestG = new Map<number, number>([[start.row * grid.cols + start.col, 0]])
  const closed = new Set<number>()

  let end: SearchNode | null = null
  while (open.length > 0) {
    // First minimal-f node wins (insertion order breaks ties deterministically).
    let bestIndex = 0
    for (let index = 1; index < open.length; index += 1) {
      const node = open[index] as SearchNode
      const best = open[bestIndex] as SearchNode
      if (node.f < best.f) bestIndex = index
    }
    const current = open.splice(bestIndex, 1)[0] as SearchNode
    const key = current.row * grid.cols + current.col
    if (closed.has(key)) continue
    closed.add(key)
    if (current.col === goal.col && current.row === goal.row) {
      end = current
      break
    }
    for (const { dc, dr } of NEIGHBORS) {
      const col = current.col + dc
      const row = current.row + dr
      if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) continue
      const nextKey = row * grid.cols + col
      if (closed.has(nextKey) || isBlocked(col, row)) continue
      const g = current.g + 1
      if (g >= (bestG.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue
      bestG.set(nextKey, g)
      open.push({ col, row, g, f: g + heuristic(col, row), parent: current })
    }
  }
  if (end === null) return fallback

  const cells: { col: number; row: number }[] = []
  for (let node: SearchNode | null = end; node !== null; node = node.parent) {
    cells.push({ col: node.col, row: node.row })
  }
  cells.reverse()
  const waypoints: Point[] = cells.map(cell => cellCenter(grid, cell.col, cell.row))
  return [from, ...waypoints.slice(1, -1), to]
}
