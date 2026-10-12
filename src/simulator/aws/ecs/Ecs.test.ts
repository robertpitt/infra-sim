import { describe, expect, it } from "vitest"
import { firstAt, gauge, maxGauge, minGauge, rate, run, service } from "./testkit.ts"

// With the test defaults a task takes 19 s from launch to RUNNING on Fargate: 10 s provisioning, 4 s pulling a 100 MiB
// image at 25 MiB/s, 5 s starting the application.

describe("ECS on Fargate: tasks", () => {
  it("a task's CPU sets how many requests it works on at once, and so its CPU utilization", async () => {
    // 100 requests a second for 50 ms each keep 5 workers busy. Two 0.5 vCPU tasks have 5 workers each; two 1 vCPU tasks 10.
    const small = await run(service({ desiredCount: 2, task: { cpu: "512" } }), { desiredCount: 2, task: { cpu: "512" } }, [], 30_000)
    expect(gauge(small.all, "cpu", 5_000)).toBeCloseTo(0.5, 1)
    expect(gauge(small.all, "cpuTasks", 5_000)).toBeCloseTo(1, 1)
    const big = await run(service({ desiredCount: 2 }), { desiredCount: 2 }, [], 30_000)
    expect(gauge(big.all, "cpu", 5_000)).toBeCloseTo(0.25, 1)
    expect(gauge(big.all, "cpuTasks", 5_000)).toBeCloseTo(0.5, 1)
  })

  it("starts a task in provisioning, image pull and application start: a bigger image takes longer, lazy loading less", async () => {
    const at = async (task: Record<string, unknown>) => {
      const base = { desiredCount: 2, task }
      const { all } = await run(service(base), base, [[10_000, { desiredCount: 4, task }]], 90_000)
      return (firstAt(all, "running", (v) => v === 4, 10_000) ?? Infinity) - 10_000
    }
    // 10 + 4 + 5 s; then 10 + 40 + 5 s for 1,000 MiB; with SOCI 10 + 3 + 5 s.
    expect(await at({ imageSize: 100 })).toBeCloseTo(19_250, -3)
    expect(await at({ imageSize: 1_000 })).toBeCloseTo(55_250, -3)
    expect(await at({ imageSize: 1_000, lazyLoading: true })).toBeCloseTo(18_250, -3)
  })

  it("keeps tasks the Fargate vCPU quota can't hold waiting in PROVISIONING", async () => {
    // Six vCPUs of quota (AWS's default), eight 1 vCPU tasks.
    const { all, probe } = await run(service({ desiredCount: 8 }, { account: { fargateOnDemandVcpus: 6 } }), { desiredCount: 8 }, [], 60_000)
    expect(gauge(all, "running", 1_000)).toBe(6)
    expect(gauge(all, "provisioning", 1_000)).toBe(2)
    expect(probe.provisioning).toBe(2)
  })

  it("launches no faster than the region's Fargate launch rate allows", async () => {
    // A burst of 5 and 1 a second: of ten more tasks, five launch at once and five when the service tries again 5 s later.
    const account = { fargateOnDemandVcpus: 10_000, fargateLaunchRate: 1, fargateLaunchBurst: 5 }
    const { all } = await run(service({ desiredCount: 2 }, { account }), { desiredCount: 2 }, [[10_000, { desiredCount: 12 }]], 60_000)
    expect(gauge(all, "provisioning", 10_250, 14_750)).toBe(5)
    expect(gauge(all, "provisioning", 15_250, 60_000)).toBe(0)
    expect(gauge(all, "running", 35_000, 60_000)).toBe(12)
  })
})

