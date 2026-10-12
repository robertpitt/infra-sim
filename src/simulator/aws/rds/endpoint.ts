import type { ClientPolicy, ConnectionCounters } from "./connections.ts"

/**
 * What a database or a proxy offers whatever is wired to it (its `Instance.offer`), and how its partners recognise it.
 *
 * A database counts the connections its clients hold, and how a client holds them (a connection per request, or a pool
 * it keeps between requests) is a property of the edge, not of the database: the client connector's settings. So the
 * connector on an edge into a database (or a proxy) tells the node about itself through `ctx.offer()`, and a proxy finds
 * the database behind it through its link's `offer()`. A node offers one of these; anything else at the far end (a
 * plain endpoint behind a proxy) offers nothing, and its callers carry on as a default client would.
 */
export interface Endpoint {
  readonly kind: "rds.database" | "rds.proxy"
  /**
   * Tell the endpoint how the client whose requests carry `key` in `group` handles its connections, and, if its edge
   * keeps them, the counters of connections it opens and has refused. Returns that client's connections, live.
   */
  readonly attach: (key: string, policy: () => ClientPolicy, counters?: ConnectionCounters) => ClientConnections
}

/** One client's connections to an endpoint, as its edge reads them each frame. */
export interface ClientConnections {
  /** Open: running a query, held by the client around one, or idle in its pool. Each counts against the limit. */
  readonly open: () => number
  /** Checked out: running a query, or held by the client around one. */
  readonly busy: () => number
}

/** A database, as a proxy in front of it sees it. */
export interface Database extends Endpoint {
  readonly kind: "rds.database"
  /** The `max_connections` of one instance: what a proxy's pool is a percentage of. */
  readonly maxConnections: () => number
  /** Connections the client `key` has open (busy and idle, to the writer and the readers). */
  readonly connections: (key: string) => number
  /** Whether the engine speaks MySQL's protocol (Aurora MySQL, MySQL, MariaDB), which decides the errors clients see. */
  readonly mysql: () => boolean
}

/** What a node offers, if it is a database or a proxy. */
export const asEndpoint = (offer: unknown): Endpoint | undefined => {
  const kind = typeof offer === "object" && offer !== null ? (offer as { readonly kind?: unknown }).kind : undefined
  return kind === "rds.database" || kind === "rds.proxy" ? (offer as Endpoint) : undefined
}

/** What a node offers, if it is a database. */
export const asDatabase = (offer: unknown): Database | undefined => {
  const endpoint = asEndpoint(offer)
  return endpoint?.kind === "rds.database" ? (endpoint as Database) : undefined
}

/** Requests from a client carry this prefix and the client's key in `group`, so the endpoint knows whose they are. */
export const CLIENT_TAG = "rds-client:"
