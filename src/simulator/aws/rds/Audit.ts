import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../internal/account.ts"
import { type Audit, fmt } from "../internal/service.ts"
import { CLASSES, ENGINE_LABELS, isAurora, offers } from "./internal/catalog.ts"
import type { Config } from "./internal/config.ts"
import { iopsOf } from "./internal/database.ts"
import { CLUSTER_STANDBYS, MAX_CONNECTIONS_RANGE, STORAGE } from "./internal/limits.ts"
import type { ProxyConfig } from "./internal/proxyConfig.ts"

/** DB instances one database counts as: its writer, its readers, and a Multi-AZ DB cluster's two standbys. */
const instancesOf = (c: Config): number => 1 + c.readers + (!isAurora(c.engine) && c.multiAz === "cluster" ? CLUSTER_STANDBYS : 0)

/** Storage one RDS database allocates: its own volume and each read replica's (same size here). */
const storageOf = (c: Config): number => (isAurora(c.engine) ? 0 : Math.max(STORAGE.minGiB[c.storage.type], c.storage.allocated) * instancesOf(c))

/**
 * Checks of a region's databases and proxies against the account's RDS quotas and against what AWS accepts:
 *  - DB instances, Aurora clusters, proxies and total storage in the region;
 *  - read replicas per primary;
 *  - a class the engine doesn't run on (Aurora offers only some; a Multi-AZ DB cluster only instance-store classes);
 *  - Multi-AZ set on Aurora (it has none: its readers are its standbys);
 *  - max_connections outside the engine's range, storage too small or IOPS out of range (clamped);
 *  - a proxy's idle connections over its maximum, or its maximum under AWS's recommended minimum.
 * The audit sees nodes, not edges, so which proxy fronts which database isn't checked. Pure and cheap.
 */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  const databases = members.filter((m) => m.type === "aws.rds")
  const proxies = members.filter((m) => m.type === "aws.rds-proxy")

  const instances = databases.reduce((sum, m) => sum + instancesOf(m.config as Config), 0)
  if (instances > account.rdsInstances) {
    out.push({ level: "warning", code: "rds-instances", message: `The databases in ${region} run ${fmt(instances)} DB instances; the account allows ${fmt(account.rdsInstances)} per region.` })
  }
  const clusters = databases.filter((m) => isAurora((m.config as Config).engine)).length
  if (clusters > account.rdsClusters) {
    out.push({ level: "warning", code: "rds-clusters", message: `${fmt(clusters)} Aurora clusters in ${region}; the account allows ${fmt(account.rdsClusters)} per region.` })
  }
  if (proxies.length > account.rdsProxies) {
    out.push({ level: "warning", code: "rds-proxies", message: `${fmt(proxies.length)} RDS Proxies in ${region}; the account allows ${fmt(account.rdsProxies)} per region.` })
  }
  const storage = databases.reduce((sum, m) => sum + storageOf(m.config as Config), 0)
  if (storage > account.rdsStorage) {
    out.push({ level: "warning", code: "rds-storage", message: `The RDS databases in ${region} allocate ${fmt(storage)} GiB of storage; the account allows ${fmt(account.rdsStorage)} GB in all.` })
  }

  for (const m of databases) {
    const c = m.config as Config
    const aurora = isAurora(c.engine)
    const engine = ENGINE_LABELS[c.engine]
    if (!offers(c.engine, c.instanceClass)) {
      out.push({ level: "warning", code: "rds-class-engine", node: m.id, message: `${m.name}: ${engine} doesn't offer ${c.instanceClass}. The simulator runs it anyway, with the RDS formula for max_connections.` })
    }
    if (!aurora && c.multiAz === "cluster" && (CLASSES[c.instanceClass] as { multiAzCluster?: true }).multiAzCluster !== true) {
      out.push({ level: "warning", code: "rds-class-multi-az-cluster", node: m.id, message: `${m.name}: a Multi-AZ DB cluster runs only on instance-store classes (db.m6gd, db.r6gd and the like), not ${c.instanceClass}.` })
    }
    if (aurora && c.multiAz !== "none") {
      out.push({ level: "info", code: "rds-aurora-multi-az", node: m.id, message: `${m.name}: Aurora has no Multi-AZ standby; its readers are what it fails over to, so the Multi-AZ setting is ignored. Add a reader for a fast failover.` })
    }
    if (!aurora && c.readers > account.rdsReadReplicas) {
      out.push({ level: "warning", code: "rds-read-replicas", node: m.id, message: `${m.name} has ${c.readers} read replicas; the account allows ${account.rdsReadReplicas} per primary.` })
    }
    const range = MAX_CONNECTIONS_RANGE[c.engine]
    if (c.maxConnections !== 0 && (c.maxConnections < range.min || c.maxConnections > range.max)) {
      out.push({ level: "warning", code: "rds-max-connections", node: m.id, message: `${m.name}: ${engine} accepts max_connections from ${fmt(range.min)} to ${fmt(range.max)}, not ${fmt(c.maxConnections)}; the simulator clamps it.` })
    }
    if (!aurora) {
      const { type, allocated, iops } = c.storage
      if (allocated < STORAGE.minGiB[type]) {
        out.push({ level: "warning", code: "rds-storage-size", node: m.id, message: `${m.name}: ${type} storage needs at least ${STORAGE.minGiB[type]} GiB; the simulator uses ${STORAGE.minGiB[type]}.` })
      }
      if (type === "gp3" && iops > 0 && allocated < STORAGE.stripedFromGiB) {
        out.push({ level: "info", code: "rds-gp3-iops", node: m.id, message: `${m.name}: gp3 IOPS can only be provisioned from ${STORAGE.stripedFromGiB} GiB; below it the baseline is ${fmt(STORAGE.gp3.baseline)}.` })
      } else if (iops > 0 && iopsOf(c) !== iops) {
        out.push({ level: "warning", code: "rds-iops", node: m.id, message: `${m.name}: ${fmt(iops)} IOPS is outside what ${type} accepts for ${fmt(allocated)} GiB; the simulator uses ${fmt(iopsOf(c))}.` })
      }
    }
  }

  for (const m of proxies) {
    const c = m.config as ProxyConfig
    if (c.maxIdleConnectionsPercent > c.maxConnectionsPercent) {
      out.push({ level: "warning", code: "rds-proxy-idle", node: m.id, message: `${m.name}: MaxIdleConnectionsPercent (${c.maxIdleConnectionsPercent}) can't exceed MaxConnectionsPercent (${c.maxConnectionsPercent}); the simulator uses ${c.maxConnectionsPercent}.` })
    }
    if (c.maxConnectionsPercent < 20) {
      out.push({ level: "info", code: "rds-proxy-max-connections", node: m.id, message: `${m.name}: AWS recommends MaxConnectionsPercent of at least 20 (30 on a db.t3.small), to leave the proxy headroom as it redistributes connections.` })
    }
  }
  return out
}
