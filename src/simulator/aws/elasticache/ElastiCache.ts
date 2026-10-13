import { Effect } from "effect"
import * as Aws from "../internal/provider.ts"
import {
  CLUSTER_SPEC_URL,
  Config,
  ECPU_URL,
  FAILOVER_URL,
  PARAMETERS_URL,
  ports,
  QUOTAS_URL,
  SERVERLESS_SCALING_URL,
  SHARDS_URL,
  State,
  TYPES_URL
} from "./internal/config.ts"
import { dashboard } from "./internal/dashboard.ts"
import { makeRuntime } from "./internal/runtime.ts"

/**
 * Amazon ElastiCache: an in-memory cache (Valkey, Redis OSS or Memcached) in front of a database. The component stands
 * for the cluster and the application's cache-aside code together: a read that hits is answered from memory, a miss
 * reads the database on `misses` and fills the key, a write updates the database on `writes` and then invalidates or
 * rewrites the key.
 * The hit ratio is not a setting: it emerges from the key space, the memory and the TTL. See `README.md`.
 */
export const ElastiCache = Aws.component({
  type: "aws.elasticache",
  service: "ElastiCache",
  title: "ElastiCache cluster",
  description:
    "In-memory cache in front of a database. The hit ratio emerges from keys, memory and TTL; misses read the database (with or without a lock against the thundering herd); keys hash to shards, so a hot key loads one; replicas in other Availability Zones serve reads and take over when a primary, or its zone, fails.",
  docs: Aws.docs.elasticache,
  category: "storage",
  // Keys reaching their TTL are a cache working as meant, not messages lost: no "expired" alarm on it.
  quietAlarms: ["expired"],
  icon: "cache",
  accent: "#c925d1",
  limits: [
    { label: "Hash slots (cluster mode)", value: "16,384, spread evenly over the shards", adjustable: false, source: CLUSTER_SPEC_URL },
    { label: "Nodes per shard", value: "1 to 6: a primary and up to 5 replicas", adjustable: false, source: SHARDS_URL },
    { label: "Shards with cluster mode off", value: "1", adjustable: false, source: SHARDS_URL },
    { label: "Nodes per cluster", value: "90 (Valkey/Redis OSS cluster mode), 60 (Memcached); up to 500 on request", adjustable: true, source: QUOTAS_URL, note: "Account quotas." },
    { label: "Nodes per region", value: "300", adjustable: true, source: QUOTAS_URL, note: "Checked by an audit." },
    { label: "Memory and network bandwidth", value: "per node type (r7g.large: 13.07 GiB, 0.937 Gbps baseline)", adjustable: false, source: TYPES_URL, note: "Bursting above the baseline is not modelled." },
    { label: "maxclients", value: "65,000 per node (20,000 on t4g.micro)", adjustable: false, source: PARAMETERS_URL, note: "Commands waiting at a node past it are refused." },
    { label: "Largest value", value: "512 MB (proto-max-bulk-len)", adjustable: false, source: PARAMETERS_URL },
    { label: "Automatic failover in cluster mode", value: "always on", adjustable: false, source: FAILOVER_URL },
    { label: "Serverless throughput", value: "30,000 ECPU/s when empty (90,000 from replicas), doubling every 2 to 3 minutes; 30,000 ECPU/s per slot (90,000 from replicas)", adjustable: false, source: SERVERLESS_SCALING_URL },
    { label: "ECPU", value: "1 per KB transferred by a simple GET or SET, at least 1", adjustable: false, source: ECPU_URL }
  ],
  dashboard,
  highlights: [
    { gauge: "hitRate", label: "hit rate", format: "percent" },
    { rate: "databaseReads", label: "db reads/s" },
    { gauge: "engineUtilization", label: "hottest node", format: "percent" }
  ],
  config: Config,
  ports,
  state: State,
  // Its nodes are spread over zones: a zone outage loses the nodes there, and their shards fail over (see `cluster.ts`).
  handlesZoneFaults: true,
  make: (node) =>
    Effect.gen(function*() {
      const { stop, ...instance } = makeRuntime(node)
      yield* Effect.addFinalizer(() => Effect.sync(stop))
      return instance
    })
})
