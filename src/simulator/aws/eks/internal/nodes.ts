import { Duration } from "effect"
import { Fleet, type Host as FleetHost, type Phase } from "../../../fleet/Fleet.ts"
import { type Host, HostPool, type Room } from "../../../fleet/Hosts.ts"
import type { Account } from "../../internal/account.ts"
import { instanceType } from "../../ec2/InstanceTypes.ts"
import * as Vcpus from "../../ec2/Vcpus.ts"
import { ImageCache } from "../../ecs/Images.ts"
import type { Settings } from "./config.ts"
import { EVICTION_MIB, reservedCpu, reservedMemoryMiB } from "./limits.ts"

/**
 * A managed node group (or Karpenter's nodes): EC2 instances that join the cluster as nodes, a `Fleet` of hosts, with a
 * `HostPool` the pods are scheduled onto. Its size is `desired`, which the node autoscaler moves (`autoscaler.ts`); a node
 * it removes is named (cordoned, drained, then terminated), never left to the Auto Scaling group's choice.
 *
 * What a node offers pods is its allocatable: the instance's vCPUs and memory less what the EKS AMI reserves for the
 * kubelet and system (6% of the first core and less of the others; 11 MiB a pod plus 255 MiB) and the kubelet's 100 MiB
 * eviction threshold; and at most `maxPods` pods.
 */
export class NodeGroup {
  readonly fleet: Fleet
  readonly pool: HostPool
  readonly images: ImageCache
  /** The group's desired size: what the autoscaler asks for. */
  desired: number
  private startingSize: number

  constructor(
    node: FleetHost,
    private readonly settings: () => Settings,
    private readonly account: () => Account,
    ledger: Vcpus.Ledger
  ) {
    const s = () => this.settings().nodes
    const ms = (d: Duration.Duration) => Duration.toMillis(d)
    this.desired = this.startingSize = s().desiredSize
    const karpenter = () => s().autoscaler === "karpenter"
    this.fleet = new Fleet(node, {
      // Nodes: a `Crash` on the hosts takes these down, and the pods on them are evicted as Kubernetes does.
      role: "hosts",
      desired: () => this.desired,
      // Karpenter's NodePools have no minimum: it keeps only the nodes pods need.
      min: () => (karpenter() ? 0 : s().minSize),
      max: () => s().maxSize,
      zones: () => node.zones.all.slice(0, this.settings().zones),
      phases: (): ReadonlyArray<Phase> =>
        karpenter()
          ? [{ name: "launching", ms: ms(s().karpenterLaunch) }]
          : [{ name: "pending", ms: ms(s().pending) }, { name: "boot", ms: ms(s().boot) }, { name: "joining", ms: ms(s().join) }],
      // Nodes serve nothing themselves; their pods do.
      workers: () => 0,
      line: () => 0,
      backlog: () => 0,
      // A node being removed is drained: it waits for its pods to be evicted and stop (up to the bootstrap limit).
      drain: () => 15 * 60_000,
      detect: () => ms(s().replaceAfter),
      // Each node takes its type's vCPUs from the region's EC2 quota, and gives back what it took (the type may change).
      capacity: Vcpus.onDemandCapacity(ledger, this.account, () => instanceType(s().instanceType).vcpus),
      // A managed node group's Auto Scaling group rebalances zones (AZRebalance); Karpenter has no group to do it.
      rebalance: () => !karpenter(),
      name: (id) => `node-${id}`
    })
    this.pool = new HostPool(this.fleet, {
      room: () => this.allocatable(),
      strategy: () => s().scheduling,
      weigh: () => "both",
      now: node.fast.now
    })
    this.images = new ImageCache(node.fast.now)
  }

  /** What one node gives pods: allocatable CPU and memory, and max pods. */
  allocatable(): Room {
    const n = this.settings().nodes
    const t = instanceType(n.instanceType)
    return {
      cpu: Math.max(0, t.vcpus - reservedCpu(t.vcpus)),
      memory: Math.max(0, t.memoryGiB * 1024 - reservedMemoryMiB(n.maxPods) - EVICTION_MIB),
      slots: n.maxPods
    }
  }

  /** Nodes requested, starting or up (not draining). */
  get live(): number {
    const c = this.fleet.count
    return c.requested + c.starting + c.grace + c.inService
  }

  /** Grow by `n` nodes, within the maximum. */
  add(n: number): number {
    const before = this.desired
    this.desired = Math.min(this.settings().nodes.maxSize, Math.max(this.desired, this.live) + n)
    this.fleet.refresh()
    return this.desired - before
  }

  /** Remove one node: cordon it, lower the size, and drain it (its pods are evicted and placed elsewhere). */
  remove(host: Host): void {
    this.pool.cordon(host)
    this.desired = Math.max(0, Math.min(this.desired, this.live) - 1)
    this.fleet.stop(host.unit)
  }

  /** Settings changed: a new starting size is a manual change of the group's size. */
  refresh(): void {
    const size = this.settings().nodes.desiredSize
    if (size !== this.startingSize) {
      this.startingSize = size
      this.desired = size
    }
    this.fleet.refresh()
  }
}
