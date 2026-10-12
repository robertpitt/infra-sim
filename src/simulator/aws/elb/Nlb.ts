import { Duration, Effect, Schema } from "effect"
import * as Component from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import type { Link } from "../../Edge.ts"
import { isNoTarget } from "../../fleet/TargetGroup.ts"
import { type Cancel, noCancel } from "../../Flow.ts"
import { type Call, type CallFailure, type Message, Unavailable } from "../../Message.ts"
import * as Setting from "../../Setting.ts"
import type { Counter } from "../../Telemetry.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import * as Aws from "../provider.ts"
import { enabledZones, nodeHash, pickByWeight, rehash } from "./balancer.ts"
import { Capacity, type Costs, nlbCosts } from "./capacity.ts"
import {
  DNS_TTL_MS,
  NLB_IDLE_TIMEOUT_MAX_S,
  NLB_IDLE_TIMEOUT_MIN_S,
  NLB_IDLE_TIMEOUT_S,
  NLB_LCU,
  NLB_MIN_ZONES,
  requestsPerConnection,
  TICK_MS,
  URL
} from "./config.ts"
import { nlbDashboard } from "./dashboard.ts"
import { ZonalDns } from "./dns.ts"
import { hostsIn, type Listener, listenerOf } from "./listener.ts"
import { type Count, count, NlbState, type TargetKind } from "./state.ts"

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

interface Host {
  readonly fast: Component.Fast<NlbSettings>
  readonly listener: Listener
  readonly c: Counters
  readonly resets: { readonly noTarget: CallFailure; readonly idle: CallFailure }
  active: number
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
class Request {
  open = true
  timer: TimerHandle | undefined = undefined
  private cancelDown: Cancel = noCancel

  constructor(
    private readonly host: Host,
    private readonly message: Message,
    private readonly link: Link,
    private readonly zone: string | undefined,
    private readonly idleMs: number,
    private readonly resume: (effect: Call) => void
  ) {}

  forward(): void {
    this.timer = this.host.fast.after(this.idleMs, onIdle, this)
    const listener = this.host.listener
    listener.zone = this.zone
    const cancel = this.link.send(this.message, this.answered)
    listener.zone = undefined
    if (this.open) this.cancelDown = cancel
  }

  /** An NLB passes what the target did through, as it is: it is a layer 4 hop. Only finding no target is its own reset. */
  private readonly answered = (failure: CallFailure | undefined): void => {
    if (!this.open) return
    this.close()
    if (failure === undefined) return this.resume(Effect.void)
    if (isNoTarget(failure)) {
      this.host.c.elbResets.add()
      return this.resume(Effect.fail(this.host.resets.noTarget))
    }
    if (failure._tag === "Unavailable") this.host.c.targetResets.add()
    this.resume(Effect.fail(failure))
  }

  processed(): void {
    this.timer = undefined
    if (this.open) this.forward()
  }

  idle(): void {
    this.timer = undefined
    if (!this.open) return
    this.close()
    this.cancelDown()
    this.cancelDown = noCancel
    this.host.c.elbResets.add()
    this.resume(Effect.fail(this.host.resets.idle))
  }

  abandon(): void {
    if (!this.open) return
    this.close()
    this.cancelDown()
    this.cancelDown = noCancel
    this.host.c.clientResets.add()
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
      const listener = yield* listenerOf(node.shared, node.id)
      listener.attached = true
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
      const capacity = new Capacity(NLB_LCU.active)
      // "An empty Availability Zone is considered unhealthy" (NLB target group attributes): it leaves DNS.
      const dns = new ZonalDns(node.zones, listener, fast.now, false)
      const zonesNow = () => enabledZones(node.zones.all, fast.settings().zones, NLB_MIN_ZONES)

      let kinds: Array<TargetKind> | undefined
      const kindsOf = (): Array<TargetKind> => (kinds ??= out.map((l) => (listener.groups.has(l.id) ? "fleet" : "address")))

      let costsFor: NlbSettings | undefined
      let costs: Costs
      let idleMs = 0
      const costsOf = (s: NlbSettings): Costs => {
        if (s !== costsFor) {
          costsFor = s
          costs = nlbCosts(s.requestsPerConnection)
          idleMs = Duration.toMillis(s.idleTimeout)
        }
        return costs
      }

      const tick = (): void => {
        dns.refresh(zonesNow())
        capacity.tick(fast.now(), host.active, undefined)
        fast.after(TICK_MS, tick, undefined)
      }
      // DNS as it has been since before the run, read once the target groups exist (their connectors are made after this).
      fast.after(0, () => dns.refresh(zonesNow()), undefined)
      fast.after(TICK_MS, tick, undefined)
      node.zones.watch(() => dns.refresh(zonesNow()))

      meter.gaugeUnsafe("activeFlows", () => host.active)
      meter.gaugeUnsafe("consumed.lcu", () => capacity.consumed)
      meter.gaugeUnsafe("peak.lcu", () => capacity.peak)
      meter.gaugeUnsafe("zones.inDns", () => dns.healthyZones)
      meter.gaugeUnsafe("healthyHosts", () => hostsIn(listener, "healthy"))
      meter.gaugeUnsafe("unhealthyHosts", () => hostsIn(listener, "unhealthy"))

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
          const k = costsOf(s)
          capacity.admit(Math.max(k.perRequest, message.bytes * k.perByte), fast.now(), false)
          c.requests.add()
          c.processedBytes.n += message.bytes
          host.active++
          const delay = Distribution.latencyMs(s.overhead, fast.random)
          return Effect.callback<void, CallFailure>((resume) => {
            const r = new Request(host, message, out[i]!, zone, idleMs, resume)
            if (delay > 0) r.timer = fast.after(delay, onProcessed, r)
            else r.forward()
            return Effect.sync(() => r.abandon())
          })
        },
        probe: Effect.sync(() => ({
          zones: dns.report(),
          consumedLcu: capacity.consumed,
          peakLcu: capacity.peak,
          active: host.active,
          requests: c.requests.total,
          elbResets: c.elbResets.total + c.deadNode.total,
          targetGroups: out.map((l, i) => ({ edge: l.id, to: l.to, kind: kindsOf()[i]! }))
        }))
      }
    })
})
