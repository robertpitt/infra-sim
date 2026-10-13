import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { rate } from "../../../testing.ts"
import type { Frame } from "../../../Telemetry.ts"
import { domain, sim, stateAt, type State, writersAndReaders } from "../testing.ts"

/** Lose one zone of us-east-1 at 10 s; it comes back at 30 s. The domain's state at 10, 29 and 45 s, and every frame. */
const loseZone = (settings: Record<string, unknown>, zone = "us-east-1a", loads = writersAndReaders, placed?: string) =>
  sim(domain(settings, loads, 7, placed), (s) =>
    Effect.gen(function*() {
      const frames: Array<Frame> = [...(yield* s.advanceTo(10_000))]
      const at = (yield* s.probe("d")).state as State
      yield* s.faults.inject({ kind: "zone", id: `aws:us-east-1:${zone}` }, { _tag: "Outage" }, 20_000)
      frames.push(...(yield* s.advanceTo(29_000)))
      const lost = (yield* s.probe("d")).state as State
      frames.push(...(yield* s.advanceTo(45_000)))
      const back = (yield* s.probe("d")).state as State
      return { frames, at, lost, back }
    }))

describe("aws.opensearch: availability zones", () => {
  it("spreads the data nodes over the domain's zones, from the node's own", async () => {
    const three = await stateAt(domain({ availabilityZones: 3, dataNodes: 6, primaryShards: 6 }, []), 1_000)
    expect(three.perNode.map((n) => n.zone)).toEqual(["us-east-1a", "us-east-1b", "us-east-1c", "us-east-1a", "us-east-1b", "us-east-1c"])
    expect(three.zones).toEqual(["us-east-1a", "us-east-1b", "us-east-1c"])
    const one = await stateAt(domain({ dataNodes: 3 }, [], 7, "us-east-1d"), 1_000)
    expect(one.zones).toEqual(["us-east-1d"])
  })

  it("without zone awareness every node is in one zone: losing it loses the domain (red), until it returns", async () => {
    const { frames, lost, back } = await loseZone({ dataNodes: 3, primaryShards: 3, replicas: 1 })
    expect(lost.status).toBe("red")
    expect(lost.nodes.live).toBe(0)
    expect(lost.zonesDown).toEqual(["us-east-1a"])
    expect(rate(frames, "writers", "fail.Unavailable", 11_000, 29_000)).toBeCloseTo(300, -1)
    expect(rate(frames, "readers", "fail.Unavailable", 11_000, 29_000)).toBeCloseTo(50, 0)
    expect(back.status).toBe("green")
    expect(rate(frames, "writers", "fail", 32_000)).toBe(0)
    expect(rate(frames, "readers", "fail", 32_000)).toBe(0)
  })

  it("over three zones with a replica, losing one leaves a copy of every shard: yellow, and searches and writes go on", async () => {
    // Node 0 (us-east-1a) holds shard 0's primary: its writes wait 5 s for the replica's promotion.
    const settings = { availabilityZones: 3, dataNodes: 3, primaryShards: 3, replicas: 1, failover: { detection: "5 seconds" } }
    const { frames, lost, back } = await loseZone(settings)
    expect(lost.status).toBe("yellow")
    expect(lost.nodes.live).toBe(2)
    expect(lost.shards.promotions).toBe(1)
    expect(rate(frames, "readers", "fail", 11_000)).toBe(0)
    expect(lost.totals.partialSearches).toBe(0)
    expect(rate(frames, "writers", "fail", 11_000)).toBe(0)
    expect(rate(frames, "writers", "ok", 16_000, 29_000)).toBeCloseTo(300, -1)
    expect(back.status).toBe("green")
  })

  it("over three zones without replicas, the lost zone's shard is red: its writes fail after their timeout, searches are partial", async () => {
    const settings = { availabilityZones: 3, dataNodes: 3, primaryShards: 3, replicas: 0, indexing: { timeout: "5 seconds" } }
    const { frames, lost, back } = await loseZone(settings)
    expect(lost.status).toBe("red")
    expect(rate(frames, "writers", "fail.Unavailable", 16_000, 29_000)).toBeCloseTo(100, -1)
    expect(rate(frames, "writers", "ok", 16_000, 29_000)).toBeCloseTo(200, -1)
    expect(rate(frames, "d", "partialSearches", 11_000, 29_000)).toBeCloseTo(50, 0)
    expect(back.status).toBe("green")
  })

  it("places a shard's copies in different zones: over two zones, either one can go", async () => {
    // Four nodes over two zones, two shards with a replica each. Dealt out by node alone, shard 0's copies would both be
    // in us-east-1a (nodes 0 and 2); zone aware, each shard has a copy in each zone.
    const settings = { availabilityZones: 2, dataNodes: 4, primaryShards: 2, replicas: 1, failover: { detection: "5 seconds" } }
    for (const zone of ["us-east-1a", "us-east-1b"]) {
      const { frames, lost } = await loseZone(settings, zone)
      expect(lost.status).toBe("yellow")
      expect(lost.nodes.live).toBe(2)
      expect(rate(frames, "readers", "fail", 11_000)).toBe(0)
      expect(rate(frames, "writers", "fail", 11_000)).toBe(0)
    }
  })

  it("a zone the domain isn't in doesn't touch it", async () => {
    const { frames, lost } = await loseZone({ availabilityZones: 3 }, "us-east-1d")
    expect(lost.status).toBe("green")
    expect(rate(frames, "writers", "fail", 0)).toBe(0)
  })

  it("a domain placed in a zone lives there", async () => {
    const { lost } = await loseZone({ dataNodes: 3 }, "us-east-1c", writersAndReaders, "us-east-1c")
    expect(lost.nodes.live).toBe(0)
    const other = await loseZone({ dataNodes: 3 }, "us-east-1a", writersAndReaders, "us-east-1c")
    expect(other.lost.nodes.live).toBe(3)
  })
})
