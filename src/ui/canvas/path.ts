import type { Selection } from "../state/document.ts"
import type { Doc } from "../state/types.ts"

/** What is on the path through the selection: everything upstream that can send work to it and everything downstream it can reach. */
export interface Focus {
  readonly nodes: ReadonlySet<string>
  readonly edges: ReadonlySet<string>
}

type Edges = Doc["edges"]

const reach = (edges: Edges, start: string, direction: "forward" | "backward"): Set<string> => {
  const next = new Map<string, Array<string>>()
  for (const edge of Object.values(edges)) {
    const [from, to] = direction === "forward" ? [edge.from.node, edge.to] : [edge.to, edge.from.node]
    const list = next.get(from)
    if (list === undefined) next.set(from, [to])
    else list.push(to)
  }
  const seen = new Set([start])
  const queue = [start]
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const n of next.get(id) ?? []) {
      if (!seen.has(n)) {
        seen.add(n)
        queue.push(n)
      }
    }
  }
  return seen
}

/**
 * The path a node or connection is part of. An edge is on it when it leads into something upstream (or the selection
 * itself) or leaves something downstream; a branch off an upstream node that never reaches the selection is not.
 * Undefined when there is nothing to show: no selection, or a node with no connections (a container, a lone node).
 */
export const pathThrough = (edges: Edges, selection: Selection | undefined): Focus | undefined => {
  if (selection === undefined) return undefined
  let head: string
  let tail: string
  if (selection.kind === "node") {
    const connected = Object.values(edges).some((e) => e.from.node === selection.id || e.to === selection.id)
    if (!connected) return undefined
    head = tail = selection.id
  } else {
    const edge = edges[selection.id]
    if (edge === undefined) return undefined
    head = edge.from.node
    tail = edge.to
  }
  const upstream = reach(edges, head, "backward")
  const downstream = reach(edges, tail, "forward")
  const onPath = new Set<string>()
  for (const [id, edge] of Object.entries(edges)) {
    if (id === selection.id || upstream.has(edge.to) || downstream.has(edge.from.node)) onPath.add(id)
  }
  return { nodes: new Set([...upstream, ...downstream]), edges: onPath }
}
