import { Effect, Schema } from "effect"
import * as Component from "../../Component.ts"
import type { CallFailure, Reply } from "../../Message.ts"
import { totals } from "../../kit/Tally.ts"
import * as Aws from "../provider.ts"
import { forward, makeProxyStats, ProxyRuntime } from "./borrow.ts"
import { SOURCES } from "./limits.ts"
import { ProxyConfig } from "./proxyConfig.ts"
import type { Endpoint } from "./endpoint.ts"

/**
 * Amazon RDS Proxy: a pool of database connections shared by many clients. Clients connect to the proxy (as many as
 * they like, at the proxy's handshake, not the database's); each request borrows a database connection for its
 * transaction and gives it back (multiplexing), up to `MaxConnectionsPercent` of the database's `max_connections`; past
 * that, requests wait for one up to the borrow timeout instead of being refused. A pinned session keeps its connection
 * for as long as its client connection is open. When the database fails over, the proxy keeps its clients' connections
 * open and holds their requests until the new primary answers, without waiting on DNS.
 */
export const RdsProxy = Aws.component({
  type: "aws.rds-proxy",
  service: "RDS",
  title: "RDS Proxy",
  description:
    "A pool of database connections shared by many clients. Requests borrow a connection per transaction, wait for one when the pool is full instead of being refused, and wait out a failover with their client connections kept open.",
  docs: SOURCES.proxy,
  // The palette groups AWS components by category: the proxy belongs next to RDS, under "Data".
  category: "storage",
  icon: "proxy",
  accent: "#2e73b8",
  limits: [
    { label: "Proxies", value: "20 per account per region", adjustable: true, source: SOURCES.proxy, note: "In the account quotas." },
    { label: "Targets", value: "One DB instance or cluster per proxy (several proxies may share one); the writer only for RDS replicas", adjustable: false, source: SOURCES.proxy },
    { label: "Endpoints", value: "A default endpoint, plus up to 20 per proxy (Aurora read-only ones reach the readers)", adjustable: false, source: SOURCES.proxy },
    { label: "Secrets", value: "Up to 200 Secrets Manager secrets (database users) per proxy", adjustable: false, source: SOURCES.proxy, note: "Not simulated." },
    { label: "Pinning", value: "Any statement over 16 KB pins the session", adjustable: false, source: SOURCES.proxyPinning, note: "Pinning is a share of sessions here." },
    { label: "Client connection life", value: "24 hours at most", adjustable: false, source: SOURCES.proxyConnections },
    { label: "Reserved connections", value: "The proxy reserves some database connections for monitoring", adjustable: false, source: SOURCES.proxyConnections, note: "AWS doesn't say how many; not simulated." },
    { label: "Failover", value: "Up to 66% faster for Aurora Multi-AZ, by bypassing DNS caches", adjustable: false, source: SOURCES.proxyConcepts },
    { label: "Availability Zones", value: "Runs in a VPC with at least two subnets in different Availability Zones", adjustable: false, source: SOURCES.proxyNetwork, note: "A zone outage doesn't take the proxy down." }
  ],
  highlights: [
    { gauge: "borrowed", label: "db conns" },
    { gauge: "waiting", label: "waiting" },
    { rate: "borrowTimeouts", label: "timeouts/s" }
  ],
  config: ProxyConfig,
  ports: { out: Component.port.one("Database") },
  // A proxy runs in the subnets of several Availability Zones (at least two: rds-proxy-network-prereqs): losing one
  // doesn't take it down, whatever zone its node is drawn in.
  handlesZoneFaults: true,
  state: Schema.Struct({
    /** Database connections the proxy may have in use: `MaxConnectionsPercent` of `max_connections`. */
    limit: Schema.Number,
    /** Database connections in use: requests running, and pinned sessions holding one. */
    borrowed: Schema.Number,
    /** Requests waiting for a database connection. */
    waiting: Schema.Number,
    /** Idle client connections holding a pinned database connection. */
    pinned: Schema.Number,
    /** Database connections the proxy has open (busy and idle), as the database counts them. */
    databaseConnections: Schema.Number,
    /** Client connections open to the proxy. */
    clientConnections: Schema.Number,
    /** Whether the database is answering: false while it fails over. */
    targetUp: Schema.Boolean,
    requests: Schema.Number,
    /** Requests that had to wait for a database connection. */
    queued: Schema.Number,
    borrowTimeouts: Schema.Number,
    /** Requests the proxy held on to and tried again because the database was failing over. */
    retried: Schema.Number,
    clientConnects: Schema.Number,
    pinnedSessions: Schema.Number
  }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const stats = makeProxyStats(node.meter)
      const proxy: ProxyRuntime = new ProxyRuntime(node.id, fast, node.out("out")[0], stats, (): boolean => proxy.target()?.mysql() ?? true)
      /** What the connectors of its clients reach it by. */
      const offer: Endpoint = { kind: "rds.proxy", attach: (key, policy) => proxy.attach(key, policy) }
      yield* Effect.addFinalizer(() => Effect.sync(() => proxy.stop()))

      // Idle client connections close at the idle timeout whether or not anything calls (a pinned one frees its slot).
      const sweep = (): void => {
        proxy.clientServer.sweep(fast.now())
        fast.after(1_000, sweep, undefined)
      }
      fast.after(1_000, sweep, undefined)

      const limit = (): number => {
        const n = proxy.limit()
        return n === Number.POSITIVE_INFINITY ? 0 : n
      }
      node.meter.gaugeUnsafe("borrowed", () => proxy.slots.running)
      node.meter.gaugeUnsafe("waiting", () => proxy.slots.queued)
      node.meter.gaugeUnsafe("limit", limit)
      node.meter.gaugeUnsafe("pinned", () => proxy.pinnedHeld)
      node.meter.gaugeUnsafe("clientConnections", () => proxy.clientServer.open)
      node.meter.gaugeUnsafe("databaseConnections", () => proxy.target()?.connections(proxy.key) ?? 0)
      node.meter.gaugeUnsafe("targetUp", () => (proxy.targetUp ? 1 : 0))

      return {
        offer,
        call: (message) =>
          Effect.callback<Reply, CallFailure>((resume) => {
            const cancel = forward(proxy, message, (failure) => resume(failure === undefined ? Effect.void : Effect.fail(failure)))
            return Effect.sync(cancel)
          }),
        probe: Effect.sync(() => {
          const t = totals(stats.count)
          return {
            limit: limit(),
            borrowed: proxy.slots.running,
            waiting: proxy.slots.queued,
            pinned: proxy.pinnedHeld,
            databaseConnections: proxy.target()?.connections(proxy.key) ?? 0,
            clientConnections: proxy.clientServer.open,
            targetUp: proxy.targetUp,
            requests: t.requests,
            queued: t.queued,
            borrowTimeouts: t.borrowTimeouts,
            retried: t.retried,
            clientConnects: t.clientConnects,
            pinnedSessions: t.pinnedSessions
          }
        })
      }
    })
})
