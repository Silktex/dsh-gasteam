/** Host-runnable coverage for the M4 scene theme resolution and detection. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { palette } from '../src/client/assets/palette.ts'
import { detectSceneTheme, resolveSceneTheme } from '../src/scenes/theme.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('resolveSceneTheme', () => {
  it('returns the exact light color set from the palette', () => {
    expect(resolveSceneTheme('light')).toEqual({
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
    })
  })

  it('returns the exact dark color set from the palette', () => {
    expect(resolveSceneTheme('dark')).toEqual({
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
    })
  })
})

describe('detectSceneTheme', () => {
  it('returns dark when the injected matchMedia matches', () => {
    expect(detectSceneTheme(() => ({ matches: true }))).toBe('dark')
  })

  it('returns light when the injected matchMedia does not match', () => {
    expect(detectSceneTheme(() => ({ matches: false }))).toBe('light')
  })

  it('queries the dark color-scheme media feature', () => {
    const queries: string[] = []
    detectSceneTheme((query: string) => {
      queries.push(query)
      return { matches: true }
    })
    expect(queries).toEqual(['(prefers-color-scheme: dark)'])
  })

  it('defaults to light in a host environment without window', () => {
    // Node host env: no global window at all.
    expect(detectSceneTheme()).toBe('light')
  })

  it('defaults to light when window.matchMedia is unavailable', () => {
    vi.stubGlobal('window', {})
    expect(detectSceneTheme()).toBe('light')
  })

  it('uses window.matchMedia when present', () => {
    vi.stubGlobal('window', {
      matchMedia: (query: string) => ({ matches: query.includes('dark') }),
    })
    expect(detectSceneTheme()).toBe('dark')
  })
})
