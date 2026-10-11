import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { dist, frames, mean, sim } from "../../components/testing.ts"
import * as Design from "../../Design.ts"
import { registry } from "../../components/registry.ts"

interface Options {
  readonly nat?: Record<string, unknown>
  readonly load?: Record<string, unknown>
  readonly endpoint?: Record<string, unknown>
  readonly edge?: Record<string, unknown>
  readonly destinations?: number
}

/** Clients call a NAT gateway in a VPC, which calls external endpoints. */
const design = ({ nat = {}, load = {}, endpoint = {}, edge, destinations = 1 }: Options = {}) => {
  const b = Builder.make("nat", { seed: 5 })
  const box = b.add("aws.region", { id: "box" })
  const vpc = b.add("aws.vpc", { id: "vpc", parent: box })
  const gateway = b.add("aws.nat-gateway", { id: "nat", parent: vpc, settings: nat })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 100, ...load } })
  b.connect(web, gateway)
  for (let i = 0; i < destinations; i++) {
    const api = b.add("common.http-endpoint", { id: `api-${i}`, settings: { latency: { mean: 1_000, cv: 0 }, ...endpoint } })
    b.connect(gateway, api, { latency: { mean: 1, cv: 0 }, ...edge }, { id: `nat-api-${i}` })
  }
  return b.build()
}

const probe = (doc: Design.Doc, ms: number, id = "nat") =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const all = yield* s.advanceTo(ms)
      const p = yield* s.probe(id)
      return { all, state: p.state as Record<string, number> }
    }))

describe("aws.nat-gateway: connections", () => {
  it("passes calls to the destination behind it, adding only its own small latency", async () => {
    const all = await frames(design({ load: { rps: 20 }, endpoint: { latency: { mean: 100, cv: 0 } } }), 20_000)
    const latency = dist(all, "web", "latency", 5_000)
    // 100 ms at the endpoint, plus network each way (10 ms last mile + 1) and the gateway's assumed 0.3 ms.
    expect(latency.p50).toBeGreaterThan(110)
    expect(latency.p50).toBeLessThan(150)
    expect(mean(all, "nodes", "nat", "rates", "ErrorPortAllocation")).toBe(0)
  })

  it("holds one connection per call in flight and gives it back when the call ends", async () => {
    const { all, state } = await probe(design({ load: { rps: 50 } }), 20_000)
    // 50 calls per second, each open for about a second.
    expect(mean(all, "nodes", "nat", "gauges", "connections", 10_000)).toBeGreaterThan(40)
    expect(mean(all, "nodes", "nat", "gauges", "connections", 10_000)).toBeLessThan(65)
    expect(state.limit).toBe(55_000)
    expect(state.portAllocationErrors).toBe(0)
  })

  it("refuses new connections with a port allocation error once a destination's ports are used up", async () => {
    // 100 calls/s held for a second would need 100 connections; 10 per address leaves room for 10.
    const { all, state } = await probe(design({ nat: { connectionsPerDestination: 10 } }), 20_000)
    expect(state.limit).toBe(10)
    expect(mean(all, "nodes", "nat", "gauges", "connections", 5_000)).toBeLessThanOrEqual(10)
    expect(mean(all, "nodes", "nat", "rates", "ErrorPortAllocation", 5_000)).toBeGreaterThan(80)
    expect(mean(all, "nodes", "nat", "rates", "ok", 5_000)).toBeGreaterThan(6)
    expect(mean(all, "nodes", "nat", "rates", "ok", 5_000)).toBeLessThan(14)
    expect(mean(all, "nodes", "nat", "rates", "fail.Throttled", 5_000)).toBeGreaterThan(80)
    expect(state.portAllocationErrors).toBeGreaterThan(1_000)
  })

  it("each IPv4 address adds a full set of connections", async () => {
    const run = async (addresses: number) => {
      const { all } = await probe(design({ nat: { connectionsPerDestination: 10, addresses } }), 20_000)
      return mean(all, "nodes", "nat", "rates", "ok", 5_000)
    }
    const one = await run(1)
    const three = await run(3)
    expect(three / one).toBeGreaterThan(2.5)
    expect(three / one).toBeLessThan(3.5)
  })

  it("counts connections per destination: a second destination has ports of its own", async () => {
    const run = async (destinations: number) => {
      const { all } = await probe(design({ nat: { connectionsPerDestination: 10, routing: "parallel" }, destinations }), 20_000)
      return mean(all, "nodes", "nat", "gauges", "connections", 5_000)
    }
    expect(await run(1)).toBeLessThanOrEqual(10)
    // Two destinations, each at its own limit of 10.
    expect(await run(2)).toBeGreaterThan(15)
  })

  it("the quota-sized limit takes the real 55,000 per address by default and cannot be set above it", () => {
    const over = design({ nat: { connectionsPerDestination: 55_001 } })
    expect(Design.resolve(over, registry).diagnostics.map((d) => d.code)).toEqual(["bad-settings"])
    const tooMany = design({ nat: { addresses: 9 } })
    expect(Design.resolve(tooMany, registry).diagnostics.map((d) => d.code)).toEqual(["bad-settings"])
  })

  it("a call that is cancelled gives its connection back", async () => {
    // The caller gives up after 100 ms, long before the endpoint answers: the connection must not leak.
    const doc = design({ nat: { connectionsPerDestination: 1_000 }, load: { rps: 20 }, edge: { cancelOnTimeout: true } })
    const { state } = await probe(
      { ...doc, edges: { ...doc.edges, "web.out->nat": { ...doc.edges["web.out->nat"]!, settings: { timeout: "100 millis", cancelOnTimeout: true } } } },
      10_000
    )
    expect(state.connections).toBeLessThan(10)
  })

  it("survives an unwired gateway and an empty call", async () => {
    const b = Builder.make("empty", { seed: 1 })
    const box = b.add("aws.region", { id: "box" })
    const vpc = b.add("aws.vpc", { id: "vpc", parent: box })
    const gateway = b.add("aws.nat-gateway", { id: "nat", parent: vpc })
    const web = b.add("common.client", { id: "web", settings: { rps: 10, payload: 0.001 } })
    b.connect(web, gateway)
    const { state } = await probe(b.build(), 5_000)
    expect(state.connections).toBe(0)
    expect(state.portAllocationErrors).toBe(0)
  })
})

