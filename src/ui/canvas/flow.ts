import { Connector, Design } from "#simulator"
import type { Edge, Node } from "@xyflow/react"
import type { ComponentManifest, ConnectorManifest, Doc, NodeDoc } from "../state/types.ts"
import type { Selection } from "../state/document.ts"
import { connectorOf, registry } from "../state/engine.ts"
import { NODE_W, nodeHeight } from "./geometry.ts"
import { containersByDepth, GROUP_DEFAULT, isContainer, regionOf } from "./groups.ts"
import type { Focus } from "./path.ts"

/**
 * The design as React Flow sees it. The document stays the source of truth: these nodes and edges are derived from it
 * on every change, and what React Flow reports back (a drag, a resize, a new wire) is turned into document edits.
 *
 * Derived objects are reused while nothing they are made from has changed, because React Flow re-renders a node or an
 * edge whose object is new: dragging one node must not redraw the other eighty.
 */

export type Level = "error" | "warning" | "info" | undefined

export type ComponentData = {
  readonly spec: NodeDoc
  readonly manifest: ComponentManifest | undefined
  /** Whether it is on the path through the selection; undefined when nothing is in focus. */
  readonly path: boolean | undefined
  /** Worst design diagnostic on it. */
  readonly level: Level
}

export type ContainerData = {
  readonly spec: NodeDoc
  readonly manifest: ComponentManifest | undefined
  /** The placement (`aws:us-east-1`) the box draws, so regional faults show on it. */
  readonly placement: string | undefined
  /** Short description under the name: the region, the address block. */
  readonly detail: string
  readonly level: Level
}

export type TrafficData = {
  readonly label: string | undefined
  /** What sits between the two nodes when it is more than a plain link: drawn as a badge on the line. */
  readonly connector: ConnectorManifest | undefined
  readonly path: boolean | undefined
}

export type ComponentNode = Node<ComponentData, "component">
export type ContainerNode = Node<ContainerData, "container">
export type FlowNode = ComponentNode | ContainerNode
export type FlowEdge = Edge<TrafficData, "traffic">

/** Containers sit behind the wires, and the wires behind the components. */
export const Z = { container: 0, edge: 1, component: 2 } as const

export interface Measured {
  readonly width: number
  readonly height: number
}

/** A cache of derived objects by id: an object is reused while every one of its inputs is the same as last time. */
export const memo = <T>() => {
  let previous = new Map<string, { readonly deps: ReadonlyArray<unknown>; readonly value: T }>()
  let next = new Map<string, { readonly deps: ReadonlyArray<unknown>; readonly value: T }>()
  return {
    get: (id: string, deps: ReadonlyArray<unknown>, make: () => T): T => {
      const hit = previous.get(id)
      const value = hit !== undefined && hit.deps.length === deps.length && hit.deps.every((d, i) => Object.is(d, deps[i])) ? hit.value : make()
      next.set(id, { deps, value })
      return value
    },
    /** Forget whatever wasn't asked for since the last call. */
    sweep: () => {
      previous = next
      next = new Map()
    }
  }
}

export interface NodeInputs {
  readonly design: Doc
  readonly manifests: Readonly<Record<string, ComponentManifest>>
  readonly selection: Selection | undefined
  readonly focus: Focus | undefined
  readonly levels: Readonly<Record<string, Level>>
  readonly measured: ReadonlyMap<string, Measured>
}

/** Containers first (outermost first, so nested boxes draw over their parents), then the components. */
export const nodesOf = (inputs: NodeInputs, cache: ReturnType<typeof memo<FlowNode>>): Array<FlowNode> => {
  const { design, manifests, selection, focus, levels, measured } = inputs
  const out: Array<FlowNode> = []
  for (const id of containersByDepth(design, manifests)) {
    const spec = design.nodes[id]!
    const manifest = manifests[spec.type]
    const { region } = regionOf(design, manifests, (p) => registry.provider(p)?.defaultRegion, id)
    const selected = selection?.kind === "node" && selection.id === id
    out.push(
      cache.get(id, [spec, manifest, region, selected, levels[id], measured.get(id)], (): ContainerNode => {
        const provider = registry.provider(manifest?.provider ?? "")
        const regionName = provider?.regions.find((r) => r.id === region)?.name
        const detail = manifest?.container?.decidesRegion
          ? `${region ?? "?"}${regionName === undefined ? "" : ` · ${regionName}`}`
          : `${region ?? ""} · IPv4 /${(spec.settings as { cidrPrefix?: number } | undefined)?.cidrPrefix ?? 16}`
        const size = spec.size ?? GROUP_DEFAULT
        return {
          id,
          type: "container",
          position: spec.position ?? { x: 0, y: 0 },
          width: size.w,
          height: size.h,
          ...(measured.has(id) ? { measured: measured.get(id)! } : {}),
          zIndex: Z.container,
          selected,
          // Only the title bar picks a box up; the middle stays canvas, to pan on and to drop things into.
          dragHandle: ".group-head",
          connectable: false,
          data: {
            spec,
            manifest,
            placement: manifest === undefined || region === undefined ? undefined : `${manifest.provider}:${region}`,
            detail,
            level: levels[id]
          }
        }
      })
    )
  }
  for (const [id, spec] of Object.entries(design.nodes)) {
    const manifest = manifests[spec.type]
    if (isContainer(manifest)) continue
    const selected = selection?.kind === "node" && selection.id === id
    const path = focus === undefined ? undefined : focus.nodes.has(id)
    out.push(
      cache.get(id, [spec, manifest, selected, path, levels[id], measured.get(id)], (): ComponentNode => ({
        id,
        type: "component",
        position: spec.position ?? { x: 0, y: 0 },
        width: NODE_W,
        height: nodeHeight(manifest),
        ...(measured.has(id) ? { measured: measured.get(id)! } : {}),
        zIndex: Z.component,
        selected,
        data: { spec, manifest, path, level: levels[id] }
      }))
    )
  }
  cache.sweep()
  return out
}

export interface EdgeInputs {
  readonly design: Doc
  readonly selection: Selection | undefined
  readonly focus: Focus | undefined
}

export const edgesOf = (inputs: EdgeInputs, cache: ReturnType<typeof memo<FlowEdge>>): Array<FlowEdge> => {
  const { design, selection, focus } = inputs
  const out: Array<FlowEdge> = []
  for (const [id, edge] of Object.entries(design.edges)) {
    const from = design.nodes[edge.from.node]
    const to = design.nodes[edge.to]
    if (from === undefined || to === undefined) continue
    const selected = selection?.kind === "edge" && selection.id === id
    const path = focus === undefined ? undefined : focus.edges.has(id)
    out.push(
      cache.get(id, [edge, from.type, to.type, selected, path], (): FlowEdge => {
        const port = Design.portOf(edge)
        // Anything but a plain link is something between the two nodes, drawn on the line.
        const between = connectorOf({ type: from.type, port }, to.type, edge.connector)?.connector
        return {
          id,
          type: "traffic",
          source: edge.from.node,
          sourceHandle: port,
          target: edge.to,
          targetHandle: "in",
          zIndex: Z.edge,
          selected,
          data: { label: edge.name, connector: between === undefined || Connector.isPlain(between.type) ? undefined : between, path }
        }
      })
    )
  }
  cache.sweep()
  return out
}
