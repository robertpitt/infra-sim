import * as Design from "./Design.ts"

/**
 * Write designs in code. Used by demos and tests, and it is the shape an importer wants too: add nodes,
 * connect them, build.
 *
 *   const b = Builder.make("Orders")
 *   const web = b.add("client", { name: "Web", settings: { rps: 200 } })
 *   const api = b.add("service", { name: "API" })
 *   b.connect(web, api, { retry: { maxAttempts: 3 } })
 *   const design = b.build()
 */

export interface PortRef {
  readonly node: Design.NodeId
  readonly port: string
}

export interface NodeRef {
  readonly id: Design.NodeId
  /** Refer to a named output port, e.g. `queue.port("dlq")`. */
  readonly port: (name: string) => PortRef
}

export interface AddOptions {
  readonly id?: string
  readonly name?: string
  /** The provider region it runs in. Defaults to the provider's default. */
  readonly region?: string
  /** The container (an `aws.region`, an `aws.vpc`) it sits inside. */
  readonly parent?: NodeRef
  /** For containers: the size of the box, in canvas units. */
  readonly size?: { readonly w: number; readonly h: number }
  readonly at?: readonly [x: number, y: number]
  readonly settings?: Readonly<Record<string, unknown>>
  readonly origin?: Design.Origin
}

export interface Builder {
  readonly add: (type: string, options?: AddOptions) => NodeRef
  readonly connect: (
    from: NodeRef | PortRef,
    to: NodeRef,
    settings?: Readonly<Record<string, unknown>>,
    /** `connector` names what sits on the edge; left out, the most specific one that fits is used. */
    options?: { readonly id?: string; readonly name?: string; readonly origin?: Design.Origin; readonly connector?: string }
  ) => void
  /** Override account-level quotas for a placement such as `aws:us-east-1`. */
  readonly account: (placement: string, settings: Readonly<Record<string, unknown>>) => void
  /** Attach a controller (`core.target-tracking`...) to a node. Returns its id. */
  readonly control: (type: string, target: NodeRef, settings?: Readonly<Record<string, unknown>>, options?: { readonly id?: string; readonly name?: string }) => string
  readonly build: () => Design.Doc
}

export const make = (name?: string, options: { readonly seed?: number } = {}): Builder => {
  let design: Design.Doc = { ...Design.empty(name), ...(options.seed === undefined ? {} : { seed: options.seed }) }
  const ref = (id: string): NodeRef => ({ id, port: (port) => ({ node: id, port }) })
  return {
    add: (type, o = {}) => {
      const added = Design.addNode(design, {
        type,
        ...(o.id === undefined ? {} : { id: o.id }),
        ...(o.name === undefined ? {} : { name: o.name }),
        ...(o.region === undefined ? {} : { region: o.region }),
        ...(o.parent === undefined ? {} : { parent: o.parent.id }),
        ...(o.size === undefined ? {} : { size: o.size }),
        ...(o.at === undefined ? {} : { position: { x: o.at[0], y: o.at[1] } }),
        ...(o.settings === undefined ? {} : { settings: o.settings }),
        ...(o.origin === undefined ? {} : { origin: o.origin })
      })
      design = added.doc
      return ref(added.id)
    },
    connect: (from, to, settings, o = {}) => {
      design = Design.connect(design, {
        from: "node" in from ? { node: from.node, port: from.port } : { node: from.id },
        to: to.id,
        ...(settings === undefined ? {} : { settings }),
        ...(o.connector === undefined ? {} : { connector: o.connector }),
        ...(o.id === undefined ? {} : { id: o.id }),
        ...(o.name === undefined ? {} : { name: o.name }),
        ...(o.origin === undefined ? {} : { origin: o.origin })
      }).doc
    },
    account: (placement, settings) => {
      design = { ...design, accounts: { ...design.accounts, [placement]: settings } }
    },
    control: (type, target, settings, o = {}) => {
      const added = Design.addController(design, {
        type,
        target: target.id,
        ...(settings === undefined ? {} : { settings }),
        ...(o.id === undefined ? {} : { id: o.id }),
        ...(o.name === undefined ? {} : { name: o.name })
      })
      design = added.doc
      return added.id
    },
    build: () => design
  }
}
