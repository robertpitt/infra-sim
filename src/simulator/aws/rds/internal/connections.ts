import type { Fast } from "../../../Component.ts"
import type { Counter } from "../../../Telemetry.ts"

/**
 * Connections: what a database (or RDS Proxy) has open, who holds them, and how many it allows.
 *
 * A database refuses a connection past `max_connections`, and a connection is held by a client whether it is running a
 * query or sitting idle in the client's pool. So the count that matters is every open connection: the ones running
 * queries, the ones being opened, and the idle ones clients keep for later (a connection pool, or a Lambda execution
 * environment that opened one outside its handler). Each client keeps its own idle connections (a `Pool`), and the
 * endpoint (a `Server`) counts them all against its limit.
 */

/** How one client handles its connections. A client is one edge into the endpoint, or a proxy. */
export interface ClientPolicy {
  /** Keep a connection open after a request and reuse it; otherwise open one per request and close it after. */
  readonly reuse: boolean
  /** How long an idle connection stays open before the client (or the server) closes it. */
  readonly idleMs: number
  /**
   * How long the client keeps the connection checked out besides the query itself: the rest of a Lambda invocation that
   * holds its environment's connection throughout, say. The query is answered at once; the connection is busy this much
   * longer. (The caller's work happens before the query in reality; the count of connections in use is the same.)
   */
  readonly holdMs: number
  /** Idle connections kept open however long they have been idle (RDS Proxy's `MaxIdleConnectionsPercent`). */
  readonly keepIdle: number
  /** Which endpoint the client connects to: the writer, the readers, or reads to the readers and writes to the writer. */
  readonly endpoint: "auto" | "writer" | "reader"
  /** How long the client caches the endpoint's DNS name: after a failover it keeps reaching the old primary up to this long. */
  readonly dnsCacheMs: number
}

/**
 * What a client's own edge counts of its connections, beside what the endpoint counts of all of them: the new ones its
 * requests opened, and the ones refused because the endpoint was at its limit.
 */
export interface ConnectionCounters {
  readonly opened: Counter
  readonly refused: Counter
}

/**
 * Close idle connections past their timeout whether or not anything calls: `sweep` runs every second of virtual time, for
 * as long as the run lasts. The database sweeps its instances' connections, a proxy its clients'.
 */
export const sweepEverySecond = (fast: Pick<Fast<unknown>, "after" | "now">, sweep: (now: number) => void): void => {
  const tick = (): void => {
    sweep(fast.now())
    fast.after(1_000, tick, undefined)
  }
  fast.after(1_000, tick, undefined)
}

/** `Pool.acquire` found no room: the server is at its limit. */
export const REFUSED = -2
/** `Pool.acquire` opened a new connection (the caller pays to open it). Otherwise it returns the reused connection's tag. */
export const OPENED = -1

/** One endpoint's connections: a database instance (or its readers together), or a proxy's clients. */
export class Server {
  /** Connections open: busy, being opened, or idle in a client's pool. */
  open = 0
  /** Bumped when every connection is dropped (a failover). A connection opened in an earlier epoch is dead. */
  epoch = 0
  readonly pools: Array<Pool> = []

  constructor(
    /** How many connections the endpoint allows right now. */
    readonly limit: () => number
  ) {}

  /** Every connection is gone: idle ones at once; busy ones are closed (and their queries failed) when they finish. */
  dropAll(): void {
    this.epoch++
    for (const pool of this.pools) this.open -= pool.clearIdle()
  }

  /** Close idle connections that have been idle too long, in every client's pool. */
  sweep(now: number): void {
    for (const pool of this.pools) pool.expire(now)
  }

  get idle(): number {
    let n = 0
    for (const pool of this.pools) n += pool.idle
    return n
  }

  get busy(): number {
    let n = 0
    for (const pool of this.pools) n += pool.busy
    return n
  }
}

/**
 * One client's connections to one server: the idle ones it keeps, most recently used on top (a pool hands out the
 * freshest first), and a count of busy ones. Each idle connection carries a tag the owner can use (a proxy marks client
 * connections that hold a pinned database connection); `onClose` hears the tag of each idle connection that closes.
 */
export class Pool {
  busy = 0
  private readonly since: Array<number> = []
  private readonly tags: Array<number> = []
  private head = 0

  constructor(
    readonly server: Server,
    readonly policy: () => ClientPolicy,
    private readonly onClose?: (tag: number) => void,
    /** The client's edge's counters, when its connector keeps them. */
    private readonly counters?: ConnectionCounters
  ) {
    server.pools.push(this)
  }

  get idle(): number {
    return this.since.length - this.head
  }

  /**
   * A connection for one request: an idle one if the client reuses connections and has one (its tag), a new one if the
   * server has room (`OPENED`), or `REFUSED`.
   */
  acquire(now: number): number {
    const p = this.policy()
    if (p.reuse) {
      this.expire(now)
      if (this.since.length > this.head) {
        this.since.pop()
        this.busy++
        return this.tags.pop()!
      }
    }
    if (this.server.open >= this.server.limit()) {
      if (this.counters !== undefined) this.counters.refused.n++
      return REFUSED
    }
    this.server.open++
    this.busy++
    if (this.counters !== undefined) this.counters.opened.n++
    return OPENED
  }

  /**
   * The request is done with its connection. It goes back to the pool (with `tag`) if the client reuses connections and
   * it is still alive (opened in the server's current epoch); otherwise it is closed.
   */
  release(now: number, epoch: number, tag = 0): void {
    this.busy--
    if (epoch !== this.server.epoch || !this.policy().reuse) {
      this.server.open--
      if (tag !== 0) this.onClose?.(tag)
      return
    }
    this.since.push(now)
    this.tags.push(tag)
  }

  /** Close idle connections idle for longer than the policy allows, oldest first, keeping its `keepIdle` freshest. */
  expire(now: number): void {
    const p = this.policy()
    const since = this.since
    while (this.head < since.length && since.length - this.head > p.keepIdle && now - since[this.head]! >= p.idleMs) {
      const tag = this.tags[this.head]!
      this.head++
      this.server.open--
      if (tag !== 0) this.onClose?.(tag)
    }
    this.compact()
  }

  /** Change the tag of every idle connection (a proxy drops its sessions' pins when its database fails over). */
  retag(to: (tag: number) => number): void {
    for (let i = this.head; i < this.tags.length; i++) this.tags[i] = to(this.tags[i]!)
  }

  /** Forget every idle connection; returns how many there were. */
  clearIdle(): number {
    const n = this.idle
    for (let i = this.head; i < this.tags.length; i++) if (this.tags[i] !== 0) this.onClose?.(this.tags[i]!)
    this.since.length = 0
    this.tags.length = 0
    this.head = 0
    return n
  }

  /** Reclaim the expired front of the arrays once it is worth it. */
  private compact(): void {
    if (this.head === this.since.length) {
      this.since.length = 0
      this.tags.length = 0
      this.head = 0
    } else if (this.head > 1024 && this.head * 2 > this.since.length) {
      this.since.splice(0, this.head)
      this.tags.splice(0, this.head)
      this.head = 0
    }
  }
}
