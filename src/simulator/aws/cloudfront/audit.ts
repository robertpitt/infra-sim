import { Duration } from "effect"
import type { Diagnostic } from "../../Diagnostic.ts"
import type { Audit } from "../service.ts"
import { type Config, QUOTAS_URL } from "./config.ts"

/** Paths a month beyond which CloudFront charges for invalidations. */
const FREE_INVALIDATION_PATHS_PER_MONTH = 1_000
const MONTH_MS = 30 * 24 * 3600 * 1000

/**
 * What a design asks of CloudFront that will cost, be clamped or fall short. Pure and cheap: it reads each
 * distribution's settings only.
 */
export const audit: Audit = (_region, members) => {
  const out: Array<Diagnostic> = []
  for (const member of members) {
    if (member.type !== "aws.cloudfront") continue
    const c = member.config as Config
    const node = { node: member.id }

    if (c.objects > c.edge.capacity) {
      out.push({
        ...node,
        level: "info",
        code: "cloudfront-cache-smaller-than-catalog",
        message: `${member.name} serves ${c.objects.toLocaleString("en-US")} objects but an edge location holds ${c.edge.capacity.toLocaleString("en-US")}: the least requested are evicted, so expect a lower hit ratio.`
      })
    }
    if (Duration.toMillis(c.cache.minTtl) > Duration.toMillis(c.cache.maxTtl)) {
      out.push({
        ...node,
        level: "warning",
        code: "cloudfront-min-ttl-above-max-ttl",
        message: `${member.name} has a minimum TTL above its maximum TTL; the minimum wins.`
      })
    }
    const every = Duration.toMillis(c.invalidation.every)
    if (every > 0) {
      if (every < 1_000) {
        out.push({
          ...node,
          level: "warning",
          code: "cloudfront-invalidation-rate",
          message: `${member.name} invalidates more than once a second; CloudFront allows one wildcard invalidation per second (${QUOTAS_URL}).`
        })
      }
      const paths = Math.floor(MONTH_MS / every)
      if (paths > FREE_INVALIDATION_PATHS_PER_MONTH) {
        out.push({
          ...node,
          level: "info",
          code: "cloudfront-invalidation-cost",
          message: `${member.name} invalidates about ${paths.toLocaleString("en-US")} paths a month; the first ${FREE_INVALIDATION_PATHS_PER_MONTH.toLocaleString("en-US")} are free and each one after is charged. Versioned file names avoid it.`
        })
      }
    }
  }
  return out
}
