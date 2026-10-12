import { Duration, Effect, Schema } from "effect"
import * as Connector from "../../Connector.ts"
import type * as Dashboard from "../../Dashboard.ts"
import * as Edge from "../../Edge.ts"
import type { Message } from "../../Message.ts"
import * as Setting from "../../Setting.ts"
import type { ClientPolicy } from "./connections.ts"
import { SOURCES } from "./limits.ts"
import { databaseClient, proxyClient } from "./dashboard.ts"
import { asEndpoint, CLIENT_TAG } from "./endpoint.ts"

/**
 * How a caller handles its connections to a database or a proxy: what sits on every edge into one.
 *
 * Whether a caller opens a connection per request or keeps a pool is the single biggest thing about how it loads a
 * database, and it belongs to the caller, not to the database: a Lambda function that connects inside its handler, one
 * that connects once per execution environment, and a service with a connection pool all look different to the same
 * database. So it is a setting of the edge, here, beside the plain link's (timeout, retries, what the call does).
 */
export const ClientSettings = Setting.group(
  {
    connections: Setting.choice(["reused", "per-request"], {
      default: "reused",
      labels: { reused: "Kept open and reused", "per-request": "One per request" },
      help: "Kept open: a connection pool, or a Lambda function that connects outside its handler (one connection per execution environment). It is opened (handshake and all) only when no idle one is free, and stays open, counting against max_connections, until it has been idle for the idle timeout. One per request: a function that connects inside its handler pays the handshake on every request."
    }),
    idleTimeout: Setting.duration({
      default: "10 minutes",
      min: "1 second",
      max: "8 hours",
      label: "Idle timeout",
      help: "How long an idle connection stays open: a pool's idle timeout, or how long a Lambda execution environment lives idle (the connection goes with it). An assumption: pools and runtimes differ, and AWS doesn't publish Lambda's."
    }),
    hold: Setting.duration({
      default: 0,
      min: 0,
      max: "15 minutes",
      label: "Held besides the query",
      help: "How long the caller keeps its connection checked out around each query, besides the query itself. A database sees only the query, but a Lambda function holds its connection for its whole invocation (its execution environment's one connection, or the one it opened in its handler), so set this to the function's duration besides the query; a service that borrows from its pool just for the query leaves it at 0. This, more than anything, decides how many connections a caller needs: about its request rate times the time it holds each."
    }),
    endpoint: Setting.choice(["auto", "writer", "reader"], {
      default: "auto",
      labels: { auto: "Reads to the readers, writes to the writer", writer: "Writer (cluster endpoint)", reader: "Readers (reader endpoint)" },
      help: "Which endpoint the client connects to. With no readers the reader endpoint reaches the writer. A write sent to a reader is refused."
    }),
    dnsCache: Setting.duration({
      default: 0,
      min: 0,
      max: "1 hour",
      label: "DNS cache",
      help: "How long the client caches the endpoint's address. A failover moves the endpoint's DNS name to the new primary, and a client still caching the old address keeps failing to connect until its cache expires. 0: it looks the name up every time. AWS advises a JVM to cache for no more than 60 seconds. A proxy isn't affected: it follows the primary itself."
    })
  },
  { label: "Database client" }
)

type Client = typeof ClientSettings.Type

const policies = new WeakMap<Client, ClientPolicy>()

/** The policy an edge's settings describe, memoised on them (they change only when someone edits them). */
export const policyOf = (c: Client): ClientPolicy => {
  let p = policies.get(c)
  if (p === undefined) {
    p = {
      reuse: c.connections === "reused",
      idleMs: Duration.toMillis(c.idleTimeout),
      holdMs: Duration.toMillis(c.hold),
      keepIdle: 0,
      endpoint: c.endpoint,
      dnsCacheMs: Duration.toMillis(c.dnsCache)
    }
    policies.set(c, p)
  }
  return p
}

/**
 * What a caller that says nothing about itself does (an edge into a database with another connector on it): the same as
 * an edge with this connector left at its defaults.
 */
export const DEFAULT_POLICY: ClientPolicy = policyOf(Schema.decodeUnknownSync(Schema.Struct({ client: ClientSettings }))({}).client)

const Config = Schema.Struct({ ...Edge.Policy.fields, client: ClientSettings })

/** What the call looks like is a property of the connection: what it does, and how much it carries (as the plain link). */
const shape = (m: Message, c: Edge.Policy, group: string): Message => ({
  ...m,
  group,
  operation: c.request.operation === "caller" ? m.operation : c.request.operation,
  ...(c.request.payload > 0 ? { bytes: c.request.payload * 1024 } : {})
})

const clientOf = (type: string, component: string, title: string, description: string, dashboard: Dashboard.Dashboard) =>
  Connector.make({
    type,
    provider: "aws",
    title,
    description,
    dashboard,
    icon: "database",
    docs: SOURCES.proxy,
    from: { protocol: "invoke" },
    to: { protocol: "invoke", component },
    config: Config,
    make: (ctx) =>
      Effect.sync(() => {
        const { fast, sink } = ctx
        const key = `${CLIENT_TAG}${ctx.id}`
        // Nodes are made before connectors, so the endpoint, if it is one of ours, is there to be told about this client.
        // It counts this client's new and refused connections on the edge, and the edge reads its open ones from it.
        const counters = { opened: ctx.meter.counter("connectionsOpened"), refused: ctx.meter.counter("connectionsRefused") }
        const connections = asEndpoint(ctx.offer())?.attach(key, () => policyOf(fast.settings().client), counters)
        if (connections !== undefined) {
          ctx.meter.gaugeUnsafe("connections", connections.open)
          ctx.meter.gaugeUnsafe("connectionsInUse", connections.busy)
        }
        return {
          send: (message, done) => {
            const c = fast.settings()
            return sink.call(shape(message, c, key), Edge.policyOf(c), done)
          }
        }
      })
  })

export const DatabaseClient = clientOf(
  "aws.rds.client",
  "aws.rds",
  "Database client",
  "A caller's connections to a database: one per request, or kept open and reused (a pool, or one per Lambda environment), on top of the plain link's timeout and retries.",
  databaseClient
)

export const ProxyClient = clientOf(
  "aws.rds-proxy.client",
  "aws.rds-proxy",
  "Proxy client",
  "A caller's connections to an RDS Proxy: one per request, or kept open and reused, on top of the plain link's timeout and retries.",
  proxyClient
)

/**
 * The proxy's own connections to its database. The proxy pools and tags them itself (see `Proxy.ts`), and forwards
 * what its clients asked, so this edge carries only how long the proxy waits and whether it retries: not what the call
 * does, which a plain link would set.
 */
export const ProxyTarget = Connector.make({
  type: "aws.rds-proxy.target",
  provider: "aws",
  title: "Proxy connection pool",
  description: "An RDS Proxy's pooled connections to its database. The pool's size and behaviour are the proxy's settings.",
  icon: "database",
  docs: SOURCES.proxyConnections,
  from: { protocol: "invoke", component: "aws.rds-proxy" },
  to: { protocol: "invoke", component: "aws.rds" },
  config: Schema.Struct({ timeout: Edge.Policy.fields.timeout, cancelOnTimeout: Edge.Policy.fields.cancelOnTimeout, retry: Edge.Policy.fields.retry }),
  make: (ctx) => Effect.sync(() => ({ send: (message, done) => ctx.sink.call(message, Edge.policyOf(ctx.fast.settings()), done) }))
})
