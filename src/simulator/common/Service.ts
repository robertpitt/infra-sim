import { Duration, Effect, Schema, Stream, SubscriptionRef } from "effect"
import * as Component from "../Component.ts"
import * as Distribution from "../Distribution.ts"
import { Fleet, type Job, type Ticket } from "../fleet/Fleet.ts"
import type { Link } from "../Edge.ts"
import * as Flow from "../Flow.ts"
import { type Call, type CallFailure, Failed, type Message, type Reply, Unavailable } from "../Message.ts"
import type { Unit } from "../Protocol.ts"
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
    help: "Requests that may wait for a free worker: in one line in front of the service when it is called directly, or in front of each replica when a load balancer (a target group) picks replicas. Beyond it they are refused at once with 503. 0 refuses whenever every worker is busy."
  }),
  startup: Setting.duration({ default: "20 seconds", min: 0, max: "30 minutes", label: "Start-up time", help: "How long a new replica takes to become ready: scheduling, pulling the image, booting, passing its readiness check." }),
  errorRate: Setting.ratio({ default: 0, label: "Error rate", help: "Fraction of requests that fail after being worked on." }),
  fanOut: Setting.choice(["sequential", "parallel", "weighted", "none"], {
    default: "sequential",
    label: "Downstream calls",
    help: "After its own work, call every output one after another, all at once, pick one by weight, or call none."
  }),
  zones: Setting.int({
    default: 0,
    min: 0,
    max: 6,
    unit: "zones",
    label: "Zones",
    help: "Spread the replicas evenly over this many zones of its region (the first ones: a, b, c...). A zone outage takes down the replicas there, and the service starts replacements in the other zones, then evens out again when the zone is back. 0: not spread, and no zone fault reaches it."
  }),
  replaceAfter: Setting.duration({
    default: "40 seconds",
    min: 0,
    max: "30 minutes",
    label: "Notices a lost replica after",
    help: "How long until the service notices on its own that a replica died (its zone went down) and starts another. An assumption: Kubernetes marks a node that stops reporting NotReady after 40 seconds. A target group's health checks may notice sooner."
  }),
  drain: Setting.duration({
    default: "30 seconds",
    min: 0,
    max: "1 hour",
    label: "Drain time",
    help: "How long a replica that is let go (scaled in, replaced) has to finish what it holds: it takes no new requests, stops as soon as it holds none, and is cut off when the time runs out. Kubernetes' default termination grace period is 30 seconds."
  })
})

type Settings = typeof Config.Type

/** What a request needs of its service, made once per node so that a request is one small object. */
interface RequestHost {
  readonly id: string
  readonly fast: Component.Fast<Settings>
  readonly out: ReadonlyArray<Link>
  readonly totals: { served: number; errors: number; refused: number; lost: number }
}

/**
 * One request's work, as a state machine with no closures of its own beyond the one downstream calls answer: a worker
 * starts it (`start`), the service time passes (`worked`), it calls downstream and is answered (`answered`); or its replica
 * is lost (`fail`), or its caller gives up (`abandon`).
 */
class Request implements Job {
  ticket: Ticket | undefined = undefined
  finished = false
  private timer: TimerHandle | undefined = undefined
  private downstream: Flow.Cancel | undefined = undefined

  constructor(
    private readonly host: RequestHost,
    private readonly message: Message,
    private readonly resume: (effect: Call) => void
  ) {}

  start(ticket: Ticket): void {
    this.ticket = ticket
    const { fast } = this.host
    this.timer = fast.after(Distribution.latencyMs(fast.settings().serviceTime, fast.random), worked, this)
  }

  /** The service time is over. */
  worked(): void {
    this.timer = undefined
    if (this.finished) return
    const { fast, totals, id } = this.host
    const c = fast.settings()
    // The worker's own part is done: it is free for the next request while this one calls downstream.
    this.ticket!.release()
    if (c.errorRate > 0 && fast.random.nextDoubleUnsafe() < c.errorRate) {
      this.finished = true
      this.ticket!.finish()
      totals.errors++
      return this.resume(Effect.fail(Failed({ node: id, reason: "500 internal server error" })))
    }
    this.downstream = Flow.fanOut(c.fanOut, this.host.out, fast.random, this.message, this.answered)
  }

  private readonly answered = (failure: CallFailure | undefined): void => {
    this.finished = true
    this.ticket!.finish()
    if (failure !== undefined) {
      this.host.totals.errors++
      return this.resume(Effect.fail(Failed({ node: this.host.id, reason: `downstream: ${failure._tag}` })))
    }
    this.host.totals.served++
    this.resume(Effect.void)
  }

  /** Its replica was lost with it (or its zone failed it, an injected error). The ticket is already finished. */
  fail(failure: CallFailure): void {
    if (this.finished) return
    this.finished = true
    this.stop()
    if (failure._tag === "Failed") this.host.totals.errors++
    else this.host.totals.lost++
    this.resume(Effect.fail(failure))
  }

  /** The caller gave up: give back the worker or the place in line, and stop the work (the callee doesn't keep going). */
  abandon(): void {
    if (this.finished) return
    this.finished = true
    this.ticket?.finish()
    this.stop()
  }

  private stop(): void {
    this.timer?.cancel()
    this.timer = undefined
    this.downstream?.()
  }
}

const worked = (request: Request): void => request.worked()

