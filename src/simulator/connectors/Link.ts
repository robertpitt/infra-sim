import { Effect } from "effect"
import * as Connector from "../Connector.ts"
import * as Edge from "../Edge.ts"
import type { Message } from "../Message.ts"

/**
 * The plain link: what every push gets unless something more specific fits.
 *
 * The source calls, the call crosses transport, and the link adds what a caller does about it: how long to wait
 * (timeout), whether to cancel or abandon the callee when it gives up, and whether to try again (retries with
 * exponential backoff and jitter). It also shapes the call (what it does to the receiver, how much it carries) and
 * carries a routing weight for sources that split traffic.
 */
export const Link = Connector.make({
  type: Connector.LINK,
  title: "Link",
  description: "A call from one component to another: network latency, a timeout, retries with backoff, and a routing weight.",
  icon: "chevron",
  from: { protocol: "invoke" },
  to: { protocol: "invoke" },
  config: Edge.Policy,
  make: (ctx) =>
    Effect.sync(() => {
      const { fast, sink } = ctx
      return {
        send: (message, done) => {
          const c = fast.settings()
          return sink.call(shape(message, c), Edge.policyOf(c), done)
        }
      }
    })
})

/** What the call looks like is a property of the connection: what it does, and how much it carries. */
const shape = (m: Message, c: Edge.Policy): Message =>
  m.operation === c.request.operation && c.request.payload === 0
    ? m
    : { ...m, operation: c.request.operation, ...(c.request.payload > 0 ? { bytes: c.request.payload * 1024 } : {}) }
