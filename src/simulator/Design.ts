import { Effect, Graph, Option, Result, Schema, SchemaAST, SchemaIssue, SchemaTransformation } from "effect"
import type { AnyComponent, PortDefs } from "./Component.ts"
import * as Connector from "./Connector.ts"
import type { AnyConnector } from "./Connector.ts"
import { type AnyController, fits as controllerFits } from "./Controller.ts"
import type { Diagnostic } from "./Diagnostic.ts"
import { keyOf, oneWayLatencyMs, type Placement } from "./Provider.ts"
import type { Components } from "./Registry.ts"
import type { Topology } from "./Topology.ts"
import * as ScenarioSpec from "./ScenarioSpec.ts"

/**
 * A design has two forms, joined by a codec.
 *
 *  - `Doc` is what lives on disk: plain JSON, string-keyed so it diffs cleanly and an importer can re-run and
 *    merge by id. Settings hold only the overrides someone chose; anything absent takes the component's default.
 *  - `Design` is what runs: a `Graph` of configured components, every setting decoded and validated against its
 *    component's `Schema`, defaults filled in, durations real `Duration`s.
 *
 * `codec(registry)` is the `Schema` between them. It reports every problem in one pass, each located by id
 * (`nodes.worker.settings.concurrency`), and it composes with `Schema.fromJsonString`.
 */

// ---------------------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------------------

export const Position = Schema.Struct({ x: Schema.Finite, y: Schema.Finite })

/** Where a node or edge came from when it was imported, so a re-import can find and merge it. */
export const Origin = Schema.Struct({
  source: Schema.String,
  ref: Schema.String,
  type: Schema.optionalKey(Schema.String)
})

export const NodeDoc = Schema.Struct({
  type: Schema.String,
  name: Schema.optionalKey(Schema.String),
  /** The provider's region it runs in. Absent means the provider's default. */
  region: Schema.optionalKey(Schema.String),
  /** The container (region, VPC) this sits inside. Absent means it sits on the open canvas. */
  parent: Schema.optionalKey(Schema.String),
  /** Absent means "lay me out": imported designs have no coordinates. */
  position: Schema.optionalKey(Position),
  /** Containers are drawn as boxes of this size, in canvas units. */
  size: Schema.optionalKey(Schema.Struct({ w: Schema.Finite, h: Schema.Finite })),
  settings: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  origin: Schema.optionalKey(Origin)
})

export const EdgeDoc = Schema.Struct({
  from: Schema.Struct({ node: Schema.String, port: Schema.optionalKey(Schema.String) }),
  to: Schema.String,
  /** What sits on the edge (`core.poller`, `aws.sqs.event-source-mapping`...). Absent means the most specific one that fits. */
  connector: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  settings: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  origin: Schema.optionalKey(Origin)
})

/** A controller attached to a node: an autoscaler, say. Its settings hold only the overrides someone chose. */
export const ControllerDoc = Schema.Struct({
  type: Schema.String,
  /** The node it controls. */
  target: Schema.String,
  name: Schema.optionalKey(Schema.String),
  settings: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
})

export const Doc = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.optionalKey(Schema.String),
  /** What the design is for. The first paragraph is its short blurb; the rest is detail (assumptions, what is left out). */
  description: Schema.optionalKey(Schema.String),
  /** Seed for the run: the same design and seed always play out identically. */
  seed: Schema.optionalKey(Schema.Int),
  /**
   * Account-level quotas by placement (`aws:us-east-1`): the limits shared by everything in that account and region.
   * Only what someone changed; the rest takes the provider's published default.
   */
  accounts: Schema.optionalKey(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
  nodes: Schema.Record(Schema.String, NodeDoc),
  edges: Schema.Record(Schema.String, EdgeDoc),
  /** Loops that watch nodes and change them while the design runs, by id. */
  controllers: Schema.optionalKey(Schema.Record(Schema.String, ControllerDoc)),
  /**
   * What happens to this design, by id: the scenarios written for it (a peak, a lost region), each with its timeline and
   * the checks that must hold (`ScenarioSpec.ts`). They travel with the design because they name its nodes.
   */
  scenarios: Schema.optionalKey(Schema.Record(Schema.String, ScenarioSpec.Spec))
})

export type Position = typeof Position.Type
export type Origin = typeof Origin.Type
export type NodeDoc = typeof NodeDoc.Type
export type EdgeDoc = typeof EdgeDoc.Type
export type ControllerDoc = typeof ControllerDoc.Type
export type Doc = typeof Doc.Type
export type NodeId = string
export type EdgeId = string

