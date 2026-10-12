import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { mean, sim } from "../../components/testing.ts"
import type { Frame } from "../../Telemetry.ts"

const gauge = (all: ReadonlyArray<Frame>, id: string, name: string, from = 0, to = Infinity) => mean(all, "nodes", id, "gauges", name, from, to)
const rate = (all: ReadonlyArray<Frame>, id: string, name: string, from = 0, to = Infinity) => mean(all, "nodes", id, "rates", name, from, to)
const minGauge = (all: ReadonlyArray<Frame>, id: string, name: string, from = 0, to = Infinity) =>
  Math.min(...all.filter((f) => f.t >= from && f.t <= to).map((f) => f.nodes[id]?.gauges[name] ?? Infinity))
const maxGauge = (all: ReadonlyArray<Frame>, id: string, name: string, from = 0, to = Infinity) =>
  Math.max(...all.filter((f) => f.t >= from && f.t <= to).map((f) => f.nodes[id]?.gauges[name] ?? -Infinity))

/** Launch timings that make the arithmetic easy: 10 + 10 + 20 + 10 = 50 s from scratch. */
const QUICK = { pending: "10 seconds", boot: "10 seconds", userData: "20 seconds", appStart: "10 seconds" }
const BIG_QUOTA = { ec2OnDemandStandardVcpus: 10_000, ec2SpotStandardVcpus: 10_000 }

interface Probe {
  readonly inService: number
  readonly pending: number
  readonly onDemand: number
  readonly spot: number
  readonly vcpus: number
  readonly launched: number
  readonly warmStarts: number
  readonly refusedLaunches: number
  readonly replaced: number
  readonly spotInterruptions: number
  readonly lost: number
  readonly errors: number
  readonly warmPool: { readonly ready: number; readonly preparing: number; readonly target: number }
  readonly instances: ReadonlyArray<{ readonly name: string; readonly zone?: string; readonly state: string; readonly purchase: string; readonly start: string; readonly broken: boolean }>
}

/** What every group in these tests has unless it says otherwise: 50 ms a request, no downstream, quick launches. */
const DEFAULTS = { serviceTime: { mean: 50, cv: 0 }, fanOut: "none", launch: QUICK }

/** A client calling a group directly (a plain edge: the fleet's idealised balancer). */
const group = (settings: Record<string, unknown>, options: { rps?: number; account?: Record<string, unknown>; seed?: number } = {}) => {
  const b = Builder.make("asg", { seed: options.seed ?? 5 })
  const web = b.add("common.client", { id: "web", settings: { rps: options.rps ?? 40, arrival: "constant" } })
  const asg = b.add("aws.ec2", { id: "asg", settings: { ...DEFAULTS, ...settings } })
  b.connect(web, asg, { timeout: "1 minute" })
  b.account("aws:us-east-1", options.account ?? BIG_QUOTA)
  return b.build()
}

const run = (doc: ReturnType<typeof group>, steps: ReadonlyArray<readonly [at: number, settings: Record<string, unknown>]>, until: number) =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const all: Array<Frame> = []
      for (const [at, settings] of steps) {
        all.push(...(yield* s.advanceTo(at)))
        // A live edit replaces the node's overrides, so it restates the defaults.
        yield* s.configureNode("asg", { ...DEFAULTS, ...settings })
      }
      all.push(...(yield* s.advanceTo(until)))
      return { all, probe: (yield* s.probe("asg")).state as Probe }
    }))