describe("ECS on Fargate: Spot", () => {
  it("splits tasks by the capacity provider strategy: the base on Fargate, the rest by weight", async () => {
    // Base 2 on FARGATE, then FARGATE 1 : FARGATE_SPOT 3 for the other six: one more On-Demand, five Spot.
    const base = { desiredCount: 8, fargate: { base: 2, weight: 1, spotWeight: 3, spotInterruptionsPerTaskHour: 0 } }
    const { probe } = await run(service(base), base, [], 10_000)
    expect([probe.onDemand, probe.spot]).toEqual([3, 5])
  })

  it("interrupts Spot tasks with a warning: each stops taking work, a replacement starts at once, nothing is lost", async () => {
    // Five Spot tasks at 30 interruptions an hour each: about 25 in ten minutes.
    const base = { desiredCount: 8, fargate: { base: 2, weight: 1, spotWeight: 3, spotInterruptionsPerTaskHour: 30 } }
    const { all, probe } = await run(service(base, { rps: 200 }), base, [], 600_000)
    expect(probe.interrupted).toBeGreaterThan(12)
    expect(probe.interrupted).toBeLessThan(45)
    expect(probe.lost).toBe(0)
    expect(rate(all, "fail", 0, 600_000, "web")).toBe(0)
    // Each replacement takes 19 s, so interruptions seldom overlap: never more than three short.
    expect(minGauge(all, "running", 1_000)).toBeGreaterThanOrEqual(5)
    // Replacements follow the strategy: Spot tasks interrupted are replaced on Spot.
    expect(probe.spot).toBe(5)
  })
})

describe("ECS on Fargate: zones", () => {
  it("loses a zone's tasks with it, replaces them in the other zones once noticed, and rebalances when it is back", async () => {
    const base = { desiredCount: 6, zones: 3 }
    const { all } = await run(service(base), base, [], 400_000, [[30_000, "zone-down"], [150_000, "zone-up"]])
    expect(gauge(all, "running", 1_000, 29_000)).toBe(6)
    expect(gauge(all, "running.us-east-1a", 1_000, 29_000)).toBe(2)
    // Dead at 30 s, noticed 60 s later, running again 19 s after that.
    expect(gauge(all, "running", 31_000, 89_000)).toBe(4)
    expect(gauge(all, "running", 110_000, 149_000)).toBe(6)
    expect(gauge(all, "running.us-east-1a", 110_000, 149_000)).toBe(0)
    // AZ rebalancing: back to two a zone, never fewer than six running on the way.
    expect(gauge(all, "running.us-east-1a", 300_000, 400_000)).toBe(2)
    expect(minGauge(all, "running", 110_000)).toBe(6)
  })
})

describe("ECS service auto scaling", () => {
  it("target tracking on CPU per task adds tasks for a surge, which serve once they have started", async () => {
    // 0.25 vCPU tasks have 2 workers. 100 requests a second keep 5 busy (2.5 tasks' worth): 4 tasks at a 70% target. 400 a
    // second keep 20 busy: 15 tasks.
    const base = { desiredCount: 4, task: { cpu: "256", memory: 512 }, queueLimit: 50 }
    const scaling = { metric: "cpuTasks", per: "unit", targetValue: 0.7, min: 2, max: 40, window: "30 seconds", period: "15 seconds", scaleOutCooldown: 0, scaleInCooldown: "5 minutes" }
    const { all } = await run(service(base, { scaling }), base, [], 240_000, [[60_000, "web", { rps: 400, arrival: "constant" }]])
    expect(gauge(all, "desired", 30_000, 59_000)).toBe(4)
    expect(maxGauge(all, "desired", 60_000)).toBeGreaterThanOrEqual(14)
    // CPU can't go past 100%, so while the tasks are saturated each decision sees only what they can do and adds a step
    // (×1/0.7): it takes a few rounds, each waiting for tasks to start. Meanwhile the queue overflows; then all is served.
    expect(rate(all, "fail.Unavailable", 60_000, 100_000)).toBeGreaterThan(100)
    expect(maxGauge(all, "desired", 60_000, 100_000)).toBeLessThan(8)
    expect(rate(all, "fail", 200_000, 240_000)).toBe(0)
  })
})
