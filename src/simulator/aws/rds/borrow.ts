import { Duration } from "effect"
import type { Fast } from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import type { Link } from "../../Edge.ts"
import type * as Flow from "../../Flow.ts"
import { type CallFailure, type Message, Throttled, Unavailable } from "../../Message.ts"
import { Slots } from "../../kit/Slots.ts"
import { type Tally, tallies } from "../../kit/Tally.ts"
import type { Meter, Sampler } from "../../Telemetry.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import { DEFAULT_POLICY } from "./client.ts"
import { type ClientPolicy, OPENED, Pool, Server } from "./connections.ts"
import { PROXY_IDLE_AFTER_MS } from "./limits.ts"
import type { ProxyConfig } from "./proxyConfig.ts"
import { CONNECTION_LOST } from "./query.ts"
import { asDatabase, CLIENT_TAG, type Database } from "./endpoint.ts"

/** Tags on the proxy's client connections (see `Pool`): a pinned session, and one that holds its database connection. */
const PLAIN = 0
const HOLDING = 1
const PINNED = 2

/** The error a client gets when no database connection came in time. (rds-proxy.troubleshooting) */
const borrowTimedOut = (mysql: boolean): string =>
  mysql ? "ERROR 9501 (HY000): Timed-out waiting to acquire database connection" : "ERROR 08000: Timed-out waiting to acquire database connection."

const COUNTERS = ["requests", "queued", "borrowTimeouts", "clientConnects", "pinnedSessions", "retried"] as const

export interface ProxyStats {
  readonly count: Record<(typeof COUNTERS)[number], Tally>
  /** Time from asking for a database connection to having one (CloudWatch's `DatabaseConnectionsBorrowLatency`), in ms. */
  readonly borrowLatency: Sampler
}

export const makeProxyStats = (meter: Meter): ProxyStats => ({ count: tallies(meter, COUNTERS), borrowLatency: meter.sampler("borrowLatency") })

/**
 * Everything one proxy's requests share: its client connections, its pool of database connections (as slots it may
 * borrow, up to `MaxConnectionsPercent` of the database's `max_connections`), whether its target is up, and its stats.
 *
 * The database connections themselves are counted by the database, as one client of it (keyed `rds-client:proxy:<id>`),
 * that reuses its connections and keeps `MaxIdleConnectionsPercent` of them however long they sit idle. The proxy decides
 * how many may be in use at once, and makes requests wait for one: that is the borrow, and the wait is what a burst
 * turns into instead of "too many connections".
 */
export class ProxyRuntime {
  /** Client connections: as many as clients open (the proxy scales; AWS publishes no fixed limit). */
  readonly clientServer = new Server(() => Number.POSITIVE_INFINITY)
  readonly clients = new Map<string, Pool>()
  /** The pool's slots: one per database connection in use (a request running, or a pinned session holding one). */
  readonly slots: Slots
  /** Idle client connections holding a pinned database connection. */
  pinnedHeld = 0
  targetUp = true
  readonly key: string
  private database: Database | undefined
  private probing: TimerHandle | undefined
  private dbMemo: { c: ProxyConfig; max: number; pinned: number; value: ClientPolicy } | undefined

  constructor(
    readonly id: string,
    readonly fast: Fast<ProxyConfig>,
    readonly link: Link | undefined,
    readonly stats: ProxyStats,
    readonly mysql: () => boolean
  ) {
    this.key = `${CLIENT_TAG}proxy:${id}`
    this.slots = new Slots(() => (this.targetUp ? this.limit() : 0), () => Number.POSITIVE_INFINITY)
  }

  /**
   * The database behind the proxy, found through what its node offers (and told about the proxy) the first time it is
   * needed: nodes are made one by one, so the database may not be there yet while the proxy is being made.
   */
  target(): Database | undefined {
    if (this.database !== undefined || this.link === undefined) return this.database
    const found = asDatabase(this.link.offer())
    if (found !== undefined) {
      this.database = found
      found.attach(this.key, () => this.databasePolicy())
    }
    return this.database
  }

  /** The most database connections the proxy may have in use: `MaxConnectionsPercent` of `max_connections`. */
  limit(): number {
    const db = this.target()
    if (db === undefined) return Number.POSITIVE_INFINITY
    return Math.max(1, Math.floor((this.fast.settings().maxConnectionsPercent / 100) * db.maxConnections()))
  }

