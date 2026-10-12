import { Duration, Effect, Schema, type Scope, Stream, SubscriptionRef } from "effect"
import * as Component from "../Component.ts"
import { builtins, providers } from "../components/registry.ts"
import type * as Design from "../Design.ts"
import { codec } from "../Design.ts"
import * as Distribution from "../Distribution.ts"
import { type Call, type CallFailure, Failed, type Message, type Reply, Unavailable } from "../Message.ts"
import type { Unit } from "../Protocol.ts"
import * as Registry from "../Registry.ts"
import * as Setting from "../Setting.ts"
import * as Simulation from "../Simulation.ts"
import type { Counter } from "../Telemetry.ts"
import { VirtualTime } from "../VirtualTime.ts"
import { Fleet, type Job } from "./Fleet.ts"
import { isNoTarget } from "./TargetGroup.ts"

/**
 * Two small components built on the fleet core, for its tests and as the worked example in `README.md`: a fleet of
 * workers (`test.workers`, the shape an EC2, ECS or EKS component takes) and a load balancer in front of one
 * (`test.balancer`, the shape an ELB component takes). They are not in the registry; `sim` below adds them.
 */

export const WorkersConfig = Schema.Struct({
  desired: Setting.int({ default: 3, min: 0, max: 1000, label: "Desired units" }),
  zones: Setting.int({ default: 0, min: 0, max: 6, label: "Zones" }),
  workers: Setting.int({ default: 100, min: 1, max: 10_000, label: "Workers per unit" }),
  backlog: Setting.int({ default: 100, min: 0, max: 100_000, label: "Backlog per unit" }),
  serviceTime: Setting.latency({ mean: "40 millis", cv: 0, label: "Service time" }),
  /** The first unit launched is this many times slower than the others: one bad host. */
  slowFirst: Setting.number({ default: 1, min: 1, max: 100, label: "First unit slower by" }),
  launch: Setting.duration({ default: "5 seconds", min: 0, max: "10 minutes", label: "Launch" }),
  boot: Setting.duration({ default: "5 seconds", min: 0, max: "10 minutes", label: "Boot" }),
  grace: Setting.duration({ default: 0, min: 0, max: "10 minutes", label: "Health-check grace" }),
  drain: Setting.duration({ default: "30 seconds", min: 0, max: "1 hour", label: "Drain" }),
  detect: Setting.duration({ default: "1 minute", min: 0, max: "1 hour", label: "Notices a dead unit after" }),
  /** How many units the account lets it run at once. */
  quota: Setting.int({ default: 1000, min: 0, max: 100_000, label: "Account quota" }),
  interruptionsPerUnitHour: Setting.number({ default: 0, min: 0, max: 1000, label: "Interruptions per unit-hour" }),
  notice: Setting.duration({ default: "2 minutes", min: 0, max: "10 minutes", label: "Interruption notice" })
})

/**
 * A fleet of workers: each unit launches, boots, then serves calls with `workers` at a time for the service time. Every
 * unit's calls are counted on their own (`unit.<name>`), so a test can see how a balancer spread them.
 */
