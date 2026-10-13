import * as Setting from "../../Setting.ts"
import { SOURCES } from "./internal/limits.ts"

/**
 * The account-level quotas RDS contributes, per region (CHAP_Limits, "Quotas in Amazon RDS"). They are merged into the
 * provider's account form (`../account.ts`). AWS publishes lower defaults for Asia Pacific (Mumbai), ap-south-1: 20 DB
 * instances where every other region has 40.
 */
export const quotas = (region: string) => ({
  rdsInstances: Setting.int({
    default: region === "ap-south-1" ? 20 : 40,
    min: 1,
    max: 100_000,
    label: "RDS DB instances",
    help: "RDS and Aurora DB instances together: each database's writer, its readers or read replicas, and a Multi-AZ DB cluster's two standbys. (A Multi-AZ DB instance's standby is not counted here.)",
    limit: Setting.quota(SOURCES.quotas)
  }),
  rdsClusters: Setting.int({
    default: 40,
    min: 1,
    max: 100_000,
    label: "RDS Aurora DB clusters",
    help: "Aurora clusters in this region.",
    limit: Setting.quota(SOURCES.quotas)
  }),
  rdsReadReplicas: Setting.int({
    default: 15,
    min: 1,
    max: 15,
    label: "RDS read replicas per primary",
    help: "Read replicas of one RDS primary. Aurora's 15 replicas per cluster can't be adjusted.",
    limit: Setting.quota(SOURCES.quotas)
  }),
  rdsProxies: Setting.int({
    default: 20,
    min: 1,
    max: 10_000,
    label: "RDS Proxies",
    limit: Setting.quota(SOURCES.quotas)
  }),
  rdsStorage: Setting.int({
    default: 100_000,
    min: 1,
    max: 100_000_000,
    unit: "GB",
    label: "RDS total storage",
    help: "Storage allocated to every RDS DB instance together (read replicas included). Aurora doesn't count.",
    limit: Setting.quota(SOURCES.quotas)
  })
})
