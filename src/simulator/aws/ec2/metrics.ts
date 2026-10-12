import type { Member } from "../../fleet/Unit.ts"

/**
 * The group's scaling metrics, as CloudWatch would aggregate them: what `core.target-tracking` tracks.
 *
 * - **CPU.** A request holds a worker (a share of a vCPU) for its service time, so busy workers over an instance's workers
 *   are its CPU utilization. AWS's predefined metric `ASGAverageCPUUtilization` averages it over the group's instances,
 *   leaving out instances still in their instance warmup ("how long after an instance reaches the InService state it
 *   waits before contributing usage data to the aggregated metrics", `ec2-auto-scaling-default-instance-warmup.html`).
 *   `cpu` is that average, as a ratio (0.5 is 50%). `cpuTotal` is that average times the instances in service, warming
 *   ones included: tracked per unit with a target of 0.5 it asks for `ceil(in service × average / 0.5)` instances, a
 *   target-tracking policy's arithmetic. Instances still launching are not in it, so a policy that already asked for
 *   them doesn't ask again while they launch; instances warming up count as capacity at the warmed instances' average,
 *   which is how AWS treats them ("considers instances that are warming up as part of the capacity of the group").
 * - **Requests.** `requestCount` is requests that reached the group in the last minute, the target group's
 *   `RequestCount`; `requestCountPerTarget` divides it by the instances serving, as `ALBRequestCountPerTarget` does.
 *   Tracked per unit, `requestCount` gives `ceil(requests per minute / target per instance)`.
 */

/** Requests over the trailing minute, in one-second buckets: O(1) a request. */
export class PerMinute {
  private readonly buckets = new Float64Array(60)
  private second = 0
  private total = 0

  add(now: number): void {
    this.roll(now)
    this.buckets[this.second % 60]!++
    this.total++
  }

  value(now: number): number {
    this.roll(now)
    return this.total
  }

  private roll(now: number): void {
    const s = Math.floor(now / 1000)
    if (s <= this.second) return
    if (s - this.second >= 60) {
      this.buckets.fill(0)
      this.total = 0
    } else {
      for (let k = this.second + 1; k <= s; k++) {
        const i = k % 60
        this.total -= this.buckets[i]!
        this.buckets[i] = 0
      }
    }
    this.second = s
  }
}

/** The group's CPU as its scaling metrics see it. */
export interface Cpu {
  /** Average utilization (0 to 1) of the instances past their warmup; of every instance serving if none is. */
  readonly average: number
  /** Instances serving (alive), warming ones included. */
  readonly serving: number
}

/**
 * The average CPU utilization of the serving, live instances whose warmup is over. `upAt` is when an instance came up
 * (undefined for instances there before the simulation started, which are warm).
 */
export const cpuOf = (units: ReadonlyArray<Member>, workers: number, warmupMs: number, now: number, upAt: (id: number) => number | undefined): Cpu => {
  let busy = 0
  let warmed = 0
  let allBusy = 0
  let serving = 0
  for (const m of units) {
    if (!m.serving || !m.alive) continue
    const used = Math.min(m.running, workers)
    serving++
    allBusy += used
    const up = upAt(m.id)
    if (up !== undefined && now - up < warmupMs) continue
    busy += used
    warmed++
  }
  if (workers <= 0 || serving === 0) return { average: 0, serving }
  return { average: warmed > 0 ? busy / (warmed * workers) : allBusy / (serving * workers), serving }
}