describe("aws.ec2: instances take minutes to launch", () => {
  it("starts with its desired capacity in service, spread over its zones", async () => {
    const { all, probe } = await run(group({ desiredCapacity: 5, availabilityZones: 3 }), [], 5_000)
    expect(gauge(all, "asg", "inService")).toBe(5)
    expect([gauge(all, "asg", "inService.us-east-1a"), gauge(all, "asg", "inService.us-east-1b"), gauge(all, "asg", "inService.us-east-1c")]).toEqual([2, 2, 1])
    expect(probe.instances.every((i) => i.start === "initial" && i.purchase === "onDemand")).toBe(true)
  })

  it("a new instance serves only after pending, boot, user data and application start", async () => {
    const base = { desiredCapacity: 2 }
    const { all, probe } = await run(group(base), [[10_000, { ...base, desiredCapacity: 4 }]], 90_000)
    // 50 s of launch: in service from 60 s.
    expect(gauge(all, "asg", "inService", 10_500, 59_500)).toBe(2)
    expect(gauge(all, "asg", "pending", 10_500, 59_500)).toBe(2)
    expect(gauge(all, "asg", "inService", 60_500)).toBe(4)
    expect(probe.instances.filter((i) => i.start === "cold")).toHaveLength(2)
  })

  it("an instance's vCPUs are its workers: CPU is busy workers over them", async () => {
    // 40 requests a second for 50 ms is 2 busy workers. Two m7i.large (2 vCPUs each): 50%. Two c7i.xlarge (4 each): 25%.
    const cpu = async (instanceType: string) => gauge((await run(group({ desiredCapacity: 2, instanceType }), [], 30_000)).all, "asg", "cpu", 5_000)
    expect(await cpu("m7i.large")).toBeCloseTo(0.5, 1)
    expect(await cpu("c7i.xlarge")).toBeCloseTo(0.25, 1)
    // Two requests per vCPU double the workers.
    expect(gauge((await run(group({ desiredCapacity: 2, requestsPerVcpu: 2 }), [], 30_000)).all, "asg", "cpu", 5_000)).toBeCloseTo(0.25, 1)
  })

  it("cpuTotal is the warmed instances' average times the instances in service: what a 50% target asks for", async () => {
    // 80 requests a second for 50 ms on 4 m7i.large: 4 busy vCPUs of 8, 50% each, 2 instances' worth.
    const { all } = await run(group({ desiredCapacity: 4 }, { rps: 80 }), [], 30_000)
    expect(gauge(all, "asg", "cpuTotal", 5_000)).toBeCloseTo(2, 0)
  })

  it("leaves instances in their warmup out of the CPU average", async () => {
    // Through a target group with a 2-minute slow start, two new instances take a growing share of the load while the
    // two old ones carry the rest. Their warmup (3 minutes) keeps them out of the average, so it shows the old ones, hotter
    // than the group as a whole; once warmed up, every instance counts and the two agree.
    const b = Builder.make("warmup", { seed: 3 })
    const web = b.add("common.client", { id: "web", settings: { rps: 80, arrival: "constant" } })
    const settings = { ...DEFAULTS, desiredCapacity: 2, launch: { pending: 0, boot: 0, userData: 0, appStart: 0 }, healthCheckGracePeriod: 0, defaultInstanceWarmup: "180 seconds" }
    const asg = b.add("aws.ec2", { id: "asg", settings })
    b.connect(web, asg, { timeout: "10 seconds", slowStart: "120 seconds" }, { connector: "core.target-group" })
    b.account("aws:us-east-1", BIG_QUOTA)
    const all = await sim(b.build(), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(10_000)
        yield* s.configureNode("asg", { ...settings, desiredCapacity: 4 })
        return [...before, ...(yield* s.advanceTo(300_000))]
      }))
    expect(gauge(all, "asg", "cpu", 40_000, 120_000)).toBeGreaterThan(gauge(all, "asg", "utilization", 40_000, 120_000) + 0.08)
    expect(Math.abs(gauge(all, "asg", "cpu", 200_000) - gauge(all, "asg", "utilization", 200_000))).toBeLessThan(0.03)
    expect(gauge(all, "asg", "cpu", 200_000)).toBeCloseTo(0.5, 1)
  })

  it("counts requests over the last minute, in total and per instance serving", async () => {
    const { all } = await run(group({ desiredCapacity: 4 }, { rps: 50 }), [], 120_000)
    // The trailing minute is the current second and the 59 before it.
    expect(Math.abs(gauge(all, "asg", "requestCount", 70_000) - 3_000)).toBeLessThan(60)
    expect(Math.abs(gauge(all, "asg", "requestCountPerTarget", 70_000) - 750)).toBeLessThan(15)
  })
})

describe("aws.ec2: the account's vCPU quotas", () => {
  it("launches past the On-Demand quota fail and wait; AWS's default of 5 vCPUs runs two m7i.large", async () => {
    const doc = group({ desiredCapacity: 4 }, { account: {} })
    const { probe } = await run(doc, [], 60_000)
    expect(probe.inService).toBe(2)
    expect(probe.pending).toBe(2)
    expect(probe.vcpus).toBe(4)
    expect(probe.refusedLaunches).toBeGreaterThan(0)
  })

  it("starts the waiting launches once the quota is raised", () =>
    sim(group({ desiredCapacity: 4 }, { account: {} }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(30_000)
        yield* s.configureAccount("aws:us-east-1", { ec2OnDemandStandardVcpus: 8 })
        const all = yield* s.advanceTo(100_000)
        // Raised at 30 s: the two waiting launches go at once and are in service 50 s later.
        expect(gauge(all, "asg", "inService", 81_000)).toBe(4)
        expect(gauge(all, "asg", "vcpus", 81_000)).toBe(8)
      })))

  it("two groups in a region share the quota", async () => {
    const b = Builder.make("two", { seed: 1 })
    const web = b.add("common.client", { id: "web", settings: { rps: 10 } })
    const a = b.add("aws.ec2", { id: "a", settings: { desiredCapacity: 3, minSize: 0, fanOut: "none" } })
    const c = b.add("aws.ec2", { id: "c", settings: { desiredCapacity: 3, minSize: 0, fanOut: "none" } })
    b.connect(web, a)
    b.connect(web, c)
    b.account("aws:us-east-1", { ec2OnDemandStandardVcpus: 10 })
    const [pa, pc] = await sim(b.build(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        return [(yield* s.probe("a")).state as Probe, (yield* s.probe("c")).state as Probe]
      }))
    // 10 vCPUs is five m7i.large between them.
    expect(pa!.inService + pc!.inService).toBe(5)
    expect(pa!.vcpus + pc!.vcpus).toBe(10)
  })
})

