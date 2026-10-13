/**
 * Where things sit on the canvas: laying out a document that arrived without coordinates, and the fixed sizes of node
 * cards and container boxes that layout and the UI agree on.
 */
import type { Doc, Position } from "./Design.ts"
import * as internal from "./internal/layout.ts"
import type { Components } from "./Registry.ts"

export interface LayoutOptions {
  readonly columnWidth?: number
  readonly rowHeight?: number
  readonly origin?: Position
  /** Re-place every node, not just those without a position. */
  readonly all?: boolean
}

/**
 * Give nodes without a position a place on the canvas. Imported templates arrive with no coordinates, so
 * this is what makes them readable: nodes flow left to right by how far they are from a traffic source,
 * ordered within each column to keep edges short. Cycles (retry loops, DLQ redrive) are tolerated by
 * ignoring the edge that closes them when assigning columns.
 */
export const autoLayout = (design: Doc, registry: Components, options: LayoutOptions = {}): Doc => internal.autoLayout(design, registry, options)

// ---------------------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------------------

/** Node cards have a fixed size so layout can be computed from the document alone. The UI draws them at these sizes. */
export const NODE_W = 236
export const HEAD_H = 42
export const STATS_H = 54
export const PORT_H = 24
const PORTS_PAD = 8
/** Height of the title strip of a container box. */
export const BOX_HEAD_H = 38
const BOX_PAD = 28

export const nodeHeight = (outputs: number): number => HEAD_H + STATS_H + (outputs > 1 ? outputs * PORT_H + PORTS_PAD : 0)

/**
 * Resize every container to hug what is inside it, innermost first, leaving room for its title. Used after laying
 * out nodes (a tidy layout, an import), which moves nodes but not the boxes drawn round them.
 */
export const fitContainers = (design: Doc, registry: Components): Doc => {
  const sizeOf = (id: string, doc: Doc) => {
    const spec = doc.nodes[id]!
    const component = registry.get(spec.type)
    const at = spec.position ?? { x: 0, y: 0 }
    if (component?.container !== undefined) return { x: at.x, y: at.y, w: spec.size?.w ?? 560, h: spec.size?.h ?? 340 }
    return { x: at.x, y: at.y, w: NODE_W, h: nodeHeight(Object.keys(component?.ports ?? {}).length) }
  }
  const depth = (id: string): number => {
    let d = 0
    for (let at = design.nodes[id]?.parent; at !== undefined && d < 32; at = design.nodes[at]?.parent) d++
    return d
  }
  const boxes = Object.keys(design.nodes)
    .filter((id) => registry.get(design.nodes[id]!.type)?.container !== undefined)
    .sort((a, b) => depth(b) - depth(a))
  let next = design
  for (const id of boxes) {
    const rects = Object.keys(next.nodes).filter((k) => next.nodes[k]!.parent === id).map((k) => sizeOf(k, next))
    if (rects.length === 0) continue
    const minX = Math.min(...rects.map((r) => r.x)) - BOX_PAD
    const minY = Math.min(...rects.map((r) => r.y)) - BOX_PAD - BOX_HEAD_H
    const maxX = Math.max(...rects.map((r) => r.x + r.w)) + BOX_PAD
    const maxY = Math.max(...rects.map((r) => r.y + r.h)) + BOX_PAD
    next = { ...next, nodes: { ...next.nodes, [id]: { ...next.nodes[id]!, position: { x: minX, y: minY }, size: { w: Math.max(260, maxX - minX), h: Math.max(160, maxY - minY) } } } }
  }
  return next
}