export const DEFAULT_PORT = "out"

export const empty = (name?: string): Doc => ({ version: 1, ...(name === undefined ? {} : { name }), nodes: {}, edges: {} })

export const portOf = (edge: EdgeDoc): string => edge.from.port ?? DEFAULT_PORT

export type ParseResult = { readonly ok: true; readonly doc: Doc } | { readonly ok: false; readonly issues: ReadonlyArray<string> }

/** Validate untrusted JSON (a loaded file, local storage, a paste) as a document. Settings are checked later, per component. */
export const parse = (input: unknown): ParseResult => {
  try {
    return { ok: true, doc: Schema.decodeUnknownSync(Doc)(input) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, issues: message.split("\n").map((s) => s.trim()).filter(Boolean) }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Pure edits on a document. Every function returns a new one; nothing is mutated.
// ---------------------------------------------------------------------------------------------------------

export const slug = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "node"

/** `base`, then `base-2`, `base-3`, ... whichever is free. */
export const uniqueId = (taken: (id: string) => boolean, base: string): string => {
  if (!taken(base)) return base
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`
}

export interface NewNode {
  readonly id?: NodeId
  readonly type: string
  readonly name?: string
  readonly region?: string
  readonly parent?: NodeId
  readonly size?: { readonly w: number; readonly h: number }
  readonly position?: Position
  readonly settings?: Readonly<Record<string, unknown>>
  readonly origin?: Origin
}

export const addNode = (doc: Doc, node: NewNode): { readonly doc: Doc; readonly id: NodeId } => {
  const id = node.id !== undefined && !(node.id in doc.nodes)
    ? node.id
    : uniqueId((candidate) => candidate in doc.nodes, slug(node.id ?? node.name ?? node.type))
  const { id: _, ...spec } = node
  return { id, doc: { ...doc, nodes: { ...doc.nodes, [id]: spec } } }
}

export const patchNode = (doc: Doc, id: NodeId, patch: Partial<NodeDoc>): Doc => {
  const node = doc.nodes[id]
  return node === undefined ? doc : { ...doc, nodes: { ...doc.nodes, [id]: { ...node, ...patch } } }
}

export const moveNode = (doc: Doc, id: NodeId, position: Position): Doc => patchNode(doc, id, { position })

const setIn = (target: Readonly<Record<string, unknown>>, path: ReadonlyArray<string>, value: unknown): Record<string, unknown> => {
  const [head, ...rest] = path
  if (head === undefined) return { ...target }
  const next: Record<string, unknown> = { ...target }
  if (rest.length === 0) {
    if (value === undefined) delete next[head]
    else next[head] = value
  } else {
    const child = setIn((target[head] as Record<string, unknown> | undefined) ?? {}, rest, value)
    if (Object.keys(child).length === 0) delete next[head]
    else next[head] = child
  }
  return next
}

/** Set one setting override on a node. Pass `undefined` to drop it and fall back to the default. */
export const setNodeSetting = (doc: Doc, id: NodeId, path: ReadonlyArray<string>, value: unknown): Doc => {
  const node = doc.nodes[id]
  return node === undefined ? doc : patchNode(doc, id, { settings: setIn(node.settings ?? {}, path, value) })
}

/** Set one account-level quota override for a placement such as `aws:us-east-1`. `undefined` drops it back to the provider's default. */
export const setAccountSetting = (doc: Doc, placement: string, path: ReadonlyArray<string>, value: unknown): Doc => {
  const next = setIn(doc.accounts?.[placement] ?? {}, path, value)
  const { [placement]: _old, ...others } = doc.accounts ?? {}
  const accounts = Object.keys(next).length === 0 ? others : { ...others, [placement]: next }
  const { accounts: _accounts, ...rest } = doc
  return Object.keys(accounts).length === 0 ? rest : { ...rest, accounts }
}

export const setEdgeSetting = (doc: Doc, id: EdgeId, path: ReadonlyArray<string>, value: unknown): Doc => {
  const edge = doc.edges[id]
  return edge === undefined ? doc : { ...doc, edges: { ...doc.edges, [id]: { ...edge, settings: setIn(edge.settings ?? {}, path, value) } } }
}

/** Remove a node and every edge touching it. */
export const removeNode = (doc: Doc, id: NodeId): Doc => {
  const { [id]: _removed, ...rest } = doc.nodes
  // What sat inside a removed container falls back onto the open canvas.
  const nodes = Object.fromEntries(
    Object.entries(rest).map(([k, n]) => {
      if (n.parent !== id) return [k, n]
      const { parent: _parent, ...free } = n
      return [k, free]
    })
  )
  const removed = { ...doc, nodes, edges: Object.fromEntries(Object.entries(doc.edges).filter(([, e]) => e.from.node !== id && e.to !== id)) }
  // A controller of a node that is gone has nothing to control.
  if (doc.controllers === undefined) return removed
  const controllers = Object.fromEntries(Object.entries(doc.controllers).filter(([, c]) => c.target !== id))
  return withControllers(removed, controllers)
}

const withControllers = (doc: Doc, controllers: Readonly<Record<string, ControllerDoc>>): Doc => {
  const { controllers: _old, ...rest } = doc
  return Object.keys(controllers).length === 0 ? rest : { ...rest, controllers }
}

export interface NewController {
  readonly id?: string
  readonly type: string
  readonly target: NodeId
  readonly name?: string
  readonly settings?: Readonly<Record<string, unknown>>
}

/** Attach a controller to a node. Its id is `<target>.<kind>` unless given, made unique among controllers. */
export const addController = (doc: Doc, controller: NewController): { readonly doc: Doc; readonly id: string } => {
  const taken = doc.controllers ?? {}
  const kind = controller.type.slice(controller.type.lastIndexOf(".") + 1)
  const id = uniqueId((candidate) => candidate in taken, controller.id ?? `${controller.target}.${kind}`)
  const { id: _, ...spec } = controller
  return { id, doc: withControllers(doc, { ...taken, [id]: spec }) }
}

export const removeController = (doc: Doc, id: string): Doc => {
  if (doc.controllers?.[id] === undefined) return doc
  const { [id]: _removed, ...rest } = doc.controllers
  return withControllers(doc, rest)
}

/** Set one setting override on a controller. Pass `undefined` to drop it and fall back to the default. */
export const setControllerSetting = (doc: Doc, id: string, path: ReadonlyArray<string>, value: unknown): Doc => {
  const controller = doc.controllers?.[id]
  return controller === undefined ? doc : withControllers(doc, { ...doc.controllers, [id]: { ...controller, settings: setIn(controller.settings ?? {}, path, value) } })
}

/** Put a node inside a container, or take it out with `undefined`. Placement is checked when the document is resolved. */
export const setParent = (doc: Doc, id: NodeId, parent: NodeId | undefined): Doc => {
  const node = doc.nodes[id]
  if (node === undefined || node.parent === parent) return doc
  const { parent: _old, ...rest } = node
  return { ...doc, nodes: { ...doc.nodes, [id]: parent === undefined ? rest : { ...rest, parent } } }
}

/** The containers above a node, nearest first. Stops if the chain loops. */
export const ancestors = (doc: Doc, id: NodeId): ReadonlyArray<NodeId> => {
  const out: Array<NodeId> = []
  for (let at = doc.nodes[id]?.parent; at !== undefined && !out.includes(at) && at !== id; at = doc.nodes[at]?.parent) out.push(at)
  return out
}

export interface NewEdge {
  readonly id?: EdgeId
  readonly from: { readonly node: NodeId; readonly port?: string }
  readonly to: NodeId
  readonly connector?: string
  readonly name?: string
  readonly settings?: Readonly<Record<string, unknown>>
  readonly origin?: Origin
}

export const edgeIdFor = (from: { readonly node: NodeId; readonly port?: string }, to: NodeId): EdgeId =>
  `${from.node}.${from.port ?? DEFAULT_PORT}->${to}`

export const connect = (doc: Doc, edge: NewEdge): { readonly doc: Doc; readonly id: EdgeId } => {
  const id = uniqueId((candidate) => candidate in doc.edges, edge.id ?? edgeIdFor(edge.from, edge.to))
  const { id: _, from, ...rest } = edge
  const spec: EdgeDoc = { ...rest, from: { node: from.node, ...(from.port === undefined ? {} : { port: from.port }) } }
  return { id, doc: { ...doc, edges: { ...doc.edges, [id]: spec } } }
}

/** Name the connector an edge uses, or with `undefined` go back to the one that fits best. Its settings are kept. */
export const setConnector = (doc: Doc, id: EdgeId, connector: string | undefined): Doc => {
  const edge = doc.edges[id]
  if (edge === undefined || edge.connector === connector) return doc
  const { connector: _old, ...rest } = edge
  return { ...doc, edges: { ...doc.edges, [id]: connector === undefined ? rest : { ...rest, connector } } }
}

export const removeEdge = (doc: Doc, id: EdgeId): Doc => {
  const { [id]: _removed, ...edges } = doc.edges
  return { ...doc, edges }
}

// ---------------------------------------------------------------------------------------------------------
// The configured design
// ---------------------------------------------------------------------------------------------------------

/** A component instance's place in the design, with its settings decoded. */
export interface Node {
  readonly id: NodeId
  readonly type: string
  readonly name: string
  readonly position?: Position
  readonly origin?: Origin
  readonly placement: Placement
  /** The container it sits inside, if any. */
  readonly parent?: NodeId
  readonly size?: { readonly w: number; readonly h: number }
  readonly component: AnyComponent
  /** Decoded against the component's schema: defaults filled in, durations as `Duration`. */
  readonly config: unknown
}

export interface Edge {
  readonly id: EdgeId
  readonly from: NodeId
  /** The output port it leaves from. */
  readonly port: string
  readonly to: NodeId
  readonly name?: string
  readonly origin?: Origin
  /** What sits on the edge. */
  readonly connector: AnyConnector
  /** Whether the document named the connector, rather than leaving it to inference. */
  readonly explicit: boolean
  /** The edge's settings schema: the port's own fields, the connector's, transport's. */
  readonly schema: Connector.Settings
  /** Decoded against `schema`. */
  readonly config: unknown
}

/** A placement's account-level quotas, decoded. */
export interface Account {
  readonly placement: Placement
  readonly config: unknown
}

/** A controller attached to a node, with its settings decoded. */
export interface Controller {
  readonly id: string
  readonly type: string
  readonly name: string
  readonly target: NodeId
  readonly def: AnyController
  readonly config: unknown
}

export interface Design extends Topology<Node, Edge> {
  readonly name?: string
  readonly description?: string
  readonly seed: number
  /** Account quotas for every placement the design uses, by placement key. */
  readonly accounts: ReadonlyMap<string, Account>
  /** The controllers, by id. */
  readonly controllers: ReadonlyMap<string, Controller>
}

const issuesOf = (error: unknown): ReadonlyArray<string> => {
  if (!Schema.isSchemaError(error)) return [error instanceof Error ? error.message : String(error)]
  const formatted = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues
  return formatted.map((i) => {
    const path = (i.path ?? []).map((p) => String(typeof p === "object" ? p.key : p)).join(".")
    return path === "" ? i.message : `${path}: ${i.message}`
  })
}

const decodeSettings = (schema: Schema.Top, settings: Readonly<Record<string, unknown>> | undefined) =>
  Schema.decodeUnknownResult(schema as Schema.Decoder<unknown>)(settings ?? {})

export interface Resolution {
  readonly design: Design | undefined
  /** Everything wrong with the document: every problem, not just the first. */
  readonly diagnostics: ReadonlyArray<Diagnostic>
}

/**
 * Decode a document against a registry. Every node's settings are validated by its component's schema, every
 * edge by the universal edge policy plus its port's settings, and the wiring is checked. If anything is wrong
 * the result carries diagnostics and no design.
 */
export const resolve = (doc: Doc, registry: Components): Resolution => {
  const diagnostics: Array<Diagnostic> = []
  const label = (id: NodeId) => doc.nodes[id]?.name ?? id
  const error = (code: string, message: string, where: { node?: string; edge?: string; controller?: string }) =>
    void diagnostics.push({ level: "error", code, message, ...where })

  // Pass 1: every node's component and decoded settings.
  const decodedNodes = new Map<NodeId, { readonly spec: NodeDoc; readonly component: AnyComponent; readonly config: unknown }>()
  for (const [id, spec] of Object.entries(doc.nodes)) {
    const component = registry.get(spec.type)
    if (component === undefined) {
      error("unknown-component", `${label(id)}: unknown component type "${spec.type}"`, { node: id })
      continue
    }
    const decoded = decodeSettings(component.config, spec.settings)
    if (Result.isFailure(decoded)) {
      error("bad-settings", `${label(id)}: ${issuesOf(decoded.failure).join("; ")}`, { node: id })
      continue
    }
    decodedNodes.set(id, { spec, component, config: decoded.success })
  }

  // Pass 2: containers decide where their contents run.
  const nodes = new Map<NodeId, Node>()
  for (const [id, { spec, component, config }] of decodedNodes) {
    const provider = registry.provider(component.provider)
    let parent: NodeId | undefined
    let inherited: string | undefined
    let placeable = true
    if (spec.parent !== undefined) {
      const above = decodedNodes.get(spec.parent)
      const chain = ancestors(doc, id)
      if (above === undefined || above.component.container === undefined) {
        error("bad-parent", `${label(id)}: ${label(spec.parent)} is not a container`, { node: id })
        placeable = false
      } else if (!above.component.container.accepts(component)) {
        error("not-accepted", `${label(id)} can't sit inside ${label(spec.parent)} (${above.component.title})`, { node: id })
        placeable = false
      } else if (chain.includes(id) || spec.parent === id) {
        error("container-cycle", `${label(id)} is inside itself`, { node: id })
        placeable = false
      } else {
        parent = spec.parent
        for (const ancestorId of chain) {
          const decide = decodedNodes.get(ancestorId)
          const region = decide?.component.container?.region?.(decide.config)
          if (region !== undefined) {
            inherited = region
            break
          }
        }
      }
    }
    if (placeable && component.within !== undefined) {
      const holder = parent === undefined ? undefined : decodedNodes.get(parent)
      const ok = holder !== undefined && (component.within.includes(holder.component.type) || ancestors(doc, id).some((a) => component.within!.includes(decodedNodes.get(a)?.component.type ?? "")))
      if (!ok) {
        error("outside-container", `${label(id)} has to be placed inside a ${component.within.map((t) => registry.get(t)?.title ?? t).join(" or ")}`, { node: id })
        placeable = false
      }
    }
    if (!placeable) continue
    // A container that decides the region decides it for itself too; otherwise the nearest one above, then the node's own setting.
    const own = component.container?.region?.(config)
    if (own === undefined && inherited !== undefined && spec.region !== undefined && spec.region !== inherited) {
      error("region-mismatch", `${label(id)} is set to ${spec.region} but sits inside a container in ${inherited}`, { node: id })
      continue
    }
    const region = own ?? inherited ?? spec.region ?? provider?.defaultRegion
    if (provider === undefined || region === undefined || !provider.regions.some((r) => r.id === region)) {
      error("unknown-region", `${label(id)}: "${region ?? "?"}" is not a region of ${provider?.title ?? component.provider}`, { node: id })
      continue
    }
    nodes.set(id, {
      id,
      type: spec.type,
      name: spec.name ?? id,
      placement: { provider: component.provider, region },
      ...(parent === undefined ? {} : { parent }),
      ...(spec.size === undefined ? {} : { size: spec.size }),
      ...(spec.position === undefined ? {} : { position: spec.position }),
      ...(spec.origin === undefined ? {} : { origin: spec.origin }),
      component,
      config
    })
  }

  const edges: Array<Edge> = []
  const perPort = new Map<string, number>()
  for (const [id, spec] of Object.entries(doc.edges)) {
    const fromSpec = doc.nodes[spec.from.node]
    const toSpec = doc.nodes[spec.to]
    if (fromSpec === undefined || toSpec === undefined) {
      error("dangling-edge", `Edge ${id} connects to a node that doesn't exist`, { edge: id })
      continue
    }
    const source = registry.get(fromSpec.type)
    const target = registry.get(toSpec.type)
    const port = portOf(spec)
    const def = source === undefined ? undefined : (source.ports as PortDefs)[port]
    if (source !== undefined && def === undefined) {
      error("unknown-port", `${label(spec.from.node)} has no "${port}" output`, { edge: id })
      continue
    }
    if (def !== undefined) {
      const key = `${spec.from.node}:${port}`
      const count = (perPort.get(key) ?? 0) + 1
      perPort.set(key, count)
      if (!def.many && count > 1) error("port-single", `${label(spec.from.node)}'s "${port}" output takes a single connection`, { edge: id })
    }
    if (target !== undefined && !target.inputs) {
      error("no-input", `${label(spec.to)} is a traffic source and can't receive connections`, { edge: id })
      continue
    }
    // An unknown component is already reported; there is nothing to check the wire against.
    if (source === undefined || target === undefined || def === undefined) continue
    const picked = registry.connectorFor({ type: source.type, port }, target.type, spec.connector)
    if (!picked.ok) {
      error("bad-connector", `${label(spec.from.node)} → ${label(spec.to)}: ${picked.reason}`, { edge: id })
      continue
    }
    // Unless someone set it, the latency between two nodes is what their placements imply.
    const placed = nodes.get(spec.from.node)
    const there = nodes.get(spec.to)
    const regionOf = (p: Placement) => registry.provider(p.provider)?.regions.find((r) => r.id === p.region)
    const estimate = placed !== undefined && there !== undefined ? oneWayLatencyMs(placed.placement, there.placement, regionOf) : undefined
    const given = (spec.settings as { latency?: { mean?: unknown } } | undefined)?.latency
    const settings = estimate === undefined || given?.mean !== undefined
      ? spec.settings
      : { ...spec.settings, latency: { ...given, mean: Math.round(estimate * 10) / 10 } }
    const schema = Connector.edgeSchema(picked.connector, def)
    const decoded = decodeSettings(schema, settings)
    if (Result.isFailure(decoded)) {
      error("bad-edge-settings", `${label(spec.from.node)} → ${label(spec.to)}: ${issuesOf(decoded.failure).join("; ")}`, { edge: id })
      continue
    }
    edges.push({
      id,
      from: spec.from.node,
      port,
      to: spec.to,
      ...(spec.name === undefined ? {} : { name: spec.name }),
      ...(spec.origin === undefined ? {} : { origin: spec.origin }),
      connector: picked.connector,
      explicit: picked.explicit,
      schema,
      config: decoded.success
    })
  }

  // Controllers: a known type, a node it can control, settings it accepts and that make sense on that node.
  const controllers = new Map<string, Controller>()
  for (const [id, spec] of Object.entries(doc.controllers ?? {})) {
    const where = { controller: id, node: spec.target }
    const def = registry.controller(spec.type)
    if (def === undefined) {
      error("unknown-controller", `Controller ${id}: unknown controller type "${spec.type}"`, where)
      continue
    }
    const target = nodes.get(spec.target)
    if (target === undefined) {
      if (doc.nodes[spec.target] === undefined) error("controller-target", `Controller ${id} controls ${spec.target}, which doesn't exist`, where)
      continue
    }
    if (!controllerFits(def, target.type)) {
      error("controller-target", `${def.title} can't control ${label(spec.target)} (${target.component.title})`, where)
      continue
    }
    const decoded = decodeSettings(def.config, spec.settings)
    if (Result.isFailure(decoded)) {
      error("bad-controller-settings", `${def.title} on ${label(spec.target)}: ${issuesOf(decoded.failure).join("; ")}`, where)
      continue
    }
    const issues = def.check(target.component, decoded.success)
    for (const w of issues.filter((i) => i.level === "warning")) {
      diagnostics.push({ level: "warning", code: "controller-incomplete", message: `${def.title} on ${label(spec.target)} ${w.message}`, ...where })
    }
    const errors = issues.filter((i) => i.level === "error")
    if (errors.length > 0) {
      error("bad-controller-settings", `${def.title} on ${label(spec.target)}: ${errors.map((i) => i.message).join("; ")}`, where)
      continue
    }
    controllers.set(id, { id, type: spec.type, name: spec.name ?? `${def.title} of ${label(spec.target)}`, target: spec.target, def, config: decoded.success })
  }

  // Account quotas, for every placement in use.
  const accounts = new Map<string, Account>()
  for (const node of nodes.values()) {
    const key = keyOf(node.placement)
    if (accounts.has(key)) continue
    const provider = registry.provider(node.placement.provider)!
    const decoded = decodeSettings(provider.account(node.placement.region), doc.accounts?.[key])
    if (Result.isFailure(decoded)) {
      diagnostics.push({ level: "error", code: "bad-account", message: `${key}: ${issuesOf(decoded.failure).join("; ")}` })
    } else accounts.set(key, { placement: node.placement, config: decoded.success })
  }

  if (diagnostics.some((d) => d.level === "error")) return { design: undefined, diagnostics }

  const nodeIndex = new Map<NodeId, Graph.NodeIndex>()
  const edgeIndex = new Map<EdgeId, Graph.EdgeIndex>()
  const graph = Graph.directed<Node, Edge>((g) => {
    for (const node of nodes.values()) nodeIndex.set(node.id, Graph.addNode(g, node))
    for (const edge of edges) edgeIndex.set(edge.id, Graph.addEdge(g, nodeIndex.get(edge.from)!, nodeIndex.get(edge.to)!, edge))
  })
  return {
    design: { ...(doc.name === undefined ? {} : { name: doc.name }), ...(doc.description === undefined ? {} : { description: doc.description }), seed: doc.seed ?? 1, graph, nodeIndex, edgeIndex, accounts, controllers },
    diagnostics
  }
}

