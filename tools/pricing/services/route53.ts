import type { ServiceMap } from "../map.ts"

/**
 * Route 53 (public DNS): hosted zones by the month (tiered by how many), queries by routing policy (tiered by the
 * month's queries), and health checks by the month, for AWS and for other endpoints, plus each optional feature on one
 * (fast 10-second interval, HTTPS, string matching, latency graphs). Priced the same everywhere: stored under `global`.
 * https://aws.amazon.com/route53/pricing/
 *
 * Usage types, from the `aws-other` file only: `HostedZone`; `DNS-Queries` (simple, weighted, failover), `LBR-Queries`
 * (latency), `Geo-Queries` (geolocation); `Health-Check-AWS` (its first 50 are free, listed as its first range) and
 * `Health-Check-Non-AWS`; `Health-Check-Option-AWS` and `Health-Check-Option-Non-AWS`.
 * Left out: queries to alias records (free; the simulator has no alias records), geoproximity, IP-based (CIDR) and
 * traffic flow (not modelled), extra RRSets, Route 53 Resolver, DNS Firewall, Profiles and Global Resolver (the
 * regional files: the simulator's resolvers are the callers' own caches, not Route 53 Resolver).
 */
const USAGES: Readonly<Record<string, string>> = {
  HostedZone: "hosted-zones",
  "DNS-Queries": "queries/standard",
  "LBR-Queries": "queries/latency",
  "Geo-Queries": "queries/geo",
  "Health-Check-AWS": "health-checks/aws",
  "Health-Check-Non-AWS": "health-checks/non-aws",
  "Health-Check-Option-AWS": "health-check-options/aws",
  "Health-Check-Option-Non-AWS": "health-check-options/non-aws"
}

export const route53: ServiceMap = {
  id: "route53",
  title: "Amazon Route 53",
  offers: ["AmazonRoute53"],
  // Its regional files hold only Resolver's prices.
  offerRegions: { AmazonRoute53: ["aws-other"] },
  dimensions: {
    "hosted-zones": {
      unit: "hosted zone-month",
      description: "Public or private hosted zones, tiered by how many the account has (first 25, then the rest)"
    },
    "queries/standard": {
      unit: "query",
      description: "Standard queries (simple, weighted, failover records), tiered by the month's queries"
    },
    "queries/latency": {
      unit: "query",
      description: "Latency-based routing queries, tiered by the month's queries"
    },
    "queries/geo": {
      unit: "query",
      description: "Geolocation routing queries, tiered by the month's queries"
    },
    "health-checks/aws": {
      unit: "health check-month",
      description: "Health checks of AWS endpoints (the first 50 are free)"
    },
    "health-checks/non-aws": {
      unit: "health check-month",
      description: "Health checks of endpoints outside AWS"
    },
    "health-check-options/aws": {
      unit: "feature-month",
      description: "Each optional feature (10-second interval, HTTPS, string matching, latency measurement) on a health check of an AWS endpoint"
    },
    "health-check-options/non-aws": {
      unit: "feature-month",
      description: "Each optional feature (10-second interval, HTTPS, string matching, latency measurement) on a health check of a non-AWS endpoint"
    }
  },
  classify: (row) => {
    // The regional files hold Resolver's prices, whose usage types (`DNS-Queries`) overlap the public DNS ones.
    if (row.region !== "aws-other") return undefined
    const dimension = USAGES[row.usage]
    if (dimension === undefined) return undefined
    // The 50 free AWS-endpoint health checks are the usage type's first range, at 0.
    if (row.price === 0 && row.from === 0 && row.to !== Number.POSITIVE_INFINITY) return { dimension, free: true, region: "global" }
    return { dimension, region: "global" }
  }
}
