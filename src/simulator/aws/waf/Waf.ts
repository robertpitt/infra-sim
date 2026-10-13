import { Effect } from "effect"
import * as Aws from "../internal/provider.ts"
import { dashboard } from "./internal/dashboard.ts"
import {
  ACTIONS_URL,
  ALB_ERRORS_URL,
  BODY_LIMIT_URL,
  Config,
  DOCS_URL,
  MANAGED_KEYS_URL,
  MAX_WCU,
  OVERSIZE_URL,
  ports,
  PRICED_WCU,
  QUOTAS_URL,
  RATE_API_URL,
  RATE_CAVEATS_URL,
  RESOURCES_URL,
  State,
  WCU_URL
} from "./internal/config.ts"
import { makeRuntime } from "./internal/runtime.ts"

/**
 * AWS WAF: a web ACL in front of an application. In AWS a web ACL is associated with a CloudFront distribution, an
 * Application Load Balancer, an API Gateway stage and so on; here it is a hop in front of that resource, which adds the
 * inspection latency, lets allowed requests through its `out` port and answers blocked ones with 403. It models a
 * rate-based rule per client IP with AWS's evaluation windows and detection lag, managed rule groups and your own rules
 * as shares of the traffic they match, body inspection limits, capacity units and the request quota. See `README.md`.
 */
export const Waf = Aws.component({
  type: "aws.waf",
  service: "WAF",
  title: "WAF web ACL",
  description:
    "Web application firewall in front of CloudFront, an ALB or API Gateway. A rate-based rule blocks an IP flooding past its limit after a detection lag; managed rule groups and your own rules block what they match; blocked requests get 403.",
  docs: DOCS_URL,
  category: "network",
  // Blocking is its job: a blocked request's 403 isn't an error to alarm on. Failures it passes on alarm where they land.
  quietAlarms: ["errors"],
  icon: "shield",
  accent: "#dd344c",
  dashboard,
  limits: [
    { label: "Web ACL capacity", value: "5,000 WCUs; the base price includes 1,500", adjustable: false, source: WCU_URL, note: `AWS refuses a web ACL over ${MAX_WCU.toLocaleString("en-US")} WCUs (a design error here); over ${PRICED_WCU.toLocaleString("en-US")} costs more.` },
    { label: "Requests per second per web ACL", value: "100,000", adjustable: true, source: QUOTAS_URL, note: "Regional web ACLs. For CloudFront the developer guide says CloudFront sets the limit; Service Quotas lists 100,000 for CloudFront web ACLs too." },
    { label: "Rate-based rule limit", value: "10 to 2,000,000,000 requests per window", adjustable: false, source: RATE_API_URL },
    { label: "Rate-based rule windows", value: "1, 2, 5 (default) or 10 minutes; rate checked about every 10 s", adjustable: false, source: RATE_API_URL },
    { label: "Rate-based rule detection", value: "usually under 30 s; up to several minutes", adjustable: false, source: RATE_CAVEATS_URL, note: "Rate limiting also lasts that long after an address falls back under the limit." },
    { label: "Addresses rate limited per rule", value: "10,000; the highest rates first", adjustable: false, source: MANAGED_KEYS_URL },
    { label: "Rate-based rules per web ACL", value: "10", adjustable: false, source: QUOTAS_URL, note: "One is modelled." },
    { label: "Body inspection", value: "8 KB for ALB and AppSync; 16 KB by default, up to 64 KB, for CloudFront, API Gateway, Cognito, App Runner, Verified Access", adjustable: false, source: BODY_LIMIT_URL },
    { label: "Headers and cookies inspected", value: "the first 8 KB or 200 of each", adjustable: false, source: OVERSIZE_URL, note: "Not modelled: requests carry no headers." },
    { label: "Blocked response", value: "403 Forbidden by default", adjustable: false, source: ACTIONS_URL, note: "A rule can send a custom response instead; not modelled." },
    { label: "Web ACL fails on an ALB", value: "500, or routed uninspected with waf.fail_open.enabled", adjustable: false, source: ALB_ERRORS_URL },
    { label: "Where web ACLs live", value: "CloudFront: us-east-1 (Global); others: the resource's Region", adjustable: false, source: RESOURCES_URL }
  ],
  highlights: [
    { rate: "allowed", label: "allowed/s" },
    { rate: "blocked", label: "blocked/s" },
    { gauge: "rateLimitedAddresses", label: "IPs limited" }
  ],
  config: Config,
  ports,
  state: State,
  make: (node) => Effect.sync(() => makeRuntime(node))
})
