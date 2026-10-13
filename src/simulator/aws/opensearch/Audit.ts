import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../internal/account.ts"
import { type Audit, fmt } from "../internal/service.ts"
import { BURSTABLE_MAX_INSTANCES, type Config, MAX_SHARDS_PER_NODE } from "./internal/config.ts"

/**
 * Checks of the OpenSearch domains in a region against the account's quotas and AWS's sizing rules:
 *  - how many domains the region may hold, and how many instances a domain may have (T2/T3 domains at most 10);
 *  - copies that can't be placed (two copies of a shard never share a node), and no replicas at all, which AWS warns
 *    leaves data unavailable when a node fails (handling-errors, "Failed cluster nodes");
 *  - fewer than three data nodes (bp-instances) and shard counts that don't divide evenly over the nodes, which AWS
 *    names as the cause of node and index skew (handling-errors, "Node shard and storage skew");
 *  - more shards on a node than OpenSearch allows (1,000 up to 2.15);
 *  - data nodes that don't divide evenly over the domain's zones (managedomains-multiaz recommends a multiple of them).
 */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  const domains = members.filter((m) => m.type === "aws.opensearch")
  if (domains.length > account.opensearchDomains) {
    out.push({ level: "warning", code: "opensearch-domains", message: `${fmt(domains.length)} OpenSearch domains in ${region}; the account allows ${fmt(account.opensearchDomains)} per region.` })
  }
  for (const m of domains) {
    const c = m.config as Config
    const burstable = c.instanceType.startsWith("t3.")
    const allowed = burstable ? Math.min(BURSTABLE_MAX_INSTANCES, account.opensearchInstancesPerDomain) : account.opensearchInstancesPerDomain
    if (c.dataNodes > allowed) {
      out.push({
        level: "warning",
        code: "opensearch-instances",
        node: m.id,
        message: burstable
          ? `${m.name} has ${fmt(c.dataNodes)} ${c.instanceType} data nodes; T3 domains hold at most ${BURSTABLE_MAX_INSTANCES} instances.`
          : `${m.name} has ${fmt(c.dataNodes)} data nodes; the account allows ${fmt(allowed)} instances per domain (AWS raises it to at most 1,002).`
      })
    }
    if (c.replicas + 1 > c.dataNodes) {
      out.push({
        level: "warning",
        code: "opensearch-unassigned-replicas",
        node: m.id,
        message: `${m.name}: ${c.replicas + 1} copies of each shard but ${c.dataNodes} data node${c.dataNodes === 1 ? "" : "s"}. Two copies of a shard never share a node, so ${fmt(c.primaryShards * (c.replicas + 1 - c.dataNodes))} replicas stay unassigned and the cluster is yellow.`
      })
    } else if (c.replicas === 0) {
      out.push({
        level: "warning",
        code: "opensearch-no-replicas",
        node: m.id,
        message: c.availabilityZones > 1
          ? `${m.name} has no replicas: its ${c.availabilityZones} Availability Zones protect nothing, as there is no copy of a shard to put in another zone, and losing a node or a zone loses its shards' data until it comes back. AWS recommends at least one replica.`
          : `${m.name} has no replicas: when a data node fails, its shards' data is unavailable until it comes back. AWS recommends at least one replica.`
      })
    }
    if (c.availabilityZones > 1 && c.dataNodes % c.availabilityZones !== 0) {
      out.push({
        level: "info",
        code: "opensearch-uneven-zones",
        node: m.id,
        message: `${m.name}: ${c.dataNodes} data nodes over ${c.availabilityZones} Availability Zones don't divide evenly, so losing the fuller zone loses more of the cluster and some nodes carry more shards. AWS recommends a node count that is a multiple of the zones.`
      })
    }
    if (c.dataNodes < 3) {
      out.push({ level: "info", code: "opensearch-few-nodes", node: m.id, message: `${m.name} has ${c.dataNodes} data node${c.dataNodes === 1 ? "" : "s"}; AWS recommends at least three.` })
    }
    const copies = c.primaryShards * Math.min(c.replicas + 1, c.dataNodes)
    if (copies % c.dataNodes !== 0) {
      out.push({
        level: "info",
        code: "opensearch-shard-skew",
        node: m.id,
        message: `${m.name}: ${fmt(copies)} shard copies over ${c.dataNodes} data nodes don't divide evenly, so some nodes hold more and work harder. AWS suggests shard counts that are a multiple of the node count.`
      })
    }
    const perNode = Math.ceil(copies / c.dataNodes)
    if (perNode > MAX_SHARDS_PER_NODE) {
      out.push({ level: "warning", code: "opensearch-shards-per-node", node: m.id, message: `${m.name} puts about ${fmt(perNode)} shards on each node; OpenSearch allows ${fmt(MAX_SHARDS_PER_NODE)} per node (up to 2.15).` })
    }
  }
  return out
}
