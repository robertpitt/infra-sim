import { Schema } from "effect"
import * as Component from "../../../Component.ts"
import * as Setting from "../../../Setting.ts"
import { docs } from "../../internal/docs.ts"

/** Where each number comes from. Every constant below names the page that says so. */
const D = docs.waf
export const DOCS_URL = `${D}waf-chapter.html`
export const QUOTAS_URL = `${D}limits.html`
export const SERVICE_QUOTAS_URL = "https://docs.aws.amazon.com/general/latest/gr/waf.html"
export const WCU_URL = `${D}aws-waf-capacity-units.html`
export const RATE_RULE_URL = `${D}waf-rule-statement-type-rate-based.html`
export const RATE_SETTINGS_URL = `${D}waf-rule-statement-type-rate-based-high-level-settings.html`
export const RATE_CAVEATS_URL = `${D}waf-rule-statement-type-rate-based-caveats.html`
export const RATE_API_URL = "https://docs.aws.amazon.com/waf/latest/APIReference/API_RateBasedStatement.html"
export const MANAGED_KEYS_URL = `${D}listing-managed-ips.html`
export const BODY_LIMIT_URL = `${D}web-acl-setting-body-inspection-limit.html`
export const OVERSIZE_URL = `${D}waf-oversize-request-components.html`
export const BASELINE_URL = `${D}aws-managed-rule-groups-baseline.html`
export const USE_CASE_URL = `${D}aws-managed-rule-groups-use-case.html`
export const IP_REPUTATION_URL = `${D}aws-managed-rule-groups-ip-rep.html`
export const BOT_CONTROL_URL = `${D}aws-managed-rule-groups-bot.html`
export const RESOURCES_URL = `${D}how-aws-waf-works-resources.html`
export const ACTIONS_URL = `${D}waf-rule-action.html`
export const STRING_MATCH_URL = `${D}waf-rule-statement-type-string-match.html`
export const SIZE_CONSTRAINT_URL = `${D}waf-rule-statement-type-size-constraint-match.html`
export const METRICS_URL = `${D}waf-metrics.html`
/** The load balancer attribute `waf.fail_open.enabled`, and its 500 for "an error executing the web ACL rules". */
export const ALB_ATTRIBUTES_URL = "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html#load-balancer-attributes"
export const ALB_ERRORS_URL = "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html#http-500-issues"

/** The most capacity a web ACL may use (hard). AWS refuses to create or update one past it. */
export const MAX_WCU = 5_000
/** Capacity included in a web ACL's base price; past it AWS charges more, in tiers. */
export const PRICED_WCU = 1_500
/** A rate-based statement's base cost; aggregating on the IP address adds nothing (custom keys would add 30 each). */
export const RATE_RULE_WCU = 2
/** A scope-down on the HTTP method is an exact string match: 2 WCUs. */
export const METHOD_MATCH_WCU = 2
/** A size constraint statement (the rule that blocks oversized bodies): 1 WCU. */
export const SIZE_CONSTRAINT_WCU = 1

/** The lowest and highest limit a rate-based rule accepts, per evaluation window (hard). */
export const MIN_RATE_LIMIT = 10
export const MAX_RATE_LIMIT = 2_000_000_000
/** AWS WAF "checks the rate about every 10 seconds", whatever the window. The window is counted in slices of this. */
export const CHECK_INTERVAL_MS = 10_000
/** Most addresses one rate-based rule can rate limit at once; past it, those with the highest rates (hard). */
export const MAX_RATE_LIMITED = 10_000

/** The Core rule set's SizeRestrictions_BODY rule blocks request bodies over 8 KB. */
export const CORE_BODY_LIMIT_BYTES = 8_192
/** The body AWS WAF can inspect for an Application Load Balancer or AppSync API: fixed at 8 KB. */
export const FIXED_BODY_LIMIT_BYTES = 8_192
/** The body inspection limits CloudFront, API Gateway, Cognito, App Runner and Verified Access accept, in KB (16 by default). */
export const BODY_LIMITS_KB = ["16", "32", "48", "64"] as const

