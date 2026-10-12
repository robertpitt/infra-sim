import { Effect, Schema } from "effect"
import * as Component from "../../Component.ts"
import type { Link } from "../../Edge.ts"
import * as Flow from "../../Flow.ts"
import { Throttled } from "../../Message.ts"
import * as Setting from "../../Setting.ts"
import * as Aws from "../provider.ts"
import { natGatewayDashboard } from "./dashboard.ts"
import { hop } from "./Hop.ts"
import { source } from "./sources.ts"

/** Each IPv4 address supports this many simultaneous connections to one destination. Source: nat-gateway-basics. */
const CONNECTIONS_PER_ADDRESS = 55_000
/** A NAT gateway starts at 5 Gbps and scales up to 100 Gbps on its own. Source: nat-gateway-basics. */
const MIN_GBPS = 5
const MAX_GBPS = 100
const BYTES_PER_GBPS = 1e9 / 8

/** Availability Zones are named by a letter after the Region: `us-east-1a`. The most any Region has is six. */
const ZONES = ["a", "b", "c", "d", "e", "f"] as const

const Config = Schema.Struct({
  zone: Setting.choice(ZONES, {
    default: "a",
    label: "Availability Zone",
    help: "A NAT gateway lives in one zone, with redundancy inside it. If that zone goes down, everything routed through it loses its way out: inject an outage on this node to see it. Counted against the NAT gateways per zone quota.",
    labels: { a: "a", b: "b", c: "c", d: "d", e: "e", f: "f" }
  }),
  addresses: Setting.int({
    default: 1,
    min: 1,
    max: 8,
    unit: "addresses",
    label: "IPv4 addresses",
    help: "One primary and up to seven secondary. Each address supports 55,000 simultaneous connections to a destination. An account can attach 2 by default (an account quota).",
    limit: Setting.hard(source.natBasics, "At most 8 IPv4 addresses per NAT gateway.")
  }),
  connectionsPerDestination: Setting.int({
    default: CONNECTIONS_PER_ADDRESS,
    min: 1,
    max: CONNECTIONS_PER_ADDRESS,
    unit: "connections",
    label: "Connections per address and destination",
    help: "Simultaneous connections one address supports to one destination (an edge leaving this gateway). The limit is 55,000: lower it to see what exhausting ports looks like with less load.",
    limit: Setting.hard(source.natBasics, "55,000 simultaneous connections per IPv4 address to each unique destination (IP, port and protocol).")
  }),
  bandwidth: Setting.number({
    default: MIN_GBPS,
    min: MIN_GBPS,
    max: MAX_GBPS,
    step: 5,
    unit: "Gbps",
    label: "Bandwidth",
    help: "A NAT gateway supports 5 Gbps and scales automatically up to 100 Gbps. AWS publishes no schedule for the scaling, so the simulator holds the gateway at this value: raise it to model one that has scaled.",
    limit: Setting.hard(source.natBasics, "Starts at 5 Gbps, scales to 100 Gbps.")
  }),
  routing: Setting.choice(["weighted", "sequential", "parallel"], {
    default: "weighted",
    label: "Destinations",
    help: "A real NAT gateway forwards whatever the client addressed. A call carries no address here, so with several destinations wired this picks one by edge weight, or calls them all."
  }),
  latency: Setting.latency({
    mean: "300 micros",
    cv: 0.3,
    label: "Processing latency",
    help: "Time the gateway adds to a call. AWS publishes no figure: an assumption."
  })
})

type Config = typeof Config.Type

/**
 * A public NAT gateway: how a function in a VPC reaches the internet. It translates addresses, so what it limits is
 * connections: each IPv4 address allows 55,000 simultaneous connections to one destination, and past that new
 * connections fail with a port allocation error. It also carries at most 5 Gbps (growing to 100).
 *
 * Wire a function's output to the gateway and the gateway's output to the external endpoints it reaches. Whether a
 * function in the VPC may reach the internet *without* it is not enforced: see the README's backlog.
 */
