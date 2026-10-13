/**
 * The machinery behind `Design.ts`: setting a value deep inside a settings object, and the two directions of the codec.
 * `resolve` decodes a document against a registry (every node's settings against its component, containers and
 * regions, every edge's connector and settings, controllers and account quotas), reporting every problem it finds;
 * `encode` writes a configured design back out as a document.
 */
import { Graph, Result, Schema, SchemaIssue } from "effect"
import type { AnyComponent, PortDefs } from "../Component.ts"
import * as Connector from "../Connector.ts"
import { fits as controllerFits } from "../Controller.ts"
import type { Account, Controller, ControllerDoc, Design, Doc, Edge, EdgeDoc, EdgeId, Node, NodeDoc, NodeId, Resolution } from "../Design.ts"
import type { Diagnostic } from "../Diagnostic.ts"
import { keyOf, oneWayLatencyMs, type Placement } from "../Provider.ts"
import type { Components } from "../Registry.ts"

/** The output port an edge leaves from when the document doesn't name one. */
export const DEFAULT_PORT = "out"

/** `target` with the value at `path` set, or dropped when `value` is `undefined`. Objects left empty are dropped too. */
export const setIn = (target: Readonly<Record<string, unknown>>, path: ReadonlyArray<string>, value: unknown): Record<string, unknown> => {
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

/** The containers above a node, nearest first. Stops if the chain loops. */
export const ancestors = (doc: Doc, id: NodeId): ReadonlyArray<NodeId> => {
  const out: Array<NodeId> = []
  for (let at = doc.nodes[id]?.parent; at !== undefined && !out.includes(at) && at !== id; at = doc.nodes[at]?.parent) out.push(at)
  return out
}

const issuesOf = (error: unknown): ReadonlyArray<string> => {
  if (!Schema.isSchemaError(error)) return [error instanceof Error ? error.message : String(error)]
  const formatted = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues
  return formatted.map((i) => {
    const path = (i.path ?? []).map((p) => String(typeof p === "object" ? p.key : p)).join(".")
    return path === "" ? i.message : `${path}: ${i.message}`
  })
}

const unknownSetting = (node: string, type: string, key: string): string =>
  type === "common.client" && key === "spike"
    ? `${node}: "spike" is no longer a setting, and is ignored. A traffic spike is a scenario now: a timeline that sets the rate, then sets it back.`
    : `${node}: "${key}" isn't one of its settings, and is ignored`

const decodeSettings = (schema: Schema.Top, settings: Readonly<Record<string, unknown>> | undefined) =>
  Schema.decodeUnknownResult(schema as Schema.Decoder<unknown>)(settings ?? {})

/** Decode a document against a registry (`Design.resolve`). */
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
    // A setting the component doesn't have (a typo, or a file older than the component) is ignored, so say so.
    const fields = (component.config as { readonly fields?: Readonly<Record<string, unknown>> }).fields
    for (const key of fields === undefined ? [] : Object.keys(spec.settings ?? {}).filter((k) => !(k in fields))) {
      diagnostics.push({ level: "warning", code: "unknown-setting", node: id, message: unknownSetting(label(id), spec.type, key) })
    }
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
    const known = provider?.regions.find((r) => r.id === region)
    if (provider === undefined || region === undefined || known === undefined) {
      error("unknown-region", `${label(id)}: "${region ?? "?"}" is not a region of ${provider?.title ?? component.provider}`, { node: id })
      continue
    }
    if (spec.zone !== undefined && !(known.zones ?? []).includes(spec.zone)) {
      const zones = known.zones ?? []
      error("unknown-zone", `${label(id)}: "${spec.zone}" is not a zone of ${region}${zones.length === 0 ? ", which has none" : ` (${zones.join(", ")})`}`, { node: id })
      continue
    }
    nodes.set(id, {
      id,
      type: spec.type,
      name: spec.name ?? id,
      placement: { provider: component.provider, region, ...(spec.zone === undefined ? {} : { zone: spec.zone }) },
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
    const port = spec.from.port ?? DEFAULT_PORT
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

/** The document form of a configured design (`Design.encode`). */
export const encode = (design: Design, registry: Components): Doc => {
  const encodeConfig = (schema: Schema.Top, config: unknown) =>
    Schema.encodeSync(schema as Schema.Encoder<unknown>)(config) as Record<string, unknown>
  const nodes: Record<NodeId, NodeDoc> = {}
  for (const [, node] of Graph.nodes(design.graph)) {
    nodes[node.id] = {
      type: node.type,
      name: node.name,
      region: node.placement.region,
      ...(node.placement.zone === undefined ? {} : { zone: node.placement.zone }),
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
