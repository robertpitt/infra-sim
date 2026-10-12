import { Duration, Effect } from "effect"
import * as Component from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import type { Link } from "../../Edge.ts"
import { type Cancel, noCancel } from "../../Flow.ts"
import type { Call, CallFailure, Message } from "../../Message.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import * as Aws from "../provider.ts"
import { type AlbSettings, AlbConfig } from "./albConfig.ts"
import { enabledZones, nodeHash, pickByWeight, rehash } from "./balancer.ts"
import { albCosts, Capacity, type Costs, reservedLcu } from "./capacity.ts"
import { ALB_LCU, ALB_MIN_ZONES, DNS_TTL_MS, LAMBDA_MAX_BODY_BYTES, LAMBDA_MAX_WAIT_MS, TARGET_GROUPS_PER_ACTION, TICK_MS, URL } from "./config.ts"
import { ZonalDns } from "./dns.ts"
import { listenerOf, type Listener } from "./listener.ts"
import { type AlbFailures, albFailures, badGateway, Outcome, outcomeOf } from "./responses.ts"
import { AlbState, type Count, count, type TargetKind } from "./state.ts"

/** What one request needs of its load balancer, made once per node so that a request is one small object. */
interface Host {
  readonly fast: Component.Fast<AlbSettings>
  readonly listener: Listener
  readonly f: AlbFailures
  readonly c: Counters
  active: number
}

/** The node's counters: CloudWatch's metrics, under the names in the README. */
interface Counters {
  readonly requests: Count
  readonly elb5xx: Count
  readonly elb502: Count
  readonly elb503: Count
  readonly elb504: Count
  readonly elb4xx: Count
  readonly elb460: Count
  readonly target5xx: Count
  readonly target4xx: Count
  readonly targetConnectionErrors: Count
  readonly rejected: Count
  readonly deadNode: Count
  readonly lambdaUserError: Count
  readonly lambdaInternalError: Count
}

/**
 * One request inside the load balancer, from the moment a node takes it until it is answered or abandoned: the node's
 * processing time (a timer), then the target group (one call through the edge) raced against the idle timeout (a timer).
 */
class Request {
  open = true
  timer: TimerHandle | undefined = undefined
  private cancelDown: Cancel = noCancel

  constructor(
    private readonly host: Host,
    private readonly message: Message,
    private readonly link: Link,
    private readonly lambda: boolean,
    private readonly zone: string | undefined,
    private readonly waitMs: number,
    private readonly resume: (effect: Call) => void
  ) {}

  /** Through the target group on the edge, with the idle timeout running. The listener tells the edge which node it is. */
  forward(): void {
    this.timer = this.host.fast.after(this.waitMs, onIdle, this)
    const listener = this.host.listener
    listener.zone = this.zone
    const cancel = this.link.send(this.message, this.answered)
    listener.zone = undefined
    if (this.open) this.cancelDown = cancel
  }

  private readonly answered = (failure: CallFailure | undefined): void => {
    if (!this.open) return
    this.close()
    if (failure === undefined) return this.resume(Effect.void)
    const { c, f } = this.host
    switch (outcomeOf(failure, this.lambda)) {
      case Outcome.Target5xx:
        c.target5xx.add()
        return this.resume(Effect.fail(failure))
      case Outcome.Target4xx:
        c.target4xx.add()
        return this.resume(Effect.fail(failure))
      case Outcome.Elb503:
        c.elb503.add()
        c.elb5xx.add()
        return this.resume(Effect.fail(f.noTarget))
      case Outcome.Elb504:
        c.elb504.add()
        c.elb5xx.add()
        return this.resume(Effect.fail(f.idle(this.waitMs)))
      case Outcome.Elb502: {
        c.elb502.add()
        c.elb5xx.add()
        if (this.lambda) {
          // LambdaInternalError when the function couldn't be reached; LambdaUserError when it failed or was throttled.
          if (failure._tag === "Unavailable") c.lambdaInternalError.add()
          else c.lambdaUserError.add()
          return this.resume(Effect.fail(f.lambda))
        }
        const bad = badGateway(f, failure)
        if (bad === f.refused) c.targetConnectionErrors.add()
        return this.resume(Effect.fail(bad))
      }
    }
  }

  /** The node's own processing is done: forward. */
  processed(): void {
    this.timer = undefined
    if (this.open) this.forward()
  }

  /** Nothing from the target within the idle timeout: 504. The target is not told, and keeps working. */
  idle(): void {
    this.timer = undefined
    if (!this.open) return
    this.close()
    this.cancelDown()
    this.cancelDown = noCancel
    this.host.c.elb504.add()
    this.host.c.elb5xx.add()
    this.resume(Effect.fail(this.host.f.idle(this.waitMs)))
  }

