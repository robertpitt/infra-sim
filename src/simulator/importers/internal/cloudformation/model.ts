import { asString, type Evaluator, isUnresolved, referencesIn, type Unresolved } from "../../Intrinsics.ts"

/**
 * What every part of the CloudFormation importer shares: the resource and draft types, and `Run`, the state of one
 * import. A service's module (`dynamodb.ts`, `sqs.ts`...) reads resources and writes drafts, settings and wires into a
 * `Run`; `assemble.ts` turns the finished `Run` into a design.
 */

// biome-ignore lint/suspicious/noExplicitAny: template properties are arbitrary JSON; each handler reads what it expects.
export type Bag = Record<string, any>

export const SOURCE = "cloudformation"

export interface Resource {
  readonly id: string
  readonly type: string
  /** Properties with intrinsic functions resolved as far as the template allows. */
  readonly props: Bag
  readonly metadata: Bag
}

/** One setting to write on a node: the path inside its settings, the value, and the template property it came from. */
export interface Setting {
  readonly path: ReadonlyArray<string>
  readonly value: unknown
  readonly label: string
}

export interface Origin {
  readonly source: string
  readonly ref: string
  readonly type?: string
}

/** A component the import intends to create. Settings are checked and clamped when the design is assembled. */
export interface Draft {
  readonly key: string
  readonly id: string
  readonly name: string
  readonly type: string
  readonly settings: Array<Setting>
  readonly origin: Origin | undefined
  /** The container it sits in (a VPC). Undefined means the region box. */
  parent: Draft | undefined
  /** The region it runs in when it is not the stack's own (a replica of a global table). */
  region: string | undefined
}

/** An edge the import intends to draw. */
export interface Wire {
  readonly from: Draft
  readonly port: string
  readonly to: Draft
  /** Nested like an edge's settings in a design (`{ request: { operation: "read" } }`); checked when assembled. */
  readonly settings: Record<string, unknown>
  readonly name: string | undefined
  readonly declared: boolean
  readonly origin: { readonly source: string; readonly ref: string } | undefined
}

/** The resources of the template, and what is needed to read them. */
export interface TemplateContext {
  readonly resources: ReadonlyMap<string, Resource>
  readonly evaluator: Evaluator
  /** SAM events declared on functions, wired once every component exists. */
  readonly events: Array<{ readonly fn: Draft; readonly name: string; readonly event: Bag }>
}

export type Handler = (run: Run, r: Resource, ctx: TemplateContext) => void

// ---------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------

export const seconds = (n: number): string => `${n} seconds`
export const millis = (n: number): string => `${n} millis`

/** `OrdersQueue` -> `orders-queue`. */
export const kebab = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "node"

/** CDK appends an 8-character hash to every logical id; it carries no meaning for a reader. */
export const stripHash = (logicalId: string): string => (/[a-z][0-9A-F]{8}$/.test(logicalId) ? logicalId.slice(0, -8) : logicalId)

export const nameOf = (r: Resource): string => {
  const path = asString(r.metadata["aws:cdk:path"])
  if (path !== undefined) {
    // `Stack/Orders/Queue/Resource` -> `Orders / Queue`
    const parts = path.split("/").slice(1).filter((p) => p !== "Resource" && p !== "Default")
    if (parts.length > 0) return parts.join(" / ")
  }
  return stripHash(r.id)
}

/** A list from a value that may be one item, a list, or absent. */
// biome-ignore lint/suspicious/noExplicitAny: the items are whatever the template holds; each caller reads what it expects.
export const listOf = (v: unknown): ReadonlyArray<any> => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])

/** `value`, or the unresolved marker so `Run.set` can report it; `undefined` when the template doesn't say. */
export const known = <T>(value: T | undefined, raw: unknown): T | Unresolved | undefined => value ?? (isUnresolved(raw) ? raw : undefined)

// ---------------------------------------------------------------------------------------------------------
// The state of one import
// ---------------------------------------------------------------------------------------------------------

export class Run {
  readonly drafts = new Map<string, Draft>()
  readonly wires: Array<Wire> = []
  readonly converted: Array<{ id: string; type: string; node: string }> = []
  readonly skipped: Array<{ id: string; type: string; reason: string; quiet: boolean }> = []
  readonly added: Array<string> = []
  readonly warnings: Array<string> = []
  readonly unresolved: Array<string> = []
  readonly adjusted: Array<string> = []
  readonly resources = new Map<string, Resource>()
  /** Lambda functions that CloudFront runs at the edge: they have no place in the traffic graph. */
  readonly edgeFunctions = new Set<Draft>()
  /** Copies of a global table in other regions: written through replication, so nothing outside is assumed to write to them. */
  readonly replicaCopies = new Set<Draft>()
  private readonly usedIds = new Set<string>()
  private readonly aliases = new Map<string, string>()
  private readonly endpoints = new Map<string, Draft>()
  private readonly deferred: Array<() => void> = []

