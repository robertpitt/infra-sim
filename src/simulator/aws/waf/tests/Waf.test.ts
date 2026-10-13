import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../../Builder.ts"
import { dist, frames, gauge, rate, sim } from "../../../testing.ts"
import { registry } from "../../../components/Builtins.ts"
import * as Diagnostics from "../../../Diagnostics.ts"
import { audit } from "../Audit.ts"
import { capacityOf } from "../internal/capacity.ts"
import { Config, type State } from "../internal/config.ts"

type Bag = Record<string, unknown>
interface Source {
  readonly id: string
  readonly settings?: Bag
  readonly edge?: Bag
}

/**
 * Traffic sources -> web ACL -> an application that answers in 10 ms. Edges carry no latency, so times are the web ACL's
 * and the application's own. Sources send at a constant rate unless told otherwise.
 */
const front = (waf: Bag, sources: ReadonlyArray<Source>, app: Bag = {}, wire = true) => {
  const b = Builder.make("waf", { seed: 7 })
  const acl = b.add("aws.waf", { id: "waf", settings: waf })
  for (const s of sources) {
    const client = b.add("common.client", { id: s.id, settings: { arrival: "constant", ...s.settings } })
    b.connect(client, acl, { latency: { mean: 0, cv: 0 }, ...s.edge })
  }
  if (wire) b.connect(acl, b.add("common.http-endpoint", { id: "app", settings: { latency: { mean: 10, cv: 0 }, ...app } }), { latency: { mean: 0, cv: 0 } })
  return b.build()
}

/** A one-minute window and a limit of 1,000 per address keep the tests short. */
const minute = (rateRule: Bag = {}, rest: Bag = {}): Bag => ({ protects: "alb", rateRule: { limit: 1_000, window: "60", lag: "10 seconds", ...rateRule }, ...rest })

const state = (s: { readonly probe: (id: string) => Effect.Effect<{ readonly state: unknown }, unknown> }, id: string) =>
  Effect.map(s.probe(id), (p) => p.state as State)

const decode = (settings: Bag) => Schema.decodeUnknownSync(Config)(settings)

