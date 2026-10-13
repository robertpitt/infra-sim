import { describe, expect, it } from "vitest"
import { firstAt, gauge, maxGauge, minGauge, rate } from "../../../../testing.ts"
import { run, service } from "../../testing.ts"

// A task takes 19 s from launch to RUNNING with the test defaults, and counts as healthy for a deployment 40 s later.

describe("ECS rolling deployments", () => {
  it("with the defaults (100% healthy, 200% at most) starts every new task first, then stops old ones as new ones are healthy", async () => {
    const base = { desiredCount: 4 }
    const { all, probe } = await run(service(base), base, [[30_000, { desiredCount: 4, task: { revision: 2 } }]], 150_000)
    // Four new tasks launch at 30 s, run at 49 s, are healthy at 89 s; then the four old ones stop.
    expect(maxGauge(all, "svc", "pending", 30_000, 48_000)).toBe(4)
    expect(gauge(all, "svc", "oldTasks", 31_000, 88_000)).toBe(4)
    expect(gauge(all, "svc", "oldTasks", 90_000)).toBe(0)
    expect(minGauge(all, "svc", "running", 1_000)).toBe(4)
    expect(maxGauge(all, "svc", "running")).toBe(8)
    expect(rate(all, "web", "fail", 0, 150_000)).toBe(0)
    expect(probe.deployment).toMatchObject({ state: "COMPLETED", revision: 2, stable: 2, oldTasks: 0, newTasks: 4 })
  })

  it("with 50% healthy and 100% at most stops half the old tasks first, and never runs more than the desired count", async () => {
    const base = { desiredCount: 4, deployment: { minimumHealthyPercent: 50, maximumPercent: 100 } }
    const { all, probe } = await run(service(base), base, [[30_000, { ...base, task: { revision: 2 } }]], 200_000)
    expect(maxGauge(all, "svc", "running") + maxGauge(all, "svc", "pending", 30_000)).toBeLessThanOrEqual(6)
    expect(gauge(all, "svc", "running", 31_000, 48_000)).toBe(2)
    expect(probe.deployment).toMatchObject({ state: "COMPLETED", revision: 2 })
  })

  it("a revision that crashes as it starts trips the circuit breaker, which rolls back; the old tasks never stopped", async () => {
    // Desired 4: the threshold is max(3, ceil(4 / 2)) = 3 failures.
    const base = { desiredCount: 4, deployment: { circuitBreaker: true, rollback: true } }
    const { all, probe } = await run(service(base), base, [[30_000, { ...base, task: { revision: 2, failure: "crash" } }]], 150_000)
    expect(probe.deployment).toMatchObject({ state: "ROLLED_BACK", revision: 1, stable: 1, rollbacks: 1, threshold: 3, newTasks: 4, oldTasks: 0 })
    expect(minGauge(all, "svc", "running", 1_000)).toBe(4)
    expect(rate(all, "web", "fail", 0, 150_000)).toBe(0)
    // The crashed tasks are gone after the rollback.
    expect(gauge(all, "svc", "pending", 60_000)).toBe(0)
  })

  it("without the circuit breaker a crashing revision is retried forever", async () => {
    const base = { desiredCount: 4 }
    const { all, probe } = await run(service(base), base, [[30_000, { desiredCount: 4, task: { revision: 2, failure: "crash" } }]], 300_000)
    expect(probe.deployment).toMatchObject({ state: "IN_PROGRESS", revision: 2, oldTasks: 4 })
    expect(gauge(all, "svc", "pending", 60_000)).toBe(4)
    expect(gauge(all, "svc", "running", 31_000)).toBe(4)
  })

  it("a revision that fails its health checks serves 500s until its container health check catches it", async () => {
    // Called directly there is no load balancer to keep requests away: the new tasks (half the service) answer 500 from
    // 49 s until the circuit breaker rolls back, when their container checks fail 90 s after RUNNING.
    const base = { desiredCount: 4, deployment: { circuitBreaker: true } }
    const { all, probe } = await run(service(base), base, [[30_000, { ...base, task: { revision: 2, failure: "unhealthy" } }]], 200_000)
    expect(rate(all, "web", "fail", 50_000, 135_000) / 100).toBeGreaterThan(0.3)
    expect(probe.deployment).toMatchObject({ state: "ROLLED_BACK", revision: 1 })
    const back = firstAt(all, "svc", "oldTasks", (v) => v === 0, 100_000) ?? Infinity
    expect(back).toBeGreaterThan(135_000)
    expect(rate(all, "web", "fail", 145_000, 200_000)).toBe(0)
  })

  it("behind a target group the broken tasks never pass a health check, so no request reaches them", async () => {
    const base = { desiredCount: 4, deployment: { circuitBreaker: true } }
    const { all, probe } = await run(service(base, { targetGroup: {} }), base, [[30_000, { ...base, task: { revision: 2, failure: "unhealthy" } }]], 200_000)
    expect(rate(all, "web", "fail", 0, 200_000)).toBe(0)
    expect(probe.deployment).toMatchObject({ state: "ROLLED_BACK", revision: 1 })
  })
})