/** Requests per second per web ACL (quota, regional). For CloudFront the developer guide says CloudFront sets it. */
export const DEFAULT_REQUEST_RATE = 100_000

/** Most traffic-source addresses tracked: bounds the rate-based rule's memory (`addresses x window / 10 s` counters). */
export const MAX_ADDRESSES = 50_000

/**
 * The resources a web ACL can be associated with, and what each implies: CloudFront's web ACLs are global (created in
 * us-east-1); the others are regional, in the resource's own region. Amplify and Bedrock AgentCore are left out: their
 * body inspection limits are not consistently documented.
 */
export const RESOURCES = ["cloudfront", "alb", "apigateway", "appsync", "cognito", "apprunner", "verifiedaccess"] as const
export type Resource = (typeof RESOURCES)[number]
export const isGlobal = (r: Resource): boolean => r === "cloudfront"
/** ALB and AppSync forward only the first 8 KB of a body to AWS WAF; the rest let you choose 16 to 64 KB. */
export const hasFixedBodyLimit = (r: Resource): boolean => r === "alb" || r === "appsync"

/** The AWS Managed Rules rule groups and their capacities, as AWS publishes them. */
export const MANAGED_GROUPS = {
  core: { name: "Core rule set (AWSManagedRulesCommonRuleSet)", wcu: 700, source: BASELINE_URL },
  knownBadInputs: { name: "Known bad inputs", wcu: 200, source: BASELINE_URL },
  adminProtection: { name: "Admin protection", wcu: 100, source: BASELINE_URL },
  sqlDatabase: { name: "SQL database", wcu: 200, source: USE_CASE_URL },
  linux: { name: "Linux operating system", wcu: 200, source: USE_CASE_URL },
  posix: { name: "POSIX operating system", wcu: 100, source: USE_CASE_URL },
  windows: { name: "Windows operating system", wcu: 200, source: USE_CASE_URL },
  php: { name: "PHP application", wcu: 100, source: USE_CASE_URL },
  wordpress: { name: "WordPress application", wcu: 100, source: USE_CASE_URL },
  ipReputation: { name: "Amazon IP reputation list", wcu: 25, source: IP_REPUTATION_URL },
  anonymousIp: { name: "Anonymous IP list", wcu: 50, source: IP_REPUTATION_URL },
  botControl: { name: "Bot Control (extra fees)", wcu: 50, source: BOT_CONTROL_URL }
} as const
export type ManagedGroup = keyof typeof MANAGED_GROUPS
export const MANAGED_GROUP_IDS = Object.keys(MANAGED_GROUPS) as ReadonlyArray<ManagedGroup>

const groupToggle = (id: ManagedGroup, help: string) =>
  Setting.bool({ default: false, help: `${help} ${MANAGED_GROUPS[id].wcu} WCUs.` })