describe("aws.waf: rate-based rule", () => {
  it("blocks one IP flooding past the limit after the next check and the propagation delay; other users are untouched", async () => {
    const all = await frames(front(minute(), [{ id: "users", settings: { rps: 50 } }, { id: "bot", settings: { rps: 100, hotKeys: 1 } }]), 60_000)
    // The bot's count passes 1,000 just after 10 s; the check at 20 s sees 2,000, and the block lands 10 s later.
    expect(rate(all, "waf", "blocked", 0, 19_000)).toBe(0)
    expect(gauge(all, "waf", "rateLimitedAddresses", 0, 19_000)).toBe(0)
    expect(rate(all, "waf", "blocked.rateBased", 31_000)).toBeCloseTo(100, -1)
    expect(gauge(all, "waf", "rateLimitedAddresses", 31_000)).toBe(1)
    expect(rate(all, "bot", "fail.Rejected", 31_000)).toBeCloseTo(100, -1)
    expect(rate(all, "users", "ok", 1_000)).toBeCloseTo(50, 0)
    expect(rate(all, "users", "fail", 0)).toBe(0)
    expect(rate(all, "app", "in", 31_000)).toBeCloseTo(50, 0)
  })

  it("the detection lag is the 10-second check plus the propagation delay", async () => {
    const bot = [{ id: "bot", settings: { rps: 100, hotKeys: 1 } }]
    const prompt = await frames(front(minute({ lag: 0 }), bot), 40_000)
    expect(rate(prompt, "waf", "blocked", 0, 19_000)).toBe(0)
    expect(rate(prompt, "waf", "blocked", 21_000)).toBeCloseTo(100, -1)
    const slow = await frames(front(minute({ lag: "60 seconds" }), bot), 100_000)
    expect(rate(slow, "waf", "blocked", 0, 79_000)).toBe(0)
    expect(rate(slow, "waf", "blocked", 81_000)).toBeCloseTo(100, -1)
  })

  it("a flood spread over many addresses stays under a per-IP limit and gets through", async () => {
    // 2,000 a second over 1,000 addresses is 120 a minute each, against a limit of 1,000.
    const botnet = [{ id: "botnet", settings: { rps: 2_000, arrival: "poisson" } }]
    const spread = await frames(front(minute({}, { traffic: { addresses: 1_000 } }), botnet), 90_000)
    expect(rate(spread, "waf", "blocked", 0)).toBe(0)
    expect(rate(spread, "app", "in", 70_000)).toBeCloseTo(2_000, -2)
    expect(gauge(spread, "waf", "busiestAddress", 70_000)).toBeLessThan(200)
    // The same flood against a limit of 100: nearly every address is over it, so nearly all of it is blocked.
    const tight = await frames(front(minute({ limit: 100 }, { traffic: { addresses: 1_000 } }), botnet), 100_000)
    expect(gauge(tight, "waf", "blockedShare", 81_000)).toBeGreaterThan(0.85)
    expect(gauge(tight, "waf", "rateLimitedAddresses", 81_000)).toBeGreaterThan(850)
  })

  it("rate limits at most 10,000 addresses, so a large enough botnet gets half through", async () => {
    // 6,000 a second over 20,000 addresses is 18 a minute each, against a limit of 10: all of them are over it.
    const botnet = [{ id: "botnet", settings: { rps: 6_000 } }]
    const all = await frames(front(minute({ limit: 10 }, { traffic: { addresses: 20_000 } }), botnet), 90_000)
    expect(gauge(all, "waf", "rateLimitedAddresses", 71_000)).toBe(10_000)
    expect(gauge(all, "waf", "blockedShare", 81_000)).toBeCloseTo(0.5, 1)
  })

  it("stops rate limiting once the address's count over the window falls under the limit, after the lag", () =>
    sim(front(minute({ limit: 1_500 }), [{ id: "bot", settings: { rps: 100, hotKeys: 1 } }]), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(31_000)
        expect((yield* state(s, "waf")).rateLimitedAddresses).toBe(1)
        yield* s.configureNode("bot", { arrival: "constant", rps: 0, hotKeys: 1 })
        // The 3,100 requests sent by 31 s fall out of the one-minute window: 2,100 are left at the 70 s check, 1,100 at 80 s.
        yield* s.advanceTo(85_000)
        expect((yield* state(s, "waf")).rateLimitedAddresses).toBe(1)
        yield* s.advanceTo(95_000)
        expect((yield* state(s, "waf")).rateLimitedAddresses).toBe(0)
      })))

  it("with the Count action it counts the flooding IP's requests and blocks nothing", async () => {
    const all = await frames(front(minute({ action: "count" }), [{ id: "bot", settings: { rps: 100, hotKeys: 1 } }]), 50_000)
    expect(rate(all, "waf", "blocked", 0)).toBe(0)
    expect(rate(all, "waf", "counted", 31_000)).toBeCloseTo(100, -1)
    expect(rate(all, "app", "in", 31_000)).toBeCloseTo(100, -1)
  })

  it("a scope-down on the method counts and limits only those requests", async () => {
    const reads = await frames(front(minute({ scope: "write" }), [{ id: "bot", settings: { rps: 100, hotKeys: 1 }, edge: { request: { operation: "read" } } }]), 50_000)
    expect(rate(reads, "waf", "blocked", 0)).toBe(0)
    const writes = await frames(front(minute({ scope: "write" }), [{ id: "bot", settings: { rps: 100, hotKeys: 1 } }]), 50_000)
    expect(rate(writes, "waf", "blocked.rateBased", 31_000)).toBeCloseTo(100, -1)
  })

  it("changing the limit resets the counts, so a blocked address gets through until it is caught again", () =>
    sim(front(minute(), [{ id: "bot", settings: { rps: 100, hotKeys: 1 } }]), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(40_000)
        expect(rate(before, "waf", "blocked", 31_000)).toBeCloseTo(100, -1)
        yield* s.configureNode("waf", minute({ limit: 1_001 }))
        // Counting starts again at 40 s: 1,000 by the 50 s check (not over 1,001), 2,000 by 60 s, blocked from 70 s.
        const after = yield* s.advanceTo(90_000)
        expect(rate(after, "waf", "blocked", 41_000, 69_000)).toBe(0)
        expect(rate(after, "waf", "blocked", 71_000)).toBeCloseTo(100, -1)
        // Changing only the action keeps the counts: the address stays limited and is counted instead.
        yield* s.configureNode("waf", minute({ limit: 1_001, action: "count" }))
        const counted = yield* s.advanceTo(100_000)
        expect(rate(counted, "waf", "counted", 91_000)).toBeCloseTo(100, -1)
        expect(rate(counted, "waf", "blocked", 91_000)).toBe(0)
      })))
})

