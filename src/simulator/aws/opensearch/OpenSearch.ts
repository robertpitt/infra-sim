import { Duration, Effect, Schema, Stream, SubscriptionRef } from "effect"
import type { Call, CallFailure } from "../../Message.ts"
import { tallies, totals } from "../../kit/Tally.ts"
import * as Aws from "../provider.ts"
import { Cluster, ZoneMap } from "./cluster.ts"
import {
  Config,
  heapBytes,
  INDEXING_PRESSURE_SHARE,
  INSTANCE_TYPES,
  MAX_PRIMARY_SHARDS,
  MAX_SHARDS_PER_NODE,
  SEARCH_QUEUE,
  searchThreads,
  SOURCES,
  WRITE_QUEUE,
  writeThreads
} from "./config.ts"
import type { DataNode } from "./node.ts"
import { Refresh } from "./refresh.ts"
import { dashboard } from "./dashboard.ts"
import { type Answer, type Context, type Counter, makeMetrics, search, write } from "./requests.ts"

const COUNTERS: ReadonlyArray<Counter> = [
  "writeRequests",
  "searchRequests",
  "indexed",
  "replicated",
  "searchShards",
  "partialSearches",
  "writeRejected",
  "searchRejected",
  "pressureRejected",
  "replicaRejected",
  "unavailableDocs",
  "unavailableShards",
  "lostTasks"
]

const STATUS = ["green", "yellow", "red"] as const

const Pool = Schema.Struct({ active: Schema.Number, queued: Schema.Number, rejected: Schema.Number })

/**
 * An Amazon OpenSearch Service domain holding one index: data nodes of one instance type, each with a write and a
 * search thread pool sharing its processors, the index's primary shards and replicas placed on them, refresh, and
 * failover when nodes fail. A call whose `operation` is write indexes `count` documents (a bulk request when more than
 * one); a read is a search.
 */
