import { describe, expect, it } from "vitest"
import * as Limiter from "../../Limiter.ts"
import { audit } from "./audit.ts"
import { makeAuthorizerCache, Verdict } from "./authorizer.ts"
import { makeResponseCache } from "./cache.ts"
import type { Plan } from "./plan.ts"
import { Admit, makeThrottle } from "./throttle.ts"
import { apiGatewayBurst, apiGatewayRate } from "./quotas.ts"

const DAY = 24 * 60 * 60 * 1000

const plan = (over: Partial<Plan> = {}): Plan => ({
  rest: true,
  integrationTimeoutMs: 29_000,
  account: { rate: 1_000_000, burst: 1_000_000 },
  stage: undefined,
  routes: 1,
  usagePlan: undefined,
  authorizer: undefined,
  cache: undefined,
  ...over
})

describe("usage plan quota windows", () => {
  it("count per client, stop at the limit, and start again when the period turns", () => {
    let t = 0
    const throttle = makeThrottle({ id: "api", limiter: Limiter.makeWith(() => t), now: () => t, accountKey: "acct" })
    const p = plan({ usagePlan: { clients: 2, bucket: undefined, quota: 3, periodMs: DAY } })
    const key = 0.37
    const results = [1, 2, 3, 4, 5].map(() => throttle.admit(p, key))
    expect(results).toEqual([Admit.Admitted, Admit.Admitted, Admit.Admitted, Admit.Quota, Admit.Quota])
    t = DAY - 1
    expect(throttle.admit(p, key)).toBe(Admit.Quota)
    t = DAY
    expect(throttle.admit(p, key)).toBe(Admit.Admitted)
  })

  it("a different key is a different client with its own count", () => {
    const throttle = makeThrottle({ id: "api", limiter: Limiter.makeWith(() => 0), now: () => 0, accountKey: "acct" })
    const p = plan({ usagePlan: { clients: 1000, bucket: undefined, quota: 1, periodMs: DAY } })
    const admitted = Array.from({ length: 200 }, (_, i) => throttle.admit(p, (i + 0.5) / 200)).filter((a) => a === Admit.Admitted).length
    // Two hundred distinct keys over a thousand clients: nearly all are the first request of their client.
    expect(admitted).toBeGreaterThan(150)
  })

  it("the stage bucket is per route and the account bucket is last", () => {
    const throttle = makeThrottle({ id: "api", limiter: Limiter.makeWith(() => 0), now: () => 0, accountKey: "acct" })
    const p = plan({ stage: { rate: 1, burst: 2 }, routes: 1, account: { rate: 1, burst: 3 } })
    const results = [0, 0, 0, 0].map(() => throttle.admit(p, 0.5))
    // Two stage tokens, then the stage says no before the account is asked.
    expect(results).toEqual([Admit.Admitted, Admit.Admitted, Admit.Stage, Admit.Stage])
    expect(throttle.accountLevel(p)).toBe(1)
  })
})

describe("authorizer and response caches", () => {
  it("an authorizer verdict is cached until its expiry, per identity", () => {
    const cache = makeAuthorizerCache()
    expect(cache.lookup(3, 0, 10)).toBe(Verdict.Unknown)
    cache.store(3, Verdict.Deny, 5_000, 10)
    expect(cache.lookup(3, 4_999, 10)).toBe(Verdict.Deny)
    expect(cache.lookup(3, 5_000, 10)).toBe(Verdict.Unknown)
    expect(cache.lookup(4, 0, 10)).toBe(Verdict.Unknown)
    // More identities than before (a live edit) keeps what was stored.
    cache.store(3, Verdict.Allow, 9_000, 10)
    expect(cache.lookup(3, 1, 10_000)).toBe(Verdict.Allow)
  })

  it("the response cache evicts the oldest entry when full and never grows past its capacity", () => {
    const cache = makeResponseCache()
    for (let i = 0; i < 100; i++) cache.put(i, 1_000, 5)
    expect(cache.size()).toBe(5)
    expect(cache.has(99, 0)).toBe(true)
    expect(cache.has(94, 0)).toBe(false)
    expect(cache.has(95, 0)).toBe(true)
    // Expired entries are not served.
    expect(cache.has(95, 1_000)).toBe(false)
    cache.flush()
    expect(cache.size()).toBe(0)
  })
})

describe("account quotas", () => {
  it("uses 2,500 / 1,250 in the smaller regions and 10,000 / 5,000 elsewhere", () => {
    for (const r of ["af-south-1", "eu-south-1", "ap-southeast-3", "ap-south-2", "ap-southeast-4", "eu-south-2", "eu-central-2", "il-central-1", "ca-west-1", "ap-southeast-5", "ap-southeast-7", "mx-central-1"]) {
      expect([apiGatewayRate(r), apiGatewayBurst(r)]).toEqual([2_500, 1_250])
    }
    for (const r of ["us-east-1", "eu-west-1", "ap-northeast-1", "sa-east-1"]) expect([apiGatewayRate(r), apiGatewayBurst(r)]).toEqual([10_000, 5_000])
  })
})

describe("audit", () => {
  const quotas = { apiGatewayRate: 1_000, apiGatewayIntegrationTimeout: 29_000 }
  const gw = (config: Record<string, unknown>) => ({
    id: "api",
    name: "API",
    type: "aws.apigateway",
    config: {
      apiType: "rest",
      endpoint: "regional",
      integrationTimeout: 29_000,
      stageThrottle: { rate: 0, burst: 0 },
      usagePlan: { enabled: false, rate: 0 },
      cache: { enabled: false, responseSize: 10 },
      authorizer: { type: "none" },
      ...config
    }
  })
  // Durations are Durations in decoded settings; the audit reads them with Duration.toMillis, which accepts millis too.
  const codes = (member: ReturnType<typeof gw>, q = quotas) => audit("us-east-1", [member], q).map((d) => d.code)

  it("is quiet for a plain API", () => {
    expect(codes(gw({}))).toEqual([])
  })

  it("warns when a stage limit is above the account's, which wins", () => {
    expect(codes(gw({ stageThrottle: { rate: 5_000, burst: 0 } }))).toContain("apigateway-stage-above-account")
    expect(codes(gw({ stageThrottle: { rate: 0, burst: 9_000 } }))).toContain("apigateway-burst-above-account")
  })

  it("warns when the timeout is longer than the API type allows", () => {
    expect(codes(gw({ integrationTimeout: 40_000 }))).toContain("apigateway-timeout-capped")
    expect(codes(gw({ apiType: "http", integrationTimeout: 40_000 }))).toContain("apigateway-timeout-capped")
    expect(codes(gw({ apiType: "http", integrationTimeout: 30_000 }))).toEqual([])
    expect(codes(gw({ integrationTimeout: 40_000 }), { ...quotas, apiGatewayIntegrationTimeout: 60_000 })).toContain("apigateway-timeout-quota-raised")
  })

  it("warns about settings the API type ignores", () => {
    expect(codes(gw({ apiType: "http", cache: { enabled: true, responseSize: 10 } }))).toContain("apigateway-cache-http")
    expect(codes(gw({ apiType: "http", usagePlan: { enabled: true, rate: 1 } }))).toContain("apigateway-usage-plan-http")
    expect(codes(gw({ cache: { enabled: true, responseSize: 2_000 } }))).toContain("apigateway-cache-response-size")
  })
})