describe("aws.waf: rules", () => {
  const users = { id: "users", settings: { rps: 100 } }
  const scanner = { id: "scanner", settings: { rps: 100 } }
  const off = { rateRule: { enabled: false } }

  it("managed rule groups block the attack traffic they match, and ordinary users pass", async () => {
    const all = await frames(front({ ...off, managed: { core: true }, traffic: { attackSources: "scanner" }, rules: { attackMatch: 0.9 } }, [users, scanner]), 30_000)
    expect(rate(all, "waf", "blocked.rules", 1_000)).toBeCloseTo(90, -1)
    expect(rate(all, "scanner", "fail.Rejected", 1_000)).toBeCloseTo(90, -1)
    expect(rate(all, "users", "fail", 0)).toBe(0)
    expect(rate(all, "app", "in", 1_000)).toBeCloseTo(110, -1)
  })

  it("with no rule groups and no rules of your own, nothing matches", async () => {
    const all = await frames(front({ ...off, traffic: { attackSources: "scanner" }, rules: { attackMatch: 1, match: 0.5 } }, [users, scanner]), 10_000)
    expect(rate(all, "waf", "blocked", 0)).toBe(0)
  })

  it("the match share blocks that share of ordinary traffic; your own rules count as rules", async () => {
    const all = await frames(front({ ...off, rules: { customWcu: 50, match: 0.2 } }, [users]), 30_000)
    expect(rate(all, "waf", "blocked.rules", 1_000) / 100).toBeCloseTo(0.2, 1)
    expect(gauge(all, "waf", "blockedShare", 11_000)).toBeCloseTo(0.2, 1)
  })

  it("overridden to Count, matches are counted and let through", async () => {
    const all = await frames(front({ ...off, managed: { core: true }, traffic: { attackSources: "scanner" }, rules: { action: "count", attackMatch: 0.9 } }, [users, scanner]), 30_000)
    expect(rate(all, "waf", "blocked", 0)).toBe(0)
    expect(rate(all, "waf", "counted", 1_000)).toBeCloseTo(90, -1)
    expect(rate(all, "app", "in", 1_000)).toBeCloseTo(200, -1)
  })

  it("the Core rule set blocks bodies over 8 KB unless that rule is overridden to Count; reads carry no body", async () => {
    const upload = (kb: number, edge: Bag = {}) => [{ id: "users", settings: { rps: 100, payload: kb }, edge }]
    const big = await frames(front({ ...off, managed: { core: true } }, upload(10)), 10_000)
    expect(rate(big, "waf", "blocked.bodySize", 1_000)).toBeCloseTo(100, -1)
    const exact = await frames(front({ ...off, managed: { core: true } }, upload(8)), 10_000)
    expect(rate(exact, "waf", "blocked", 0)).toBe(0)
    const reads = await frames(front({ ...off, managed: { core: true } }, upload(10, { request: { operation: "read" } })), 10_000)
    expect(rate(reads, "waf", "blocked", 0)).toBe(0)
    const overridden = await frames(front({ ...off, managed: { core: true, coreBodySize: "count" } }, upload(10)), 10_000)
    expect(rate(overridden, "waf", "blocked", 0)).toBe(0)
    expect(rate(overridden, "waf", "counted", 1_000)).toBeCloseTo(100, -1)
  })

  it("an attack padded past the body inspection limit is caught only in the share inspected", async () => {
    // A 32 KB body: 16 KB inspected catches half, 32 KB all of it, an ALB's fixed 8 KB a quarter.
    const padded = [{ id: "scanner", settings: { rps: 200, payload: 32 } }]
    const rules = (body: Bag, protects = "apigateway") => ({ ...off, protects, managed: { sqlDatabase: true }, traffic: { attackSources: "scanner" }, rules: { attackMatch: 1 }, body })
    const share = async (settings: Bag) => rate(await frames(front(settings, padded), 20_000), "waf", "blocked", 1_000) / 200
    expect(await share(rules({}))).toBeCloseTo(0.5, 1)
    expect(await share(rules({ inspectionLimit: "32" }))).toBeCloseTo(1, 2)
    expect(await share(rules({ inspectionLimit: "64" }, "alb"))).toBeCloseTo(0.25, 1)
    // Blocking oversized bodies stops all of it, before the rule groups, and legitimate uploads with it.
    const strict = await frames(front(rules({ blockOversize: true }), [...padded, { id: "uploads", settings: { rps: 50, payload: 20 } }]), 20_000)
    expect(rate(strict, "waf", "blocked.oversize", 1_000)).toBeCloseTo(250, -1)
    expect(rate(strict, "waf", "blocked.rules", 0)).toBe(0)
  })
})