/** The document form of a configured design. Settings are written out in full, so the result stands on its own. */
export const encode = (design: Design, registry: Components): Doc => {
  const encodeConfig = (schema: Schema.Top, config: unknown) =>
    Schema.encodeSync(schema as Schema.Encoder<unknown>)(config) as Record<string, unknown>
  const nodes: Record<NodeId, NodeDoc> = {}
  for (const [, node] of Graph.nodes(design.graph)) {
    nodes[node.id] = {
      type: node.type,
      name: node.name,
      region: node.placement.region,
      ...(node.parent === undefined ? {} : { parent: node.parent }),
      ...(node.size === undefined ? {} : { size: node.size }),
      ...(node.position === undefined ? {} : { position: node.position }),
      settings: encodeConfig(node.component.config, node.config),
      ...(node.origin === undefined ? {} : { origin: node.origin })
    }
  }
  const edges: Record<EdgeId, EdgeDoc> = {}
  for (const [, edge] of Graph.edges(design.graph)) {
    const e = edge.data
    edges[e.id] = {
      from: { node: e.from, port: e.port },
      to: e.to,
      ...(e.explicit ? { connector: e.connector.type } : {}),
      ...(e.name === undefined ? {} : { name: e.name }),
      settings: encodeConfig(e.schema, e.config),
      ...(e.origin === undefined ? {} : { origin: e.origin })
    }
  }
  const accounts: Record<string, Record<string, unknown>> = {}
  for (const [key, account] of design.accounts) {
    const settings = account.config as Record<string, unknown>
    if (Object.keys(settings).length > 0) accounts[key] = encodeConfig(registry.provider(account.placement.provider)!.account(account.placement.region), settings)
  }
  const controllers: Record<string, ControllerDoc> = {}
  for (const [id, c] of design.controllers) {
    controllers[id] = { type: c.type, target: c.target, name: c.name, settings: encodeConfig(c.def.config, c.config) }
  }
  return {
    version: 1,
    ...(design.name === undefined ? {} : { name: design.name }),
    ...(design.description === undefined ? {} : { description: design.description }),
    seed: design.seed,
    ...(Object.keys(accounts).length === 0 ? {} : { accounts }),
    nodes,
    edges,
    ...(Object.keys(controllers).length === 0 ? {} : { controllers })
  }
}