  /** The client gave up first and closed its connection: what the access log records as 460. */
  abandon(): void {
    if (!this.open) return
    this.close()
    this.cancelDown()
    this.cancelDown = noCancel
    this.host.c.elb460.add()
    this.host.c.elb4xx.add()
  }

  private close(): void {
    this.open = false
    this.timer?.cancel()
    this.timer = undefined
    this.host.active--
  }
}

const onIdle = (r: Request): void => r.idle()
const onProcessed = (r: Request): void => r.processed()

/**
 * An Application Load Balancer: a layer 7 load balancer with a node in each of its zones, a listener that routes each
 * request to a target group (an edge on its `out` port), and the target groups' targets behind them. See `README.md`.
 *
 * Each edge is a target group: into a fleet (`aws.alb.target-group`: health checks, routing algorithms, slow start,
 * stickiness, deregistration delay, cross-zone), into a Lambda function (`aws.alb.lambda-target`), or to one address
 * (`aws.alb.ip-target`). The component does what the listener and the nodes do: DNS over its zones, its capacity in LCUs,
 * the idle timeout, and turning what went wrong into 502, 503 and 504.
 */
export const Alb = Aws.component({
  type: "aws.alb",
  service: "Elastic Load Balancing",
  title: "Application Load Balancer",
  description:
    "Layer 7 load balancing: a node in each zone, listener routing to weighted target groups, health checks, round robin or least outstanding requests, slow start, sticky sessions, cross-zone, deregistration delay, the 60 s idle timeout, 502/503/504, and capacity that scales with a lag (LCUs, reservations).",
  docs: URL.albDocs,
  category: "network",
  icon: "balancer",
  accent: "#8c4fff",
  limits: [
    { label: "Availability Zones", value: "at least 2", adjustable: false, source: URL.albSubnets },
    { label: "DNS TTL", value: `${DNS_TTL_MS / 1000} seconds`, adjustable: false, source: URL.howItWorks, note: "A zone taken out of DNS still gets requests from clients that cached it, until their answer expires." },
    { label: "Target groups per action", value: `${TARGET_GROUPS_PER_ACTION}`, adjustable: false, source: URL.albQuotas, note: "Weights 0 to 999 each." },
    { label: "Target groups per load balancer", value: "100", adjustable: false, source: URL.albQuotas },
    { label: "Targets per load balancer", value: "1,000", adjustable: true, source: URL.albQuotas },
    { label: "Lambda request and response", value: "1 MB each", adjustable: false, source: URL.albLambda, note: "A larger request is answered 413, a larger response 502." },
    { label: "Connection timeout to a target", value: "10 seconds", adjustable: false, source: URL.albTroubleshooting, note: "504 when a connection can't be made. Not modelled apart from the idle timeout." },
    {
      label: "LCU dimensions",
      value: "25 new connections/s, 3,000 active connections, 1 GB/hour (0.4 GB for Lambda), 1,000 rule evaluations/s",
      adjustable: false,
      source: URL.pricing,
      note: "Billed on the largest. The first 10 rules of a request are free."
    }
  ],
  highlights: [
    { rate: "requests", label: "req/s" },
    { rate: "elb.5xx", label: "ELB 5xx/s" },
    { gauge: "capacityUtilization", label: "capacity", format: "percent" }
  ],
  config: AlbConfig,
  ports: { out: Component.port.many("Target groups") },
  state: AlbState,
  make: (node) =>
    Effect.gen(function*() {
      const { fast, meter } = node
      const out = node.out("out")
      const listener = yield* listenerOf(node.shared, node.id)
      listener.attached = true
      const counter = (name: string) => count(meter, name)
      const c: Counters = {
        requests: counter("requests"),
        elb5xx: counter("elb.5xx"),
        elb502: counter("elb.502"),
        elb503: counter("elb.503"),
        elb504: counter("elb.504"),
        elb4xx: counter("elb.4xx"),
        elb460: counter("elb.460"),
        target5xx: counter("target.5xx"),
        target4xx: counter("target.4xx"),
        targetConnectionErrors: counter("targetConnectionErrors"),
        rejected: counter("rejectedConnections"),
        deadNode: counter("deadNode"),
        lambdaUserError: counter("lambda.userError"),
        lambdaInternalError: counter("lambda.internalError")
      }
      const host: Host = { fast, listener, f: albFailures(node.id), c, active: 0 }
      const capacity = new Capacity(ALB_LCU.active)
      // An empty zone stays in an ALB's DNS: AWS warns that requests entering it get 503s.
      const dns = new ZonalDns(node.zones, listener, fast.now, true)
      const zonesNow = () => enabledZones(node.zones.all, fast.settings().zones, ALB_MIN_ZONES)

      // Which edges invoke a Lambda function: known once the connectors exist, which is after this component is made.
      let kinds: Array<TargetKind> | undefined
      const kindsOf = (): Array<TargetKind> =>
        (kinds ??= out.map((l) => (listener.lambdas.has(l.id) ? "lambda" : listener.groups.has(l.id) ? "fleet" : "address")))

      // Derived numbers, worked out again only when the settings are replaced.
      let costsFor: AlbSettings | undefined
      let costs: Costs
      let idleMs = 0
      const costsOf = (s: AlbSettings): Costs => {
        if (s !== costsFor) {
          costsFor = s
          costs = albCosts(s.requestsPerConnection, s.rules)
          idleMs = Duration.toMillis(s.idleTimeout)
        }
        return costs
      }

      // Once a second: the zones' health for DNS, and the load for scaling.
      const tick = (): void => {
        const s = fast.settings()
        dns.refresh(zonesNow())
        capacity.tick(fast.now(), host.active, s.capacity.model ? s.capacity : undefined)
        fast.after(TICK_MS, tick, undefined)
      }
      // DNS as it has been since before the run, read once the target groups exist (their connectors are made after this).
      fast.after(0, () => dns.refresh(zonesNow()), undefined)
      // The first tick, a second in, sizes the load balancer to the traffic it has seen.
      fast.after(TICK_MS, tick, undefined)
      node.zones.watch(() => dns.refresh(zonesNow()))

      meter.gaugeUnsafe("activeConnections", () => host.active)
      meter.gaugeUnsafe("capacity.lcu", () => capacity.lcu)
      meter.gaugeUnsafe("consumed.lcu", () => capacity.consumed)
      meter.gaugeUnsafe("peak.lcu", () => capacity.peak)
      meter.gaugeUnsafe("reserved.lcu", () => reservedLcu(fast.settings().capacity.reserved))
      meter.gaugeUnsafe("capacityUtilization", () => capacity.utilization)
      meter.gaugeUnsafe("zones.inDns", () => dns.healthyZones)

      const fail = (failure: CallFailure) => Effect.fail(failure)

      return {
        call: (message) => {
          const s = fast.settings()
          const kind = kindsOf()
          const i = pickByWeight(out, s.routing === "rules" ? rehash(message.key) : fast.random.nextDoubleUnsafe())
          if (i < 0) {
            c.elb503.add()
            c.elb5xx.add()
            return fail(host.f.noTargetGroup)
          }
          const lambda = kind[i] === "lambda"
          if (lambda && message.bytes > LAMBDA_MAX_BODY_BYTES) {
            c.elb4xx.add()
            return fail(host.f.tooLarge)
          }
          // The node in the zone the client's DNS answer named.
          const zone = dns.pick(nodeHash(message.key))
          // Only an outage reaches a load balancer node: a zone's Slow and Errors faults are its instances' (the fleets').
          if (zone !== undefined && node.zones.down(zone)) {
            c.deadNode.add()
            return fail(host.f.nodeDown)
          }
          const k = costsOf(s)
          const cost = Math.max(k.perRequest, message.bytes * (lambda ? k.perLambdaByte : k.perByte))
          if (!capacity.admit(cost, fast.now(), s.capacity.model)) {
            c.rejected.add()
            return fail(host.f.rejected)
          }
          c.requests.add()
          host.active++
          const waitMs = lambda ? LAMBDA_MAX_WAIT_MS : idleMs
          const delay = Distribution.latencyMs(s.overhead, fast.random)
          return Effect.callback<void, CallFailure>((resume) => {
            const r = new Request(host, message, out[i]!, lambda, zone, waitMs, resume)
            if (delay > 0) r.timer = fast.after(delay, onProcessed, r)
            else r.forward()
            return Effect.sync(() => r.abandon())
          })
        },
        probe: Effect.sync(() => ({
          zones: dns.report(),
          capacityLcu: capacity.lcu,
          consumedLcu: capacity.consumed,
          peakLcu: capacity.peak,
          reservedLcu: reservedLcu(fast.settings().capacity.reserved),
          active: host.active,
          requests: c.requests.total,
          elb502: c.elb502.total,
          elb503: c.elb503.total,
          elb504: c.elb504.total,
          elb4xx: c.elb4xx.total,
          target5xx: c.target5xx.total,
          rejectedConnections: c.rejected.total,
          targetGroups: out.map((l, i) => ({ edge: l.id, to: l.to, kind: kindsOf()[i]! }))
        }))
      }
    })
})
