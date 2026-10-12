import { Duration } from "effect"
import { Fleet, type Host as FleetHost } from "../../fleet/Fleet.ts"
import { HostPool, type Resources, type Room } from "../../fleet/Hosts.ts"
import type { Account } from "../account.ts"
import { instanceType } from "../ec2/instanceTypes.ts"
import * as Vcpus from "../ec2/vcpus.ts"
import type { Settings } from "./config.ts"
import { ImageCache } from "./images.ts"
import { METRIC_PERIOD_MS, SCALE_IN_AFTER_MS, SCALE_OUT_FROM_ZERO } from "./limits.ts"

/**
 * An EC2 Auto Scaling group capacity provider: the container instances an ECS service's tasks are placed on, and the
 * managed scaling that grows the group when tasks can't be placed. Two-level scaling: service auto scaling changes the
 * desired count of tasks; tasks that find no room wait in PROVISIONING; managed scaling sees them in the
 * CapacityProviderReservation metric and launches instances; once those register, the tasks are placed and start.
 *
 * The instances are a `Fleet` (launch, boot, agent registration; zones; replacement; scale-in) and the tasks are placed on
 * them through a `HostPool`. In AWS the group is a resource of its own that a cluster's capacity provider points at; here
 * it belongs to the service, so a service has its own instances (several services sharing a cluster's instances is in the
 * README's backlog).
 */

/** Managed scaling's last look, for a probe and gauges. */
export interface ScalingView {
  /** CapacityProviderReservation, in percent. */
  reservation: number
  /** Instances needed (M) and running or launching (N) at the last look. */
  needed: number
  running: number
  /** What managed scaling set the group's desired capacity to. */
  desired: number
}

export class Ec2Capacity {
  readonly instances: Fleet
  readonly pool: HostPool
  readonly view: ScalingView
  private lastScaleOut = Number.NEGATIVE_INFINITY
  /** The vCPUs each instance took from the account's quota, by instance id. */
  private readonly vcpus = new Map<number, number>()
  private lowSince: number | undefined = undefined
  private startingSize: number
  /** The images on each instance. */
  readonly images: ImageCache

  constructor(
    private readonly node: FleetHost,
    private readonly settings: () => Settings,
    private readonly account: () => Account,
    ledger: Vcpus.Ledger,
    /** What a task asks of an instance now. */
    private readonly demand: () => Resources,
    /** Tasks waiting for room (PROVISIONING). */
    private readonly pending: () => number
  ) {
    const s = () => this.settings().ec2
    const ms = (d: Duration.Duration) => Duration.toMillis(d)
    this.startingSize = s().desiredSize
    this.view = { reservation: 100, needed: 0, running: s().desiredSize, desired: s().desiredSize }
    let pool: HostPool | undefined
    this.instances = new Fleet(node, {
      // Container instances: a `Crash` on the hosts takes these down, and their tasks with them.
      role: "hosts",
      desired: () => this.view.desired,
      min: () => s().minSize,
      max: () => s().maxSize,
      zones: () => node.zones.all.slice(0, this.settings().zones),
      phases: () => [
        { name: "pending", ms: ms(s().pending) },
        { name: "boot", ms: ms(s().boot) },
        { name: "register", ms: ms(s().register) }
      ],
      // Instances serve no requests themselves: their tasks do.
      workers: () => 0,
      line: () => 0,
      backlog: () => 0,
      // With managed draining an instance waits for its tasks to be replaced and stop (up to 48 hours); without, it goes at once.
      drain: () => (s().managedDraining ? 48 * 3_600_000 : 0),
      detect: () => ms(s().replaceAfter),
      // Each instance takes its type's vCPUs from the region's EC2 quota, and gives back what it took (the type may change).
      capacity: {
        take: (unit) => {
          const vcpus = this.room().cpu
          if (!Vcpus.take(ledger, this.account(), "onDemand", vcpus)) return false
          this.vcpus.set(unit.id, vcpus)
          return true
        },
        give: (unit) => {
          Vcpus.give(ledger, "onDemand", this.vcpus.get(unit.id) ?? 0)
          this.vcpus.delete(unit.id)
        }
      },
      protect: (unit) => s().managedTerminationProtection && pool!.occupied(unit),
      name: (id) => `i-${id}`
    })
    pool = new HostPool(this.instances, {
      room: () => this.room(),
      strategy: () => s().placement,
      weigh: () => (s().placement === "binpack" ? "memory" : "both"),
      evictOnDrain: () => s().managedDraining,
      now: node.fast.now
    })
    this.pool = pool
    this.images = new ImageCache(node.fast.now)
    node.fast.after(METRIC_PERIOD_MS, this.tick, undefined)
  }

  /** What one instance of the configured type gives its tasks: all its vCPUs and memory (see the README for what isn't reserved). */
  room(): Room {
    const t = instanceType(this.settings().ec2.instanceType)
    return { cpu: t.vcpus, memory: t.memoryGiB * 1024, slots: Number.POSITIVE_INFINITY }
  }

  /** Settings changed: a new starting size is a manual change of the group's desired capacity. */
  refresh(): void {
    const size = this.settings().ec2.desiredSize
    if (size !== this.startingSize) {
      this.startingSize = size
      this.view.desired = size
    }
    this.instances.refresh()
  }

  /**
   * Managed scaling, once a minute: CapacityProviderReservation = M / N × 100, where M is the instances needed (those
   * running tasks, and as many more as the tasks waiting in PROVISIONING would fill) and N the instances running or
   * launching, so instances already launching for waiting tasks keep it from launching more for them. Target tracking keeps it at the target capacity: out at once
   * (one data point), by at least the minimum step and at most the maximum; in only after 15 minutes below and 15 minutes
   * after the last scale-out.
   */
  private readonly tick = (): void => {
    this.node.fast.after(METRIC_PERIOD_MS, this.tick, undefined)
    const s = this.settings().ec2
    if (!s.managedScaling) return
    const now = this.node.fast.now()
    let occupied = 0
    let up = 0
    for (const h of this.pool.hosts) {
      if (!h.alive || h.cordoned) continue
      up++
      if (h.tenants.size > 0) occupied++
    }
    const starting = this.instances.count.requested + this.instances.count.starting
    const perHost = HostPool.perHost(this.room(), this.demand())
    const waiting = this.pending()
    const forWaiting = perHost > 0 ? Math.ceil(waiting / perHost) : 0
    const needed = occupied + forWaiting
    const running = up + starting
    this.view.needed = needed
    this.view.running = running
    let wanted: number
    if (running === 0) {
      this.view.reservation = waiting > 0 ? 200 : 100
      wanted = waiting > 0 ? SCALE_OUT_FROM_ZERO : 0
    } else {
      this.view.reservation = (needed / running) * 100
      wanted = Math.ceil((needed * 100) / s.targetCapacity)
    }
    const clampSize = (n: number) => Math.max(s.minSize, Math.min(s.maxSize, n))
    const step = (n: number) => Math.max(s.minimumScalingStepSize, Math.min(s.maximumScalingStepSize, n))
    if (wanted > running) {
      this.lowSince = undefined
      const next = clampSize(running + step(wanted - running))
      this.view.desired = next
      this.lastScaleOut = now
      this.instances.refresh()
      return
    }
    if (wanted < running) {
      this.lowSince ??= now
      if (now - this.lowSince >= SCALE_IN_AFTER_MS && now - this.lastScaleOut >= SCALE_IN_AFTER_MS) {
        this.view.desired = clampSize(running - step(running - wanted))
        this.lowSince = now
        this.instances.refresh()
      }
      return
    }
    this.lowSince = undefined
  }
}
