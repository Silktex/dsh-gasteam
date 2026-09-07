/** M4 scene theming: light/dark color sets and prefers-color-scheme detection. */

import { palette } from '../client/assets/palette.ts'

/** Scene theme identifier. */
export type SceneTheme = 'light' | 'dark'

/** Resolved per-theme paint colors consumed by paintScene and paintAmbient. */
export interface SceneThemeColors {
  readonly background: string
  readonly grid: string
  readonly deskTop: string
  readonly deskLeg: string
  readonly plaqueFrame: string
  readonly plaqueFill: string
  readonly plaqueText: string
  readonly gearA: string
  readonly gearB: string
  readonly lampGlow: string
  readonly boardFill: string
  readonly boardText: string
}

/** Light theme: parchment day shift. */
const LIGHT_COLORS: SceneThemeColors = {
  background: palette.parchment,
  grid: palette.muted,
  deskTop: palette.darkWood,
  deskLeg: palette.bronze,
  plaqueFrame: palette.brass,
  plaqueFill: palette.surface,
  plaqueText: palette.ink,
  gearA: palette.brass,
  gearB: palette.copper,
  lampGlow: palette.lamplight,
  boardFill: palette.surface,
  boardText: palette.ink,
}

/** Dark theme: night shift by furnace light. */
const DARK_COLORS: SceneThemeColors = {
  background: palette.nightBg,
  grid: palette.surfaceDark,
  deskTop: palette.surfaceDark,
  deskLeg: palette.bronze,
  plaqueFrame: palette.brass,
  plaqueFill: palette.darkWood,
  plaqueText: palette.highlight,
  gearA: palette.copper,
  gearB: palette.brass,
  lampGlow: palette.furnace,
  boardFill: palette.surfaceDark,
  boardText: palette.highlight,
}

/** Resolve a theme identifier to its concrete color set. */
export function resolveSceneTheme(theme: SceneTheme): SceneThemeColors {
  return theme === 'dark' ? DARK_COLORS : LIGHT_COLORS
}

/** Minimal matchMedia shape this module depends on. */
type MatchMediaFn = (query: string) => { readonly matches: boolean }

/** Media query driving the automatic theme. */
const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * Detect the active scene theme. Uses the injected matchMedia when given,
 * otherwise window.matchMedia; falls back to 'light' when neither exists
 * (host/test environments) or the query throws.
 */
export function detectSceneTheme(matchMediaFn?: MatchMediaFn): SceneTheme {
  const query: MatchMediaFn | undefined = matchMediaFn
    ?? (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia.bind(window)
      : undefined)
  if (query === undefined) return 'light'
  try {
    return query(DARK_QUERY).matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}
