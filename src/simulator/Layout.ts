import { Graph } from "effect"
import type { Doc, NodeId, Position } from "./Design.ts"
import type { Components } from "./Registry.ts"
import * as Topology from "./Topology.ts"

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
export const autoLayout = (design: Doc, registry: Components, options: LayoutOptions = {}): Doc => {
  const columnWidth = options.columnWidth ?? 320
  const rowHeight = options.rowHeight ?? 150
  const origin = options.origin ?? { x: 80, y: 80 }
  const top = Topology.fromDoc(design, registry)
  // Containers are boxes drawn round their contents, not part of the flow.
  const ids = Object.keys(design.nodes).filter((id) => registry.get(design.nodes[id]!.type)?.container === undefined)
  if (ids.length === 0) return design

  // 1. Find the edges that close cycles (back edges of a DFS that starts at the sources) and set them aside.
  const succ = new Map<NodeId, Array<NodeId>>(ids.map((id) => [id, []]))
  for (const id of ids) for (const e of Topology.outgoing(top, id)) succ.get(id)!.push(e.to)
  const color = new Map<NodeId, 0 | 1 | 2>()
  const forward = new Map<NodeId, Array<NodeId>>(ids.map((id) => [id, []]))
  const visit = (root: NodeId) => {
    // Iterative DFS so a long chain can't overflow the stack.
    const stack: Array<{ id: NodeId; next: number }> = [{ id: root, next: 0 }]
    color.set(root, 1)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const children = succ.get(frame.id)!
      if (frame.next >= children.length) {
        color.set(frame.id, 2)
        stack.pop()
        continue
      }
      const child = children[frame.next++]!
      const state = color.get(child) ?? 0
      if (state === 1) continue // back edge: closes a cycle
      forward.get(frame.id)!.push(child)
      if (state === 0) {
        color.set(child, 1)
        stack.push({ id: child, next: 0 })
      }
    }
  }
  const sources = Topology.sources(top)
  const roots = [...sources, ...ids.filter((id) => !sources.includes(id) && Topology.incoming(top, id).length === 0), ...ids]
  for (const root of roots) if ((color.get(root) ?? 0) === 0) visit(root)

  // 2. Longest-path columns over the resulting DAG, using Graph's topological walk.
  const dag = Graph.directed<NodeId, null>((g) => {
    const index = new Map<NodeId, number>(ids.map((id) => [id, Graph.addNode(g, id)]))
    for (const [from, tos] of forward) for (const to of tos) Graph.addEdge(g, index.get(from)!, index.get(to)!, null)
  })
  const column = new Map<NodeId, number>(ids.map((id) => [id, 0]))
  for (const [, id] of Graph.topo(dag)) {
    for (const to of forward.get(id)!) column.set(to, Math.max(column.get(to)!, column.get(id)! + 1))
  }

  // 3. Order each column: a few barycenter sweeps to untangle crossings.
  const columns: Array<Array<NodeId>> = []
  for (const id of ids) (columns[column.get(id)!] ??= []).push(id)
  const rank = new Map<NodeId, number>()
  const reindex = () => columns.forEach((col) => col?.forEach((id, i) => rank.set(id, i)))
  reindex()
  const pred = new Map<NodeId, Array<NodeId>>(ids.map((id) => [id, []]))
  for (const [from, tos] of forward) for (const to of tos) pred.get(to)!.push(from)
  const bary = (id: NodeId, neighbours: ReadonlyArray<NodeId>) =>
    neighbours.length === 0 ? rank.get(id)! : neighbours.reduce((s, n) => s + rank.get(n)!, 0) / neighbours.length
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let c = 1; c < columns.length; c++) {
      columns[c]?.sort((a, b) => bary(a, pred.get(a)!) - bary(b, pred.get(b)!))
      reindex()
    }
    for (let c = columns.length - 2; c >= 0; c--) {
      columns[c]?.sort((a, b) => bary(a, forward.get(a)!) - bary(b, forward.get(b)!))
      reindex()
    }
  }

  // 4. Coordinates, with each column centred on the tallest one.
  const tallest = Math.max(...columns.map((c) => c?.length ?? 0))
  const nodes = { ...design.nodes }
  columns.forEach((col, c) => {
    if (col === undefined) return
    const offset = ((tallest - col.length) * rowHeight) / 2
    col.forEach((id, row) => {
      const node = nodes[id]!
      if (options.all === true || node.position === undefined) {
        nodes[id] = { ...node, position: { x: origin.x + c * columnWidth, y: origin.y + offset + row * rowHeight } }
      }
    })
  })
  return { ...design, nodes }
}


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
