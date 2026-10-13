import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../../Builder.ts"
import { registry } from "../../../components/Builtins.ts"
import { sim } from "../../../testing.ts"
import { diagnose } from "../../../Diagnostics.ts"
import type { Unit } from "../../../Protocol.ts"
import { audit } from "../Audit.ts"
import { Config, type Settings } from "../internal/config.ts"
import { INSTANCE_TYPE_NAMES, instanceType, INSTANCE_TYPES } from "../InstanceTypes.ts"
import { onDemandOf } from "../internal/spot.ts"
import { pick } from "../internal/termination.ts"


const settings = (over: Record<string, unknown> = {}): Settings => Schema.decodeUnknownSync(Config)(over)

describe("aws.ec2: the instance type catalog", () => {
  it("has the vCPUs and memory AWS's Instance Types guide lists", () => {
    const spec = (name: string) => [instanceType(name).vcpus, instanceType(name).memoryGiB]
    expect(spec("t3.nano")).toEqual([2, 0.5])
    expect(spec("t3.medium")).toEqual([2, 4])
    expect(spec("t3.2xlarge")).toEqual([8, 32])
    expect(spec("m5.large")).toEqual([2, 8])
    expect(spec("m5.24xlarge")).toEqual([96, 384])
    expect(spec("m6i.32xlarge")).toEqual([128, 512])
    expect(spec("m7i.48xlarge")).toEqual([192, 768])
    expect(spec("m7g.medium")).toEqual([1, 4])
    expect(spec("c6i.large")).toEqual([2, 4])
    expect(spec("c7i.48xlarge")).toEqual([192, 384])
    expect(spec("c7g.16xlarge")).toEqual([64, 128])
    expect(spec("r6i.large")).toEqual([2, 16])
    expect(spec("r6i.32xlarge")).toEqual([128, 1024])
  })

  it("names each type once, marks Graviton as arm64 and T3 as burstable, and falls back to the default for an unknown name", () => {
    expect(new Set(INSTANCE_TYPE_NAMES).size).toBe(INSTANCE_TYPES.length)
    expect(instanceType("c7g.large").architecture).toBe("arm64")
    expect(instanceType("t3.micro").burstable).toBe(true)
    expect(instanceType("m7i.large").burstable).toBe(false)
    expect(instanceType("x9.huge").name).toBe("m7i.large")
  })
})

describe("aws.ec2: the On-Demand and Spot split", () => {
  it("matches the examples in AWS's mixed instances guide", () => {
    // Base 10, 50/50 above it: 10, 15, 20, 25 On-Demand at 10, 20, 30, 40 instances.
    expect([10, 20, 30, 40].map((n) => onDemandOf(n, 10, 50))).toEqual([10, 15, 20, 25])
    // Base 0, 60/40: 6, 12, 18, 24.
    expect([10, 20, 30, 40].map((n) => onDemandOf(n, 0, 60))).toEqual([6, 12, 18, 24])
    // Base 12, all Spot above it: 10, 12, 12, 12.
    expect([10, 20, 30, 40].map((n) => onDemandOf(n, 12, 0))).toEqual([10, 12, 12, 12])
    // A fraction rounds up in favour of On-Demand: 3 above the base at 50% is 2.
    expect(onDemandOf(3, 0, 50)).toBe(2)
  })
})

describe("aws.ec2: termination policy", () => {
  const unit = (id: number): Unit => ({ id, name: `i-${id}`, zone: undefined, state: "inService", since: 0 })
  const units = [unit(1), unit(2), unit(3)]
  const launched = new Map([
    [1, { purchase: "onDemand" as const, launchedAt: 0 }],
    [2, { purchase: "spot" as const, launchedAt: 1_000_000 }],
    [3, { purchase: "spot" as const, launchedAt: 2_000_000 }]
  ])
  const info = (u: Unit) => launched.get(u.id)
  const choose = (over: Record<string, unknown>, now: number) => pick(settings(over), units, info, { onDemand: 1, total: 3 }, now)?.name

  it("ClosestToNextInstanceHour picks the instance furthest into its billing hour", () => {
    // At 3,500 s: i-1 is 3,500 s into its hour, i-2 2,500 s, i-3 1,500 s.
    expect(choose({ terminationPolicy: "ClosestToNextInstanceHour" }, 3_500_000)).toBe("i-1")
    // At 3,700 s: i-1 is only 100 s into its second hour; i-2 is furthest (2,700 s).
    expect(choose({ terminationPolicy: "ClosestToNextInstanceHour" }, 3_700_000)).toBe("i-2")
  })

  it("OldestInstance and NewestInstance go by launch time", () => {
    expect(choose({ terminationPolicy: "OldestInstance" }, 3_000_000)).toBe("i-1")
    expect(choose({ terminationPolicy: "NewestInstance" }, 3_000_000)).toBe("i-3")
  })

  it("in a group with Spot, picks from the purchase option out of proportion first", () => {
    // One On-Demand of three, all Spot above a base of 1: two instances want one On-Demand, so a Spot one goes.
    expect(choose({ terminationPolicy: "OldestInstance", spot: { onDemandBaseCapacity: 1, onDemandPercentageAboveBase: 0 } }, 3_000_000)).toBe("i-2")
    // All On-Demand wanted (no base, 100%): the split is ignored, and the oldest goes.
    expect(choose({ terminationPolicy: "OldestInstance" }, 3_000_000)).toBe("i-1")
  })
})