describe("aws.waf: quota, latency and the protected resource", () => {
  const off = { rateRule: { enabled: false } }

  it("past its request quota a regional web ACL answers 500; fail-open on an ALB lets the excess through uninspected", async () => {
    const load = [{ id: "users", settings: { rps: 300 } }]
    const closed = await frames(front({ ...off, protects: "alb", requestRate: 100 }, load), 20_000)
    expect(rate(closed, "users", "fail.Failed", 5_000)).toBeCloseTo(200, -1)
    expect(rate(closed, "app", "in", 5_000)).toBeCloseTo(100, -1)
    const open = await frames(front({ ...off, protects: "alb", requestRate: 100, failOpen: true }, load), 20_000)
    expect(rate(open, "users", "fail", 0)).toBe(0)
    expect(rate(open, "waf", "uninspected", 5_000)).toBeCloseTo(200, -1)
    // Fail-open is an ALB attribute: on API Gateway it does nothing.
    const apigw = await frames(front({ ...off, protects: "apigateway", requestRate: 100, failOpen: true }, load), 20_000)
    expect(rate(apigw, "users", "fail.Failed", 5_000)).toBeCloseTo(200, -1)
    // For CloudFront, CloudFront sets the limit: the web ACL's quota is not applied.
    const cloudfront = await frames(front({ ...off, protects: "cloudfront", requestRate: 100 }, load), 20_000)
    expect(rate(cloudfront, "users", "fail", 0)).toBe(0)
  })

  it("adds its inspection latency, blocked or allowed", async () => {
    const all = await frames(front({ ...off, latency: { mean: 5, cv: 0 }, managed: { core: true }, traffic: { attackSources: "scanner" }, rules: { attackMatch: 1 } }, [{ id: "users", settings: { rps: 50 } }, { id: "scanner", settings: { rps: 50 } }]), 10_000)
    expect(dist(all, "users", "latency", 1_000).p50).toBeCloseTo(15, 0)
    expect(dist(all, "waf", "latency", 1_000).p50).toBeGreaterThanOrEqual(5)
  })

  it("passes the protected resource's answers through unchanged", async () => {
    const failing = await frames(front(off, [{ id: "users", settings: { rps: 50 } }], { errorRate: 1 }), 10_000)
    expect(rate(failing, "users", "fail.Failed", 1_000)).toBeCloseTo(50, 0)
    const full = await frames(front(off, [{ id: "users", settings: { rps: 50 } }], { maxConcurrency: 1, latency: { mean: 100, cv: 0 } }), 10_000)
    expect(rate(full, "users", "fail.Unavailable", 1_000)).toBeGreaterThan(30)
  })

  it("with nothing behind it, the web ACL answers the requests it allows", async () => {
    const all = await frames(front(off, [{ id: "users", settings: { rps: 50 } }], {}, false), 5_000)
    expect(rate(all, "users", "ok", 1_000)).toBeCloseTo(50, 0)
  })

  it("with no inspection latency it answers at once, allowed, blocked or unwired", async () => {
    const instant = { ...off, latency: { mean: 0, cv: 0 }, rules: { customWcu: 10, match: 0.5 } }
    const wired = await frames(front(instant, [{ id: "users", settings: { rps: 100 } }]), 10_000)
    expect(rate(wired, "users", "ok", 1_000)).toBeCloseTo(50, -1)
    expect(rate(wired, "users", "fail.Rejected", 1_000)).toBeCloseTo(50, -1)
    expect(dist(wired, "users", "latency", 1_000).p50).toBeCloseTo(10, 0)
    const alone = await frames(front(instant, [{ id: "users", settings: { rps: 100 } }], {}, false), 10_000)
    expect(rate(alone, "users", "ok", 1_000) + rate(alone, "users", "fail.Rejected", 1_000)).toBeCloseTo(100, -1)
  })

  it("a caller that gives up takes nothing with it", () =>
    sim(front(off, [{ id: "users", settings: { rps: 50 }, edge: { timeout: "50 millis", retry: { maxAttempts: 1 } } }], { latency: { mean: 200, cv: 0 } }), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(5_000)
        expect(rate(all, "users", "fail.Timeout", 1_000)).toBeCloseTo(50, 0)
        yield* s.configureNode("users", { arrival: "constant", rps: 0 })
        yield* s.advanceTo(8_000)
        expect((yield* s.probe("waf")).inflight).toBe(0)
      })))

  it("plays out the same for the same seed", async () => {
    const design = front(minute({}, { managed: { core: true }, rules: { match: 0.1 } }), [{ id: "users", settings: { rps: 80, arrival: "poisson" } }, { id: "bot", settings: { rps: 100, hotKeys: 1, arrival: "poisson" } }])
    const once = await sim(design, (s) => Effect.flatMap(s.advanceTo(45_000), () => state(s, "waf")))
    const again = await sim(design, (s) => Effect.flatMap(s.advanceTo(45_000), () => state(s, "waf")))
    expect(again).toEqual(once)
    expect(once.blockedByRateRule).toBeGreaterThan(0)
    expect(once.blockedByRules).toBeGreaterThan(0)
  })

  it("reports its counts, capacity and gauges", () =>
    sim(front(minute({ scope: "write" }, { managed: { core: true, ipReputation: true } }), [{ id: "bot", settings: { rps: 100, hotKeys: 1 } }]), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(40_000)
        const st = yield* state(s, "waf")
        expect(st.wcu).toBe(700 + 25 + 2 + 2)
        expect(st.trackedSources).toBe(1)
        expect(st.allowed + st.blocked).toBe((yield* s.probe("waf")).totals.in)
        expect(st.blockedByRateRule).toBe(st.blocked)
        expect(st.busiestAddressCount).toBeGreaterThan(1_000)
        for (const g of ["rateLimitedAddresses", "busiestAddress", "blockedShare", "wcu"]) expect(all.at(-1)!.nodes.waf!.gauges[g]).toBeDefined()
      })))
})