  /** How the proxy holds its database connections, as a client of the database. */
  private databasePolicy(): ClientPolicy {
    const c = this.fast.settings()
    const max = this.database?.maxConnections() ?? 0
    const memo = this.dbMemo
    if (memo !== undefined && memo.c === c && memo.max === max && memo.pinned === this.pinnedHeld) return memo.value
    const idlePercent = Math.min(c.maxIdleConnectionsPercent, c.maxConnectionsPercent)
    const value: ClientPolicy = {
      reuse: true,
      idleMs: PROXY_IDLE_AFTER_MS,
      // Multiplexing: the proxy gives a database connection back as soon as the transaction is done.
      holdMs: 0,
      // Pinned sessions' connections are idle at the database but not the proxy's to close.
      keepIdle: Math.floor((idlePercent / 100) * max) + this.pinnedHeld,
      endpoint: c.endpoint === "read-only" ? "reader" : "writer",
      // The proxy follows the primary itself, past DNS.
      dnsCacheMs: 0
    }
    this.dbMemo = { c, max, pinned: this.pinnedHeld, value }
    return value
  }

  attach(key: string, policy: () => ClientPolicy): void {
    if (this.clients.has(key)) return
    // The proxy closes client connections idle past its own timeout, whatever the client would do.
    let memo: { p: ClientPolicy; c: ProxyConfig; value: ClientPolicy } | undefined
    const effective = (): ClientPolicy => {
      const p = policy()
      const c = this.fast.settings()
      if (memo !== undefined && memo.p === p && memo.c === c) return memo.value
      const value = { ...p, idleMs: Math.min(p.idleMs, Duration.toMillis(c.idleClientTimeout)) }
      memo = { p, c, value }
      return value
    }
    this.clients.set(key, new Pool(this.clientServer, effective, this.closed))
  }

  /** A client connection closed: one holding a pinned database connection gives it back. */
  private readonly closed = (tag: number): void => {
    if (tag !== HOLDING) return
    this.pinnedHeld--
    this.slots.release()
  }

  /** The database refused as unavailable: wait for it, trying again every `targetCheck`. Pinned sessions lose their connections. */
  down(): void {
    if (!this.targetUp) return
    this.targetUp = false
    for (const pool of this.clients.values()) {
      pool.retag((tag) => {
        if (tag !== HOLDING) return tag
        this.pinnedHeld--
        this.slots.release()
        return PINNED
      })
    }
    this.scheduleProbe()
  }

  private scheduleProbe(): void {
    this.probing = this.fast.after(Duration.toMillis(this.fast.settings().targetCheck), this.probe, undefined)
  }

  private readonly probe = (): void => {
    this.probing = undefined
    if (this.link === undefined) return
    const message = this.fast.mint({ operation: "read", count: 1, bytes: 64, group: this.key })
    this.link.send(message, (failure) => {
      if (failure === undefined || !isTargetDown(failure)) {
        this.targetUp = true
        this.slots.kick()
        return
      }
      this.scheduleProbe()
    })
  }

  stop(): void {
    this.probing?.cancel()
  }
}

/** The database refused before running anything because it was down: the request can wait and try again. */
const isTargetDown = (failure: CallFailure): failure is CallFailure & { readonly _tag: "Unavailable"; readonly reason: string } =>
  failure._tag === "Unavailable" && failure.reason !== CONNECTION_LOST

/**
 * One request through the proxy: a client connection (reused, or opened at the proxy's handshake), the proxy's hop,
 * a database connection borrowed from the pool (waiting up to the borrow timeout, through a failover too), the query on
 * the database, and everything given back. A pinned session keeps its database connection when the request is done, as
 * long as its client connection stays open. Returns the function that abandons it.
 */
