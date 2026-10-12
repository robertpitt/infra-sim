import { Schema } from "effect"
import type { Counter, Meter } from "../../Telemetry.ts"

/** What an edge out of a load balancer leads to: a fleet's target group, a Lambda function, or one address. */
export type TargetKind = "fleet" | "lambda" | "address"

/**
 * A counter that shows in frames (a rate) and keeps a running total for the probe. The meter's counters are emptied every
 * frame, so the total lives here.
 */
export class Count {
  total = 0
  constructor(private readonly frame: Counter) {}
  add(): void {
    this.frame.n++
    this.total++
  }
}

export const count = (meter: Meter, name: string): Count => new Count(meter.counter(name))

const Zone = Schema.Struct({
  zone: Schema.String,
  /** Whether its address is in DNS now. */
  inDns: Schema.Boolean,
  /** Its share of new requests now: falls to 0 over the TTL after it leaves DNS. */
  share: Schema.Number,
  /** Whether its load balancer node is up (its zone isn't down). */
  nodeUp: Schema.Boolean
})

const TargetGroupEdge = Schema.Struct({ edge: Schema.String, to: Schema.String, kind: Schema.Literals(["fleet", "lambda", "address"]) })

/** What an ALB's probe reports. */
export const AlbState = Schema.Struct({
  zones: Schema.Array(Zone),
  /** Capacity now, in LCUs (0 until it is first sized, or with scaling off). */
  capacityLcu: Schema.Number,
  /** Demand in the last second, in LCUs. */
  consumedLcu: Schema.Number,
  peakLcu: Schema.Number,
  reservedLcu: Schema.Number,
  /** Requests in flight. */
  active: Schema.Number,
  requests: Schema.Number,
  elb502: Schema.Number,
  elb503: Schema.Number,
  elb504: Schema.Number,
  elb4xx: Schema.Number,
  target5xx: Schema.Number,
  rejectedConnections: Schema.Number,
  targetGroups: Schema.Array(TargetGroupEdge)
})

/** What an NLB's probe reports. */
export const NlbState = Schema.Struct({
  zones: Schema.Array(Zone),
  consumedLcu: Schema.Number,
  peakLcu: Schema.Number,
  /** Connections (requests) in flight. */
  active: Schema.Number,
  requests: Schema.Number,
  /** Resets the load balancer sent itself: no target, idle timeout, a dead node. */
  elbResets: Schema.Number,
  targetGroups: Schema.Array(TargetGroupEdge)
})