describe("aws.ec2: warm pools", () => {
  const scaleOut = (warmPool: Record<string, unknown>) => {
    const base = { desiredCapacity: 2, maxSize: 6, warmPool }
    return run(group(base), [[10_000, { ...base, desiredCapacity: 6 }]], 80_000)
  }

  it("a stopped pool instance skips user data: in service in 30 s instead of 50", async () => {
    const { all, probe } = await scaleOut({ enabled: true, poolState: "Stopped" })
    // The pool holds MaxSize minus desired: four, ready at the start.
    expect(gauge(all, "asg", "warm", 0, 9_000)).toBe(4)
    expect(gauge(all, "asg", "inService", 10_500, 39_500)).toBe(2)
    expect(gauge(all, "asg", "inService", 40_500)).toBe(6)
    expect(probe.warmStarts).toBe(4)
    // With the group at its maximum, the pool's target is zero: nothing to replace.
    expect(probe.warmPool.target).toBe(0)
  })

  it("a running pool instance is in service at once, and holds its vCPUs while it waits", async () => {
    const { all } = await scaleOut({ enabled: true, poolState: "Running" })
    expect(gauge(all, "asg", "vcpus", 0, 9_000)).toBe(12)
    expect(gauge(all, "asg", "inService", 10_500)).toBe(6)
  })

  it("an empty pool means a cold start", async () => {
    const { all, probe } = await scaleOut({ enabled: true, maxGroupPreparedCapacity: 4 })
    // Prepared capacity 4 minus desired 2: two in the pool. Two warm starts (30 s), two cold (50 s).
    expect(gauge(all, "asg", "inService", 41_000, 59_000)).toBe(4)
    expect(gauge(all, "asg", "inService", 61_000)).toBe(6)
    expect(probe.warmStarts).toBe(2)
  })

  it("refills the pool after a scale-in, launching into it from scratch", async () => {
    const base = { desiredCapacity: 4, maxSize: 6, warmPool: { enabled: true } }
    const { all } = await run(group(base), [[10_000, { ...base, desiredCapacity: 2 }]], 80_000)
    expect(gauge(all, "asg", "warm", 0, 9_000)).toBe(2)
    expect(gauge(all, "asg", "warmPreparing", 11_000, 59_000)).toBe(2)
    expect(gauge(all, "asg", "warm", 61_000)).toBe(4)
  })
})

