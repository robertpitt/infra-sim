import { Effect } from "effect"
import type { Fast } from "../../../Component.ts"
import * as Distribution from "../../../Distribution.ts"
import type { Link } from "../../../Edge.ts"
import * as Flow from "../../../Flow.ts"
import type { Limiter } from "../../../Limiter.ts"
import { type Call, type CallFailure, type Message, Throttled } from "../../../Message.ts"
import type { Latency } from "../../../Setting.ts"
import type { Meter } from "../../../Telemetry.ts"

/**
 * What a NAT gateway and a VPC endpoint have in common: a network appliance a call passes through on its way out of
 * the VPC. It adds a little latency, can carry only so many bytes per second, and hands the call to whatever is wired
 * behind it. The two differ in what else limits them (the NAT gateway counts connections), which they plug in here.
 */

/** The parts of a node a hop uses. A component's node satisfies it. */
export interface Host<Config> {
  readonly id: string
  readonly fast: Fast<Config>
  readonly out: (port: "out") => ReadonlyArray<Link>
  readonly limiter: Limiter
  readonly meter: Meter
}

/** What a hop plugs in: its bandwidth, its own latency, how it picks a destination, and anything else that limits it. */
export interface HopSpec<Config> {
  /** Bytes per second the hop carries right now, or `undefined` when AWS publishes no limit for it. */
  readonly bytesPerSecond: (config: Config) => number | undefined
  /** Time the hop itself adds to a call, or `undefined` for none. */
  readonly latency: (config: Config) => Latency | undefined
  /** How a call picks among the destinations wired behind the hop. */
  readonly mode: (config: Config) => Flow.FanOut
  /** Wraps each destination link, to count or limit what goes through it. Called once per wired link. */
  readonly gate?: (link: Link) => Link
  /** What the failure says when the bandwidth is exhausted. */
  readonly saturated: string
}

/** A built hop: its call path, and the totals its probe reports. */
export interface Hop {
  readonly call: (message: Message) => Call
  /** Running totals for the probe (the meter's counters reset every window, these never do). */
  readonly totals: {
    /** Bytes the hop has carried. */
    bytes: number
    /** Calls refused because the hop had no bandwidth left. */
    drops: number
  }
}

/**
 * Build the call path of a hop. Per call: spend the message's bytes from a per-second bucket (a hop that is out of
 * bandwidth drops the call), wait the hop's own latency, then call a destination.
 */
export const hop = <Config>(node: Host<Config>, spec: HopSpec<Config>): Hop => {
  const { fast } = node
  const bytes = node.meter.counter("bytes")
  const drops = node.meter.counter("drops")
  const totals = { bytes: 0, drops: 0 }
  const bandwidthKey = `${node.id}/bandwidth`

  // The wrapped links are the same for every call until wiring changes: rebuild only when the link array does.
  let wired: ReadonlyArray<Link> | undefined
  let gated: ReadonlyArray<Link> = []
  const destinations = (links: ReadonlyArray<Link>): ReadonlyArray<Link> => {
    if (spec.gate === undefined) return links
    if (wired !== links || gated.length !== links.length) {
      wired = links
      gated = links.map(spec.gate)
    }
    return gated
  }

  return {
    totals,
    call: (message) => {
      const c = fast.settings()
      const bytesPerSecond = spec.bytesPerSecond(c)
      if (bytesPerSecond !== undefined && !node.limiter.takeUnsafe(bandwidthKey, { rate: bytesPerSecond, burst: bytesPerSecond }, message.bytes)) {
        drops.n++
        totals.drops++
        return Effect.fail(Throttled({ node: node.id, reason: spec.saturated }))
      }
      bytes.n += message.bytes
      totals.bytes += message.bytes
      const latency = spec.latency(c)
      const delay = latency === undefined ? 0 : Distribution.latencyMs(latency, fast.random)
      const mode = spec.mode(c)
      const links = destinations(node.out("out"))
      return Effect.callback<void, CallFailure>((resume) => {
        let cancelDownstream = Flow.noCancel
        const start = (): void => {
          cancelDownstream = Flow.fanOut(mode, links, fast.random, message, (failure) => resume(failure === undefined ? Effect.void : Effect.fail(failure)))
        }
        if (delay <= 0) {
          start()
          return Effect.sync(() => cancelDownstream())
        }
        const timer = fast.after(delay, start, undefined)
        return Effect.sync(() => {
          timer.cancel()
          cancelDownstream()
        })
      })
    }
  }
}
