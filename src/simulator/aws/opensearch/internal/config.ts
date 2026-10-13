import { Schema } from "effect"
import * as Setting from "../../../Setting.ts"
import { docs } from "../../internal/docs.ts"
import { GiB, MiB } from "../../internal/units.ts"

/**
 * Everything that is a number from AWS or OpenSearch, or a setting of the OpenSearch component: constants with their
 * sources, the instance types offered, and the settings schema. Behaviour lives in the other modules.
 */

const D = docs.opensearch
const OPENSEARCH_SOURCE = "https://github.com/opensearch-project/OpenSearch/blob/main/server/src/main/java/org/opensearch/"

/** The pages every number here comes from, so the README, the limits list and the settings cite one source. */
export const SOURCES = {
  quotas: `${D}limits.html`,
  serviceQuotas: "https://docs.aws.amazon.com/general/latest/gr/opensearch-service.html",
  instanceTypes: `${D}supported-instance-types.html`,
  sharding: `${D}bp-sharding.html`,
  instances: `${D}bp-instances.html`,
  errors: `${D}handling-errors.html`,
  metrics: `${D}managedomains-cloudwatchmetrics.html`,
  multiAz: `${D}managedomains-multiaz.html`,
  zoneAwareness: "https://docs.aws.amazon.com/opensearch-service/latest/APIReference/API_ZoneAwarenessConfig.html",
  ec2General: "https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html",
  ec2Compute: "https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html",
  ec2Memory: "https://docs.aws.amazon.com/ec2/latest/instancetypes/mo.html",
  threadPool: `${OPENSEARCH_SOURCE}threadpool/ThreadPool.java`,
  indexingPressure: `${OPENSEARCH_SOURCE}index/IndexingPressure.java`,
  replication: `${OPENSEARCH_SOURCE}action/support/replication/TransportReplicationAction.java`,
  replicationTimeout: `${OPENSEARCH_SOURCE}action/support/replication/ReplicationRequest.java`,
  faultDetection: `${OPENSEARCH_SOURCE}cluster/coordination/FollowersChecker.java`,
  routing: `${OPENSEARCH_SOURCE}cluster/routing/OperationRouting.java`,
  indexMetadata: `${OPENSEARCH_SOURCE}cluster/metadata/IndexMetadata.java`,
  indexSettings: "https://docs.opensearch.org/latest/install-and-configure/configuring-opensearch/index-settings/",
  searchApi: "https://docs.opensearch.org/latest/api-reference/search-apis/search/",
  bulkApi: "https://docs.opensearch.org/latest/api-reference/document-apis/bulk/"
} as const

/**
 * A data node's instance type: what it has to work with. vCPUs and memory are the EC2 instance's of the same name (the
 * EC2 pages; AWS's sizing guide gives the same figures for `m6g.large.search`); the request payload limit is the
 * OpenSearch network quota for the type (limits).
 */
export interface InstanceType {
  readonly vcpu: number
  readonly memoryGiB: number
  /** Largest HTTP request body the domain accepts, in MiB. Over it the request is refused with 413. */
  readonly payloadMiB: number
}

/** A handful of common data node types, small to large, general purpose, compute and memory optimised. */
export const INSTANCE_TYPES = {
  "t3.medium.search": { vcpu: 2, memoryGiB: 4, payloadMiB: 10 },
  "m6g.large.search": { vcpu: 2, memoryGiB: 8, payloadMiB: 10 },
  "m6g.xlarge.search": { vcpu: 4, memoryGiB: 16, payloadMiB: 100 },
  "m6g.2xlarge.search": { vcpu: 8, memoryGiB: 32, payloadMiB: 100 },
  "c6g.xlarge.search": { vcpu: 4, memoryGiB: 8, payloadMiB: 100 },
  "c6g.2xlarge.search": { vcpu: 8, memoryGiB: 16, payloadMiB: 100 },
  "r6g.large.search": { vcpu: 2, memoryGiB: 16, payloadMiB: 100 },
  "r6g.xlarge.search": { vcpu: 4, memoryGiB: 32, payloadMiB: 100 },
  "r6g.2xlarge.search": { vcpu: 8, memoryGiB: 64, payloadMiB: 100 },
  "r6g.4xlarge.search": { vcpu: 16, memoryGiB: 128, payloadMiB: 100 },
  "r7g.large.search": { vcpu: 2, memoryGiB: 16, payloadMiB: 100 },
  "r7g.xlarge.search": { vcpu: 4, memoryGiB: 32, payloadMiB: 100 },
  "r7g.2xlarge.search": { vcpu: 8, memoryGiB: 64, payloadMiB: 100 },
  "r7g.4xlarge.search": { vcpu: 16, memoryGiB: 128, payloadMiB: 100 }
} as const satisfies Record<string, InstanceType>

