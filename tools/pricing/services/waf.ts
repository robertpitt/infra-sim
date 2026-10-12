import type { ServiceMap } from "../map.ts"

/**
 * AWS WAF: web ACLs and rules by the month (prorated hourly), and requests inspected, at a price set by the web ACL's
 * capacity (WCUs: the base price up to 1,500, then more for each further 500, up to 5,000); a body inspection limit
 * raised past the default 16 KB adds to each request; Bot Control (common) adds a monthly fee and a request price past
 * 10 million a month. A regional web ACL is priced in its Region; a CloudFront one under `global`.
 * https://aws.amazon.com/waf/pricing/
 *
 * Usage types (after the region prefix; `Global-` in the `aws-other` file, which holds CloudFront's): `WebACLV2`,
 * `RuleV2`, `RequestV2-Tier1` (up to 1,500 WCUs) and `RequestV2-Tier<n>-<wcu>WCU` (up to 2,000 ... 5,000 WCUs: each the
 * whole price, not a surcharge), `RequestV2-32KB` / `-48KB` / `-64KB` (the surcharge for that body limit),
 * `AMR-BotControl` and `AMR-BotControl-Request` (its first 10 million free, listed as its first range).
 * Left out: AWS WAF Classic (`WebACL`, `Rule`, `Request`), `RequestV2-Tier0` (no published meaning; the same price as
 * Tier1), prices for Shield Advanced customers (`ShieldProtected-`), CAPTCHA and Challenge, Bot Control's targeted level,
 * Account Takeover and Account Creation Fraud Prevention, Anti-DDoS: none of them is modelled (Bot Control only as a
 * toggle with its capacity).
 */
const USAGES: Readonly<Record<string, string>> = {
  WebACLV2: "web-acls",
  RuleV2: "rules",
  "RequestV2-Tier1": "requests/1500",
  "RequestV2-Tier2-2000WCU": "requests/2000",
  "RequestV2-Tier3-2500WCU": "requests/2500",
  "RequestV2-Tier4-3000WCU": "requests/3000",
  "RequestV2-Tier5-3500WCU": "requests/3500",
  "RequestV2-Tier6-4000WCU": "requests/4000",
  "RequestV2-Tier7-4500WCU": "requests/4500",
  "RequestV2-Tier8-5000WCU": "requests/5000",
  "RequestV2-32KB": "body-inspection/32",
  "RequestV2-48KB": "body-inspection/48",
  "RequestV2-64KB": "body-inspection/64",
  "AMR-BotControl": "bot-control/rule-groups",
  "AMR-BotControl-Request": "bot-control/requests"
}

const WCU_TIERS = [1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000]

export const waf: ServiceMap = {
  id: "waf",
  title: "AWS WAF",
  offers: ["awswaf"],
  extraRegions: ["aws-other"],
  dimensions: {
    "web-acls": {
      unit: "web ACL-month",
      description: "Web ACLs (protection packs), prorated hourly"
    },
    rules: {
      unit: "rule-month",
      description: "Rules and rule groups in a web ACL (a managed rule group counts as one), prorated hourly"
    },
    ...Object.fromEntries(
      WCU_TIERS.map((wcu, i) => [
        `requests/${wcu}`,
        {
          unit: "request",
          description: `Requests inspected by a web ACL of ${i === 0 ? "up to 1,500" : `${WCU_TIERS[i - 1]! + 1} to ${wcu.toLocaleString("en")}`} WCUs`
        }
      ])
    ),
    ...Object.fromEntries(
      ["32", "48", "64"].map((kb) => [
        `body-inspection/${kb}`,
        { unit: "request", description: `Extra per request for a ${kb} KB body inspection limit (CloudFront, API Gateway...)` }
      ])
    ),
    "bot-control/rule-groups": {
      unit: "rule group-month",
      description: "Bot Control (common) managed rule group in a web ACL, prorated hourly"
    },
    "bot-control/requests": {
      unit: "request",
      description: "Requests inspected by Bot Control (common); the first 10 million a month are free"
    }
  },
  classify: (row) => {
    const global = row.region === "aws-other"
    if (global !== row.usage.startsWith("Global-")) return undefined
    const dimension = USAGES[global ? row.usage.slice("Global-".length) : row.usage]
    if (dimension === undefined) return undefined
    const region = global ? { region: "global" } : {}
    // Bot Control's 10 million free requests are its first range, at 0.
    if (row.price === 0 && row.from === 0 && row.to !== Number.POSITIVE_INFINITY) return { dimension, free: true, ...region }
    return { dimension, ...region }
  }
}
