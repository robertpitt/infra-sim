import { Effect } from "effect"
import * as Component from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import type { Link } from "../../Edge.ts"
import type { Call, CallFailure, Message } from "../../Message.ts"
import type { Counter, Sampler } from "../../Telemetry.ts"
import * as Aws from "../internal/provider.ts"
import { type AlbSettings, AlbConfig } from "./internal/albConfig.ts"
import { balancer, nodeHash, pickByWeight, rehash } from "./internal/balancer.ts"
import { albCosts, reservedLcu } from "./internal/capacity.ts"
import { albDashboard } from "./internal/dashboard.ts"
import { ALB_LCU, ALB_MIN_ZONES, DNS_TTL_MS, LAMBDA_MAX_BODY_BYTES, LAMBDA_MAX_WAIT_MS, TARGET_GROUPS_PER_ACTION, URL } from "./internal/config.ts"
import { Forwarded, type Node, start } from "./internal/request.ts"
import { type AlbFailures, albFailures, badGateway, Outcome, outcomeOf } from "./internal/responses.ts"
import { AlbState, type Count, count } from "./internal/state.ts"

/** What one request needs of its load balancer, made once per node so that a request is one small object. */
interface Host extends Node {
  readonly fast: Component.Fast<AlbSettings>
  readonly f: AlbFailures
  readonly c: Counters
  /** TargetResponseTime: from the request leaving the load balancer to the target's answer. */
  readonly targetResponseTime: Sampler
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
  /** ProcessedBytes: the bytes of the requests the load balancer took (requests carry the only sizes there are). */
  readonly processedBytes: Counter
}

/** One request inside an ALB: what it makes of the target group's answer, of the idle timeout, and of a client leaving. */
class Request extends Forwarded<Host> {
  constructor(
    host: Host,
    message: Message,
    link: Link,
    private readonly lambda: boolean,
    zone: string | undefined,
    waitMs: number,
    resume: (effect: Call) => void
  ) {
    super(host, message, link, zone, waitMs, resume)
  }

  protected readonly answered = (failure: CallFailure | undefined): void => {
    if (!this.open) return
    this.close()
    const { c, f } = this.node
    // The target answered (well or with its own error): TargetResponseTime. The load balancer's own errors have none.
    if (failure === undefined) {
      this.node.targetResponseTime.add(this.node.fast.now() - this.sentAt)
      return this.resume(Effect.void)
    }
    switch (outcomeOf(failure, this.lambda)) {
      case Outcome.Target5xx:
        c.target5xx.add()
        this.node.targetResponseTime.add(this.node.fast.now() - this.sentAt)
        return this.resume(Effect.fail(failure))
      case Outcome.Target4xx:
        c.target4xx.add()
        this.node.targetResponseTime.add(this.node.fast.now() - this.sentAt)
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

  /** Nothing from the target within the idle timeout: 504. */
  protected timedOut(): void {
    this.node.c.elb504.add()
    this.node.c.elb5xx.add()
    this.resume(Effect.fail(this.node.f.idle(this.waitMs)))
  }

  /** The client gave up first and closed its connection: what the access log records as 460. */
  protected abandoned(): void {
    this.node.c.elb460.add()
    this.node.c.elb4xx.add()
  }
}

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
  dashboard: albDashboard,
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
      const lb = yield* balancer(node, out, {
        activePerLcu: ALB_LCU.active,
        minZones: ALB_MIN_ZONES,
        // An empty zone stays in an ALB's DNS: AWS warns that requests entering it get 503s.
        emptyZonesStay: true,
        costs: (s) => albCosts(s.requestsPerConnection, s.rules),
        scaling: (s) => (s.capacity.model ? s.capacity : undefined),
        active: () => host.active
      })
      const { listener, capacity, dns } = lb
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
        lambdaInternalError: counter("lambda.internalError"),
        processedBytes: meter.counter("processedBytes")
      }
      const host: Host = { fast, listener, f: albFailures(node.id), c, targetResponseTime: meter.sampler("targetResponseTime"), active: 0 }

      meter.gaugeUnsafe("activeConnections", () => host.active)
      meter.gaugeUnsafe("capacity.lcu", () => capacity.lcu)
      meter.gaugeUnsafe("consumed.lcu", () => capacity.consumed)
      meter.gaugeUnsafe("peak.lcu", () => capacity.peak)
      meter.gaugeUnsafe("reserved.lcu", () => reservedLcu(fast.settings().capacity.reserved))
      meter.gaugeUnsafe("capacityUtilization", () => capacity.utilization)
      lb.gaugeHealth(meter)

      const fail = (failure: CallFailure) => Effect.fail(failure)

      return {
        call: (message) => {
          const s = fast.settings()
          const kind = lb.kinds()
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
          const { costs: k, idleMs } = lb.derived(s)
          const cost = Math.max(k.perRequest, message.bytes * (lambda ? k.perLambdaByte : k.perByte))
          if (!capacity.admit(cost, fast.now(), s.capacity.model)) {
            c.rejected.add()
            return fail(host.f.rejected)
          }
          c.requests.add()
          c.processedBytes.n += message.bytes
          host.active++
          const waitMs = lambda ? LAMBDA_MAX_WAIT_MS : idleMs
          const delay = Distribution.latencyMs(s.overhead, fast.random)
          return Effect.callback<void, CallFailure>((resume) => start(new Request(host, message, out[i]!, lambda, zone, waitMs, resume), delay))
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
          targetGroups: lb.targetGroups()
        }))
      }
    })
})
