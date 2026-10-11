import { clamp } from "../lib/format.ts"
import { createStore } from "../lib/store.ts"
import type { Bounds } from "./geometry.ts"

export interface View {
  readonly x: number
  readonly y: number
  readonly k: number
}

export const MIN_ZOOM = 0.2
export const MAX_ZOOM = 2.5

/**
 * Pan and zoom for the canvas. The Canvas component subscribes and applies the transform straight to the DOM,
 * so panning at 60fps never goes through React. Other views (the toolbar's zoom readout) select from the store.
 */
export const view = createStore<View>({ x: 0, y: 0, k: 1 })

let container: HTMLElement | undefined
export const attach = (element: HTMLElement | undefined): void => {
  container = element
}

const size = () => {
  const r = container?.getBoundingClientRect()
  return { w: r?.width ?? 800, h: r?.height ?? 600, left: r?.left ?? 0, top: r?.top ?? 0 }
}

export const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
  const { left, top } = size()
  const v = view.get()
  return { x: (clientX - left - v.x) / v.k, y: (clientY - top - v.y) / v.k }
}

export const panBy = (dx: number, dy: number): void => view.set((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))

/** Zoom keeping the point under (px, py), in container pixels, fixed. */
export const zoomAt = (px: number, py: number, factor: number): void =>
  view.set((v) => {
    const k = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM)
    const f = k / v.k
    return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f }
  })

export const zoomCenter = (factor: number): void => {
  const { w, h } = size()
  zoomAt(w / 2, h / 2, factor)
}

export const fit = (bounds: Bounds | undefined, padding = 72): void => {
  const { w, h } = size()
  if (bounds === undefined) return view.set({ x: w / 2, y: h / 2, k: 1 })
  const bw = bounds.maxX - bounds.minX
  const bh = bounds.maxY - bounds.minY
  const k = clamp(Math.min((w - padding * 2) / bw, (h - padding * 2) / bh), MIN_ZOOM, 1.25)
  view.set({ k, x: (w - bw * k) / 2 - bounds.minX * k, y: (h - bh * k) / 2 - bounds.minY * k })
}

/** World-space point at the centre of the visible canvas. */
export const centre = (): { x: number; y: number } => {
  const { w, h, left, top } = size()
  return toWorld(left + w / 2, top + h / 2)
}
