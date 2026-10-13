import { Effect, Schema } from "effect"
import * as Component from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import { isNoTarget } from "../../fleet/TargetGroup.ts"
import { type CallFailure, Unavailable } from "../../Message.ts"
import * as Setting from "../../Setting.ts"
import type { Counter } from "../../Telemetry.ts"
import * as Aws from "../internal/provider.ts"
import { balancer, nodeHash, pickByWeight, rehash } from "./internal/balancer.ts"
import { nlbCosts } from "./internal/capacity.ts"
import {
  DNS_TTL_MS,
  NLB_IDLE_TIMEOUT_MAX_S,
  NLB_IDLE_TIMEOUT_MIN_S,
  NLB_IDLE_TIMEOUT_S,
  NLB_LCU,
  NLB_MIN_ZONES,
  requestsPerConnection,
  URL
} from "./internal/config.ts"
import { nlbDashboard } from "./internal/dashboard.ts"
import { Forwarded, type Node, start } from "./internal/request.ts"
import { type Count, count, NlbState } from "./internal/state.ts"

export const NlbConfig = Schema.Struct({
  zones: Setting.int({
    default: 3,
    min: NLB_MIN_ZONES,
    max: 6,
    unit: "zones",
    label: "Availability Zones",
    help: "Zones the load balancer has a node in: the first ones of its region. Clients spread over them through DNS; with cross-zone off (the NLB default) each node only sends to targets in its own zone."
  }),
  idleTimeout: Setting.duration({
    default: `${NLB_IDLE_TIMEOUT_S} seconds`,
    min: `${NLB_IDLE_TIMEOUT_MIN_S} seconds`,
    max: `${NLB_IDLE_TIMEOUT_MAX_S} seconds`,
    label: "TCP idle timeout",
    help: "A connection with nothing sent either way for this long is forgotten, and the next packet on it gets a reset. Here: a request whose target hasn't answered in this long is reset.",
    limit: Setting.hard(URL.nlb, "60 to 6,000 seconds; 350 by default.")
  }),
  overhead: Setting.latency({
    mean: 0,
    cv: 0,
    label: "Load balancer processing time",
    help: "Time the load balancer adds to a connection. AWS calls it ultra-low and publishes no figure: 0 by default (an assumption), the network on the edges being the cost."
  }),
  requestsPerConnection
})
type NlbSettings = typeof NlbConfig.Type

interface Host extends Node {
  readonly fast: Component.Fast<NlbSettings>
  readonly c: Counters
  readonly resets: { readonly noTarget: CallFailure; readonly idle: CallFailure }
}

interface Counters {
  readonly requests: Count
  readonly elbResets: Count
  readonly targetResets: Count
  readonly clientResets: Count
  readonly deadNode: Count
  /** ProcessedBytes: the bytes of the connections the load balancer took (requests carry the only sizes there are). */
  readonly processedBytes: Counter
}

/** One connection's request through the load balancer: the target group's answer raced against the idle timeout. */
class Request extends Forwarded<Host> {
  /** An NLB passes what the target did through, as it is: it is a layer 4 hop. Only finding no target is its own reset. */
  protected readonly answered = (failure: CallFailure | undefined): void => {
    if (!this.open) return
    this.close()
    if (failure === undefined) return this.resume(Effect.void)
    if (isNoTarget(failure)) {
      this.node.c.elbResets.add()
      return this.resume(Effect.fail(this.node.resets.noTarget))
    }
    if (failure._tag === "Unavailable") this.node.c.targetResets.add()
    this.resume(Effect.fail(failure))
  }

  protected timedOut(): void {
    this.node.c.elbResets.add()
    this.resume(Effect.fail(this.node.resets.idle))
  }

  protected abandoned(): void {
    this.node.c.clientResets.add()
  }
}

/**
 * A Network Load Balancer: layer 4, a node in each of its zones, and connections kept on one target for their life (a
 * hash of the flow: the message's key). It has no HTTP errors of its own: what goes wrong is a reset (`Unavailable`), and
 * whatever the target answers passes through as it is. Cross-zone is off by default. See `README.md`.
 */
