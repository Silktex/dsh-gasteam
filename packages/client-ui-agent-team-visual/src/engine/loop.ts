/** Single requestAnimationFrame render loop with a setTimeout fallback (jsdom safety). */

/** Handle returned by startLoop; stop() is idempotent. */
export interface LoopHandle { stop(): void }

/** Optional injectables for startLoop (tests drive frames via a fake scheduler). */
export interface LoopOptions {
  readonly requestFrame?: (cb: () => void) => number
  readonly cancelFrame?: (id: number) => void
  readonly maxDtMs?: number
  readonly now?: () => number
}

/**
 * Schedule `callback` repeatedly via requestFrame (default
 * `globalThis.requestAnimationFrame`; falls back to `setTimeout(cb, 16)` when
 * no rAF exists and none is injected). `dtMs` = now() - previous frame,
 * clamped to [0, maxDtMs] (default 100). stop() cancels the pending frame and
 * prevents rescheduling. Errors thrown by the callback propagate to the
 * caller of the frame — they are never swallowed.
 */
export function startLoop(
  callback: (timeMs: number, dtMs: number) => void,
  options: LoopOptions = {},
): LoopHandle {
  const maxDtMs = options.maxDtMs ?? 100
  const now = options.now ?? ((): number => Date.now())
  const nativeRaf = typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : undefined
  const nativeCancel = typeof globalThis.cancelAnimationFrame === 'function'
    ? globalThis.cancelAnimationFrame.bind(globalThis)
    : undefined
  const useTimeoutFallback = options.requestFrame === undefined && nativeRaf === undefined
  const requestFrame = options.requestFrame ?? nativeRaf
    ?? ((cb: () => void): number => setTimeout(cb, 16) as unknown as number)
  const cancelFrame = options.cancelFrame
    ?? (useTimeoutFallback
      ? (id: number): void => { clearTimeout(id) }
      : (nativeCancel ?? ((): void => {})))

  let stopped = false
  let pending: number | null = null
  let last = now()

  const frame = (): void => {
    if (stopped) return
    const timeMs = now()
    const dtMs = Math.min(Math.max(timeMs - last, 0), maxDtMs)
    last = timeMs
    // Schedule the next frame BEFORE invoking the callback so stop() inside
    // the callback cancels it and a thrown error still propagates to the
    // frame's caller without silently killing the loop.
    pending = requestFrame(frame)
    callback(timeMs, dtMs)
  }
  pending = requestFrame(frame)

  return {
    stop(): void {
      if (stopped) return
      stopped = true
      if (pending !== null) cancelFrame(pending)
      pending = null
    },
  }
}
