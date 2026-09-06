/** Gastown-inspired ORIGINAL palette for the GasView visual agents scene (M0: no sprites). */

/** Typed scene palette; every value is original art direction, not copied assets. */
export const palette = {
  parchment: '#e8dcc8',
  parchmentAlt: '#d9c9b0',
  surface: '#f5e6d3',
  darkWood: '#3e2723',
  surfaceDark: '#4a3728',
  ink: '#2c1810',
  muted: '#5d4037',
  brass: '#cd7f32',
  bronze: '#8b4513',
  copper: '#b87333',
  steel: '#70798c',
  oxide: '#8b2500',
  highlight: '#d4a574',
  nightBg: '#0f1419',
  lamplight: '#ffb454',
  furnace: '#ff8f40',
} as const

/** Palette key union. */
export type PaletteKey = keyof typeof palette