export const Workers = Component.make({
  type: "test.workers",
  title: "Workers",
  category: "compute",
  fleet: true,
  config: WorkersConfig,
  ports: {},
  state: Schema.Struct({ serving: Schema.Number, requested: Schema.Number, launched: Schema.Number, interrupted: Schema.Number, lost: Schema.Number }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const ms = (d: Duration.Duration) => Duration.toMillis(d)
      let used = 0
      const fleet = new Fleet(node, {
        desired: () => fast.settings().desired,
        zones: () => node.zones.all.slice(0, fast.settings().zones),
        phases: () => [
          { name: "launch", ms: ms(fast.settings().launch) },
          { name: "boot", ms: ms(fast.settings().boot) }
        ],
        grace: () => ms(fast.settings().grace),
        workers: () => fast.settings().workers,
        line: () => fast.settings().backlog,
        backlog: () => fast.settings().backlog,
        drain: () => ms(fast.settings().drain),
        detect: () => ms(fast.settings().detect),
        capacity: {
          take: () => used < fast.settings().quota && ++used > 0,
          give: () => void used--,
          retryMs: 5_000
        },
        name: (id) => `w${id}`,
        interruptions: () => ({ perUnitHour: fast.settings().interruptionsPerUnitHour, noticeMs: ms(fast.settings().notice) })
      })
      const perUnit = new Map<number, Counter>()
      const counted = (unit: Unit): Counter => {
        let c = perUnit.get(unit.id)
        if (c === undefined) perUnit.set(unit.id, (c = node.meter.counter(`unit.${unit.name}`)))
        return c
      }
      let lost = 0

      const handle = (_message: Message, unit: Unit | undefined): Call =>
        Effect.callback<Reply, CallFailure>((resume) => {
          let timer: { readonly cancel: () => void } | undefined
          const job: Job = {
            start: (ticket) => {
              const u = ticket.unit!
              counted(u).n++
              const c = fast.settings()
              const slower = u.id === 1 ? c.slowFirst : 1
              timer = fast.after(Distribution.latencyMs(c.serviceTime, fast.random) * slower, () => {
                ticket.finish()
                resume(Effect.void)
              }, undefined)
            },
            // The unit was lost with the call on it: the ticket is already finished.
            fail: (failure) => {
              timer?.cancel()
              lost++
              resume(Effect.fail(failure))
            }
          }
          const admitted = fleet.admit(job, unit)
          if (typeof admitted === "string") {
            resume(Effect.fail(Unavailable({ node: node.id, reason: admitted })))
            return Effect.void
          }
          return Effect.sync(() => {
            timer?.cancel()
            admitted.finish()
          })
        })

      yield* node.spawn(SubscriptionRef.changes(node.config).pipe(Stream.runForEach(() => Effect.sync(() => fleet.refresh()))))
      node.meter.gaugeUnsafe("serving", () => fleet.serving)
      node.meter.gaugeUnsafe("starting", () => fleet.pending)
      node.meter.gaugeUnsafe("draining", () => fleet.count.draining)
      node.meter.gaugeUnsafe("busy", () => fleet.busy)
      for (const zone of node.zones.all.slice(0, 3)) node.meter.gaugeUnsafe(`serving.${zone}`, () => fleet.servingIn(zone))

      return {
        call: (message) => handle(message, undefined),
        fleet: fleet.offer((unit, message) => handle(message, unit)),
        probe: Effect.sync(() => ({ serving: fleet.serving, requested: fleet.count.requested, launched: fleet.totals.launched, interrupted: fleet.totals.interrupted, lost }))
      }
    })
})

/**
 * A load balancer's listener, as little as there is of one: it forwards each request through its target group (the
 * connector on its edge) and turns what went wrong into what a client of a load balancer sees. No healthy target: 503;
 * the target didn't answer in time: 504; the target refused, reset or failed: 502. Counted as `lb.502` and so on.
 */
export const Balancer = Component.make({
  type: "test.balancer",
  title: "Balancer",
  category: "network",
  config: Schema.Struct({}),
  ports: { targets: Component.port.one("Target group") },
  make: (node) =>
    Effect.sync(() => {
      const [targets] = node.out("targets")
      const c502 = node.meter.counter("lb.502")
      const c503 = node.meter.counter("lb.503")
      const c504 = node.meter.counter("lb.504")
      return {
        call: (message) =>
          Effect.callback<Reply, CallFailure>((resume) => {
            if (targets === undefined) {
              c503.n++
              resume(Effect.fail(Unavailable({ node: node.id, reason: "503 no target group" })))
              return Effect.void
            }
            const cancel = targets.send(message, (failure) => {
              if (failure === undefined) return resume(Effect.void)
              if (isNoTarget(failure)) {
                c503.n++
                return resume(Effect.fail(Unavailable({ node: node.id, reason: "503 service unavailable" })))
              }
              if (failure._tag === "Timeout") {
                c504.n++
                return resume(Effect.fail(Failed({ node: node.id, reason: "504 gateway timeout" })))
              }
              c502.n++
              resume(Effect.fail(Failed({ node: node.id, reason: "502 bad gateway" })))
            })
            return Effect.sync(cancel)
          })
      }
    })
})

/** The built-in registry plus the two test components. */
export const registry = Registry.make([...builtins, Workers, Balancer], providers)

const start = (doc: Design.Doc): Effect.Effect<Simulation.Service, never, Scope.Scope> =>
  Effect.gen(function*() {
    const design = yield* Schema.decodeUnknownEffect(codec(registry))(doc, { errors: "all" }).pipe(Effect.orDie)
    return yield* Simulation.make(design).pipe(Effect.provide(VirtualTime.layer), Effect.provide(Registry.Registry.layer([...builtins, Workers, Balancer], providers)), Effect.orDie)
  })

/** Run a test body against a fresh simulation of `doc`, with the test components available. */
export const sim = <A, E>(doc: Design.Doc, body: (sim: Simulation.Service) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(start(doc), body)))