describe("aws.nat-gateway: bandwidth", () => {
  it("carries 5 Gbps by default and drops what is beyond it", async () => {
    // 20 requests a second of 100 MB each is 16 Gbps against a gateway holding 5.
    const { all, state } = await probe(design({ load: { rps: 20, payload: 100_000 }, endpoint: { latency: { mean: 10, cv: 0 } } }), 20_000)
    const ok = mean(all, "nodes", "nat", "rates", "ok", 5_000)
    expect(ok).toBeGreaterThan(4)
    expect(ok).toBeLessThan(9)
    expect(mean(all, "nodes", "nat", "rates", "drops", 5_000)).toBeGreaterThan(10)
    expect(state.drops).toBeGreaterThan(100)
  })

  it("scales to 100 Gbps when the gateway has", async () => {
    const { all } = await probe(design({ nat: { bandwidth: 100 }, load: { rps: 20, payload: 100_000 }, endpoint: { latency: { mean: 10, cv: 0 } } }), 20_000)
    expect(mean(all, "nodes", "nat", "rates", "drops", 5_000)).toBe(0)
  })

  it("a refused call is a Throttled failure, which the caller's retry policy can act on", async () => {
    const all = await frames(design({ load: { rps: 20, payload: 100_000 }, endpoint: { latency: { mean: 10, cv: 0 } } }), 15_000)
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 5_000)).toBeGreaterThan(10)
  })

  it("bandwidth limits are hard: below 5 or above 100 Gbps is rejected", () => {
    for (const bandwidth of [4, 101]) {
      expect(Design.resolve(design({ nat: { bandwidth } }), registry).diagnostics.map((d) => d.code)).toEqual(["bad-settings"])
    }
  })
})

describe("aws.nat-gateway: zones and faults", () => {
  it("fails everything routed through it when its zone fails, which is an outage on the gateway", async () => {
    const doc = design({ load: { rps: 20 }, endpoint: { latency: { mean: 50, cv: 0 } } })
    const all = await sim(doc, (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(5_000)
        yield* s.faults.inject({ kind: "node", id: "nat" }, { _tag: "Outage" })
        return [...before, ...(yield* s.advanceTo(15_000))]
      }))
    expect(mean(all, "nodes", "web", "rates", "ok", 1_000, 4_500)).toBeGreaterThan(15)
    expect(mean(all, "nodes", "web", "rates", "ok", 8_000)).toBe(0)
  })

  it("is the same simulation for the same seed", async () => {
    const run = async () => (await probe(design({ nat: { connectionsPerDestination: 10 } }), 10_000)).state
    expect(await run()).toEqual(await run())
  })
})