export const NatGateway = Aws.component({
  type: "aws.nat-gateway",
  service: "VPC",
  title: "NAT gateway",
  description: "Lets functions in a VPC call the internet. Limited by 55,000 connections per address and destination, and by bandwidth.",
  category: "network",
  icon: "gateway",
  accent: "#8c4fff",
  docs: source.natBasics,
  dashboard: natGatewayDashboard,
  limits: [
    { label: "Bandwidth", value: "5 Gbps, scaling to 100 Gbps", adjustable: false, source: source.natBasics },
    { label: "Packets per second", value: "1 million, scaling to 10 million", adjustable: false, source: source.natBasics, note: "Beyond it the gateway drops packets. Not simulated: bandwidth binds first for all but tiny packets." },
    { label: "Simultaneous connections", value: "55,000 per IPv4 address to each unique destination", adjustable: false, source: source.natBasics, note: "Add addresses (up to 8) to raise it." },
    { label: "Idle connection timeout", value: "350 seconds", adjustable: false, source: source.natTroubleshooting, note: "Not simulated: only calls in flight count as connections." }
  ],
  highlights: [
    { gauge: "connections", label: "connections" },
    { rate: "ErrorPortAllocation", label: "port errors/s" }
  ],
  config: Config,
  within: ["aws.vpc"],
  ports: { out: Component.port.many("Destinations") },
  state: Schema.Struct({
    /** Connections open right now, summed over destinations. */
    connections: Schema.Number,
    /** Connections open to the busiest destination. */
    busiest: Schema.Number,
    /** The most simultaneous connections one destination can have right now. */
    limit: Schema.Number,
    /** New connections refused because the address had no free ports to that destination. */
    portAllocationErrors: Schema.Number,
    /** Calls dropped for want of bandwidth. */
    drops: Schema.Number,
    /** Bytes carried. */
    bytes: Schema.Number
  }),
  make: (node) =>
    Effect.sync(() => {
      const { fast } = node
      /** Connections open per destination (per wired edge). Entries are removed at zero, so it stays as small as the traffic is wide. */
      const open = new Map<string, number>()
      let connections = 0
      let portAllocationErrors = 0
      const portErrors = node.meter.counter("ErrorPortAllocation")
      // ConnectionAttemptCount and ConnectionEstablishedCount: every new connection asked for, and those given a port.
      const connectionAttempts = node.meter.counter("connectionAttempts")
      const connectionsEstablished = node.meter.counter("connectionsEstablished")
      node.meter.gaugeUnsafe("connections", () => connections)

      const limitOf = (c: Config): number => c.connectionsPerDestination * c.addresses
      /** Connections open to the busiest destination: the one that runs out of ports first. */
      const busiest = (): number => {
        let most = 0
        for (const n of open.values()) if (n > most) most = n
        return most
      }
      node.meter.gaugeUnsafe("busiestDestination", busiest)
      node.meter.gaugeUnsafe("portLimit", () => limitOf(fast.settings()))

      /** Take a connection for the call on `link`, or refuse it when the destination's ports are used up. */
      const gate = (link: Link): Link => ({
        ...link,
        send: (message, done) => {
          connectionAttempts.n++
          const held = open.get(link.id) ?? 0
          if (held >= limitOf(fast.settings())) {
            portErrors.n++
            portAllocationErrors++
            done?.(Throttled({ node: node.id, reason: "ErrorPortAllocation: no free port to this destination" }))
            return Flow.noCancel
          }
          open.set(link.id, held + 1)
          connections++
          connectionsEstablished.n++
          let released = false
          const release = (): void => {
            if (released) return
            released = true
            connections--
            const now = (open.get(link.id) ?? 1) - 1
            if (now <= 0) open.delete(link.id)
            else open.set(link.id, now)
          }
          const cancel = link.send(message, (failure) => {
            release()
            done?.(failure)
          })
          return () => {
            release()
            cancel()
          }
        }
      })

      const path = hop<Config>(node, {
        bytesPerSecond: (c) => c.bandwidth * BYTES_PER_GBPS,
        latency: (c) => c.latency,
        mode: (c) => c.routing,
        gate,
        saturated: "NAT gateway out of bandwidth: packets dropped"
      })

      return {
        call: path.call,
        probe: Effect.sync(() => ({
          connections,
          busiest: busiest(),
          limit: limitOf(fast.settings()),
          portAllocationErrors,
          drops: path.totals.drops,
          bytes: path.totals.bytes
        }))
      }
    })
})
