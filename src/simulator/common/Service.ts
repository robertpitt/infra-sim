import { Duration, Effect, Schema, Stream, SubscriptionRef } from "effect"
import * as Component from "../Component.ts"
import * as Distribution from "../Distribution.ts"
import * as Flow from "../Flow.ts"
import { type CallFailure, Failed, type Reply, Unavailable } from "../Message.ts"
import { Slots } from "../kit/Slots.ts"
import * as Setting from "../Setting.ts"
import type { TimerHandle } from "../VirtualTime.ts"

export const Config = Schema.Struct({
  replicas: Setting.int({
    default: 2,
    min: 0,
    max: 10_000,
    unit: "replicas",
    label: "Replicas",
    help: "Copies of the service running. Added ones take the start-up time to become ready; removed ones finish what they are doing. An autoscaler (a target-tracking controller) can drive this."
  }),
  concurrency: Setting.int({ default: 10, min: 1, max: 10_000, unit: "requests", label: "Requests per replica", help: "How many requests one replica works on at once: its threads, or its event loop's practical limit." }),
  serviceTime: Setting.latency({ mean: "50 millis", cv: 0.5, label: "Service time", help: "How long a request keeps a worker busy, before any downstream calls." }),
  queueLimit: Setting.int({
    default: 100,
    min: 0,
    max: 10_000_000,
    unit: "requests",
    label: "Queue limit",
    help: "Requests that may wait for a free worker. Beyond it they are refused at once with 503. 0 refuses whenever every worker is busy."
  }),
  startup: Setting.duration({ default: "20 seconds", min: 0, max: "30 minutes", label: "Start-up time", help: "How long a new replica takes to become ready: scheduling, pulling the image, booting, passing its readiness check." }),
  errorRate: Setting.ratio({ default: 0, label: "Error rate", help: "Fraction of requests that fail after being worked on." }),
  fanOut: Setting.choice(["sequential", "parallel", "weighted", "none"], {
    default: "sequential",
    label: "Downstream calls",
    help: "After its own work, call every output one after another, all at once, pick one by weight, or call none."
  })
})

/**
 * A service of identical replicas behind a load balancer: a Kubernetes Deployment, an ECS service, a fleet of VMs, a
 * team of people taking tickets. Nothing in it belongs to one provider; it is the plain M/M/c queue that most systems are
 * made of, with the part that makes scaling interesting: replicas take time to start.
 *
 * Requests wait in one line for a free worker (`replicas × concurrency` of them), each keeps a worker busy for the service
 * time, then calls downstream. The line has a limit, past which requests are refused (503). Its gauges are what an
 * autoscaler watches. `busy` per replica is what a Kubernetes horizontal autoscaler's CPU target stands in for, and it
 * counts a replica that is still starting as idle, as the autoscaler does, so tracking it doesn't overshoot while new
 * replicas start. (`utilization`, busy over *ready* workers, does: every decision during a start-up sees the old replicas
 * saturated and adds more.) `queued` is a backlog to track per replica.
 */
export const Service = Component.make({
  type: "common.service",
  provider: "internet",
  service: "Service",
  title: "Service",
  description: "Identical replicas behind a load balancer, each working on a few requests at once, with a queue in front and a start-up time for new replicas.",
  category: "compute",
  icon: "cpu",
  accent: "#5a9bd5",
  highlights: [
    { gauge: "ready", label: "ready" },
    { gauge: "utilization", label: "busy", format: "percent" },
    { gauge: "queued", label: "queued" }
  ],
  config: Config,
  ports: { out: Component.port.many("Downstream") },
  state: Schema.Struct({
    /** Replicas ready to serve. */
    ready: Schema.Number,
    /** Replicas still starting. */
    starting: Schema.Number,
    busy: Schema.Number,
    queued: Schema.Number,
    served: Schema.Number,
    errors: Schema.Number,
    refused: Schema.Number
  }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const out = node.out("out")
      let ready = Math.max(0, fast.settings().replicas)
      /** Replicas starting, each with the timer that makes it ready. */
      const starting: Array<TimerHandle> = []
      const totals = { served: 0, errors: 0, refused: 0 }
      const workers = new Slots(() => ready * fast.settings().concurrency, () => fast.settings().queueLimit)

      /** Bring the replicas to what the settings ask: start the missing ones, stop the extra ones. */
      const rescale = (): void => {
        const want = Math.max(0, fast.settings().replicas)
        while (ready + starting.length < want) {
          const timer = fast.after(Duration.toMillis(fast.settings().startup), becameReady, undefined)
          starting.push(timer)
        }
        // Fewer wanted: stop starting ones first, then ready ones (their running requests finish).
        while (ready + starting.length > want && starting.length > 0) starting.pop()!.cancel()
        if (ready > want) ready = want
      }
      const becameReady = (): void => {
        starting.shift()
        ready++
        workers.kick()
      }

      // Settings edited while running (by a person, or an autoscaler) apply at once: replicas start or stop, and more
      // workers per replica take waiting requests.
      yield* node.spawn(
        SubscriptionRef.changes(node.config).pipe(
          Stream.runForEach(() =>
            Effect.sync(() => {
              rescale()
              workers.kick()
            })
          )
        )
      )

      node.meter.gaugeUnsafe("replicas", () => fast.settings().replicas)
      node.meter.gaugeUnsafe("ready", () => ready)
      node.meter.gaugeUnsafe("starting", () => starting.length)
      node.meter.gaugeUnsafe("busy", () => workers.running)
      node.meter.gaugeUnsafe("queued", () => workers.queued)
      node.meter.gaugeUnsafe("utilization", () => {
        const capacity = ready * fast.settings().concurrency
        return capacity === 0 ? (workers.running > 0 ? 1 : 0) : Math.min(1, workers.running / capacity)
      })

      return {
        call: (message) =>
          Effect.callback<Reply, CallFailure>((resume) => {
            let cancelWork: Flow.Cancel = Flow.noCancel
            let finished = false
            const work = (): void => {
              const c = fast.settings()
              const timer = fast.after(Distribution.latencyMs(c.serviceTime, fast.random), () => {
                if (finished) return
                // The worker's own part is done: it is free for the next request while this one calls downstream.
                workers.release()
                if (c.errorRate > 0 && fast.random.nextDoubleUnsafe() < c.errorRate) {
                  finished = true
                  totals.errors++
                  return resume(Effect.fail(Failed({ node: node.id, reason: "500 internal server error" })))
                }
                cancelWork = Flow.fanOut(c.fanOut, out, fast.random, message, (failure) => {
                  finished = true
                  if (failure !== undefined) {
                    totals.errors++
                    return resume(Effect.fail(Failed({ node: node.id, reason: `downstream: ${failure._tag}` })))
                  }
                  totals.served++
                  resume(Effect.void)
                })
              }, undefined)
              cancelWork = () => {
                timer.cancel()
                workers.release()
              }
            }
            const leave = workers.acquire(work)
            if (leave === undefined) {
              totals.refused++
              resume(Effect.fail(Unavailable({ node: node.id, reason: "503 every worker busy and the queue full" })))
              return Effect.void
            }
            return Effect.sync(() => {
              if (finished) return
              finished = true
              leave()
              cancelWork()
            })
          }),
        probe: Effect.sync(() => ({ ready, starting: starting.length, busy: workers.running, queued: workers.queued, ...totals }))
      }
    })
})
