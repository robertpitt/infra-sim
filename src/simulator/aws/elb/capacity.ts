import { ALB_LCU, MIN_RESERVED_LCU, NLB_LCU, SCALE_IN_HALF_LIFE_MS, TARGET_UTILIZATION, TICK_MS } from "./config.ts"

/**
 * Load balancer capacity units: what a request costs, how much a load balancer has, and how it scales.
 *
 * AWS bills (and sizes reservations) in LCUs, each the larger of a few dimensions (Elastic Load Balancing pricing): new
 * connections a second, active connections, bytes processed an hour, rule evaluations a second. A request's cost is its
 * share of the dimension it weighs most on: `1 / (requests per connection × 25)` LCU-seconds for opening connections,
 * `bytes / (1 GB / 3,600)` for the bytes it carries (0.4 GB an hour for a Lambda target), `(rules − 10) / 1,000` for rule
 * evaluations; active connections (requests in flight ÷ 3,000) are added when demand is measured. What the simulator does
 * not know (response sizes, connections held idle between requests) is left out, so these are lower bounds.
 *
 * How an ALB scales is not published. AWS says it scales automatically to the traffic it sees, that `CapacityUtilization`
 * can reach 100% "briefly during rapid traffic spikes when demand exceeds the load balancer's automatic scaling capacity",
 * and that an LCU reservation (at least 100 LCUs) keeps capacity from going below it. The model, every number assumed:
 *
 *  - the load balancer starts scaled to the traffic of its first second, as one that has been running for a while is;
 *  - once a second it measures demand (LCUs, counting requests it turned away) and wants `demand / 0.7`, never less than
 *    its minimum or its reservation;
 *  - capacity grows towards that at most `scaleUpPerMinute` times a minute (continuously), and shrinks with a ten-minute
 *    half-life; a reservation applies at once;
 *  - requests are admitted against a bucket that refills at the capacity (LCU-seconds a second) and holds one second of
 *    it; a request that finds it empty is a rejected connection (`RejectedConnectionCount`).
 */

/** The burst an ALB absorbs above its capacity: a second of it (assumed). */
const BURST_S = 1

/** What an ALB's settings make of a request's cost, worked out once per settings object. */
export interface Costs {
  /** LCU-seconds per request for opening connections, or for rule evaluations, whichever is larger. */
  readonly perRequest: number
  /** LCU-seconds per byte, for instance, IP and container targets and for Lambda targets. */
  readonly perByte: number
  readonly perLambdaByte: number
}

export const albCosts = (requestsPerConnection: number, rules: number): Costs => ({
  perRequest: Math.max(1 / (Math.max(1, requestsPerConnection) * ALB_LCU.newPerS), Math.max(0, rules - ALB_LCU.freeRules) / ALB_LCU.rulesPerS),
  perByte: 3_600 / ALB_LCU.bytesPerHour,
  perLambdaByte: 3_600 / ALB_LCU.lambdaBytesPerHour
})

export const nlbCosts = (requestsPerConnection: number): Costs => ({
  perRequest: 1 / (Math.max(1, requestsPerConnection) * NLB_LCU.newPerS),
  perByte: 3_600 / NLB_LCU.bytesPerHour,
  perLambdaByte: 3_600 / NLB_LCU.bytesPerHour
})

/** What scaling reads from the ALB's settings. */
export interface Scaling {
  readonly reserved: number
  readonly minimum: number
  readonly scaleUpPerMinute: number
}

/** A reservation is at least 100 LCUs: anything from 1 to 99 counts as 100 (AWS refuses less). */
export const reservedLcu = (reserved: number): number => (reserved <= 0 ? 0 : Math.max(MIN_RESERVED_LCU, reserved))

/**
 * One load balancer's capacity and demand. `admit` is on every request; `tick` once a second. Plain numbers, no
 * allocation, nothing random: two runs of the same design scale identically.
 */
export class Capacity {
  /** Capacity now, in LCUs. 0 until the first tick sizes it. */
  lcu = 0
  /** Demand measured at the last tick, in LCUs: `ConsumedLCUs` as it is right now. */
  consumed = 0
  /** The most demand measured so far: `PeakLCUs`. */
  peak = 0
  private sized = false
  private tokens = 0
  private at = 0
  /** LCU-seconds asked for since the last tick, admitted or not. */
  private asked = 0

  constructor(private readonly activePerLcu: number) {}

  /** Count a request's cost, and say whether the load balancer has room for it. Always room until it is first sized. */
  admit(cost: number, now: number, limit: boolean): boolean {
    this.asked += cost
    if (!limit || !this.sized) return true
    const elapsed = now - this.at
    if (elapsed > 0) {
      this.tokens = Math.min(this.lcu * BURST_S, this.tokens + (elapsed / 1000) * this.lcu)
      this.at = now
    }
    if (this.tokens < cost) return false
    this.tokens -= cost
    return true
  }

  /** Measure the last second's demand (plus `active` connections) and, if `scaling` is given, scale towards it. */
  tick(now: number, active: number, scaling: Scaling | undefined): void {
    const demand = this.asked / (TICK_MS / 1000) + active / this.activePerLcu
    this.asked = 0
    this.consumed = demand
    if (demand > this.peak) this.peak = demand
    if (scaling === undefined) return
    const floor = Math.max(scaling.minimum, reservedLcu(scaling.reserved))
    const want = Math.max(floor, demand / TARGET_UTILIZATION)
    if (!this.sized) {
      this.sized = true
      this.lcu = want
      this.tokens = want * BURST_S
      this.at = now
      return
    }
    if (want > this.lcu) this.lcu = Math.min(want, this.lcu * scaling.scaleUpPerMinute ** (TICK_MS / 60_000))
    else if (want < this.lcu) this.lcu = Math.max(want, this.lcu * 0.5 ** (TICK_MS / SCALE_IN_HALF_LIFE_MS))
    if (this.lcu < floor) this.lcu = floor
  }

  /** Demand over capacity, 0 to 1: `CapacityUtilization`. */
  get utilization(): number {
    return this.lcu <= 0 ? 0 : Math.min(1, this.consumed / this.lcu)
  }
}
