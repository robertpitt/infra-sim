import { Effect, Schema } from "effect"
import * as Connector from "../../Connector.ts"
import * as Edge from "../../Edge.ts"
import type { Message } from "../../Message.ts"
import * as Setting from "../../Setting.ts"
import { docs } from "../docs.ts"
import { TCP_CONNECT_TIMEOUT_MS } from "./config.ts"

/**
 * What a call does once DNS has named the endpoint. A plain link would make every call through it a write (an edge's
 * default) whatever the caller asked; a client that resolved a name and then made a GET is still making a GET.
 */
const request = Setting.group(
  {
    operation: Setting.choice(["caller", "read", "write"], {
      default: "caller",
      labels: { caller: "What the caller asked (read or write)", read: "Read", write: "Write" },
      help: "What the call does to the endpoint. By default it is whatever the caller sent: Route 53 only answered the name."
    }),
    payload: Setting.int({
      default: 0,
      min: 0,
      max: 1_000_000,
      unit: "KB",
      label: "Payload size",
      help: "Size of what this call carries. 0 keeps the size the caller gave it."
    })
  },
  { label: "Request" }
)

export const ConnectionPolicy = Schema.Struct({
  request,
  timeout: Edge.Policy.fields.timeout,
  cancelOnTimeout: Edge.Policy.fields.cancelOnTimeout,
  retry: Edge.Policy.fields.retry
})
type ConnectionPolicy = typeof ConnectionPolicy.Type

/**
 * A health checker's request: one try, never retried, given up on after the longest any checker waits (a TCP check's
 * 10 seconds). The record itself judges an HTTP check against its shorter deadline and abandons it then.
 */
const PROBE = Edge.within(TCP_CONNECT_TIMEOUT_MS)

const shape = (m: Message, c: ConnectionPolicy): Message => {
  const operation = c.request.operation === "caller" ? m.operation : c.request.operation
  return operation === m.operation && c.request.payload === 0
    ? m
    : { ...m, operation, ...(c.request.payload > 0 ? { bytes: c.request.payload * 1024 } : {}) }
}

/**
 * The caller's own connection to the endpoint a Route 53 record named. Route 53 answers the name and is then out of
 * the path, so this is the call the caller makes: its operation, timeout and retries. Health checks from the record
 * cross the same edge (the endpoint, its region and the network between are what they test), as one try each.
 */
export const Connection = Connector.make({
  type: "aws.route53.connection",
  provider: "aws",
  title: "Resolved connection",
  description: "The caller's own connection to the endpoint its DNS answer named: what it asked for, with its timeout and retries. Route 53's health checks cross it too.",
  icon: "dns",
  docs: `${docs.route53}welcome-dns-service.html`,
  from: { protocol: "invoke", component: "aws.route53", port: "out" },
  to: { protocol: "invoke" },
  config: ConnectionPolicy,
  make: (ctx) =>
    Effect.sync(() => {
      const { fast, sink } = ctx
      return {
        send: (message, done) => {
          // Only health checks start at the record itself; everything else came from a caller.
          if (message.origin === ctx.from) return sink.call(message, PROBE, done)
          const c = fast.settings()
          return sink.call(shape(message, c), Edge.policyOf(c), done)
        }
      }
    })
})
