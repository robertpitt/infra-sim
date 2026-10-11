import { Duration, Effect, Schema } from "effect"
import * as Component from "../Component.ts"
import * as Distribution from "../Distribution.ts"
import { Family, keyOf } from "../Family.ts"
import * as Flow from "../Flow.ts"
import { type CallFailure, Failed, type Reply, Unavailable } from "../Message.ts"
import { Slots } from "../kit/Slots.ts"
import * as Setting from "../Setting.ts"

export const Config = Schema.Struct({
  objects: Setting.int({
    default: 1_000,
    min: 1,
    max: 100_000_000,
    unit: "objects",
    label: "Objects",
    help: "How many distinct objects the traffic is spread over. A request's partition key picks its object, so a client's hot keys are hot objects."
  }),
  concurrency: Setting.int({
    default: 1,
    min: 1,
    max: 10_000,
    unit: "requests",
    label: "Requests at once per object",
    help: "1 is single-threaded: an object's requests run one after another, as a Durable Object's or an actor's do. Everything an object can do is bounded by this."
  }),
  handlerTime: Setting.latency({ mean: "5 millis", cv: 0.5, label: "Handler time", help: "How long one request keeps its object busy, before any downstream call." }),
  holdDuringDownstream: Setting.bool({
    default: true,
    label: "Busy while calling downstream",
    help: "Keep the object busy while it waits on its downstream calls, as a Durable Object's input gate holds other requests while it waits on its storage. Off: the object takes its next request while the call is in flight."
  }),
  queueLimit: Setting.int({
    default: 100,
    min: 0,
    max: 1_000_000,
    unit: "requests",
    label: "Queue limit per object",
    help: "Requests that may wait for one object. Beyond it they are refused at once (503, overloaded), as Durable Objects refuse an object whose queue is too long."
  }),
  coldStart: Setting.latency({ mean: "15 millis", cv: 0.5, label: "Cold start", help: "Making an object that isn't in memory: starting it and loading its state. Its first requests wait for it." }),
  idle: Setting.duration({
    default: "30 seconds",
    min: "1 millis",
    max: "1 day",
    label: "Evicted after idle",
    help: "An object with nothing to do for this long is evicted from memory; the next request to it starts it again, cold."
  }),
  errorRate: Setting.ratio({ default: 0, label: "Error rate", help: "Fraction of requests that fail in the handler." }),
  fanOut: Setting.choice(["sequential", "parallel", "weighted", "none"], {
    default: "sequential",
    label: "Downstream calls",
    help: "After the handler: call every output one after another (its storage, say), all at once, pick one by weight, or call none."
  })
})

/** One object: its thread(s) and the line of requests waiting for it, and when it is ready after a cold start. */
interface Instance {
  readonly slots: Slots
  readonly readyAt: number
}

/** How many of the busiest objects the probe lists. */
const HOTTEST = 5

/**
 * A family of objects addressed by key, each with its own state and its own single thread: Durable Objects, actors
 * (Orleans grains, Akka actors), a per-user session. One logical node that is really many instances, made on first use
 * and evicted when idle (see `Family`).
 *
 * What it shows is what such systems are for and where they hurt: work for different keys runs side by side however
 * much there is, while work for one key runs one request at a time, so a hot key's throughput is capped at one object's
 * pace (about 1 / handler time) and its queue, and only its queue, grows. Cold starts follow the key distribution: many
 * keys touched rarely means many cold starts. Its durable state, if it has any, is a separate store node wired to its
 * output, which is why it can be held busy while it calls downstream.
 */