export const OpenSearch = Aws.component({
  type: "aws.opensearch",
  service: "OpenSearch Service",
  title: "OpenSearch domain",
  description:
    "Search and analytics cluster. Data nodes with write and search thread pools that share their CPU and reject with 429 past their queues, primary shards and replicas (replicas cost write capacity), hot shards by routing key, refresh lag, and replicas promoted when a node, or its Availability Zone, fails.",
  docs: `${Aws.docs.opensearch}what-is.html`,
  category: "storage",
  icon: "search",
  accent: "#8c4fff",
  limits: [
    { label: "Write thread pool", value: "one thread per vCPU, queue of 10,000 per node", adjustable: false, source: SOURCES.threadPool, note: "200 before Elasticsearch 7.1. Replica writes are never rejected for a full queue." },
    { label: "Search thread pool", value: "int(vCPUs × 3 / 2) + 1 threads, queue of 1,000 per node", adjustable: false, source: SOURCES.threadPool },
    { label: "Indexing pressure", value: "indexing in flight on a node at most 10% of its heap (replicas 1.5 times that)", adjustable: false, source: SOURCES.indexingPressure },
    { label: "Java heap", value: "half the instance's memory, at most 32 GiB", adjustable: false, source: SOURCES.quotas },
    { label: "HTTP request payload", value: "10 MiB (t3, m6g.large, smaller types) or 100 MiB, by instance type", adjustable: false, source: `${SOURCES.quotas}#network-limits`, note: "Larger requests get 413." },
    { label: "Instances per domain", value: "200 by default, up to 1,002; T2 and T3 at most 10", adjustable: true, source: SOURCES.serviceQuotas, note: "The developer guide's table gives 80 as the default for most families; the account quota is the General Reference's 200." },
    { label: "Dedicated master nodes", value: "at most 5 per domain", adjustable: false, source: SOURCES.serviceQuotas, note: "Not modelled: masters are assumed healthy." },
    { label: "Primary shards per index", value: `at most ${MAX_PRIMARY_SHARDS.toLocaleString("en-US")}; fixed when the index is created; OpenSearch Service's default is 5 with 1 replica`, adjustable: false, source: SOURCES.sharding },
    { label: "Shards per node", value: `${MAX_SHARDS_PER_NODE.toLocaleString("en-US")} up to OpenSearch 2.15; from 2.17, 1,000 per 16 GiB of heap up to 4,000`, adjustable: false, source: SOURCES.quotas },
    { label: "Domains per region", value: "500", adjustable: true, source: SOURCES.serviceQuotas, note: "Set in the account quotas." }
  ],
  dashboard,
  highlights: [
    { rate: "fail.Throttled", label: "429/s" },
    { gauge: "cpuMax", label: "hottest CPU", format: "percent" },
    { gauge: "searchQueue", label: "search queue" }
  ],
  config: Config,
  // A domain answers; it calls nothing.
  ports: {},
  // Its data nodes are spread over zones: a zone outage fails the nodes there (see `cluster.ts`), not the domain.
  handlesZoneFaults: true,
  state: Schema.Struct({
    instanceType: Schema.String,
    vcpu: Schema.Number,
    heapGiB: Schema.Number,
    /** Threads per node in each pool, and the size of each pool's queue. */
    threads: Schema.Struct({ write: Schema.Number, search: Schema.Number }),
    queues: Schema.Struct({ write: Schema.Number, search: Schema.Number }),
    /** Bytes of indexing a node may hold in flight (coordinating and primary). */
    indexingPressureLimit: Schema.Number,
    status: Schema.Literals(STATUS),
    nodes: Schema.Struct({ configured: Schema.Number, live: Schema.Number }),
    /** The Availability Zones the data nodes are spread over, and those of them that are down. */
    zones: Schema.Array(Schema.String),
    zonesDown: Schema.Array(Schema.String),
    shards: Schema.Struct({
      primaries: Schema.Number,
      replicas: Schema.Number,
      active: Schema.Number,
      unassigned: Schema.Number,
      promotions: Schema.Number,
      /** Writes waiting for a shard to have a primary again. */
      waitingWrites: Schema.Number
    }),
    /** Each data node: whether it is up, what it holds, how busy it is. `cpu` is its utilisation over the last frame. */
    perNode: Schema.Array(Schema.Struct({
      node: Schema.Number,
      /** Its Availability Zone ("" in a place with none). */
      zone: Schema.String,
      up: Schema.Boolean,
      primaries: Schema.Number,
      replicas: Schema.Number,
      cpu: Schema.Number,
      write: Pool,
      search: Pool,
      indexingBytes: Schema.Number,
      replicaBytes: Schema.Number
    })),
    totals: Schema.Struct({
      writeRequests: Schema.Number,
      searchRequests: Schema.Number,
      indexed: Schema.Number,
      replicated: Schema.Number,
      searchShards: Schema.Number,
      partialSearches: Schema.Number,
      writeRejected: Schema.Number,
      searchRejected: Schema.Number,
      pressureRejected: Schema.Number,
      replicaRejected: Schema.Number,
      unavailableDocs: Schema.Number,
      unavailableShards: Schema.Number,
      lostTasks: Schema.Number
    }),
    refresh: Schema.Struct({ intervalMs: Schema.Number, unrefreshed: Schema.Number, lagMs: Schema.Number })
  }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      // Data nodes are spread over the domain's zones from the node's own zone, or the region's first.
      const home = node.placement.zone === undefined ? 0 : Math.max(0, node.zones.all.indexOf(node.placement.zone))
      const zones = new ZoneMap(node.zones.all, home)
      const cluster = new Cluster(fast, zones)
      const refresh = new Refresh(fast)
      const counts = tallies(node.meter, COUNTERS)
      const ctx: Context = { id: node.id, fast, cluster, refresh, tallies: counts, searchable: node.meter.sampler("searchableAfter"), metrics: makeMetrics(node.meter) }

      const apply = (): void => {
        const c = fast.settings()
        cluster.reconcile(c)
        refresh.setInterval(Duration.toMillis(c.refreshInterval))
      }
      apply()
      // Failures, recoveries and a new refresh interval take effect when they are set, not at the next request.
      yield* node.spawn(SubscriptionRef.changes(node.config).pipe(Stream.runForEach(() => Effect.sync(apply))))

      // A zone's outage fails its data nodes, and its end brings them back, as `failover.failedNodes` does. The engine
      // leaves zone faults to the domain (`handlesZoneFaults`); an Outage on the node is still the endpoint down.
      const zonesChanged = (): void => {
        let changed = false
        for (let z = 0; z < zones.names.length; z++) {
          const down = node.zones.down(zones.names[z]!) ? 1 : 0
          if (zones.lost[z] === down) continue
          zones.lost[z] = down
          changed = true
        }
        if (!changed) return
        zones.anyLost = zones.lost.includes(1)
        cluster.reconcile(fast.settings())
        cluster.zonesChanged()
      }
      const unwatch = node.faults.watch(zonesChanged)
      yield* Effect.addFinalizer(() => Effect.sync(unwatch))

      /** Nodes in the cluster right now (a scale-in leaves old ones behind, holding nothing). */
      const members = () => cluster.nodes.slice(0, fast.settings().dataNodes)

      // CPU utilisation is measured over each frame, once for every gauge and the probe that read it.
      let sampledAt = -1
      let cpuMean = 0
      let cpuMax = 0
      const perNodeCpu: Array<number> = []
      const sampleCpu = (): void => {
        const now = fast.now()
        if (now === sampledAt) return
        sampledAt = now
        let sum = 0
        let live = 0
        cpuMax = 0
        for (const n of members()) {
          const u = n.cpu.sample()
          perNodeCpu[n.index] = u
          if (!n.up) continue
          sum += u
          live++
          if (u > cpuMax) cpuMax = u
        }
        cpuMean = live > 0 ? sum / live : 0
      }
      const sum = (read: (n: DataNode) => number): number => {
        let total = 0
        for (const n of members()) if (n.up) total += read(n)
        return total
      }
      const max = (read: (n: DataNode) => number): number => {
        let most = 0
        for (const n of members()) if (n.up) most = Math.max(most, read(n))
        return most
      }
      const pressureLimit = (): number => heapBytes(INSTANCE_TYPES[fast.settings().instanceType]) * INDEXING_PRESSURE_SHARE

      node.meter.gaugeUnsafe("cpu", () => (sampleCpu(), cpuMean))
      node.meter.gaugeUnsafe("cpuMax", () => (sampleCpu(), cpuMax))
      node.meter.gaugeUnsafe("writeActive", () => sum((n) => n.write.running))
      node.meter.gaugeUnsafe("writeQueue", () => sum((n) => n.write.queued))
      node.meter.gaugeUnsafe("writeQueueMax", () => max((n) => n.write.queued))
      node.meter.gaugeUnsafe("searchActive", () => sum((n) => n.search.running))
      node.meter.gaugeUnsafe("searchQueue", () => sum((n) => n.search.queued))
      node.meter.gaugeUnsafe("searchQueueMax", () => max((n) => n.search.queued))
      node.meter.gaugeUnsafe("indexingPressure", () => max((n) => n.indexingBytes) / pressureLimit())
      node.meter.gaugeUnsafe("unrefreshed", () => refresh.unrefreshed)
      node.meter.gaugeUnsafe("refreshLag", () => refresh.lag())
      node.meter.gaugeUnsafe("clusterStatus", () => cluster.status())
      // CloudWatch publishes the status as three metrics, each 1 while it holds.
      node.meter.gaugeUnsafe("statusGreen", () => (cluster.status() === 0 ? 1 : 0))
      node.meter.gaugeUnsafe("statusYellow", () => (cluster.status() === 1 ? 1 : 0))
      node.meter.gaugeUnsafe("statusRed", () => (cluster.status() === 2 ? 1 : 0))
      node.meter.gaugeUnsafe("activeShards", () => cluster.shards.length * (fast.settings().replicas + 1) - cluster.unassigned())
      node.meter.gaugeUnsafe("liveNodes", () => cluster.live)
      node.meter.gaugeUnsafe("unassignedShards", () => cluster.unassigned())
      node.meter.gaugeUnsafe("waitingWrites", () => cluster.waiting)

      return {
        call: (message): Call => {
          let early: Call | undefined
          let resume: ((effect: Call) => void) | undefined
          const reply: Answer = (failure) => {
            const effect: Call = failure === undefined ? Effect.void : Effect.fail(failure)
            if (resume !== undefined) resume(effect)
            else early = effect
          }
          const started = message.operation === "read" ? search(ctx, message, reply) : write(ctx, message, reply)
          if (typeof started !== "function") return Effect.fail(started)
          // Answered before anything had to wait (every shard refused it at once, say).
          if (early !== undefined) return early
          return Effect.callback<void, CallFailure>((r) => {
            if (early !== undefined) return r(early)
            resume = r
            return Effect.sync(started)
          })
        },
        probe: Effect.sync(() => {
          const c = fast.settings()
          cluster.reconcile(c)
          const type = INSTANCE_TYPES[c.instanceType]
          const nodes = members()
          const held = nodes.map(() => ({ primaries: 0, replicas: 0 }))
          for (const shard of cluster.shards) {
            for (const copy of shard.copies) {
              const h = held[copy]
              if (h === undefined) continue
              if (copy === shard.primary) h.primaries++
              else h.replicas++
            }
          }
          const unassigned = cluster.unassigned()
          const domainZones = [...new Set(nodes.map((n) => cluster.zoneName(n.index)))].filter((z) => z !== "")
          return {
            instanceType: c.instanceType,
            vcpu: type.vcpu,
            heapGiB: heapBytes(type) / 1024 ** 3,
            threads: { write: writeThreads(type.vcpu), search: searchThreads(type.vcpu) },
            queues: { write: WRITE_QUEUE, search: SEARCH_QUEUE },
            indexingPressureLimit: pressureLimit(),
            status: STATUS[cluster.status()]!,
            nodes: { configured: c.dataNodes, live: cluster.live },
            zones: domainZones,
            zonesDown: domainZones.filter((z) => zones.lost[zones.names.indexOf(z)] === 1),
            shards: {
              primaries: cluster.shards.length,
              replicas: c.replicas,
              active: cluster.shards.length * (c.replicas + 1) - unassigned,
              unassigned,
              promotions: cluster.promotions,
              waitingWrites: cluster.waiting
            },
            perNode: nodes.map((n, i) => ({
              node: n.index,
              zone: cluster.zoneName(n.index),
              up: n.up,
              primaries: held[i]!.primaries,
              replicas: held[i]!.replicas,
              cpu: perNodeCpu[n.index] ?? 0,
              write: { active: n.write.running, queued: n.write.queued, rejected: n.write.rejected },
              search: { active: n.search.running, queued: n.search.queued, rejected: n.search.rejected },
              indexingBytes: n.indexingBytes,
              replicaBytes: n.replicaBytes
            })),
            totals: totals(counts),
            refresh: { intervalMs: Duration.toMillis(c.refreshInterval), unrefreshed: refresh.unrefreshed, lagMs: refresh.lag() }
          }
        })
      }
    })
})