export type InstanceName = keyof typeof INSTANCE_TYPES
const INSTANCE_NAMES = Object.keys(INSTANCE_TYPES) as unknown as readonly [InstanceName, ...Array<InstanceName>]

/** OpenSearch Service gives the JVM half the instance's memory, at most 32 GiB by default (limits, "Java process quota"). */
export const HEAP_SHARE = 0.5
export const HEAP_MAX_GIB = 32
/** Bytes of Java heap a data node of this type has. */
export const heapBytes = (type: InstanceType): number => Math.min(type.memoryGiB * HEAP_SHARE, HEAP_MAX_GIB) * GiB
/** The largest request body this type accepts. */
export const payloadBytes = (type: InstanceType): number => type.payloadMiB * MiB

/** The write pool has one thread per allocated processor and a queue of 10,000 (ThreadPool.java; 200 before 7.1, metrics page). */
export const writeThreads = (vcpu: number): number => vcpu
export const WRITE_QUEUE = 10_000
/** The search pool has `int(processors × 3 / 2) + 1` threads and a queue of 1,000 (ThreadPool.java, `searchThreadPoolSize`; metrics page). */
export const searchThreads = (vcpu: number): number => Math.floor((vcpu * 3) / 2) + 1
export const SEARCH_QUEUE = 1_000
/**
 * Indexing pressure: bytes of indexing in flight on a node (as coordinating node and on its primaries) may not exceed
 * `indexing_pressure.memory.limit`, 10% of the heap; replicas get 1.5 times that (IndexingPressure.java).
 */
export const INDEXING_PRESSURE_SHARE = 0.1
export const REPLICA_PRESSURE_FACTOR = 1.5
/** An index has at most 1,024 primary shards (IndexMetadata.java, `opensearch.index.max_number_of_shards`). */
export const MAX_PRIMARY_SHARDS = 1_024
/** A domain can have up to 1,002 instances, on request (Service Quotas, "Instances per domain"). */
export const MAX_INSTANCES = 1_002
/** T2 and T3 domains hold at most 10 instances (supported-instance-types; limits, "Total node limit by instance family"). */
export const BURSTABLE_MAX_INSTANCES = 10
/** Up to 2.15 a node holds at most 1,000 shards (bp-sharding, `cluster.max_shards_per_node`). */
export const MAX_SHARDS_PER_NODE = 1_000
/** A Multi-AZ domain spreads its nodes over 2 or 3 Availability Zones (ZoneAwarenessConfig, `AvailabilityZoneCount`). */
export const MAX_AVAILABILITY_ZONES = 3

const Hard = Setting.hard