export const Actor = Component.make({
  type: "common.actor",
  provider: "internet",
  service: "Actor",
  title: "Actors (keyed objects)",
  description:
    "A family of single-threaded objects addressed by key, made on first use and evicted when idle: Durable Objects, actors, per-user sessions. Different keys run side by side; one key runs one request at a time.",
  category: "compute",
  icon: "share",
  accent: "#e07a5f",
  highlights: [
    { gauge: "instances", label: "in memory" },
    { gauge: "queued", label: "queued" },
    { rate: "coldStarts", label: "cold/s" }
  ],
  config: Config,
  ports: { out: Component.port.many("Downstream") },
  state: Schema.Struct({
    /** Objects in memory. */
    instances: Schema.Number,
    /** Requests waiting for their object, over all objects. */
    queued: Schema.Number,
    coldStarts: Schema.Number,
    evictions: Schema.Number,
    served: Schema.Number,
    errors: Schema.Number,
    /** Refused because their object's queue was full. */
    overloaded: Schema.Number,
    /** The objects with the longest queues right now. */
    hottest: Schema.Array(Schema.Struct({ object: Schema.String, queued: Schema.Number, running: Schema.Number }))
  }),
  make: (node) =>
    Effect.sync(() => {
      const { fast } = node
      const out = node.out("out")
      const totals = { served: 0, errors: 0, overloaded: 0 }
      let queued = 0
      const coldStarts = node.meter.counter("coldStarts")
      const overloaded = node.meter.counter("overloaded")

      const objects = new Family<Instance>({
        now: fast.now,
        idleMs: () => Duration.toMillis(fast.settings().idle),
        create: () => ({
          slots: new Slots(() => fast.settings().concurrency, () => fast.settings().queueLimit),
          readyAt: fast.now() + Distribution.latencyMs(fast.settings().coldStart, fast.random)
        })
      })

      node.meter.gaugeUnsafe("instances", () => objects.size)
      node.meter.gaugeUnsafe("queued", () => queued)

      return {
        call: (message) =>
          Effect.callback<Reply, CallFailure>((resume) => {
            const c = fast.settings()
            const key = keyOf(message.key, c.objects)
            const { instance: obj, cold } = objects.enter(key)
            if (cold) coldStarts.n++
            let left = false
            let finished = false
            let waiting = true
            let holding = false
            let cancelWork: Flow.Cancel = Flow.noCancel
            /** Give the object back (once), and the family its count of work in progress (once). */
            const letGo = (): void => {
              if (holding) {
                holding = false
                obj.slots.release()
              }
            }
            const leave = (): void => {
              letGo()
              if (left) return
              left = true
              objects.leave(key)
            }
            const end = (failure: CallFailure | undefined): void => {
              if (finished) return
              finished = true
              leave()
              if (failure === undefined) {
                totals.served++
                return resume(Effect.void)
              }
              totals.errors++
              resume(Effect.fail(failure))
            }
            const work = (): void => {
              if (waiting) {
                waiting = false
                queued--
              }
              holding = true
              const s = fast.settings()
              // An object still starting up keeps its first requests waiting until it is ready.
              const ms = Math.max(0, obj.readyAt - fast.now()) + Distribution.latencyMs(s.handlerTime, fast.random)
              const timer = fast.after(ms, () => {
                if (finished) return
                if (s.errorRate > 0 && fast.random.nextDoubleUnsafe() < s.errorRate) return end(Failed({ node: node.id, reason: "500 internal error" }))
                if (!s.holdDuringDownstream) letGo()
                cancelWork = Flow.fanOut(s.fanOut, out, fast.random, message, (failure) =>
                  end(failure === undefined ? undefined : Failed({ node: node.id, reason: `downstream: ${failure._tag}` })))
              }, undefined)
              cancelWork = () => timer.cancel()
            }
            queued++
            const giveUp = obj.slots.acquire(work)
            if (giveUp === undefined) {
              queued--
              waiting = false
              finished = true
              leave()
              totals.overloaded++
              overloaded.n++
              resume(Effect.fail(Unavailable({ node: node.id, reason: "503 object overloaded: its queue is full" })))
              return Effect.void
            }
            return Effect.sync(() => {
              if (finished) return
              finished = true
              if (waiting) {
                waiting = false
                queued--
                giveUp()
              }
              cancelWork()
              leave()
            })
          }),
        probe: Effect.sync(() => {
          const hottest: Array<{ object: string; queued: number; running: number }> = []
          objects.forEach((obj, key) => {
            if (obj.slots.queued > 0 || obj.slots.running > 0) hottest.push({ object: key, queued: obj.slots.queued, running: obj.slots.running })
          })
          hottest.sort((a, b) => b.queued - a.queued || b.running - a.running)
          return {
            instances: objects.size,
            queued,
            coldStarts: objects.created,
            evictions: objects.evictions,
            ...totals,
            hottest: hottest.slice(0, HOTTEST)
          }
        })
      }
    })
})
