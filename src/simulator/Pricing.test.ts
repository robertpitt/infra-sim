import { describe, expect, it } from "vitest"
import { prices } from "./aws/pricing.ts"
import { catalog as regions } from "./aws/region/catalog.ts"
import * as Pricing from "./Pricing.ts"

/** A catalog by hand: Lambda-like tiers and free allowance, and a global service. */
const catalog = Pricing.decode({
  provider: "aws",
  currency: "USD",
  generated: "2026-10-12T00:00:00Z",
  disclaimer: "",
  services: {
    fn: {
      title: "Functions",
      sources: [],
      dimensions: {
        requests: { unit: "request", description: "", free: 1_000_000, regions: { "us-east-1": 0.0000002, "eu-west-1": 0.0000003 } },
        duration: { unit: "GB-second", description: "", regions: { "us-east-1": [[0, 3], [10, 2], [20, 1]] } }
      }
    },
    dns: { title: "DNS", sources: [], dimensions: { zone: { unit: "zone-month", description: "", regions: { global: 0.5 } } } }
  }
})

describe("Pricing", () => {
  it("finds a dimension's price in a region, and nothing where the catalog has none", () => {
    expect(Pricing.price(catalog, "fn", "eu-west-1", "requests")).toMatchObject({ unit: "request", currency: "USD", tiers: [[0, 0.0000003]], free: 1_000_000 })
    expect(Pricing.price(catalog, "fn", "eu-west-1", "duration")).toBeUndefined()
    expect(Pricing.price(catalog, "fn", "us-east-1", "nothing")).toBeUndefined()
    expect(Pricing.price(catalog, "nothing", "us-east-1", "requests")).toBeUndefined()
  })

  it("finds a global service's price from any region", () => {
    expect(Pricing.price(catalog, "dns", "ap-south-1", "zone")).toMatchObject({ region: "global", tiers: [[0, 0.5]] })
  })

  it("prices units through each tier in turn", () => {
    const p = Pricing.price(catalog, "fn", "us-east-1", "duration")!
    expect(Pricing.cost(p, 5)).toBe(15)
    // 10 at 3, 10 at 2, 5 at 1.
    expect(Pricing.cost(p, 25)).toBe(55)
    // Already 15 used this month: 5 more at 2, then 10 at 1.
    expect(Pricing.cost(p, 15, { used: 15 })).toBe(20)
    expect(Pricing.rate(p)).toBe(3)
  })

  it("takes the free allowance first, unless the account has none left", () => {
    const p = Pricing.price(catalog, "fn", "us-east-1", "requests")!
    expect(Pricing.cost(p, 1_000_000)).toBe(0)
    expect(Pricing.cost(p, 3_000_000)).toBeCloseTo(0.4, 10)
    expect(Pricing.cost(p, 1_000_000, { used: 500_000 })).toBeCloseTo(0.1, 10)
    expect(Pricing.cost(p, 1_000_000, { free: false })).toBeCloseTo(0.2, 10)
  })

  it("lists a service's regions and dimensions", () => {
    expect(Pricing.regionsOf(catalog, "fn")).toEqual(["eu-west-1", "us-east-1"])
    expect(Pricing.dimensionsOf(catalog, "fn")).toEqual(["duration", "requests"])
  })
})

describe("the AWS catalog in the repo (pricing/aws.json)", () => {
  const aws = prices()

  it("is one the simulator can read, in USD", () => {
    expect(aws.provider).toBe("aws")
    expect(aws.currency).toBe("USD")
    expect(Object.keys(aws.services).length).toBeGreaterThan(0)
  })

  it("has tiers from 0, ascending, with prices that are finite and not negative", () => {
    for (const [service, s] of Object.entries(aws.services)) {
      expect(s.sources.length, service).toBeGreaterThan(0)
      for (const [dimension, d] of Object.entries(s.dimensions)) {
        for (const [region, p] of Object.entries(d.regions)) {
          const tiers = typeof p === "number" ? [[0, p] as const] : p
          const where = `${service} ${dimension} ${region}`
          expect(tiers[0]?.[0], where).toBe(0)
          for (let i = 0; i < tiers.length; i++) {
            expect(Number.isFinite(tiers[i]![1]) && tiers[i]![1] >= 0, where).toBe(true)
            if (i > 0) expect(tiers[i]![0], where).toBeGreaterThan(tiers[i - 1]![0])
          }
        }
      }
    }
  })

  it("prices Lambda in every region the simulator has", () => {
    for (const r of regions) {
      expect(Pricing.price(aws, "lambda", r.id, "requests"), r.id).toBeDefined()
      expect(Pricing.price(aws, "lambda", r.id, "duration/arm64"), r.id).toBeDefined()
    }
  })
})
