import { Graph, Option } from "effect"
import type { AnyComponent, PortDefs } from "./Component.ts"
import type { Doc } from "./Design.ts"
import { DEFAULT_PORT } from "./Design.ts"
import type { Components } from "./Registry.ts"

/**
 * Graph questions about a design.
 *
 * A design is a directed `Graph` of components. Here are the questions worth asking of it: which nodes does a
 * failure reach, is there a feedback loop that can amplify retries, what never receives traffic, what does it
 * look like as a diagram. Graph indices are only stable inside one built graph, so ids stay the identity and a
 * `Topology` maps between the two.
 */

export interface NodeLike {
  readonly id: string
  readonly type: string
  readonly name?: string | undefined
  /** Undefined when a document names a component type the registry doesn't know. */
  readonly component: AnyComponent | undefined
}

export interface EdgeLike {
  readonly id: string
  /** The output port it leaves from. */
  readonly port: string
  /** Id of the node it arrives at. */
  readonly to: string
}

export interface Topology<N extends NodeLike = NodeLike, E extends EdgeLike = EdgeLike> {
  readonly graph: Graph.DirectedGraph<N, E>
  readonly nodeIndex: ReadonlyMap<string, Graph.NodeIndex>
  readonly edgeIndex: ReadonlyMap<string, Graph.EdgeIndex>
}

export interface DocNode extends NodeLike {
  readonly spec: Doc["nodes"][string]
}
export interface DocEdge extends EdgeLike {
  readonly spec: Doc["edges"][string]
}

/** The topology of a document, however unfinished: edges to nodes that don't exist are left out. */
export const fromDoc = (doc: Doc, registry: Components): Topology<DocNode, DocEdge> & { readonly dangling: ReadonlyArray<string> } => {
  const nodeIndex = new Map<string, Graph.NodeIndex>()
  const edgeIndex = new Map<string, Graph.EdgeIndex>()
  const dangling: Array<string> = []
  const graph = Graph.directed<DocNode, DocEdge>((g) => {
    for (const [id, spec] of Object.entries(doc.nodes)) {
      nodeIndex.set(id, Graph.addNode(g, { id, type: spec.type, name: spec.name, component: registry.get(spec.type), spec }))
    }
    for (const [id, spec] of Object.entries(doc.edges)) {
      const from = nodeIndex.get(spec.from.node)
      const to = nodeIndex.get(spec.to)
      if (from === undefined || to === undefined) dangling.push(id)
      else edgeIndex.set(id, Graph.addEdge(g, from, to, { id, port: spec.from.port ?? DEFAULT_PORT, to: spec.to, spec }))
    }
  })
  return { graph, nodeIndex, edgeIndex, dangling }
}

const nodeAt = <N extends NodeLike>(top: Topology<N, EdgeLike>, index: Graph.NodeIndex): N => {
  const node = Graph.getNode(top.graph, index)
  if (Option.isNone(node)) throw new Error(`Graph node ${index} missing`)
  return node.value
}

const edgesOf = <E extends EdgeLike>(top: Topology<NodeLike, E>, indices: ReadonlyArray<Graph.EdgeIndex>): ReadonlyArray<E> =>
  indices.flatMap((i) => {
    const edge = Graph.getEdge(top.graph, i)
    return Option.isSome(edge) ? [edge.value.data] : []
  })

/** Edges leaving a node, in design order. */
export const outgoing = <E extends EdgeLike>(top: Topology<NodeLike, E>, id: string): ReadonlyArray<E> => {
  const index = top.nodeIndex.get(id)
  return index === undefined ? [] : edgesOf(top, Graph.outgoingEdges(top.graph, index))
}

export const incoming = <E extends EdgeLike>(top: Topology<NodeLike, E>, id: string): ReadonlyArray<E> => {
  const index = top.nodeIndex.get(id)
  return index === undefined ? [] : edgesOf(top, Graph.incomingEdges(top.graph, index))
}

const reach = (top: Topology, starts: ReadonlyArray<string>, direction: "outgoing" | "incoming"): ReadonlyArray<string> => {
  const start = starts.flatMap((id) => {
    const index = top.nodeIndex.get(id)
    return index === undefined ? [] : [index]
  })
  if (start.length === 0) return []
  return Array.from(Graph.indices(Graph.bfs(top.graph, { start, direction }))).map((i) => nodeAt(top, i).id)
}

/** Everything a failure at `id` can reach, following edges forward. The blast radius. Excludes `id` itself. */
export const downstream = (top: Topology, id: string): ReadonlyArray<string> => reach(top, [id], "outgoing").filter((n) => n !== id)

/** Everything that can send work to `id`, directly or indirectly. Excludes `id` itself. */
export const upstream = (top: Topology, id: string): ReadonlyArray<string> => reach(top, [id], "incoming").filter((n) => n !== id)

/** Nodes that originate traffic: components with no inbound side. */
export const sources = (top: Topology): ReadonlyArray<string> =>
  Array.from(Graph.values(Graph.nodes(top.graph))).filter((n) => n.component !== undefined && !n.component.inputs && n.component.container === undefined).map((n) => n.id)

/** Nodes some source can reach, sources included. */
export const reachable = (top: Topology): ReadonlySet<string> => new Set(reach(top, sources(top), "outgoing"))

/**
 * Groups of nodes that can reach each other, plus self-loops. This is where retries and redelivery can feed
 * back into the load that caused them. Replication doesn't count: a replica is never replicated on, so two stores
 * replicating to each other (a global table) pass nothing round.
 */
export const feedbackLoops = (top: Topology): ReadonlyArray<ReadonlyArray<string>> => {
  const replication = new Set<string>()
  for (const [id, index] of top.nodeIndex) {
    const ports: PortDefs | undefined = nodeAt(top, index).component?.ports
    for (const edge of outgoing(top, id)) if (ports?.[edge.port]?.replication === true) replication.add(edge.id)
  }
  const graph = replication.size === 0 ? top.graph : Graph.mutate(top.graph, (g) => {
    Graph.filterEdges(g, (e) => !replication.has(e.id))
  })
  return Graph.stronglyConnectedComponents(graph)
    .filter((component) => {
      if (component.length > 1) return true
      const only = component[0]
      return only !== undefined && Graph.hasEdge(graph, only, only)
    })
    .map((component) => component.map((i) => nodeAt(top, i).id).sort())
}

/** A Mermaid flowchart of the design: handy for docs, issues and sanity-checking an import. */
export const toMermaid = (top: Topology): string =>
  Graph.toMermaid(top.graph, {
    direction: "LR",
    nodeLabel: (n) => `${n.name ?? n.id} · ${n.type}`,
    edgeLabel: (e) => (e.port === DEFAULT_PORT ? "" : e.port),
    nodeShape: (n) => (n.component?.inputs === false ? "stadium" : n.component?.category === "storage" ? "cylindrical" : "rounded")
  })
