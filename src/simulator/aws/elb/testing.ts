import { Duration, Effect, Schema, type Scope, Stream, SubscriptionRef } from "effect"
import * as Builder from "../../Builder.ts"
import * as Component from "../../Component.ts"
import { builtins, providers } from "../../components/registry.ts"
import type * as Design from "../../Design.ts"
import { codec } from "../../Design.ts"
import * as Distribution from "../../Distribution.ts"
import { Fleet, type Job } from "../../fleet/Fleet.ts"
import { type Call, type CallFailure, Failed, type Message, type Reply, Unavailable } from "../../Message.ts"
import type { Unit } from "../../Protocol.ts"
import * as Registry from "../../Registry.ts"
import * as Setting from "../../Setting.ts"
import * as Simulation from "../../Simulation.ts"
import type { Counter } from "../../Telemetry.ts"
import { VirtualTime } from "../../VirtualTime.ts"

/**
 * A fleet for the load balancers' tests, placed in an AWS Region so it shares the load balancer's zones (a `common.service`
 * lives outside AWS, with zones of its own). Each unit serves `workers` calls at a time for the service time; the first
 * unit can be made slower; every call is counted per unit (`unit.<name>`) and by what it does (`op.read`, `op.write`).
 * Not in the registry: `sim` below adds it.
 */
