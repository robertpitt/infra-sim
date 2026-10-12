import { Duration, Effect } from "effect"
import * as Distribution from "../../Distribution.ts"
import * as Edge from "../../Edge.ts"
import { type Cancel, delayed, noCancel } from "../../Flow.ts"
import type { Bucket } from "../../Limiter.ts"
import { type Call, type CallFailure, Failed, type ItemFailures, type Message, Rejected, type Reply } from "../../Message.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import * as Aws from "../provider.ts"
import { capacityOf, hasContentRules } from "./capacity.ts"
import {
  ACTIONS_URL,
  ALB_ERRORS_URL,
  BODY_LIMIT_URL,
  CHECK_INTERVAL_MS,
  Config,
  CORE_BODY_LIMIT_BYTES,
  DOCS_URL,
  FIXED_BODY_LIMIT_BYTES,
  hasFixedBodyLimit,
  isGlobal,
  MANAGED_KEYS_URL,
  MAX_WCU,
  OVERSIZE_URL,
  ports,
  PRICED_WCU,
  QUOTAS_URL,
  RATE_API_URL,
  RATE_CAVEATS_URL,
  RESOURCES_URL,
  type Settings,
  State,
  WCU_URL
} from "./config.ts"
import { makeRateTracker, type RateSpec } from "./rateRule.ts"

/** What a request comes to, in the order the web ACL evaluates its rules. */
const Verdict = { Allow: 0, RateBased: 1, Oversize: 2, BodySize: 3, Rules: 4 } as const
type Verdict = (typeof Verdict)[keyof typeof Verdict]

/** What the settings mean for one request, worked out once per settings object and reused. */
interface Plan {
  /** The regional web ACL's request quota as a one-second bucket, or undefined (CloudFront sets its own). */
  readonly requestRate: Bucket | undefined
  /** Only an Application Load Balancer can be told to route requests AWS WAF cannot take. */
  readonly failOpen: boolean
  readonly bodyLimit: number
  readonly rate: {
    readonly spec: RateSpec
    readonly scope: Settings["rateRule"]["scope"]
    readonly block: boolean
    readonly lagMs: number
  } | undefined
  readonly blockOversize: boolean
  /** The Core rule set's body size rule: its action, or undefined when the group is not in the web ACL. */
  readonly coreBodySize: "block" | "count" | undefined
  /** Whether any content rule is there to match: a managed rule group or your own rules. */
  readonly content: boolean
  readonly rulesBlock: boolean
  readonly match: number
  readonly attackMatch: number
  readonly attackSources: ReadonlySet<string>
  readonly wcu: number
}

const derive = (c: Settings): Plan => {
  const global = isGlobal(c.protects)
  const rulesBlock = c.rules.action === "block"
  return {
    requestRate: global ? undefined : { rate: c.requestRate, burst: c.requestRate },
    failOpen: c.protects === "alb" && c.failOpen,
    bodyLimit: hasFixedBodyLimit(c.protects) ? FIXED_BODY_LIMIT_BYTES : Number(c.body.inspectionLimit) * 1024,
    rate: c.rateRule.enabled
      ? {
        spec: { limit: c.rateRule.limit, slices: Number(c.rateRule.window) * 1000 / CHECK_INTERVAL_MS, addresses: c.traffic.addresses },
        scope: c.rateRule.scope,
        block: c.rateRule.action === "block",
        lagMs: Duration.toMillis(c.rateRule.lag)
      }
      : undefined,
    blockOversize: c.body.blockOversize,
    // Overriding every rule to Count overrides this one too.
    coreBodySize: c.managed.core ? (rulesBlock ? c.managed.coreBodySize : "count") : undefined,
    content: hasContentRules(c),
    rulesBlock,
    match: c.rules.match,
    attackMatch: c.rules.attackMatch,
    attackSources: new Set(c.traffic.attackSources.split(/[\s,]+/).filter((s) => s.length > 0)),
    wcu: capacityOf(c).total
  }
}