// ---------------------------------------------------------------------------------------------------------
// The codec
// ---------------------------------------------------------------------------------------------------------

const DesignSchema = Schema.declare((u): u is Design => typeof u === "object" && u !== null && "graph" in u && "seed" in u)

/**
 * A `Schema` from the document form to a configured `Design`, and back.
 *
 *   const decode = Schema.decodeUnknownEffect(Design.codec(registry))
 *   const design = yield* decode(JSON.parse(text), { errors: "all" })
 *
 * Failures carry id-based paths for every problem found, e.g. `nodes.worker.settings.concurrency`.
 */
export const codec = (registry: Components): Schema.Codec<Design, typeof Doc.Encoded> =>
  Doc.pipe(
    Schema.decodeTo(
      DesignSchema,
      SchemaTransformation.transformEffect({
        decode: (doc: Doc) => {
          const { design, diagnostics } = resolve(doc, registry)
          if (design !== undefined) return Effect.succeed(design)
          const issues = diagnostics.map((d) =>
            new SchemaIssue.Pointer(
              d.controller !== undefined ? ["controllers", d.controller] : d.node !== undefined ? ["nodes", d.node] : d.edge !== undefined ? ["edges", d.edge] : [],
              new SchemaIssue.InvalidValue({ message: d.message })
            )
          )
          return Effect.fail(new SchemaIssue.Composite(SchemaAST.unknown, issues as never, Option.some(doc)))
        },
        encode: (design: Design) => Effect.succeed(encode(design, registry))
      })
    )
  ) as unknown as Schema.Codec<Design, typeof Doc.Encoded>
