import { describe, expect, it } from "vitest"
import { readyAfter, restartsAfter } from "./Eks.ts"
import { reservedCpu, reservedMemoryMiB } from "./limits.ts"
import { firstAt, gauge, HPA, maxGauge, minGauge, rate, run, workload } from "./testkit.ts"

// With the test defaults: pods of 500m and 512 MiB, three to an m7i.large node (1.93 vCPUs allocatable). A pod scheduled
// on a node that has its image is ready 11 s later (1 s to start, ready at the 10 s probe); on a new node 15 s (4 s pull).
// A managed node group's node joins 90 s after launch; Karpenter's in 50 s.

describe("EKS: pods on nodes", () => {
  it("reserves what the EKS AMI keeps back: 70m and 574 MiB on a 2-vCPU node with 29 pods", () => {
    expect(reservedCpu(2)).toBeCloseTo(0.07, 5)
    expect(reservedMemoryMiB(29)).toBe(574)
    expect(reservedCpu(8)).toBeCloseTo(0.06 + 0.01 + 0.005 * 2 + 0.0025 * 4, 5)
  })

  it("schedules pods by their requests: three 500m pods fit a node, a tenth on three nodes is Pending", async () => {
    const base = { replicas: 9, nodes: { autoscaler: "none" } }
    const { all, probe } = await run(workload(base), base, [[10_000, { ...base, replicas: 10 }]], 30_000)
    expect(gauge(all, "requestedCpu", 1_000, 9_000)).toBeCloseTo(4.5 / 5.79, 2)
    expect(gauge(all, "pending", 11_000)).toBe(1)
    expect(probe.nodeList.map((n) => n.pods)).toEqual([3, 3, 3])
  })

  it("a pod is ready at the first readiness probe after its application is up, and pulls its image only on a new node", async () => {
    expect(readyAfter(5_000, 0, 10_000)).toBe(10_000)
    expect(readyAfter(5_000, 2_000, 2_000)).toBe(6_000)
    expect(readyAfter(0, 0, 10_000)).toBe(0)
    // Three nodes with two pods each: a seventh goes on a node that has the image.
    const base = { replicas: 6, nodes: { autoscaler: "none" } }
    const { all } = await run(workload(base), base, [[10_000, { ...base, replicas: 7 }]], 40_000)
    expect((firstAt(all, "ready", (v) => v === 7, 10_000) ?? Infinity) - 10_000).toBeCloseTo(11_250, -3)
  })

  it("counts CrashLoopBackOff restarts 10 s, 20 s, 40 s... apart, capped at five minutes", () => {
    expect([restartsAfter(9_000), restartsAfter(10_000), restartsAfter(30_000), restartsAfter(70_000)]).toEqual([0, 1, 2, 3])
    // 10 + 20 + 40 + 80 + 160 = 310 s, then 300 s apart.
    expect(restartsAfter(610_000)).toBe(6)
  })
})

describe("EKS: two-level scaling", () => {
  it("Cluster Autoscaler: Pending pods get a node at the next scan; the node joins in 90 s; then the pods start in seconds", async () => {
    const base = { replicas: 9 }
    const { all, probe } = await run(workload(base), base, [[10_000, { ...base, replicas: 12 }]], 200_000)
    // Pending from 10 s; the scan at 20 s adds a node, ready at 110 s; the pods pull the image there and are ready at 125 s.
    expect(gauge(all, "pending", 11_000, 109_000)).toBe(3)
    expect(gauge(all, "nodesDesired", 21_000)).toBe(4)
    expect(gauge(all, "nodes", 111_000)).toBe(4)
    expect((firstAt(all, "ready", (v) => v === 12, 10_000) ?? Infinity)).toBeCloseTo(125_250, -3)
    expect(probe.autoscaler[0]).toMatchObject({ action: "add", nodes: 1, t: 20_000 })
  })

  it("Karpenter: batches the Pending pods for a second, launches a node directly, and it is ready in 50 s", async () => {
    const base = { replicas: 9, nodes: { autoscaler: "karpenter" } }
    const { all, probe } = await run(workload(base), base, [[10_000, { ...base, replicas: 12 }]], 200_000)
    expect(probe.autoscaler[0]).toMatchObject({ action: "add", nodes: 1, t: 12_000 })
    expect((firstAt(all, "ready", (v) => v === 12, 10_000) ?? Infinity)).toBeCloseTo(77_250, -3)
  })

  it("Cluster Autoscaler removes a node under half requested only after 10 minutes; Karpenter consolidates at once", async () => {
    // Nine pods on three nodes, cut to three: one a node, a quarter of each node requested.
    const cut = (autoscaler: string) => {
      const base = { replicas: 9, nodes: { autoscaler } }
      return run(workload(base), base, [[10_000, { ...base, replicas: 3 }]], 900_000)
    }
    const ca = await cut("cluster-autoscaler")
    expect(gauge(ca.all, "nodes", 11_000, 600_000)).toBe(3)
    expect(gauge(ca.all, "nodes", 700_000)).toBe(1)
    // Removing a node evicts its pod: one short until the replacement is ready elsewhere, 11 s later. The second node goes
    // at the next scan, before that: with no PodDisruptionBudget (not modelled) nothing stops it, so two are short a while.
    expect(ca.probe.autoscaler.filter((d) => d.action === "remove").map((d) => d.t)).toEqual([620_000, 630_000])
    expect(minGauge(ca.all, "ready", 11_000)).toBe(1)
    expect(gauge(ca.all, "ready", 700_000)).toBe(3)
    const k = await cut("karpenter")
    expect(firstAt(k.all, "nodes", (v) => v === 1, 10_000)).toBeLessThan(60_000)
    expect(rate(k.all, "fail", 0, 900_000, "web")).toBe(0)
  })

  it("with the HPA in front: a surge adds pods, Pending pods add nodes, and once both are up everything is served", async () => {
    const base = { replicas: 3, nodes: { desiredSize: 2 } }
    const { all } = await run(workload(base, { hpa: HPA }), base, [], 500_000, [[60_000, "web", { rps: 600, arrival: "constant" }]])
    expect(maxGauge(all, "replicas", 60_000)).toBeGreaterThanOrEqual(9)
    expect(maxGauge(all, "pending", 60_000)).toBeGreaterThan(0)
    expect(maxGauge(all, "nodes", 60_000)).toBeGreaterThanOrEqual(3)
    expect(rate(all, "fail", 60_000, 120_000, "web")).toBeGreaterThan(0)
    expect(rate(all, "fail", 400_000, 500_000, "web")).toBe(0)
  })
})

