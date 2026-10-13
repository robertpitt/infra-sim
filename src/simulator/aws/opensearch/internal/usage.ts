import type { Fast } from "../../../Component.ts"
import type { Cluster } from "./cluster.ts"
import type { Config } from "./config.ts"
import type { DataNode } from "./node.ts"

/**
 * What `OpenSearch`'s gauges and probe read off the data nodes: CPU utilisation measured over each frame, sums and
 * maxima over the live nodes, and the shard copies each node holds. Read once a frame, not per request.
 */
export class Usage {
  private sampledAt = -1
  /** Mean utilisation of the live nodes over the last frame. */
  cpuMean = 0
  /** The busiest live node's utilisation over the last frame. */
  cpuMax = 0
  /** Each node's utilisation over the last frame, by its index. */
  readonly perNodeCpu: Array<number> = []

  constructor(
    private readonly fast: Fast<Config>,
    private readonly cluster: Cluster
  ) {}

  /** Nodes in the cluster right now (a scale-in leaves old ones behind, holding nothing). */
  members(): ReadonlyArray<DataNode> {
    return this.cluster.nodes.slice(0, this.fast.settings().dataNodes)
  }

  /** Measure CPU utilisation, once for every gauge and the probe that read it in a frame. */
  sampleCpu(): void {
    const now = this.fast.now()
    if (now === this.sampledAt) return
    this.sampledAt = now
    let sum = 0
    let live = 0
    this.cpuMax = 0
    for (const n of this.members()) {
      const u = n.cpu.sample()
      this.perNodeCpu[n.index] = u
      if (!n.up) continue
      sum += u
      live++
      if (u > this.cpuMax) this.cpuMax = u
    }
    this.cpuMean = live > 0 ? sum / live : 0
  }

  /** `read` summed over the live nodes. */
  sum(read: (n: DataNode) => number): number {
    let total = 0
    for (const n of this.members()) if (n.up) total += read(n)
    return total
  }

  /** The most `read` gives on any live node (0 with none). */
  max(read: (n: DataNode) => number): number {
    let most = 0
    for (const n of this.members()) if (n.up) most = Math.max(most, read(n))
    return most
  }

  /** The primaries and replicas each of `nodes` holds, in their order. */
  held(nodes: ReadonlyArray<DataNode>): Array<{ primaries: number; replicas: number }> {
    const held = nodes.map(() => ({ primaries: 0, replicas: 0 }))
    for (const shard of this.cluster.shards) {
      for (const copy of shard.copies) {
        const h = held[copy]
        if (h === undefined) continue
        if (copy === shard.primary) h.primaries++
        else h.replicas++
      }
    }
    return held
  }
}