export const Config = Schema.Struct({
  protects: Setting.choice(RESOURCES, {
    default: "cloudfront",
    label: "Protects",
    labels: {
      cloudfront: "CloudFront distribution (global)",
      alb: "Application Load Balancer",
      apigateway: "API Gateway REST API",
      appsync: "AppSync GraphQL API",
      cognito: "Cognito user pool",
      apprunner: "App Runner service",
      verifiedaccess: "Verified Access instance"
    },
    help:
      "What the web ACL is associated with: put the WAF in front of it. A CloudFront web ACL is global (created in us-east-1), so leave it outside region boxes like CloudFront; the others are regional and belong in the protected resource's region. It decides the body inspection limit (8 KB fixed for ALB and AppSync) and whether the regional request quota applies."
  }),
  latency: Setting.latency({
    mean: "1 millis",
    cv: 0.5,
    label: "Inspection latency",
    help: "What evaluating the web ACL adds to each request. AWS publishes no figure: an assumption. The association is modelled as a hop, so the edge into the protected resource adds its own (1 ms inside a region; set it to 0 for none)."
  }),
  requestRate: Setting.int({
    default: DEFAULT_REQUEST_RATE,
    min: 1,
    max: 100_000_000,
    unit: "req/s",
    label: "Requests per second (web ACL)",
    help:
      "Regional web ACLs only. Past it AWS WAF cannot take the request, which the protected resource answers as an ALB does when the web ACL fails: 500, or the request goes through uninspected with fail-open (what happens past the quota is not documented: an assumption). For CloudFront the developer guide says CloudFront sets the limit, so it is not applied here.",
    limit: Setting.quota(QUOTAS_URL, "100,000 per web ACL. Service Quotas also lists 100,000 for CloudFront web ACLs.")
  }),
  failOpen: Setting.bool({
    default: false,
    label: "Fail open (ALB)",
    help: "The load balancer attribute waf.fail_open.enabled: when the ALB cannot hand a request to AWS WAF it routes it to its targets uninspected instead of answering 500. Application Load Balancers only (default off)."
  }),
  rateRule: Setting.group(
    {
      enabled: Setting.bool({ default: true, help: "One rate-based rule, aggregating on the client IP address, evaluated before every other rule." }),
      limit: Setting.int({
        default: 2_000,
        min: MIN_RATE_LIMIT,
        max: MAX_RATE_LIMIT,
        unit: "requests",
        label: "Rate limit",
        help: "Requests one address may make in the evaluation window. Over it, the address is rate limited until its count falls back under. AWS has no default: 2,000 is an example.",
        limit: Setting.hard(RATE_API_URL, "At least 10 and at most 2,000,000,000 per window.")
      }),
      window: Setting.choice(["60", "120", "300", "600"], {
        default: "300",
        label: "Evaluation window",
        labels: { "60": "1 minute", "120": "2 minutes", "300": "5 minutes (AWS default)", "600": "10 minutes" },
        help: "How far back AWS WAF counts each time it checks. It checks about every 10 seconds whatever the window."
      }),
      scope: Setting.choice(["all", "write", "read"], {
        default: "all",
        label: "Scope-down",
        labels: { all: "Every request", write: "Writes only (POST, PUT...: a login or signup)", read: "Reads only (GET)" },
        help: "Count and rate limit only these requests, with a scope-down statement on the HTTP method (2 WCUs). A request's method is its operation."
      }),
      action: Setting.choice(["block", "count"], {
        default: "block",
        labels: { block: "Block (403)", count: "Count (watch, don't block)" },
        help: "What happens to a rate-limited address's requests. Count only counts them, the way a new rule is tested."
      }),
      lag: Setting.duration({
        default: "10 seconds",
        min: 0,
        max: "5 minutes",
        label: "Propagation delay",
        help:
          "How long after a check AWS WAF starts (or stops) rate limiting an address, on top of checking every 10 seconds. AWS says the delay is usually under 30 seconds and can be several minutes: an assumption."
      })
    },
    { label: "Rate-based rule" }
  ),
  traffic: Setting.group(
    {
      addresses: Setting.int({
        default: 1_000,
        min: 1,
        max: MAX_ADDRESSES,
        label: "Addresses per traffic source",
        help:
          "A request carries no IP address, so each traffic source (the client that made it) is taken to send from this many addresses, a request's key choosing one. A client's hot key always lands on one address: one IP flooding. A source spread over many addresses stays under a per-IP limit. A modelling choice."
      }),
      attackSources: Setting.text({
        default: "",
        label: "Attack traffic from",
        placeholder: "scanner, bots",
        help: "Ids of traffic sources (client nodes) whose requests are attacks: scanners, injection attempts, bad bots. The rules match them at the attack match share below. Comma separated."
      })
    },
    { label: "Traffic as AWS WAF sees it" }
  ),
  managed: Setting.group(
    {
      core: groupToggle("core", "OWASP-style protections for any web application. Its SizeRestrictions_BODY rule blocks bodies over 8 KB."),
      coreBodySize: Setting.choice(["block", "count"], {
        default: "block",
        label: "Core: SizeRestrictions_BODY",
        labels: { block: "Block (the group's action)", count: "Override to Count" },
        help: "The Core rule set blocks any request body over 8,192 bytes, uploads included. Overriding this one rule to Count is the usual fix."
      }),
      knownBadInputs: groupToggle("knownBadInputs", "Request patterns known to be invalid or exploits (Log4j, Java deserialization)."),
      adminProtection: groupToggle("adminProtection", "Blocks access to exposed admin pages."),
      sqlDatabase: groupToggle("sqlDatabase", "SQL injection."),
      linux: groupToggle("linux", "Linux local file inclusion."),
      posix: groupToggle("posix", "Unix shell command injection."),
      windows: groupToggle("windows", "Windows and PowerShell command injection."),
      php: groupToggle("php", "PHP code injection."),
      wordpress: groupToggle("wordpress", "WordPress exploits."),
      ipReputation: groupToggle("ipReputation", "Addresses Amazon's threat intelligence knows as malicious."),
      anonymousIp: groupToggle("anonymousIp", "VPNs, proxies, Tor and hosting providers."),
      botControl: groupToggle("botControl", "Self-identifying bots (common level); charged extra. Only its matching is modelled.")
    },
    { label: "AWS Managed Rules rule groups" }
  ),
  rules: Setting.group(
    {
      customWcu: Setting.int({
        default: 0,
        min: 0,
        max: MAX_WCU,
        unit: "WCU",
        label: "Your own rules",
        help: "Capacity your own rules and rule groups use (IP sets, string and regex matches, geo matches...). They match like the managed groups below."
      }),
      action: Setting.choice(["block", "count"], {
        default: "block",
        labels: { block: "Block (403)", count: "Count (override every rule to Count)" },
        help: "What the managed rule groups and your rules do with a request they match. Count only counts, the way new rules are tried out."
      }),
      match: Setting.ratio({
        default: 0,
        label: "Match share (other traffic)",
        help: "Share of ordinary requests that some rule matches: bad requests mixed into the traffic, or false positives. An assumption about your traffic, like an SNS filter's match share. Nothing matches when there are no rules."
      }),
      attackMatch: Setting.ratio({
        default: 0.9,
        label: "Match share (attack traffic)",
        help: "Share of requests from the attack sources that the rules catch, when every byte of them is inspected. An assumption. Nothing matches when there are no rules."
      })
    },
    { label: "What the rules match" }
  ),
  body: Setting.group(
    {
      inspectionLimit: Setting.choice(BODY_LIMITS_KB, {
        default: "16",
        label: "Body inspection limit",
        labels: { "16": "16 KB (default)", "32": "32 KB", "48": "48 KB", "64": "64 KB" },
        help: "How much of a request body AWS WAF inspects, for CloudFront, API Gateway, Cognito, App Runner and Verified Access. Fixed at 8 KB for ALB and AppSync (this is then ignored). Raising it costs extra for bodies over 16 KB. The rules miss an attack hidden past the limit.",
      }),
      blockOversize: Setting.bool({
        default: false,
        label: "Block oversized bodies",
        help: "A size constraint rule (1 WCU) placed before the rule groups that blocks any body over the inspection limit, as AWS recommends, so nothing uninspected gets through. Legitimate large uploads are blocked too."
      })
    },
    { label: "Body inspection" }
  )
})
export type Settings = typeof Config.Type

export const ports = {
  // A web ACL can be associated with several resources; a request goes to one of them, by edge weight.
  out: Component.port.many("Protected resource")
} as const

export const State = Schema.Struct({
  allowed: Schema.Number,
  blocked: Schema.Number,
  counted: Schema.Number,
  blockedByRateRule: Schema.Number,
  blockedByRules: Schema.Number,
  blockedBodySize: Schema.Number,
  blockedOversize: Schema.Number,
  overQuota: Schema.Number,
  uninspected: Schema.Number,
  rateLimitedAddresses: Schema.Number,
  busiestAddressCount: Schema.Number,
  trackedSources: Schema.Number,
  wcu: Schema.Number
})
export type State = typeof State.Type
