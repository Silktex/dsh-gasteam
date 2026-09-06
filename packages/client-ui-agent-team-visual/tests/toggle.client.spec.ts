// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createVisualToggleStore, TOGGLE_KEY_PREFIX, type StorageLike } from '../src/client/toggle.ts'

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial))
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
}

beforeEach(() => { window.localStorage.clear() })

describe('createVisualToggleStore', () => {
  it('defaults to off when no flag was stored', () => {
    const store = createVisualToggleStore(memoryStorage(), false)
    expect(store.isEnabled('project-a')).toBe(false)
  })

  it('honors the default until a flag is written', () => {
    const store = createVisualToggleStore(memoryStorage(), true)
    expect(store.isEnabled('project-a')).toBe(true)
    store.setEnabled('project-a', false)
    expect(store.isEnabled('project-a')).toBe(false)
  })

  it('persists flags per project under the gasteam prefix', () => {
    const storage = memoryStorage()
    const store = createVisualToggleStore(storage, false)
    store.setEnabled('project-a', true)
    expect(storage.getItem(`${TOGGLE_KEY_PREFIX}project-a`)).toBe('1')
    expect(store.isEnabled('project-a')).toBe(true)
    store.setEnabled('project-a', false)
    expect(storage.getItem(`${TOGGLE_KEY_PREFIX}project-a`)).toBe('0')
    expect(store.isEnabled('project-a')).toBe(false)
  })

  it('keeps flags independent across projects', () => {
    const store = createVisualToggleStore(memoryStorage(), false)
    store.setEnabled('project-a', true)
    expect(store.isEnabled('project-a')).toBe(true)
    expect(store.isEnabled('project-b')).toBe(false)
    store.setEnabled('project-b', true)
    store.setEnabled('project-a', false)
    expect(store.isEnabled('project-a')).toBe(false)
    expect(store.isEnabled('project-b')).toBe(true)
  })

  it('treats malformed values as unset', () => {
    const storage = memoryStorage({ [`${TOGGLE_KEY_PREFIX}project-a`]: 'yes' })
    expect(createVisualToggleStore(storage, false).isEnabled('project-a')).toBe(false)
    expect(createVisualToggleStore(storage, true).isEnabled('project-a')).toBe(true)
  })

  it('notifies subscribers on writes and stops after unsubscribe', () => {
    const store = createVisualToggleStore(memoryStorage(), false)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.setEnabled('project-a', true)
    expect(listener).toHaveBeenCalledTimes(1)
    store.setEnabled('project-b', false)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    store.setEnabled('project-a', false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('round-trips through window.localStorage', () => {
    const store = createVisualToggleStore(window.localStorage, false)
    store.setEnabled('project-a', true)
    expect(createVisualToggleStore(window.localStorage, false).isEnabled('project-a')).toBe(true)
  })
})