describe("aws.waf: capacity and audit", () => {
  it("adds up the published capacities", () => {
    const c = capacityOf(decode({ rateRule: { scope: "write" }, managed: { core: true, knownBadInputs: true, ipReputation: true }, body: { blockOversize: true }, rules: { customWcu: 10 } }))
    expect(c).toEqual({ managed: 925, rateRule: 4, oversize: 1, custom: 10, total: 940 })
    expect(capacityOf(decode({ rateRule: { enabled: false } })).total).toBe(0)
  })

  const member = (settings: Bag, id = "waf") => ({ id, name: id, type: "aws.waf", config: decode(settings) })
  const codes = (members: ReadonlyArray<ReturnType<typeof member>>, region = "us-east-1", quotas: Bag = { wafWebAcls: 100, wafCloudFrontWebAcls: 100 }) =>
    audit(region, members, quotas).map((d) => `${d.level}:${d.code}`)
  const everyGroup = { core: true, knownBadInputs: true, adminProtection: true, sqlDatabase: true, linux: true, posix: true, windows: true, php: true, wordpress: true, ipReputation: true, anonymousIp: true, botControl: true }

  it("refuses a web ACL over 5,000 WCUs and notes one over the 1,500 the price includes", () => {
    expect(capacityOf(decode({ managed: everyGroup })).managed).toBe(2_025)
    expect(codes([member({ managed: everyGroup })])).toContain("info:waf-capacity-priced")
    expect(codes([member({ managed: everyGroup, rules: { customWcu: 3_000 } })])).toContain("error:waf-capacity-exceeded")
    expect(codes([member({ managed: { core: true } })])).toEqual([])
  })

  it("says where a CloudFront web ACL lives, and which settings a resource ignores", () => {
    expect(codes([member({ protects: "cloudfront" })], "eu-west-1")).toContain("warning:waf-cloudfront-region")
    expect(codes([member({ protects: "alb" })], "eu-west-1")).toEqual([])
    expect(codes([member({ protects: "alb", body: { inspectionLimit: "32" } })])).toContain("warning:waf-body-limit-fixed")
    expect(codes([member({ protects: "apigateway", failOpen: true })])).toContain("warning:waf-fail-open-alb")
    expect(codes([member({ protects: "cloudfront", requestRate: 50 })])).toContain("info:waf-request-rate-cloudfront")
    expect(codes([member({ traffic: { attackSources: "scanner" } })])).toContain("warning:waf-no-rules")
  })

  it("counts web ACLs against the account's quotas, regional and CloudFront apart", () => {
    const three = [member({ protects: "alb" }, "a"), member({ protects: "alb" }, "b"), member({ protects: "cloudfront" }, "c")]
    expect(codes(three, "us-east-1", { wafWebAcls: 2, wafCloudFrontWebAcls: 1 })).toEqual([])
    expect(codes(three, "us-east-1", { wafWebAcls: 1, wafCloudFrontWebAcls: 1 })).toEqual(["error:waf-web-acls-exceeded"])
  })

  it("a web ACL over its capacity is an error in the design", () => {
    const doc = front({ managed: everyGroup, rules: { customWcu: 3_000 } }, [{ id: "users" }])
    const found = Diagnostics.diagnose(doc, registry)
    expect(found.some((d) => d.code === "waf-capacity-exceeded" && d.level === "error" && d.node === "waf")).toBe(true)
    expect(Diagnostics.hasErrors(found)).toBe(true)
  })
})
