import { Duration, Effect, Schema } from "effect"
import * as Component from "../Component.ts"
import * as Edge from "../Edge.ts"
import { type CallFailure, failureCounter, type Message } from "../Message.ts"
import * as Setting from "../Setting.ts"

/** Longest the generator naps before re-reading its settings, so edits (a scenario changing the rate) take effect promptly. */
const MAX_NAP = Duration.millis(500)

const Config = Schema.Struct({
  rps: Setting.number({ default: 100, min: 0, max: 100_000, step: 10, unit: "req/s", label: "Request rate" }),
  arrival: Setting.choice(["poisson", "constant"], {
    default: "poisson",
    help: "Poisson: random, bursty arrivals like real users. Constant: evenly spaced."
  }),
  payload: Setting.number({ default: 1, min: 0.001, max: 100_000, step: 1, unit: "KB", label: "Request size", help: "Size of each request. Services enforce their own payload limits against it." }),
  hotKeys: Setting.ratio({
    default: 0,
    label: "Hot key share",
    help: "Fraction of requests that use the same partition key. Stores and streams partition by key, so a hot key can overload one partition while the rest sit idle."
  }),
  messageGroups: Setting.int({ default: 0, min: 0, max: 100_000, label: "FIFO message groups", help: "Spread requests across this many message groups (0 for none). FIFO queues process one message per group at a time." }),
  invocation: Setting.choice(["sync", "async"], { default: "sync", help: "How requests invoke what they call. Lambda queues async invocations and retries them; sync ones are answered or throttled at once." })
})

export const Client = Component.make({
  type: "common.client",
  provider: "internet",
  service: "Client",
  title: "Clients",
  description: "Generates traffic. When several edges leave it, requests are split between them by edge weight.",
  category: "traffic",
  icon: "users",
  accent: "#5aa2ff",
  inputs: false,
  highlights: [{ gauge: "inflight", label: "in flight" }],
  config: Config,
  state: Schema.Struct({ rate: Schema.Number, sent: Schema.Number, inflight: Schema.Number }),
  make: (node) =>
    Effect.sync(() => {
      const { fast } = node
      const links = node.out("out")
      const sentTotal = node.meter.counter("sent")
      const ok = node.meter.counter("ok")
      const failed = node.meter.counter("fail")
      const noRoute = node.meter.counter("noroute")
      const latency = node.meter.sampler("latency")
      const failures = new Map<string, { n: number }>()
      let sent = 0
      let inflight = 0
      node.meter.gaugeUnsafe("inflight", () => inflight)

      const done = (message: Message) => (failure: CallFailure | undefined) => {
        inflight--
        if (failure === undefined) {
          ok.n++
          latency.add(fast.now() - message.bornAt)
          return
        }
        failed.n++
        const name = failureCounter(failure)
        let counter = failures.get(name)
        if (counter === undefined) failures.set(name, (counter = node.meter.counter(name)))
        counter.n++
      }

      /** Send one request down one of the edges. */
      const emit = (): void => {
        const link = Edge.pickUnsafe(links, fast.random)
        if (link === undefined) {
          noRoute.n++
          return
        }
        const c = fast.settings()
        const hot = c.hotKeys > 0 && fast.random.nextDoubleUnsafe() < c.hotKeys
        const message = fast.mint({
          bytes: Math.round(c.payload * 1024),
          invocation: c.invocation,
          ...(hot ? { key: 0.1234 } : {}),
          ...(c.messageGroups > 0 ? { group: `g${Math.floor(fast.random.nextDoubleUnsafe() * c.messageGroups)}` } : {})
        })
        sentTotal.n++
        sent++
        inflight++
        link.send(message, done(message))
      }

      // Traffic is a chain of timers: work out the next arrival, wait for it, send, repeat. No fiber, no effects.
      const maxNap = Duration.toMillis(MAX_NAP)
      let last = fast.now()
      const arrive = (due: number): void => {
        // If we fell behind, don't try to catch up with a burst.
        const rate = fast.settings().rps
        last = rate > 0 ? Math.max(due, fast.now() - 1000 / rate) : fast.now()
        emit()
        step()
      }
      const nap = (): void => step()
      const step = (): void => {
        const t = fast.now()
        const c = fast.settings()
        const rate = c.rps
        if (!(rate > 0)) {
          last = t + 100
          fast.after(100, nap, undefined)
          return
        }
        if (c.arrival === "poisson") {
          // Memoryless, so napping and redrawing is statistically exact.
          const gap = -(1000 / rate) * Math.log(1 - fast.random.nextDoubleUnsafe())
          if (gap > maxNap) fast.after(maxNap, nap, undefined)
          else fast.after(gap, arrive, t)
        } else {
          const due = last + 1000 / rate
          const wait = due - t
          if (wait > maxNap) fast.after(maxNap, nap, undefined)
          else fast.after(Math.max(0, wait), arrive, due)
        }
      }
      fast.after(0, nap, undefined)

      return {
        probe: Effect.sync(() => ({ rate: fast.settings().rps, sent, inflight }))
      }
    })
})