describe("aws.ec2: Spot", () => {
  it("splits the group as AWS does: the On-Demand base, then a share of the rest rounded up for On-Demand", async () => {
    const { probe } = await run(group({ desiredCapacity: 5, spot: { onDemandBaseCapacity: 1, onDemandPercentageAboveBase: 50 } }), [], 5_000)
    // 1 + ceil(4 × 50%) = 3 On-Demand, 2 Spot.
    expect([probe.onDemand, probe.spot]).toEqual([3, 2])
  })

  it("keeps the split when it scales out", async () => {
    const base = { desiredCapacity: 4, maxSize: 20, spot: { onDemandBaseCapacity: 0, onDemandPercentageAboveBase: 25 } }
    const { probe } = await run(group(base), [[10_000, { ...base, desiredCapacity: 10 }]], 70_000)
    // ceil(10 × 25%) = 3 On-Demand, 7 Spot.
    expect([probe.onDemand, probe.spot]).toEqual([3, 7])
  })

  it("counts Spot vCPUs against the Spot quota, not the On-Demand one", async () => {
    const { probe } = await run(group({ desiredCapacity: 4, spot: { onDemandPercentageAboveBase: 0 } }, { account: { ec2OnDemandStandardVcpus: 0, ec2SpotStandardVcpus: 6 } }), [], 10_000)
    expect(probe.spot).toBe(3)
    expect(probe.onDemand).toBe(0)
  })

  it("without Spot capacity it keeps retrying Spot and never falls back to On-Demand", async () => {
    const base = { desiredCapacity: 2, maxSize: 10, spot: { onDemandPercentageAboveBase: 0, insufficientCapacity: 1 } }
    const { probe } = await run(group(base), [[5_000, { ...base, desiredCapacity: 4 }]], 120_000)
    expect(probe.spot).toBe(2)
    expect(probe.onDemand).toBe(0)
    expect(probe.pending).toBe(2)
    expect(probe.refusedLaunches).toBeGreaterThan(3)
  })

  const storm = (capacityRebalance: boolean) =>
    run(
      group({ desiredCapacity: 6, maxSize: 10, spot: { onDemandPercentageAboveBase: 0, interruptionsPerHour: 2, capacityRebalance, rebalanceLead: "2 minutes" } }, { rps: 60, seed: 11 }),
      [],
      1_800_000
    )

  it("interrupts Spot instances at the rate set, each terminated two minutes after its notice", async () => {
    const { all, probe } = await storm(false)
    // Six instances at two an hour each for half an hour: about six interruptions.
    expect(probe.spotInterruptions).toBeGreaterThan(2)
    expect(probe.spotInterruptions).toBeLessThan(13)
    // Without Capacity Rebalancing the replacement launches only when the old one is terminated, so the group is short
    // for a launch time (50 s) after every interruption.
    expect(minGauge(all, "asg", "inService", 60_000)).toBeLessThan(6)
    expect(probe.launched).toBeGreaterThanOrEqual(6 + probe.spotInterruptions - 1)
  })

  it("with Capacity Rebalancing replaces at-risk instances before they are interrupted, so the group is never short", async () => {
    const { all, probe } = await storm(true)
    expect(probe.spotInterruptions).toBeGreaterThan(2)
    // The replacement launches on the recommendation (2 minutes before the notice) and is up 50 s later; the at-risk
    // instance is then terminated, well before the interruption.
    expect(minGauge(all, "asg", "inService", 1_000)).toBe(6)
    expect(maxGauge(all, "asg", "inService")).toBeLessThanOrEqual(7)
    expect(probe.lost).toBe(0)
  })
})

describe("aws.ec2: termination policies and scale-in protection", () => {
  const scaleOutThenIn = (settings: Record<string, unknown>) => {
    const base = { desiredCapacity: 2, maxSize: 10, availabilityZones: 1, ...settings }
    return run(group(base), [[10_000, { ...base, desiredCapacity: 4 }], [120_000, { ...base, desiredCapacity: 2 }]], 200_000)
  }
  const survivors = (probe: Probe) => probe.instances.filter((i) => i.state === "inService" || i.state === "grace").map((i) => i.name)

  it("OldestInstance terminates the instances there at the start, NewestInstance the ones it just launched", async () => {
    expect(survivors((await scaleOutThenIn({ terminationPolicy: "OldestInstance" })).probe)).toEqual(["i-3", "i-4"])
    expect(survivors((await scaleOutThenIn({ terminationPolicy: "NewestInstance" })).probe)).toEqual(["i-1", "i-2"])
  })

  it("Default terminates the instances closest to their next billing hour", async () => {
    // At 120 s the first two have run 120 s of their hour, the new two 110 s: the first two are closer to the next.
    expect(survivors((await scaleOutThenIn({ terminationPolicy: "Default" })).probe)).toEqual(["i-3", "i-4"])
  })

  it("Default terminates the purchase option out of proportion first", async () => {
    const base = { desiredCapacity: 4, maxSize: 10, availabilityZones: 1, spot: { onDemandPercentageAboveBase: 50 } }
    // Four: two On-Demand, two Spot. Lower the On-Demand share, then scale in by two: the On-Demand ones go.
    const { probe } = await run(group(base), [[10_000, { ...base, desiredCapacity: 2, spot: { onDemandPercentageAboveBase: 0 } }]], 60_000)
    expect([probe.onDemand, probe.spot]).toEqual([0, 2])
  })

  it("instances launched with scale-in protection stay when the desired capacity drops", async () => {
    const base = { desiredCapacity: 2, maxSize: 10, scaleInProtection: true }
    const { probe } = await run(group(base), [[10_000, { ...base, desiredCapacity: 4 }], [120_000, { ...base, desiredCapacity: 1, minSize: 1 }]], 200_000)
    // The two there at the start aren't protected and go; the two launched with protection stay.
    expect(survivors(probe)).toEqual(["i-3", "i-4"])
  })
})