export const Nlb = Aws.component({
  type: "aws.nlb",
  service: "Elastic Load Balancing",
  title: "Network Load Balancer",
  description:
    "Layer 4 load balancing: a node in each zone, each connection (key) kept on one target by a flow hash, TCP health checks, cross-zone off by default, a 350 s idle timeout, resets instead of HTTP errors, and next to no added latency.",
  docs: URL.nlbDocs,
  category: "network",
  icon: "balancer",
  accent: "#8c4fff",
  dashboard: nlbDashboard,
  limits: [
    { label: "DNS TTL", value: `${DNS_TTL_MS / 1000} seconds`, adjustable: false, source: URL.howItWorks },
    { label: "Targets per Availability Zone", value: "500 (500 per load balancer with cross-zone on)", adjustable: true, source: URL.nlbQuotas },
    { label: "Targets per load balancer", value: "3,000", adjustable: true, source: URL.nlbQuotas },
    { label: "Target groups per action", value: "5", adjustable: false, source: URL.nlbQuotas },
    { label: "LCU dimensions (TCP)", value: "800 new connections/s, 100,000 active connections, 1 GB/hour", adjustable: false, source: URL.pricing, note: "Billed on the largest." },
    { label: "Targets", value: "instances, IP addresses, an Application Load Balancer", adjustable: false, source: URL.createTargetGroup, note: "Not Lambda functions." }
  ],
  highlights: [
    { rate: "requests", label: "conn/s" },
    { gauge: "activeFlows", label: "active" },
    { rate: "elb.resets", label: "resets/s" }
  ],
  config: NlbConfig,
  ports: { out: Component.port.many("Target groups") },
  state: NlbState,
  make: (node) =>
    Effect.gen(function*() {
      const { fast, meter } = node
      const out = node.out("out")
      const lb = yield* balancer(node, out, {
        activePerLcu: NLB_LCU.active,
        minZones: NLB_MIN_ZONES,
        // "An empty Availability Zone is considered unhealthy" (NLB target group attributes): it leaves DNS.
        emptyZonesStay: false,
        costs: (s) => nlbCosts(s.requestsPerConnection),
        scaling: () => undefined,
        active: () => host.active
      })
      const { listener, capacity, dns } = lb
      const c: Counters = {
        requests: count(meter, "requests"),
        elbResets: count(meter, "elb.resets"),
        targetResets: count(meter, "target.resets"),
        clientResets: count(meter, "client.resets"),
        deadNode: count(meter, "deadNode"),
        processedBytes: meter.counter("processedBytes")
      }
      const host: Host = {
        fast,
        listener,
        c,
        resets: {
          noTarget: Unavailable({ node: node.id, reason: "connection reset by the load balancer: no target" }),
          idle: Unavailable({ node: node.id, reason: "connection reset by the load balancer: idle timeout" })
        },
        active: 0
      }
      const noGroup = Unavailable({ node: node.id, reason: "connection reset by the load balancer: no target group" })
      const nodeDown = Unavailable({ node: node.id, reason: "connection failed: the load balancer node in its zone is down" })

      meter.gaugeUnsafe("activeFlows", () => host.active)
      meter.gaugeUnsafe("consumed.lcu", () => capacity.consumed)
      meter.gaugeUnsafe("peak.lcu", () => capacity.peak)
      lb.gaugeHealth(meter)

      return {
        call: (message) => {
          const s = fast.settings()
          // A connection chooses its target group by its flow, so it stays with it.
          const i = pickByWeight(out, rehash(message.key))
          if (i < 0) {
            c.elbResets.add()
            return Effect.fail(noGroup)
          }
          const zone = dns.pick(nodeHash(message.key))
          // Only an outage reaches a load balancer node: a zone's Slow and Errors faults are its instances' (the fleets').
          if (zone !== undefined && node.zones.down(zone)) {
            c.deadNode.add()
            return Effect.fail(nodeDown)
          }
          const { costs: k, idleMs } = lb.derived(s)
          capacity.admit(Math.max(k.perRequest, message.bytes * k.perByte), fast.now(), false)
          c.requests.add()
          c.processedBytes.n += message.bytes
          host.active++
          const delay = Distribution.latencyMs(s.overhead, fast.random)
          return Effect.callback<void, CallFailure>((resume) => start(new Request(host, message, out[i]!, zone, idleMs, resume), delay))
        },
        probe: Effect.sync(() => ({
          zones: dns.report(),
          consumedLcu: capacity.consumed,
          peakLcu: capacity.peak,
          active: host.active,
          requests: c.requests.total,
          elbResets: c.elbResets.total + c.deadNode.total,
          targetGroups: lb.targetGroups()
        }))
      }
    })
})