describe("EKS: failures", () => {
  it("a zone outage: its pods are evicted 5 min 50 s after their node stops reporting, then rescheduled", async () => {
    // One node a zone, two pods each. The cut-off nodes pass their own status checks (replaced after an hour).
    const base = { replicas: 6, nodes: { replaceAfter: "1 hour", autoscaler: "none" } }
    const { all } = await run(workload(base), base, [], 500_000, [[30_000, "zone-down"]])
    expect(gauge(all, "ready", 31_000, 379_000)).toBe(4)
    // Evicted at 30 + 50 + 300 = 380 s, placed on the two other nodes (room for one more each), ready 11 s later.
    expect(gauge(all, "ready", 395_000)).toBe(6)
    expect(gauge(all, "ready.us-east-1a", 31_000)).toBe(0)
  })

  it("a dead node replaced by its Auto Scaling group takes its pods off the cluster sooner than eviction would", async () => {
    const base = { replicas: 6, nodes: { autoscaler: "none" } }
    const { all } = await run(workload(base), base, [], 300_000, [[30_000, "zone-down"]])
    // Replaced at 30 + 180 s: the pods go with it and start on the other nodes.
    expect(gauge(all, "ready", 31_000, 209_000)).toBe(4)
    expect(gauge(all, "ready", 230_000)).toBe(6)
  })

  it("a rolling update replaces pods one over and one under at a time, never with fewer than three of four ready", async () => {
    const base = { replicas: 4 }
    const { all, probe } = await run(workload(base), base, [[30_000, { ...base, pod: { revision: 2 } }]], 150_000)
    expect(minGauge(all, "ready", 1_000)).toBeGreaterThanOrEqual(3)
    expect(probe.rollout).toMatchObject({ revision: 2, rolling: false, oldPods: 0, newPods: 4 })
    expect(rate(all, "fail", 0, 150_000, "web")).toBe(0)
  })

  it("a crashing revision stalls the rollout in CrashLoopBackOff with maxUnavailable old pods gone, and is never rolled back", async () => {
    const base = { replicas: 4, nodes: { autoscaler: "none" } }
    const { all, probe } = await run(workload(base), base, [[30_000, { ...base, pod: { revision: 2, failure: "crash" } }]], 700_000)
    expect(gauge(all, "ready", 40_000)).toBe(3)
    expect(probe.rollout).toMatchObject({ revision: 2, rolling: true, oldPods: 3, newPods: 2, progressDeadlineExceeded: true })
    expect(Math.max(...probe.podList.map((p) => p.restarts))).toBeGreaterThan(3)
  })

  it("an old pod evicted during a stalled rollout comes back as an old pod: its ReplicaSet recreates it", async () => {
    // The stalled rollout of the last test, with the Cluster Autoscaler removing an underused node at about 610 s.
    const base = { replicas: 4 }
    const { all, probe } = await run(workload(base), base, [[30_000, { ...base, pod: { revision: 2, failure: "crash" } }]], 700_000)
    expect(probe.autoscaler.some((d) => d.action === "remove")).toBe(true)
    expect(probe.rollout).toMatchObject({ oldPods: 3, newPods: 2 })
    expect(gauge(all, "ready", 680_000)).toBe(3)
  })
})