export const TestFleet = Component.make({
  type: "test.elb-fleet",
  provider: "aws",
  title: "Test fleet",
  category: "compute",
  fleet: true,
  config: Schema.Struct({
    desired: Setting.int({ default: 3, min: 0, max: 1000 }),
    zones: Setting.int({ default: 3, min: 0, max: 6 }),
    workers: Setting.int({ default: 100, min: 1, max: 10_000 }),
    backlog: Setting.int({ default: 100, min: 0, max: 100_000 }),
    serviceTime: Setting.latency({ mean: "40 millis", cv: 0 }),
    slowFirst: Setting.number({ default: 1, min: 1, max: 100 }),
    errorRate: Setting.ratio({ default: 0 }),
    launch: Setting.duration({ default: "10 seconds", min: 0, max: "10 minutes" }),
    drain: Setting.duration({ default: "5 minutes", min: 0, max: "1 hour" }),
    detect: Setting.duration({ default: "10 minutes", min: 0, max: "1 hour" })
  }),
  ports: {},
  state: Schema.Struct({ serving: Schema.Number, lost: Schema.Number }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const ms = (d: Duration.Duration) => Duration.toMillis(d)
      const fleet = new Fleet(node, {
        desired: () => fast.settings().desired,
        zones: () => node.zones.all.slice(0, fast.settings().zones),
        phases: () => [{ name: "launch", ms: ms(fast.settings().launch) }],
        workers: () => fast.settings().workers,
        line: () => fast.settings().backlog,
        backlog: () => fast.settings().backlog,
        drain: () => ms(fast.settings().drain),
        detect: () => ms(fast.settings().detect),
        name: (id) => `u${id}`
      })
      const perUnit = new Map<number, Counter>()
      const counted = (unit: Unit): Counter => {
        let c = perUnit.get(unit.id)
        if (c === undefined) perUnit.set(unit.id, (c = node.meter.counter(`unit.${unit.name}`)))
        return c
      }
      const reads = node.meter.counter("op.read")
      const writes = node.meter.counter("op.write")
      let lost = 0
      const handle = (message: Message, unit: Unit | undefined): Call =>
        Effect.callback<Reply, CallFailure>((resume) => {
          let timer: { readonly cancel: () => void } | undefined
          const job: Job = {
            start: (ticket) => {
              const u = ticket.unit!
              counted(u).n++
              if (message.operation === "read") reads.n++
              else writes.n++
              const c = fast.settings()
              const slower = u.id === 1 ? c.slowFirst : 1
              timer = fast.after(Distribution.latencyMs(c.serviceTime, fast.random) * slower, () => {
                ticket.finish()
                if (c.errorRate > 0 && fast.random.nextDoubleUnsafe() < c.errorRate) resume(Effect.fail(Failed({ node: node.id, reason: "500 internal server error" })))
                else resume(Effect.void)
              }, undefined)
            },
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
      return {
        call: (message) => handle(message, undefined),
        fleet: fleet.offer((unit, message) => handle(message, unit)),
        probe: Effect.sync(() => ({ serving: fleet.serving, lost }))
      }
    })
})

/** A component that counts what reaches it (`op.read`, `op.write`) and answers after 10 ms: an IP target. */
export const TestEndpoint = Component.make({
  type: "test.elb-endpoint",
  provider: "aws",
  title: "Test endpoint",
  category: "compute",
  config: Schema.Struct({}),
  ports: {},
  make: (node) =>
    Effect.sync(() => {
      const reads = node.meter.counter("op.read")
      const writes = node.meter.counter("op.write")
      return {
        call: (message) =>
          Effect.callback<Reply, CallFailure>((resume) => {
            if (message.operation === "read") reads.n++
            else writes.n++
            const timer = node.fast.after(10, () => resume(Effect.void), undefined)
            return Effect.sync(() => timer.cancel())
          })
      }
    })
})

const extra = [TestFleet, TestEndpoint]
export const registry = Registry.make([...builtins, ...extra], providers)

const start = (doc: Design.Doc): Effect.Effect<Simulation.Service, never, Scope.Scope> =>
  Effect.gen(function*() {
    const design = yield* Schema.decodeUnknownEffect(codec(registry))(doc, { errors: "all" }).pipe(Effect.orDie)
    return yield* Simulation.make(design).pipe(Effect.provide(VirtualTime.layer), Effect.provide(Registry.Registry.layer([...builtins, ...extra], providers)), Effect.orDie)
  })

/** Run a test body against a fresh simulation of `doc`, with the test components available. */
export const sim = <A, E>(doc: Design.Doc, body: (sim: Simulation.Service) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(start(doc), body)))

/** The zone fault id for a zone of us-east-1, where the tests put everything. */
export const ZONE_A = "aws:us-east-1:us-east-1a"
export const zoneTarget = (zone: string) => ({ kind: "zone" as const, id: `aws:us-east-1:${zone}` })

interface Wiring {
  readonly lb?: "aws.alb" | "aws.nlb"
  readonly lbSettings?: Record<string, unknown>
  readonly rps?: number
  readonly client?: Record<string, unknown>
  readonly clientEdge?: Record<string, unknown>
  /** Fleets behind the load balancer: id → settings of the test fleet and of its edge (the target group). */
  readonly fleets?: Record<string, { readonly settings?: Record<string, unknown>; readonly edge?: Record<string, unknown> }>
  readonly seed?: number
}

/**
 * Clients (in us-east, outside AWS) → a load balancer `lb` → test fleets, all in a us-east-1 Region box. The target group
 * edges are `lb->` + the fleet id.
 */
export const balanced = (w: Wiring = {}): Builder.Builder & { readonly box: Builder.NodeRef; readonly lb: Builder.NodeRef } => {
  const b = Builder.make("elb", { seed: w.seed ?? 5 })
  const box = b.add("aws.region", { id: "box", settings: { region: "us-east-1" } })
  const web = b.add("common.client", { id: "web", region: "us-east", settings: { rps: w.rps ?? 300, arrival: "constant", ...w.client } })
  const lb = b.add(w.lb ?? "aws.alb", { id: "lb", parent: box, settings: w.lbSettings ?? {} })
  b.connect(web, lb, { timeout: "2 minutes", ...w.clientEdge }, { id: "web->lb" })
  for (const [id, f] of Object.entries(w.fleets ?? { fleet: {} })) {
    const node = b.add("test.elb-fleet", { id, parent: box, settings: f.settings ?? {} })
    b.connect(lb, node, f.edge ?? {}, { id: `lb->${id}` })
  }
  return Object.assign(b, { box, lb })
}
