import { useRef } from "react"

/**
 * A value shown as text, refreshed at most every `ms` of real time. At 50× a number recomputed on every redraw changes
 * sixteen times a second, too fast to read; the charts can move smoothly while their numbers hold still long enough.
 * A new `key` (another node selected) shows the new value at once, not the last one's for a moment.
 */
export const useSteady = <T,>(value: T, key = "", ms = 450): T => {
  const shown = useRef<{ value: T; key: string; at: number } | undefined>(undefined)
  const now = performance.now()
  if (shown.current === undefined || shown.current.key !== key || now - shown.current.at >= ms) shown.current = { value, key, at: now }
  return shown.current.value
}