describe("aws.ec2: audit", () => {
  const group = (over: Record<string, unknown>) => ({ id: "g", name: "Web", type: "aws.ec2", config: settings(over) })
  const quotas = { ec2OnDemandStandardVcpus: 5, ec2SpotStandardVcpus: 5, ec2AutoScalingGroups: 500 } as never
  const codes = (members: ReadonlyArray<ReturnType<typeof group>>, q = quotas) => audit("us-east-1", members, q).map((d) => d.code)

  it("warns when the groups' desired sizes need more vCPUs than AWS's default 5 allows", () => {
    expect(codes([group({ desiredCapacity: 2, maxSize: 2 })])).toEqual([])
    expect(codes([group({ desiredCapacity: 3, maxSize: 3 })])).toEqual(["ec2-on-demand-vcpus"])
    expect(codes([group({ desiredCapacity: 2, maxSize: 10 })])).toEqual(["ec2-on-demand-vcpus-max"])
    expect(codes([group({ desiredCapacity: 4, maxSize: 4, spot: { onDemandPercentageAboveBase: 0 } })])).toEqual(["ec2-spot-vcpus"])
  })

  it("adds up every group in the region", () => {
    expect(codes([group({ desiredCapacity: 2, maxSize: 2 }), group({ minSize: 1, desiredCapacity: 1, maxSize: 1 })])).toEqual(["ec2-on-demand-vcpus"])
  })

  it("flags sizes AWS would refuse, a warm pool with Spot, and too many groups", () => {
    const big = { ec2OnDemandStandardVcpus: 1_000, ec2SpotStandardVcpus: 1_000, ec2AutoScalingGroups: 1 } as never
    expect(codes([group({ minSize: 5, maxSize: 2 })], big)).toEqual(["ec2-min-over-max"])
    expect(codes([group({ desiredCapacity: 20, maxSize: 10 })], big)).toEqual(["ec2-desired-out-of-range"])
    expect(codes([group({ warmPool: { enabled: true }, spot: { onDemandPercentageAboveBase: 50 } })], big)).toEqual(["ec2-warm-pool-spot"])
    expect(codes([group({}), group({})], big)).toEqual(["ec2-groups-quota"])
  })

  it("reaches a design's diagnostics through the provider", () => {
    const b = Builder.make("audit")
    b.add("aws.ec2", { id: "g", settings: { desiredCapacity: 4 } })
    expect(diagnose(b.build(), registry).map((d) => d.code)).toContain("ec2-on-demand-vcpus")
  })
})

describe("aws.ec2: hardening", () => {
  const doc = (over: Record<string, unknown>, rps = 20) => {
    const b = Builder.make("edge", { seed: 1 })
    const web = b.add("common.client", { id: "web", settings: { rps, arrival: "constant" } })
    const asg = b.add("aws.ec2", { id: "asg", settings: { fanOut: "none", ...over } })
    b.connect(web, asg, { timeout: "5 seconds" })
    b.account("aws:us-east-1", { ec2OnDemandStandardVcpus: 1_000, ec2SpotStandardVcpus: 1_000 })
    return b.build()
  }
  const probe = (d: ReturnType<typeof doc>, ms: number) =>
    sim(d, (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(ms)
        return { all, state: (yield* s.probe("asg")).state as { inService: number; refused: number; served: number; vcpus: number; pending: number } }
      }))

  it("a group of no instances refuses at once (503) rather than queueing", async () => {
    const { state } = await probe(doc({ minSize: 0, desiredCapacity: 0 }), 10_000)
    expect(state.inService).toBe(0)
    expect(state.refused).toBeGreaterThan(150)
    expect(state.served).toBe(0)
  })

  it("with no downstream wired, a request still completes", async () => {
    const { state } = await probe(doc({ fanOut: "sequential" }), 10_000)
    expect(state.served).toBeGreaterThan(150)
  })

  it("a minimum above the maximum runs the maximum", async () => {
    const { state } = await probe(doc({ minSize: 6, maxSize: 3, desiredCapacity: 4 }), 5_000)
    expect(state.inService).toBe(3)
  })

  it("gives back every vCPU when it scales to zero", () =>
    sim(doc({ desiredCapacity: 4, minSize: 0 }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5_000)
        yield* s.configureNode("asg", { fanOut: "none", desiredCapacity: 0, minSize: 0 })
        yield* s.advanceTo(120_000)
        const state = (yield* s.probe("asg")).state as { inService: number; vcpus: number }
        expect(state).toMatchObject({ inService: 0, vcpus: 0 })
      })))

  it("plays out the same with the same seed", async () => {
    const run = () => probe(doc({ desiredCapacity: 6, spot: { onDemandPercentageAboveBase: 0, interruptionsPerHour: 20 }, launch: { pending: "5 seconds", boot: 0, userData: 0, appStart: 0 } }, 60), 600_000)
    const a = await run()
    const b = await run()
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state))
  })
})
