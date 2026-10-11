import { Design } from "#simulator"
import type { ComponentManifest, Doc, NodeDoc } from "../state/types.ts"
import { NODE_W, nodeHeight } from "./geometry.ts"

/**
 * Containers (an AWS region, a VPC) are boxes drawn round the nodes that sit inside them. Which box a node is in is
 * recorded as its `parent`; the box itself is just a node with a size. This file holds the geometry and rules.
 */

type Manifests = Readonly<Record<string, ComponentManifest>>

export const GROUP_DEFAULT = { w: 560, h: 340 } as const
export const GROUP_MIN = { w: 260, h: 160 } as const
export const GROUP_HEAD_H = 38
const PAD = 28

export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export const isContainer = (manifest: ComponentManifest | undefined): boolean => manifest?.container !== undefined

export const rectOf = (node: NodeDoc, manifest: ComponentManifest | undefined): Rect => {
  const at = node.position ?? { x: 0, y: 0 }
  if (isContainer(manifest)) return { x: at.x, y: at.y, w: node.size?.w ?? GROUP_DEFAULT.w, h: node.size?.h ?? GROUP_DEFAULT.h }
  return { x: at.x, y: at.y, w: NODE_W, h: nodeHeight(manifest) }
}

/** The node and everything inside it, however deep. */
export const withDescendants = (doc: Doc, id: string): ReadonlyArray<string> => {
  const out = [id]
  for (let i = 0; i < out.length; i++) {
    for (const [other, node] of Object.entries(doc.nodes)) if (node.parent === out[i] && !out.includes(other)) out.push(other)
  }
  return out
}

/** How many containers deep a node sits: 0 on the open canvas. */
export const depthOf = (doc: Doc, id: string): number => Design.ancestors(doc, id).length

/** Whether `type` may sit in the container at `candidate`, counting what the container sits in. */
const fits = (doc: Doc, manifests: Manifests, type: string, candidate: string): boolean => {
  const holder = doc.nodes[candidate]
  const box = holder === undefined ? undefined : manifests[holder.type]?.container
  if (box === undefined || !box.accepts.includes(type)) return false
  const within = manifests[type]?.within
  if (within === undefined) return true
  return [candidate, ...Design.ancestors(doc, candidate)].some((id) => within.includes(doc.nodes[id]?.type ?? ""))
}

/** The innermost container whose box holds the point and which would accept this node. */
export const containerAt = (doc: Doc, manifests: Manifests, id: string, point: { readonly x: number; readonly y: number }): string | undefined => {
  const type = doc.nodes[id]?.type
  if (type === undefined) return undefined
  const inside = new Set(withDescendants(doc, id))
  let best: { id: string; depth: number } | undefined
  for (const [candidate, node] of Object.entries(doc.nodes)) {
    if (inside.has(candidate) || !isContainer(manifests[node.type])) continue
    const r = rectOf(node, manifests[node.type])
    if (point.x < r.x || point.x > r.x + r.w || point.y < r.y || point.y > r.y + r.h) continue
    if (!fits(doc, manifests, type, candidate)) continue
    const depth = depthOf(doc, candidate)
    if (best === undefined || depth > best.depth) best = { id: candidate, depth }
  }
  return best?.id
}

/** Containers outermost first, so inner boxes paint over outer ones. */
export const containersByDepth = (doc: Doc, manifests: Manifests): ReadonlyArray<string> =>
  Object.keys(doc.nodes)
    .filter((id) => isContainer(manifests[doc.nodes[id]!.type]))
    .sort((a, b) => depthOf(doc, a) - depthOf(doc, b))

/**
 * Resize every container to hug what is inside it (with room for its title), innermost first. Used after a tidy
 * layout, which moves nodes but leaves boxes where they were.
 */
export const fitGroups = (doc: Doc, manifests: Manifests): Doc => {
  let next = doc
  const boxes = containersByDepth(doc, manifests).slice().reverse()
  for (const id of boxes) {
    const children = Object.entries(next.nodes).filter(([, n]) => n.parent === id)
    if (children.length === 0) continue
    const rects = children.map(([, n]) => rectOf(n, manifests[n.type]))
    const minX = Math.min(...rects.map((r) => r.x)) - PAD
    const minY = Math.min(...rects.map((r) => r.y)) - PAD - GROUP_HEAD_H
    const maxX = Math.max(...rects.map((r) => r.x + r.w)) + PAD
    const maxY = Math.max(...rects.map((r) => r.y + r.h)) + PAD
    next = Design.patchNode(next, id, { position: { x: minX, y: minY }, size: { w: Math.max(GROUP_MIN.w, maxX - minX), h: Math.max(GROUP_MIN.h, maxY - minY) } })
  }
  return next
}

/** The region a node runs in and, when a container decides it, which one. */
export const regionOf = (
  doc: Doc,
  manifests: Manifests,
  defaults: (provider: string) => string | undefined,
  id: string
): { readonly region: string | undefined; readonly decidedBy: string | undefined } => {
  const node = doc.nodes[id]
  if (node === undefined) return { region: undefined, decidedBy: undefined }
  for (const holder of [id, ...Design.ancestors(doc, id)]) {
    const spec = doc.nodes[holder]
    if (spec === undefined || !manifests[spec.type]?.container?.decidesRegion) continue
    const region = (spec.settings as { region?: unknown } | undefined)?.region
    return { region: typeof region === "string" ? region : "us-east-1", decidedBy: holder === id ? undefined : holder }
  }
  const provider = manifests[node.type]?.provider
  return { region: node.region ?? (provider === undefined ? undefined : defaults(provider)), decidedBy: undefined }
}