  constructor(readonly options: { readonly region: string; readonly rps: number; readonly knownRegions: ReadonlyArray<string> }) {}

  // -- Drafts ----------------------------------------------------------------------------------------------
  draft(key: string, name: string, type: string, origin?: Origin): Draft {
    const base = kebab(name)
    let id = base
    for (let n = 2; this.usedIds.has(id); n++) id = `${base}-${n}`
    this.usedIds.add(id)
    const d: Draft = { key, id, name, type, settings: [], origin, parent: undefined, region: undefined }
    this.drafts.set(key, d)
    return d
  }

  /** Record a setting. `undefined` means the template doesn't set it; an unresolved value keeps the default and says so. */
  set(d: Draft, path: ReadonlyArray<string>, value: unknown, label: string): void {
    if (value === undefined) return
    if (isUnresolved(value)) {
      this.unresolved.push(`${d.name}: ${label} (${value.reason})`)
      return
    }
    // A later statement of the same setting replaces the earlier one (an alias raising what the function said).
    const at = d.settings.findIndex((s) => s.path.join(".") === path.join("."))
    if (at >= 0) d.settings.splice(at, 1)
    d.settings.push({ path, value, label })
  }

  /** What was recorded for a setting, if anything. */
  setting(d: Draft, path: ReadonlyArray<string>): unknown {
    return d.settings.find((s) => s.path.join(".") === path.join("."))?.value
  }

  alias(from: string, to: string): void {
    this.aliases.set(from, to)
  }

  /** The component a resource became, following aliases and versions to the function they point at. */
  nodeFor(logicalId: string): Draft | undefined {
    return this.drafts.get(this.aliases.get(logicalId) ?? logicalId)
  }

  /** Every component a value points at, once each, in the order first seen. */
  targets(value: unknown): ReadonlyArray<Draft> {
    const out: Array<Draft> = []
    for (const id of referencesIn(value)) {
      const d = this.nodeFor(id)
      if (d !== undefined && !out.includes(d)) out.push(d)
    }
    return out
  }

  /** The component of a given type a value points at. */
  target(value: unknown, type: string): Draft | undefined {
    return this.targets(value).find((d) => d.type === type)
  }

  /** The first resource of `types` whose property `prop` is the literal `name` (a bucket named by an ARN, say). */
  byName(types: ReadonlyArray<string>, prop: string, name: string): Draft | undefined {
    for (const r of this.resources.values()) if (types.includes(r.type) && r.props[prop] === name) return this.nodeFor(r.id)
    return undefined
  }

  /** Add an edge unless that connection exists already; returns the edge either way so callers can refine its settings. */
  wire(from: Draft, port: string, to: Draft, options: { settings?: Record<string, unknown>; name?: string; declared?: boolean; origin?: Wire["origin"] } = {}): Wire | undefined {
    if (from === to) return undefined
    const existing = this.wires.find((w) => w.from === from && w.port === port && w.to === to)
    if (existing !== undefined) return existing
    const w: Wire = { from, port, to, settings: options.settings ?? {}, name: options.name, declared: options.declared ?? true, origin: options.origin }
    this.wires.push(w)
    return w
  }

  /** A third-party HTTP service, named by its host. */
  endpoint(url: string, why: string): Draft {
    const host = /^[a-z]+:\/\/([^/:?#]+)/i.exec(url)?.[1] ?? url
    let d = this.endpoints.get(host)
    if (d === undefined) {
      d = this.draft(`endpoint:${host}`, host, "common.http-endpoint", { source: SOURCE, ref: why })
      this.endpoints.set(host, d)
      this.added.push(`An external HTTP service for ${host}: its latency and error rate are the defaults, set them to match.`)
    }
    return d
  }

  consumed(r: Resource, into: Draft): void {
    this.converted.push({ id: r.id, type: r.type, node: into.id })
  }

  skip(r: Resource, reason: string, quiet = false): void {
    this.skipped.push({ id: r.id, type: r.type, reason, quiet })
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message)
  }

  /** Run something once the whole template has been read (a setting that needs every method of an API, say). */
  later(fn: () => void): void {
    this.deferred.push(fn)
  }

  flush(): void {
    // A deferred step may defer more; they run in the order they were added.
    for (let i = 0; i < this.deferred.length; i++) this.guard("a setting or connection that needs the whole template", this.deferred[i]!)
    this.deferred.length = 0
  }

  /**
   * Run one step of the import. A template is someone else's text and may hold a property of a shape nobody expected;
   * that costs the one thing being read, which is reported, not the import.
   */
  guard(what: string, step: () => void, resource?: Resource): void {
    try {
      step()
    } catch (error) {
      const why = error instanceof Error ? error.message.split("\n")[0] : String(error)
      if (resource !== undefined) this.skip(resource, `couldn't be read (${why})`)
      this.warn(`${what} couldn't be read (${why}), so it is left out.`)
    }
  }
}
