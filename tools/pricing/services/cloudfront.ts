import type { Match, ServiceMap } from "../map.ts"

/**
 * CloudFront: requests and data transfer out to viewers, by the geography of the edge location that serves them (the
 * transfer tiered by the month's GB), data transfer from edge locations to the origin, CloudFront Functions invocations
 * and invalidation paths, all priced the same everywhere (`global`); and, by the AWS Region they run in, Origin Shield
 * requests and Lambda@Edge requests and duration.
 * https://aws.amazon.com/cloudfront/pricing/
 *
 * Usage types, in the `aws-other` file, each edge geography a prefix (`US-`, `EU-`, `JP-`...): `<geo>-Requests-Tier2-HTTPS`,
 * `<geo>-DataTransfer-Out-Bytes` (seven tiers from 10 TB), `<geo>-DataTransfer-Out-OBytes`; `Executions-CloudFrontFunctions`
 * (its first 2 million free, listed as its first range); `Invalidations` (likewise, the first 1,000 paths). The always-free
 * tier is `Global-Requests-Tier1` (10 million requests) and `Global-DataTransfer-Out-Bytes` (1 TB): listed once, so every
 * geography gets it, marked `freeShared` because AWS counts it once across them. In each Region's file: `Requests-OriginShield`,
 * `Lambda-Edge-Request`, `Lambda-Edge-GB-Second` (AWS publishes those for 15 Regions only).
 * Which geographies a price class serves from: 100 is the US, Canada, Mexico, Europe and Israel; 200 adds South Africa,
 * the Middle East, Japan, the rest of Asia and India; All adds South America, Australia and New Zealand.
 * Left out: HTTP requests (the simulator has no TLS setting; HTTPS is what nearly every distribution serves), proxy
 * requests (PUT, POST... are priced the same as GET and HEAD in every geography), field-level encryption, KeyValueStore,
 * real-time logs, dedicated IPs, custom SSL certificates, flat-rate plans: none is modelled. Origin Shield's own data
 * transfer is listed at 0.
 */

/** AWS's edge geography prefix to ours, and what it covers. */
const GEOS: Readonly<Record<string, { readonly id: string; readonly name: string }>> = {
  US: { id: "us", name: "the United States, Mexico" },
  CA: { id: "ca", name: "Canada" },
  EU: { id: "eu", name: "Europe and Israel" },
  ZA: { id: "za", name: "South Africa, Kenya, Nigeria" },
  ME: { id: "me", name: "the Middle East" },
  SA: { id: "sa", name: "South America" },
  JP: { id: "jp", name: "Japan" },
  AU: { id: "au", name: "Australia and New Zealand" },
  AP: { id: "ap", name: "Asia Pacific (Hong Kong, Singapore, Korea, Taiwan and the rest)" },
  IN: { id: "in", name: "India" }
}

const geos = Object.values(GEOS)

export const cloudfront: ServiceMap = {
  id: "cloudfront",
  title: "Amazon CloudFront",
  offers: ["AmazonCloudFront"],
  extraRegions: ["aws-other"],
  dimensions: {
    ...Object.fromEntries(
      geos.flatMap((g) => [
        [`requests/${g.id}`, { unit: "request", description: `HTTPS requests served from edge locations in ${g.name}`, freeShared: "requests" }],
        [
          `data-out/${g.id}`,
          { unit: "GB", description: `Data transfer out to viewers from edge locations in ${g.name}, tiered by the month's GB`, freeShared: "data-out" }
        ],
        [`data-to-origin/${g.id}`, { unit: "GB", description: `Data transfer from edge locations in ${g.name} to the origin (request bodies of writes)` }]
      ])
    ),
    "functions/invocations": {
      unit: "invocation",
      description: "CloudFront Functions invocations"
    },
    "invalidation-paths": {
      unit: "path",
      description: "Invalidation paths requested (a wildcard counts as one)"
    },
    "origin-shield/requests": {
      unit: "request",
      description: "Requests to Origin Shield (cache misses at the regional edge caches), by the Region it is in"
    },
    "lambda-edge/requests": {
      unit: "request",
      description: "Lambda@Edge invocations, by the Region they run in"
    },
    "lambda-edge/duration": {
      unit: "GB-second",
      description: "Lambda@Edge duration, by memory configured, by the Region they run in"
    }
  },
  classify: (row) => {
    if (row.region === "aws-other") {
      const free = (dimension: (geo: string) => string): ReadonlyArray<Match> => geos.map((g) => ({ dimension: dimension(g.id), free: true, region: "global" }))
      switch (row.usage) {
        case "Global-Requests-Tier1":
          return free((g) => `requests/${g}`)
        case "Global-DataTransfer-Out-Bytes":
          return free((g) => `data-out/${g}`)
        case "Executions-CloudFrontFunctions":
          return { dimension: "functions/invocations", free: row.price === 0, region: "global" }
        case "Invalidations":
          return { dimension: "invalidation-paths", free: row.price === 0, region: "global" }
      }
      const m = /^([A-Z]{2})-(Requests-Tier2-HTTPS|DataTransfer-Out-Bytes|DataTransfer-Out-OBytes)$/.exec(row.usage)
      const geo = m === null ? undefined : GEOS[m[1]!]
      if (m === null || geo === undefined) return undefined
      const kind = m[2] === "Requests-Tier2-HTTPS" ? "requests" : m[2] === "DataTransfer-Out-Bytes" ? "data-out" : "data-to-origin"
      return { dimension: `${kind}/${geo.id}`, region: "global" }
    }
    switch (row.usage) {
      case "Requests-OriginShield":
        return { dimension: "origin-shield/requests" }
      case "Lambda-Edge-Request":
        return { dimension: "lambda-edge/requests" }
      case "Lambda-Edge-GB-Second":
        return { dimension: "lambda-edge/duration" }
      default:
        return undefined
    }
  }
}