/** A request AWS WAF let through: waiting out the inspection, then with the protected resource. */
class Passing {
  open = true
  timer: TimerHandle | undefined
  cancelDown: Cancel = noCancel
  constructor(readonly message: Message, readonly resume: (effect: Call) => void) {}
}

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
  make: (node) =>
    Effect.sync(() => {
      const { fast, meter, limiter } = node
      const out = node.out("out")
      const quotaKey = `${node.id}/requests`
      const tracker = makeRateTracker()

      // Each answer is the same every time, so it is made once.
      const BLOCKED: Record<Exclude<Verdict, 0>, CallFailure> = {
        [Verdict.RateBased]: Rejected({ node: node.id, reason: "403 blocked by the rate-based rule" }),
        [Verdict.Oversize]: Rejected({ node: node.id, reason: "403 blocked: body larger than AWS WAF inspects" }),
        [Verdict.BodySize]: Rejected({ node: node.id, reason: "403 blocked by the Core rule set (SizeRestrictions_BODY)" }),
        [Verdict.Rules]: Rejected({ node: node.id, reason: "403 blocked by a rule" })
      }
      /** The same answers as functions, for `delayed`, so a blocked request allocates no closure of its own. */
      const answerBlocked = {
        [Verdict.RateBased]: () => BLOCKED[Verdict.RateBased],
        [Verdict.Oversize]: () => BLOCKED[Verdict.Oversize],
        [Verdict.BodySize]: () => BLOCKED[Verdict.BodySize],
        [Verdict.Rules]: () => BLOCKED[Verdict.Rules]
      }
      const OVER_QUOTA = Failed({ node: node.id, reason: "500 AWS WAF could not take the request (web ACL request quota)" })

      // CloudWatch's names where there is one: AllowedRequests, BlockedRequests, CountedRequests.
      const allowedN = meter.counter("allowed")
      const blockedN = meter.counter("blocked")
      const countedN = meter.counter("counted")
      const blockedBy = {
        [Verdict.RateBased]: meter.counter("blocked.rateBased"),
        [Verdict.Oversize]: meter.counter("blocked.oversize"),
        [Verdict.BodySize]: meter.counter("blocked.bodySize"),
        [Verdict.Rules]: meter.counter("blocked.rules")
      }
      const overQuotaN = meter.counter("overQuota")
      const uninspectedN = meter.counter("uninspected")
      const totals = { allowed: 0, blocked: 0, counted: 0, blockedByRateRule: 0, blockedByRules: 0, blockedBodySize: 0, blockedOversize: 0, overQuota: 0, uninspected: 0 }
      const totalBy = { [Verdict.RateBased]: "blockedByRateRule", [Verdict.Oversize]: "blockedOversize", [Verdict.BodySize]: "blockedBodySize", [Verdict.Rules]: "blockedByRules" } as const

      // What the settings mean is worked out again only when they are replaced. The rate rule's counts are reset when
      // its limit, window or aggregation change (AWS resets them too), not on other edits.
      let planFrom: Settings | undefined
      let planMemo: Plan
      const planOf = (c: Settings): Plan => {
        if (c !== planFrom) {
          planFrom = c
          planMemo = derive(c)
          tracker.configure(planMemo.rate?.spec)
        }
        return planMemo
      }

      // The share of requests blocked between two checks, for the `blockedShare` gauge.
      let recentSeen = 0
      let recentBlocked = 0
      let blockedShare = 0
      /** Set by `decide` when a rule with the Count action matched on the way. */
      let counted = false

      /** Run the request through the web ACL's rules in priority order and say what it comes to. */
      const decide = (message: Message, plan: Plan): Verdict => {
        // The rate-based rule goes first. It counts every request in its scope, blocked ones included: a flooding
        // address stays over the limit for as long as it keeps flooding.
        const rate = plan.rate
        if (rate !== undefined && (rate.scope === "all" || rate.scope === message.operation) && tracker.see(message.origin, message.key)) {
          if (rate.block) return Verdict.RateBased
          counted = true
        }
        // A read is a GET and carries no body.
        const body = message.operation === "write" ? message.bytes : 0
        // AWS's advice: a rule ahead of the rule groups that blocks bodies they cannot see all of.
        if (plan.blockOversize && body > plan.bodyLimit) return Verdict.Oversize
        if (plan.coreBodySize !== undefined && body > CORE_BODY_LIMIT_BYTES) {
          if (plan.coreBodySize === "block") return Verdict.BodySize
          counted = true
        }
        if (plan.content) {
          // An attack hidden in a body larger than the inspection limit is caught only if it sits in the part that is
          // inspected: the share inspected, assuming the payload is equally likely to be anywhere in the body.
          const attack = plan.attackSources.size > 0 && plan.attackSources.has(message.origin)
          const share = attack ? plan.attackMatch * (body > plan.bodyLimit ? plan.bodyLimit / body : 1) : plan.match
          if (share > 0 && fast.random.nextDoubleUnsafe() < share) {
            if (plan.rulesBlock) return Verdict.Rules
            counted = true
          }
        }
        return Verdict.Allow
      }

      /** Decide, and count the outcome the way CloudWatch does: allowed or blocked, and counted when a Count rule matched. */
      const inspect = (message: Message, plan: Plan): Verdict => {
        counted = false
        const verdict = decide(message, plan)
        if (counted) {
          totals.counted++
          countedN.n++
        }
        recentSeen++
        if (verdict === Verdict.Allow) {
          totals.allowed++
          allowedN.n++
        } else {
          totals.blocked++
          blockedN.n++
          totals[totalBy[verdict]]++
          blockedBy[verdict].n++
          recentBlocked++
        }
        return verdict
      }

      // ---- Allowed requests: the inspection, then the protected resource -----------------------------------------
      // A timer and one downstream call, no fibers. The web ACL is transparent: whatever the protected resource answers,
      // the caller gets.

      const finish = (r: Passing, failure: CallFailure | undefined, items?: ItemFailures): void => {
        if (!r.open) return
        r.open = false
        r.timer?.cancel()
        r.timer = undefined
        r.cancelDown = noCancel
        r.resume(failure !== undefined ? Effect.fail(failure) : items !== undefined ? Effect.succeed(items) : Effect.void)
      }
      /** The caller gave up: stop waiting and abandon the call downstream (it carries on unless its edge cancels). */
      const abandon = (r: Passing): void => {
        if (!r.open) return
        r.open = false
        r.timer?.cancel()
        r.timer = undefined
        r.cancelDown()
        r.cancelDown = noCancel
      }
      const send = (r: Passing): void => {
        r.timer = undefined
        const link = Edge.pickUnsafe(out, fast.random)
        // No protected resource drawn: the web ACL answers for it, so a WAF can be tried on its own.
        if (link === undefined) return finish(r, undefined)
        r.cancelDown = link.send(r.message, (failure, items) => finish(r, failure, items))
      }
      const pass = (message: Message, ms: number): Call =>
        Effect.callback<Reply, CallFailure>((resume) => {
          const r = new Passing(message, resume)
          if (ms > 0) r.timer = fast.after(ms, send, r)
          else send(r)
          return Effect.sync(() => abandon(r))
        })

      // ---- The check: AWS WAF looks at the rates about every 10 seconds -----------------------------------------
      // It decides which addresses to rate limit from the counts over the window, and that takes effect after the
      // propagation delay. Then the oldest slice of the window is dropped.
      const check = (): void => {
        const plan = planOf(fast.settings())
        if (plan.rate !== undefined) {
          const decision = tracker.evaluate()
          if (plan.rate.lagMs > 0) fast.after(plan.rate.lagMs, tracker.apply, decision)
          else tracker.apply(decision)
        }
        tracker.advance()
        blockedShare = recentSeen > 0 ? recentBlocked / recentSeen : 0
        recentSeen = 0
        recentBlocked = 0
        fast.after(CHECK_INTERVAL_MS, check, undefined)
      }
      fast.after(CHECK_INTERVAL_MS, check, undefined)

      meter.gaugeUnsafe("rateLimitedAddresses", tracker.limitedCount)
      meter.gaugeUnsafe("busiestAddress", tracker.busiest)
      meter.gaugeUnsafe("blockedShare", () => blockedShare)
      meter.gaugeUnsafe("wcu", () => planOf(fast.settings()).wcu)

      return {
        call: (message) => {
          const c = fast.settings()
          const plan = planOf(c)
          if (plan.requestRate !== undefined && !limiter.takeUnsafe(quotaKey, plan.requestRate)) {
            totals.overQuota++
            overQuotaN.n++
            if (!plan.failOpen) return Effect.fail(OVER_QUOTA)
            totals.uninspected++
            uninspectedN.n++
            return pass(message, 0)
          }
          const verdict = inspect(message, plan)
          const ms = Distribution.latencyMs(c.latency, fast.random)
          if (verdict === Verdict.Allow) return pass(message, ms)
          // Blocked: the protected resource answers 403 once the web ACL has been evaluated.
          return ms > 0 ? delayed(fast, ms, answerBlocked[verdict]) : Effect.fail(BLOCKED[verdict])
        },
        probe: Effect.sync(() => ({
          ...totals,
          rateLimitedAddresses: tracker.limitedCount(),
          busiestAddressCount: tracker.busiest(),
          trackedSources: tracker.sources(),
          wcu: planOf(fast.settings()).wcu
        }))
      }
    })
})
