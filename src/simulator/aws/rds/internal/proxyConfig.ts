import { Schema } from "effect"
import * as Setting from "../../../Setting.ts"
import { PROXY_BORROW_TIMEOUT_MAX, PROXY_CLIENT_MAX_LIFE, SOURCES } from "./limits.ts"

const Hard = Setting.hard

/** An RDS Proxy's settings: its target group's connection pool, and what it does with client connections. */
export const ProxyConfig = Schema.Struct({
  maxConnectionsPercent: Setting.int({
    default: 100,
    min: 1,
    max: 100,
    unit: "%",
    label: "Connection pool maximum connections",
    help: "MaxConnectionsPercent: the most database connections the proxy opens, as a share of the database's max_connections. Set it below 100 to leave room for other clients of the database. AWS recommends at least 20 (30 on a db.t3.small).",
    limit: Hard(SOURCES.proxyPool)
  }),
  maxIdleConnectionsPercent: Setting.int({
    default: 50,
    min: 0,
    max: 100,
    unit: "%",
    label: "Maximum idle connections",
    help: "MaxIdleConnectionsPercent: database connections the proxy keeps open while idle, as a share of max_connections; beyond it, connections idle for five minutes are closed. At most MaxConnectionsPercent (clamped). AWS's default is half of MaxConnectionsPercent: 50 here.",
    limit: Hard(SOURCES.proxyPool)
  }),
  borrowTimeout: Setting.duration({
    default: "120 seconds",
    min: 0,
    max: PROXY_BORROW_TIMEOUT_MAX,
    label: "Connection borrow timeout",
    help: "How long a request waits for a database connection when the pool is at its maximum and all are busy, or while the database fails over, before it gets 'Timed-out waiting to acquire database connection'.",
    limit: Hard(SOURCES.proxyPool)
  }),
  idleClientTimeout: Setting.duration({
    default: "30 minutes",
    min: "1 second",
    max: PROXY_CLIENT_MAX_LIFE,
    label: "Idle client connection timeout",
    help: "The proxy closes a client connection idle this long. Default 1,800 seconds. AWS states no range; the proxy ends every client connection after 24 hours, so that is the maximum here.",
    limit: Hard(SOURCES.proxyConnections)
  }),
  endpoint: Setting.choice(["read-write", "read-only"], {
    default: "read-write",
    labels: { "read-write": "Read/write (the writer)", "read-only": "Read-only (the readers)" },
    help: "The proxy endpoint its clients use: the default one reaches the writer; a read-only endpoint reaches an Aurora cluster's readers."
  }),
  pinning: Setting.ratio({
    default: 0,
    label: "Pinned sessions",
    help: "Share of client sessions that do something the proxy can't multiplex (session variables, prepared statements, temporary tables, a statement over 16 KB). A pinned session keeps its database connection until the client connection closes, so a client that keeps connections open ties up one database connection each."
  }),
  latency: Setting.latency({
    mean: "1 millis",
    cv: 0.3,
    label: "Proxy latency",
    help: "What the proxy's hop adds to each request, on top of the network. AWS publishes no figure; an assumption."
  }),
  clientHandshake: Setting.latency({
    mean: "15 millis",
    cv: 0.4,
    label: "Client handshake",
    help: "Opening a client connection to the proxy: TLS and authentication, which the proxy handles instead of the database. An assumption."
  }),
  targetCheck: Setting.duration({
    default: "1 second",
    min: "100 millis",
    max: "1 minute",
    label: "Target check interval",
    help: "While the database is unavailable (failing over), how often the proxy tries it again; requests wait meanwhile. AWS says the proxy monitors its targets actively but not how often; an assumption."
  })
})

export type ProxyConfig = typeof ProxyConfig.Type
