import type { ComponentManifest, Doc, NodeDoc } from "../state/types.ts"
import { rectOf } from "./groups.ts"

/**
 * Node cards have a fixed geometry, so the design alone says where everything is: placing new nodes, fitting the view
 * and hit-testing a wire's end need no DOM. (Where wires attach, React Flow measures from the handles.)
 */
export const NODE_W = 236
export const HEAD_H = 42
export const STATS_H = 54
export const PORT_H = 24
const PORTS_PAD = 8

export const nodeHeight = (manifest: ComponentManifest | undefined): number => {
  const ports = manifest?.outputs.length ?? 1
  return HEAD_H + STATS_H + (ports > 1 ? ports * PORT_H + PORTS_PAD : 0)
}

export interface Point {
  readonly x: number
  readonly y: number
}

export const edgePath = (a: Point, b: Point): string => {
  const dx = Math.max(60, Math.abs(b.x - a.x) * 0.5)
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
}

export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

export interface Bounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

export const boundsOf = (design: Doc, byType: Readonly<Record<string, ComponentManifest>>): Bounds | undefined => {
  let bounds: Bounds | undefined
  for (const node of Object.values(design.nodes)) {
    const r = rectOf(node, byType[node.type])
    bounds = bounds === undefined
      ? { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h }
      : {
        minX: Math.min(bounds.minX, r.x),
        minY: Math.min(bounds.minY, r.y),
        maxX: Math.max(bounds.maxX, r.x + r.w),
        maxY: Math.max(bounds.maxY, r.y + r.h)
      }
  }
  return bounds
}