/**
 * A service of identical replicas behind a load balancer: a Kubernetes Deployment, an ECS service, a fleet of VMs, a
 * team of people taking tickets. Nothing in it belongs to one provider; it is the plain M/M/c queue that most systems are
 * made of, with the part that makes scaling interesting: replicas take time to start.
 *
 * It is built on the fleet core (`fleet/Fleet.ts`), so each replica is a unit of its own, with a zone, a life and its
 * workers. Called directly (a plain edge), requests wait in one line for a free worker (`replicas × concurrency` of them,
 * an idealised balancer), each keeps a worker busy for the service time, then calls downstream. The line has a limit,
 * past which requests are refused (503). Called through a target group (`core.target-group` on the edge), the balancer
 * there picks a replica for each request, and each replica has a line of its own.
 *
 * Its gauges are what an autoscaler watches. `busy` per replica is what a Kubernetes horizontal autoscaler's CPU target
 * stands in for, and it counts a replica that is still starting as idle, as the autoscaler does, so tracking it doesn't
 * overshoot while new replicas start. (`utilization`, busy over *ready* workers, does: every decision during a start-up
 * sees the old replicas saturated and adds more.) `queued` is a backlog to track per replica.
 */
export const Service = Component.make({
  type: "common.service",
  provider: "internet",
  service: "Service",
  title: "Service",
  description: "Identical replicas behind a load balancer, each working on a few requests at once, with a queue in front and a start-up time for new replicas. Can spread over zones, and be reached replica by replica through a target group.",
  category: "compute",
  icon: "cpu",
  accent: "#5a9bd5",
  highlights: [
    { gauge: "ready", label: "ready" },
    { gauge: "utilization", label: "busy", format: "percent" },
    { gauge: "queued", label: "queued" }
  ],
  fleet: true,
  config: Config,
  ports: { out: Component.port.many("Downstream") },
  state: Schema.Struct({
    /** Replicas ready to serve. */
    ready: Schema.Number,
    /** Replicas still starting. */
    starting: Schema.Number,
    /** Replicas let go, finishing what they hold. */
    draining: Schema.Number,
    busy: Schema.Number,
    queued: Schema.Number,
    served: Schema.Number,
    errors: Schema.Number,
    refused: Schema.Number,
    /** Requests that failed because their replica was lost (its zone went down) or cut off at the end of its drain. */
    lost: Schema.Number,
    /** Replicas started to replace ones that died. */
    replaced: Schema.Number,
    replicaList: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        zone: Schema.optionalKey(Schema.String),
        state: Schema.String,
        alive: Schema.Boolean,
        busy: Schema.Number,
        queued: Schema.Number
      })
    )
  }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const out = node.out("out")
      const totals = { served: 0, errors: 0, refused: 0, lost: 0 }
      const settings = (): Settings => fast.settings()
      const fleet = new Fleet(node, {
        desired: () => settings().replicas,
        zones: () => node.zones.all.slice(0, settings().zones),
        phases: () => [{ name: "start", ms: Duration.toMillis(settings().startup) }],
        workers: () => settings().concurrency,
        line: () => settings().queueLimit,
        backlog: () => settings().queueLimit,
        drain: () => Duration.toMillis(settings().drain),
        detect: () => Duration.toMillis(settings().replaceAfter),
        name: (id) => `replica-${id}`
      })

      const host: RequestHost = { id: node.id, fast, out, totals }
      /** One request: wait for a worker (on `unit`, if a balancer chose one), work for the service time, then call downstream. */
      const handle = (message: Message, unit: Unit | undefined): Call =>
        Effect.callback<Reply, CallFailure>((resume) => {
          const request = new Request(host, message, resume)
          const admitted = fleet.admit(request, unit)
          if (typeof admitted === "string") {
            totals.refused++
            resume(Effect.fail(Unavailable({ node: node.id, reason: admitted })))
            return Effect.void
          }
          request.ticket = admitted
          return Effect.sync(() => request.abandon())
        })

      // Ready replicas per zone, for each zone it has spread over (registered when it first does).
      const zoneGauges = new Set<string>()
      const gaugeZones = (): void => {
        for (const zone of fleet.zonesList()) {
          if (zoneGauges.has(zone)) continue
          zoneGauges.add(zone)
          node.meter.gaugeUnsafe(`ready.${zone}`, () => fleet.servingIn(zone))
        }
      }

      // Settings edited while running (by a person, or an autoscaler) apply at once: replicas start or stop, and more
      // workers per replica take waiting requests.
      yield* node.spawn(
        SubscriptionRef.changes(node.config).pipe(
          Stream.runForEach(() =>
            Effect.sync(() => {
              fleet.refresh()
              gaugeZones()
            })
          )
        )
      )

      node.meter.gaugeUnsafe("replicas", () => settings().replicas)
      node.meter.gaugeUnsafe("ready", () => fleet.serving)
      node.meter.gaugeUnsafe("starting", () => fleet.pending)
      node.meter.gaugeUnsafe("busy", () => fleet.busy)
      node.meter.gaugeUnsafe("queued", () => fleet.waiting)
      node.meter.gaugeUnsafe("utilization", () => fleet.utilization)
      node.meter.gaugeUnsafe("draining", () => fleet.count.draining)
      gaugeZones()

      return {
        call: (message) => handle(message, undefined),
        fleet: fleet.offer((unit, message) => handle(message, unit)),
        probe: Effect.sync(() => ({
          ready: fleet.serving,
          starting: fleet.pending,
          draining: fleet.count.draining,
          busy: fleet.busy,
          queued: fleet.waiting,
          ...totals,
          replaced: fleet.totals.replaced,
          replicaList: fleet.snapshot().map((u) => ({ name: u.name, ...(u.zone === undefined ? {} : { zone: u.zone }), state: u.state, alive: u.alive, busy: u.busy, queued: u.queued }))
        }))
      }
    })
})