export const forward = (proxy: ProxyRuntime, message: Message, done: Flow.Done): Flow.Cancel => {
  const { fast, stats, slots } = proxy
  const c = fast.settings()
  const pool = proxy.clients.get(message.group ?? "") ?? anonymous(proxy)
  const clientEpoch = proxy.clientServer.epoch
  const got = pool.acquire(fast.now())
  let tag = got === OPENED ? (fast.random.nextDoubleUnsafe() < c.pinning ? PINNED : PLAIN) : got
  if (tag === HOLDING) proxy.pinnedHeld-- // it is this request's now, not an idle session's
  if (got === OPENED) {
    stats.count.clientConnects.add(1)
    if (tag === PINNED) stats.count.pinnedSessions.add(1)
  }
  stats.count.requests.add(1)

  let finished = false
  let holdsSlot = tag === HOLDING
  let timer: TimerHandle | undefined
  let deadline: TimerHandle | undefined
  let giveUp: (() => void) | undefined
  let cancelDb: Flow.Cancel | undefined
  let askedAt = -1
  let waitingSince = 0
  let waited = false

  const finish = (failure: CallFailure | undefined): void => {
    finished = true
    deadline?.cancel()
    // A pinned session keeps its database connection for as long as its client connection is open: through the time the
    // client holds it, and while it sits idle in the client's pool. Closing it gives the database connection back.
    const pinned = tag !== PLAIN
    let keep = pinned ? PINNED : PLAIN
    if (holdsSlot) {
      if (pinned && failure === undefined) {
        keep = HOLDING
        proxy.pinnedHeld++
      } else slots.release()
    }
    const hold = failure === undefined ? pool.policy().holdMs : 0
    if (hold > 0) fast.after(hold, () => pool.release(fast.now(), clientEpoch, keep), undefined)
    else pool.release(fast.now(), clientEpoch, keep)
    done(failure)
  }

  const send = (): void => {
    const target = proxy.link
    if (target === undefined) return finish(Unavailable({ node: proxy.id, reason: "the proxy has no target database" }))
    cancelDb = target.send({ ...message, group: proxy.key }, (failure) => {
      cancelDb = undefined
      if (finished) return
      if (failure !== undefined && isTargetDown(failure)) {
        // Refused before it ran: the database is failing over (or down). Hold on to the request and wait for it.
        stats.count.retried.add(1)
        // Down first, so the slot given back isn't handed straight to the next request in line.
        proxy.down()
        holdsSlot = false
        slots.release()
        return borrow()
      }
      finish(failure)
    })
  }

  const granted = (): void => {
    giveUp = undefined
    holdsSlot = true
    deadline?.cancel()
    deadline = undefined
    stats.borrowLatency.add(fast.now() - waitingSince)
    send()
  }

  const timedOut = (): void => {
    deadline = undefined
    if (finished) return
    giveUp?.()
    giveUp = undefined
    stats.count.borrowTimeouts.add(1)
    const reason = borrowTimedOut(proxy.mysql())
    finish(proxy.targetUp ? Throttled({ node: proxy.id, reason }) : Unavailable({ node: proxy.id, reason }))
  }

  /** Ask the pool for a database connection; the borrow timeout counts from the first time this request asked. */
  const borrow = (): void => {
    const now = fast.now()
    if (askedAt < 0) askedAt = now
    waitingSince = now
    const place = slots.acquire(granted)
    if (holdsSlot) return
    giveUp = place
    if (!waited) {
      waited = true
      stats.count.queued.add(1)
    }
    const left = askedAt + Duration.toMillis(fast.settings().borrowTimeout) - now
    if (left <= 0) return timedOut()
    if (deadline === undefined) deadline = fast.after(left, timedOut, undefined)
  }

  const start = (): void => {
    timer = undefined
    if (finished) return
    if (holdsSlot) return send()
    borrow()
  }

  const delay = Distribution.latencyMs(c.latency, fast.random) + (got === OPENED ? Distribution.latencyMs(c.clientHandshake, fast.random) : 0)
  timer = fast.after(delay, start, undefined)

  return () => {
    if (finished) return
    finished = true
    timer?.cancel()
    deadline?.cancel()
    giveUp?.()
    cancelDb?.()
    if (holdsSlot) slots.release()
    pool.release(fast.now(), clientEpoch, tag === HOLDING ? PINNED : tag)
  }
}

/** Requests from clients the proxy doesn't know (an edge with another connector), together, as a default client. */
const anonymous = (proxy: ProxyRuntime): Pool => {
  let pool = proxy.clients.get("")
  if (pool === undefined) {
    proxy.attach("", () => DEFAULT_POLICY)
    pool = proxy.clients.get("")!
  }
  return pool
}