/** Settings of one OpenSearch Service domain holding one index. */
export const Config = Schema.Struct({
  instanceType: Setting.choice(INSTANCE_NAMES, {
    default: "r6g.large.search",
    label: "Data node type",
    help: "Each data node's vCPUs size its thread pools (write: one per vCPU; search: 1.5 per vCPU + 1) and share their CPU; its memory sets the Java heap (half, at most 32 GiB), which sets the indexing pressure limit. Larger types also accept larger requests (10 MiB or 100 MiB)."
  }),
  dataNodes: Setting.int({
    default: 3,
    min: 1,
    max: MAX_INSTANCES,
    unit: "nodes",
    label: "Data nodes",
    help: "AWS recommends at least three. The per-domain instance quota is an account quota (default 200); AWS raises it to at most 1,002.",
    limit: Hard(SOURCES.serviceQuotas, "Instances per domain: 200 by default, up to 1,002 on request")
  }),
  availabilityZones: Setting.int({
    default: 1,
    min: 1,
    max: MAX_AVAILABILITY_ZONES,
    unit: "zones",
    label: "Availability Zones",
    help: "1: every data node in one zone (zone awareness off, the API's default), so losing that zone loses the domain. 2 or 3 (Multi-AZ without Standby): data nodes are spread over that many zones, from the node's own zone (or the region's first), and the copies of each shard are put in different zones, so with replicas a zone outage leaves a copy of every shard (yellow) and the domain carries on. AWS recommends 3 zones and a node count that is a multiple of them.",
    limit: Hard(SOURCES.zoneAwareness, "1 (zone awareness off), 2 or 3")
  }),
  primaryShards: Setting.int({
    default: 5,
    min: 1,
    max: MAX_PRIMARY_SHARDS,
    unit: "shards",
    label: "Primary shards",
    help: "Shards of the index. OpenSearch Service creates an index with 5 by default (open-source OpenSearch: 1). Fixed when the index is created; here a change re-places the shards at once. Use a multiple of the data node count to spread them evenly.",
    limit: Hard(SOURCES.indexMetadata, "At most 1,024 per index")
  }),
  replicas: Setting.int({
    default: 1,
    min: 0,
    max: 30,
    unit: "per shard",
    label: "Replicas",
    help: "Copies of each primary shard, each on a different node. Every indexed document is written again on each replica (write capacity), and a search can use any copy. With none, a failed node takes its shards' data with it. More copies than nodes can't be placed (the cluster stays yellow). The maximum here is a bound for the form, not an OpenSearch limit."
  }),
  routing: Setting.choice(["id", "key"], {
    default: "id",
    labels: { id: "By document ID", key: "By routing key" },
    label: "Shard routing",
    help: "By document ID (OpenSearch's default) spreads a bulk request's documents over every shard, and a search asks every shard. By routing key, the message's key picks one shard for all of a request's documents and for its search: a tenant or user ID as custom routing. A hot key then makes a hot shard."
  }),
  refreshInterval: Setting.duration({
    default: "1 second",
    min: 0,
    max: "1 hour",
    label: "Refresh interval",
    help: "How often shards refresh, making what was indexed since searchable (index.refresh_interval, 1 s by default). 0 turns refresh off (OpenSearch's -1), as people do during a large reindex: nothing new becomes searchable until it is turned on again."
  }),
  indexing: Setting.group(
    {
      cpuPerDocument: Setting.number({
        default: 0.5,
        min: 0,
        max: 1_000,
        step: 0.05,
        unit: "ms",
        label: "CPU per document",
        help: "CPU time to index one document, on the primary and again on each replica. Depends on document size, mapping and analysers; an assumption, measure your own."
      }),
      cpuPerRequest: Setting.number({
        default: 1,
        min: 0,
        max: 1_000,
        step: 0.1,
        unit: "ms",
        label: "CPU per shard request",
        help: "CPU time each shard-level indexing request costs on top of its documents (parsing, translog, coordination). It is why one bulk request of many documents is cheaper than many single ones. An assumption."
      }),
      waitForRefresh: Setting.bool({
        default: false,
        label: "Wait for refresh",
        help: "refresh=wait_for: a write is answered only once its documents are searchable, at the next refresh. Ignored while refresh is off."
      }),
      timeout: Setting.duration({
        default: "1 minute",
        min: "1 millis",
        max: "10 minutes",
        label: "Primary wait timeout",
        help: "The bulk and index APIs' timeout: how long a write waits for its shard's primary when it has none (a failed node not yet replaced by a replica, or no replica at all) before failing with 503 UnavailableShardsException. OpenSearch's default is 1 minute."
      })
    },
    { label: "Indexing" }
  ),
  search: Setting.group(
    {
      cpuPerShard: Setting.latency({
        mean: "5 millis",
        cv: 1,
        label: "CPU per shard query",
        help: "CPU time one shard takes to answer a search (query and fetch). Depends entirely on the query and the data; an assumption. Heavy aggregations are a larger mean."
      }),
      allowPartialResults: Setting.bool({
        default: true,
        label: "Allow partial results",
        help: "allow_partial_search_results (true by default): a search that some shards couldn't answer (rejected, or no copy left) still succeeds with what the others returned. Off, it fails instead."
      })
    },
    { label: "Search" }
  ),
  failover: Setting.group(
    {
      failedNodes: Setting.int({
        default: 0,
        min: 0,
        max: MAX_INSTANCES,
        unit: "nodes",
        label: "Failed data nodes",
        help: "How many data nodes are down (the first ones). Set it from a scenario's timeline and back to 0 to bring them back: their work is lost, primaries on them are replaced by replicas after the detection delay, and a shard with no copy left is unavailable. An Outage on one of the domain's Availability Zones fails that zone's nodes the same way; an Outage fault on this node takes the whole domain endpoint down instead."
      }),
      detection: Setting.duration({
        default: "30 seconds",
        min: 0,
        max: "5 minutes",
        label: "Failure detection",
        help: "How long the cluster takes to notice a failed node and promote replicas of its primaries. OpenSearch removes a node at once when its connection drops, and after 3 failed checks 1 s apart, each waiting up to 10 s, when it stops answering: about 30 s. Writes to its primaries wait meanwhile; searches use other copies at once."
      })
    },
    { label: "Node failure" }
  )
})

export type Config = typeof Config.Type
