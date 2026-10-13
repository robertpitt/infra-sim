import { Duration } from "effect"
import type { Diagnostic } from "../../Diagnostic.ts"
import type { Audit } from "../internal/service.ts"
import { type Config, RECOMMENDED_HEALTH_CHECKED_TTL_MS, TTL_URL } from "./internal/config.ts"

/**
 * What a design asks of Route 53 that will work against it. Pure and cheap: it reads each record's settings. Audits see
 * nodes, not edges, so the number of health checks (one per record that asks) can't be counted against the account's
 * quota here; the records enforce it as they run.
 */
export const audit: Audit = (_region, members) => {
  const out: Array<Diagnostic> = []
  for (const member of members) {
    if (member.type !== "aws.route53") continue
    const c = member.config as Config
    const node = { node: member.id }
    const ttl = Duration.toMillis(c.ttl)
    if (c.policy !== "simple" && ttl > RECOMMENDED_HEALTH_CHECKED_TTL_MS) {
      out.push({
        ...node,
        level: "info",
        code: "route53-ttl-above-health-check-advice",
        message: `${member.name} caches its answers for ${Math.round(ttl / 1000)} s. AWS recommends 60 s or less for records with health checks, so that callers follow a change in health quickly (${TTL_URL}).`
      })
    }
    if (c.resolvers.ignoreTtlShare > 0) {
      out.push({
        ...node,
        level: "info",
        code: "route53-resolvers-ignore-ttl",
        message: `${member.name}: ${Math.round(c.resolvers.ignoreTtlShare * 100)}% of resolver caches keep answers for ${Math.round(Duration.toMillis(c.resolvers.ignoreTtlFor) / 1000)} s whatever the TTL, so that share of traffic follows a change late.`
      })
    }
  }
  return out
}
