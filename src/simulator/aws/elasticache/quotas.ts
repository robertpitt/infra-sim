import * as Setting from "../../Setting.ts"
import { QUOTAS_URL, SHARDS_URL } from "./config.ts"

/**
 * The account-level quotas ElastiCache contributes, per region. AWS publishes the same defaults in every region. Nodes
 * per cluster are quotas of the account (each cluster gets the allowance), so they are here rather than on the
 * component: raising one raises it for every cluster.
 */
export const quotas = (_region: string) => ({
  elasticacheNodesPerRegion: Setting.int({
    default: 300,
    min: 1,
    max: 100_000,
    unit: "nodes",
    label: "ElastiCache nodes per region",
    help: "Non-reserved nodes across every cluster in the region. Checked against the design, not enforced while running.",
    limit: Setting.quota(QUOTAS_URL)
  }),
  elasticacheNodesPerCluster: Setting.int({
    default: 90,
    min: 1,
    max: 500,
    unit: "nodes",
    label: "ElastiCache nodes per cluster (cluster mode)",
    help: "Nodes in one Valkey or Redis OSS cluster with cluster mode on: shards x (1 + replicas). A cluster asking for more runs with as many shards as fit. Raisable to 500.",
    limit: Setting.quota(SHARDS_URL, "90 by default, up to 500 on request (Valkey 7.2+, Redis OSS 5.0.6 to 7.1).")
  }),
  elasticacheMemcachedNodesPerCluster: Setting.int({
    default: 60,
    min: 1,
    max: 10_000,
    unit: "nodes",
    label: "ElastiCache Memcached nodes per cluster",
    help: "Nodes in one Memcached cluster. A cluster asking for more runs with as many as the quota allows.",
    limit: Setting.quota(QUOTAS_URL)
  }),
  elasticacheServerlessCachesPerRegion: Setting.int({
    default: 40,
    min: 1,
    max: 10_000,
    unit: "caches",
    label: "ElastiCache serverless caches per region",
    help: "Checked against the design, not enforced while running.",
    limit: Setting.quota(QUOTAS_URL)
  })
})