describe("aws.ec2: Availability Zones and health checks", () => {
  it("loses a zone's instances, replaces them in the other zones once status checks notice, and rebalances after", () =>
    sim(group({ desiredCapacity: 6, availabilityZones: 3, statusCheckReplace: "60 seconds" }, { rps: 60 }), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(20_000)
        yield* s.faults.inject({ kind: "zone", id: "aws:us-east-1:us-east-1a" }, { _tag: "Outage" }, 300_000)
        const all = [...before, ...(yield* s.advanceTo(600_000))]
        const zones = (from: number, to: number) => ["a", "b", "c"].map((z) => gauge(all, "asg", `inService.us-east-1${z}`, from, to))
        expect(zones(0, 19_000)).toEqual([2, 2, 2])
        expect(gauge(all, "asg", "inService", 21_000, 79_000)).toBe(4)
        // Noticed after 60 s, replaced in b and c 50 s later.
        expect(zones(131_000, 319_000)).toEqual([0, 3, 3])
        // Zone a is back at 320 s: one launched there before one of b's goes, then the same for c.
        expect(zones(500_000, 600_000)).toEqual([2, 2, 2])
        expect(minGauge(all, "asg", "inService", 131_000)).toBe(6)
        const probe = (yield* s.probe("asg")).state as Probe
        expect(probe.replaced).toBe(2)
      })))

  /** Clients → the group through a target group (checks every 10 s, two failures to be unhealthy). */
  const balanced = (settings: Record<string, unknown>) => {
    const b = Builder.make("tg", { seed: 2 })
    const web = b.add("common.client", { id: "web", settings: { rps: 40, arrival: "constant" } })
    const asg = b.add("aws.ec2", { id: "asg", settings: { serviceTime: { mean: 50, cv: 0 }, fanOut: "none", launch: QUICK, healthCheckGracePeriod: 0, ...settings } })
    b.connect(web, asg, { timeout: "10 seconds", healthCheck: { interval: "10 seconds", unhealthyThreshold: 2 } }, { connector: "core.target-group", id: "tg" })
    b.account("aws:us-east-1", BIG_QUOTA)
    return b.build()
  }

  it("with ELB health checks replaces instances whose application is broken, again and again", async () => {
    const base = { desiredCapacity: 2, maxSize: 10, healthCheckType: "ELB", healthCheckGracePeriod: 0 }
    const { probe } = await run(balanced(base), [[5_000, { ...base, desiredCapacity: 4, brokenLaunches: 1 }]], 400_000)
    // Each broken instance is up after 50 s, found unhealthy 20 s later, replaced by another broken one: about every
    // 70 s, twice over, in 400 s.
    expect(probe.launched).toBeGreaterThan(8)
    expect(probe.replaced).toBeGreaterThan(6)
    expect(probe.inService).toBeLessThanOrEqual(4)
  })

  it("with EC2 health checks keeps them: the load balancer stops sending them requests, but they stay", async () => {
    const base = { desiredCapacity: 2, maxSize: 10, healthCheckType: "EC2", healthCheckGracePeriod: 0 }
    const { probe } = await run(balanced(base), [[5_000, { ...base, desiredCapacity: 4, brokenLaunches: 1 }]], 400_000)
    expect(probe.launched).toBe(4)
    expect(probe.replaced).toBe(0)
    expect(probe.instances.filter((i) => i.broken)).toHaveLength(2)
  })

  it("an instance found dead during its grace period is replaced when the grace period ends", () =>
    sim(group({ desiredCapacity: 3, availabilityZones: 3, healthCheckGracePeriod: "200 seconds", statusCheckReplace: "30 seconds" }), (s) =>
      Effect.gen(function*() {
        yield* s.configureNode("asg", { ...DEFAULTS, desiredCapacity: 6, availabilityZones: 3, healthCheckGracePeriod: "200 seconds", statusCheckReplace: "30 seconds" })
        // Three new instances are up at 50 s and in their grace period until 250 s. Zone a fails at 60 s.
        yield* s.advanceTo(60_000)
        yield* s.faults.inject({ kind: "zone", id: "aws:us-east-1:us-east-1a" }, { _tag: "Outage" })
        yield* s.advanceTo(120_000)
        // The old instance in zone a is noticed after 30 s and replaced; the new one there waits for its grace to end.
        expect(((yield* s.probe("asg")).state as Probe).replaced).toBe(1)
        yield* s.advanceTo(260_000)
        expect(((yield* s.probe("asg")).state as Probe).replaced).toBe(2)
      })))
})
