import { describe, expect, it } from "vitest"
import { firstAt, gauge, maxGauge } from "../../../../testing.ts"
import { BIG_QUOTA, run, service } from "../../testing.ts"

// EC2 launch type on m7i.large instances (2 vCPUs, 8 GiB): two 1 vCPU tasks fit on one. An instance takes 75 s to join
// (30 s pending, 30 s boot, 15 s for the ECS agent to register); a task on it 5 s to provision, its image pull (4 s, or
// 1 s if the instance has the image), and 5 s to start.
const EC2 = { launchType: "EC2", ec2: { desiredSize: 2, maxSize: 10 } }

describe("ECS on EC2: tasks placed on container instances", () => {
  it("places tasks on instances with room; the ones that don't fit wait in PROVISIONING", async () => {
    const base = { ...EC2, desiredCount: 4, ec2: { ...EC2.ec2, managedScaling: false } }
    const { all, probe } = await run(service(base), base, [[10_000, { ...base, desiredCount: 6 }]], 120_000)
    expect(gauge(all, "svc", "running", 1_000, 9_000)).toBe(4)
    expect(gauge(all, "svc", "provisioning", 11_000)).toBe(2)
    expect(gauge(all, "svc", "instances")).toBe(2)
    expect(gauge(all, "svc", "cpuReservation", 1_000)).toBe(1)
    expect(probe.instances).toMatchObject({ running: 2, launching: 0 })
  })

  it("starts a task on an instance that already has its image without pulling it again", async () => {
    // Two instances with one task each: a third task goes where there is room, and the image is already there.
    const base = { ...EC2, desiredCount: 2 }
    const { all } = await run(service(base), base, [[10_000, { ...base, desiredCount: 3 }]], 60_000)
    // 5 s + 1 s + 5 s: 11 s, against 19 s on Fargate.
    expect((firstAt(all, "svc", "running", (v) => v === 3, 10_000) ?? Infinity) - 10_000).toBeCloseTo(11_250, -3)
  })

  it("scales the group with managed scaling when tasks can't be placed: two-level scaling", async () => {
    // Four tasks fill the two instances; two more wait. Managed scaling looks once a minute (at 60 s): one more instance is
    // needed, which joins 75 s later; then the two tasks start there (pulling the image, which the new instance hasn't).
    const base = { ...EC2, desiredCount: 4 }
    const { all, probe } = await run(service(base), base, [[10_000, { ...base, desiredCount: 6 }]], 240_000)
    expect(gauge(all, "svc", "provisioning", 11_000, 134_000)).toBe(2)
    expect(gauge(all, "svc", "instancesDesired", 61_000, 240_000)).toBe(3)
    expect(gauge(all, "svc", "instances", 136_000)).toBe(3)
    expect((firstAt(all, "svc", "running", (v) => v === 6, 10_000) ?? Infinity)).toBeCloseTo(149_250, -3)
    expect(probe.instances?.reservation).toBeCloseTo(100, 0)
  })

  it("keeps spare instances with a target capacity under 100%", async () => {
    // Four tasks need two instances; at 50% managed scaling keeps four.
    const base = { ...EC2, desiredCount: 4, ec2: { ...EC2.ec2, targetCapacity: 50 } }
    const { all } = await run(service(base), base, [], 200_000)
    expect(gauge(all, "svc", "instancesDesired", 61_000)).toBe(4)
    expect(gauge(all, "svc", "instances", 140_000)).toBe(4)
  })

  it("scales in only after 15 minutes below the target", async () => {
    // Binpacked in one zone, six tasks fill three instances. Down to two tasks: the newest four go, emptying the last two
    // instances. Below target from 120 s, managed scaling lets them go 15 minutes later.
    const base = { ...EC2, desiredCount: 6, zones: 1, ec2: { ...EC2.ec2, desiredSize: 3, placement: "binpack" } }
    const { all, probe } = await run(service(base), base, [[60_000, { ...base, desiredCount: 2 }]], 1_200_000)
    expect(gauge(all, "svc", "instances", 61_000, 900_000)).toBe(3)
    expect(gauge(all, "svc", "instances", 1_100_000)).toBe(1)
    expect(gauge(all, "svc", "running", 61_000)).toBe(2)
    expect(probe.tasks.every((t) => t.instance === "i-1")).toBe(true)
  })

  it("with managed termination protection lets go only of instances without tasks", async () => {
    // Spread in one zone: two tasks on i-1 and i-2, i-3 empty. The group's maximum is cut to one instance.
    const at = async (protect: boolean) => {
      const base = { ...EC2, desiredCount: 2, zones: 1, ec2: { ...EC2.ec2, desiredSize: 3, managedScaling: false, managedTerminationProtection: protect } }
      return run(service(base), base, [[10_000, { ...base, ec2: { ...base.ec2, maxSize: 1 } }]], 60_000)
    }
    const kept = await at(true)
    // Only the empty one goes; i-2 runs a task and is protected, so the group stays over its maximum.
    expect(gauge(kept.all, "svc", "instances", 11_000)).toBe(2)
    const cut = await at(false)
    // Unprotected, i-2 goes too: managed draining moves its task to i-1 first.
    expect(gauge(cut.all, "svc", "instances", 30_000)).toBe(1)
    expect(gauge(cut.all, "svc", "running", 30_000)).toBe(2)
    expect(cut.probe.lost).toBe(0)
  })

  it("can't grow past the account's EC2 vCPU quota: the instance waits, and so do the tasks", async () => {
    // AWS's default of 5 Standard vCPUs holds two m7i.large instances.
    const base = { ...EC2, desiredCount: 6 }
    const { all } = await run(service(base, { account: { ...BIG_QUOTA, ec2OnDemandStandardVcpus: 5 } }), base, [], 300_000)
    expect(maxGauge(all, "svc", "instancesDesired")).toBe(3)
    expect(gauge(all, "svc", "instances", 1_000)).toBe(2)
    expect(gauge(all, "svc", "provisioning", 1_000)).toBe(2)
  })

  it("loses the tasks of a zone's instances with them, and starts them on instances elsewhere", async () => {
    // Three zones, one instance each, room for six tasks: three run, one a zone. Zone a fails at 30 s; ECS notices the
    // lost task 60 s later and starts it on another instance, which has the image.
    const base = { ...EC2, desiredCount: 3, zones: 3, ec2: { ...EC2.ec2, desiredSize: 3 } }
    const { all } = await run(service(base), base, [], 200_000, [[30_000, "zone-down"]])
    expect(gauge(all, "svc", "running", 31_000, 89_000)).toBe(2)
    expect(gauge(all, "svc", "running", 102_000, 200_000)).toBe(3)
    expect(gauge(all, "svc", "running.us-east-1a", 31_000)).toBe(0)
  })
})
