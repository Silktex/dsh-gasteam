/** Per-project opt-in toggle persisted in Web Storage. Pure, no React. */

/** Minimal Storage slice so the store stays testable without a DOM. */
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** Per-project visual overlay toggle. */
export interface VisualToggleStore {
  isEnabled(projectId: string): boolean
  setEnabled(projectId: string, enabled: boolean): void
  subscribe(listener: () => void): () => void
}

/** localStorage key prefix for the per-project flag. */
export const TOGGLE_KEY_PREFIX = 'gasteam.visual-agents.'

/**
 * Create a per-project visual toggle store.
 * @param storage - Web Storage (or test double) holding `'1'`/`'0'` flags.
 * @param defaultEnabled - value used when the key is unset or malformed.
 * @returns the toggle store; `setEnabled` notifies every subscriber.
 */
export function createVisualToggleStore(storage: StorageLike, defaultEnabled: boolean): VisualToggleStore {
  const listeners = new Set<() => void>()
  const key = (projectId: string): string => `${TOGGLE_KEY_PREFIX}${projectId}`
  return {
    isEnabled(projectId) {
      const value = storage.getItem(key(projectId))
      if (value === '1') return true
      if (value === '0') return false
      return defaultEnabled
    },
    setEnabled(projectId, enabled) {
      storage.setItem(key(projectId), enabled ? '1' : '0')
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
