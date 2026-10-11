import type { ReactFlowInstance } from "@xyflow/react"
import { clamp } from "../lib/format.ts"
import { createStore } from "../lib/store.ts"
import type { FlowEdge, FlowNode } from "./flow.ts"
import type { Bounds } from "./geometry.ts"

export interface View {
  readonly x: number
  readonly y: number
  readonly k: number
}

export const MIN_ZOOM = 0.2
export const MAX_ZOOM = 2.5

/**
 * Pan and zoom for the canvas. React Flow owns the viewport; this mirrors it (the canvas reports every move) so the
 * rest of the app can read it without React Flow's context (the toolbar's zoom readout) and steer it from outside
 * (fit, zoom buttons, revealing a node) with plain functions.
 */
export const view = createStore<View>({ x: 0, y: 0, k: 1 })

let container: HTMLElement | undefined
let flow: ReactFlowInstance<FlowNode, FlowEdge> | undefined

/** Called by the canvas once React Flow is ready. A view set before then (an early fit) is applied now. */
export const attach = (element: HTMLElement | undefined, instance?: ReactFlowInstance<FlowNode, FlowEdge>): void => {
  container = element
  flow = instance
  if (flow !== undefined) {
    const { x, y, k } = view.get()
    void flow.setViewport({ x, y, zoom: k })
  }
}

/** The canvas reports React Flow's viewport here as it moves. */
export const moved = (v: { readonly x: number; readonly y: number; readonly zoom: number }): void => {
  const current = view.get()
  if (current.x !== v.x || current.y !== v.y || current.k !== v.zoom) view.set({ x: v.x, y: v.y, k: v.zoom })
}

/** Move the view. The mirror is updated at once: React Flow doesn't report a move it was told to make. */
const apply = (next: View): void => {
  view.set(next)
  if (flow !== undefined) void flow.setViewport({ x: next.x, y: next.y, zoom: next.k })
}

const size = () => {
  const r = container?.getBoundingClientRect()
  return { w: r?.width ?? 800, h: r?.height ?? 600, left: r?.left ?? 0, top: r?.top ?? 0 }
}

export const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
  if (flow !== undefined) return flow.screenToFlowPosition({ x: clientX, y: clientY })
  const { left, top } = size()
  const v = view.get()
  return { x: (clientX - left - v.x) / v.k, y: (clientY - top - v.y) / v.k }
}

export const panBy = (dx: number, dy: number): void => {
  const v = view.get()
  apply({ ...v, x: v.x + dx, y: v.y + dy })
}

/** Zoom keeping the point under (px, py), in container pixels, fixed. */
export const zoomAt = (px: number, py: number, factor: number): void => {
  const v = view.get()
  const k = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM)
  const f = k / v.k
  apply({ k, x: px - (px - v.x) * f, y: py - (py - v.y) * f })
}

export const zoomCenter = (factor: number): void => {
  const { w, h } = size()
  zoomAt(w / 2, h / 2, factor)
}

export const fit = (bounds: Bounds | undefined, padding = 72): void => {
  const { w, h } = size()
  if (bounds === undefined) return apply({ x: w / 2, y: h / 2, k: 1 })
  const bw = bounds.maxX - bounds.minX
  const bh = bounds.maxY - bounds.minY
  const k = clamp(Math.min((w - padding * 2) / bw, (h - padding * 2) / bh), MIN_ZOOM, 1.25)
  apply({ k, x: (w - bw * k) / 2 - bounds.minX * k, y: (h - bh * k) / 2 - bounds.minY * k })
}

/** World-space point at the centre of the visible canvas. */
export const centre = (): { x: number; y: number } => {
  const { w, h, left, top } = size()
  return toWorld(left + w / 2, top + h / 2)
}

/** Pan so the world-space point (x, y) is in the middle of the canvas, keeping the zoom. */
export const centreOn = (x: number, y: number): void => {
  const { w, h } = size()
  const v = view.get()
  apply({ ...v, x: w / 2 - x * v.k, y: h / 2 - y * v.k })
}

/** Whether a world-space rectangle is wholly on screen. */
export const isVisible = (r: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }): boolean => {
  const { w, h } = size()
  const v = view.get()
  return r.x * v.k + v.x >= 0 && r.y * v.k + v.y >= 0 && (r.x + r.w) * v.k + v.x <= w && (r.y + r.h) * v.k + v.y <= h
}
