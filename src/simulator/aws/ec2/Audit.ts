import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../internal/account.ts"
import { type Audit, fmt } from "../internal/service.ts"
import type { Settings } from "./internal/config.ts"
import { instanceType } from "./InstanceTypes.ts"
import { onDemandOf } from "./internal/spot.ts"

/** What a group asks of the quotas at a given size: its On-Demand and Spot vCPUs. */
const vcpusAt = (c: Settings, size: number): { readonly onDemand: number; readonly spot: number } => {
  const vcpus = instanceType(c.instanceType).vcpus
  const spotOn = c.spot.onDemandPercentageAboveBase < 100 && !c.warmPool.enabled
  const od = spotOn ? onDemandOf(size, c.spot.onDemandBaseCapacity, c.spot.onDemandPercentageAboveBase) : size
  return { onDemand: od * vcpus, spot: (size - od) * vcpus }
}

/**
 * Static checks of a region's Auto Scaling groups against the account's EC2 quotas and against AWS's rules: the vCPUs
 * the groups need at their desired and maximum sizes against the On-Demand and Spot vCPU quotas (shared by every group
 * in the region), the number of groups, sizes AWS would refuse, and a warm pool on a group with Spot. Pure and cheap.
 */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  const groups = members.filter((m) => m.type === "aws.ec2")
  if (groups.length === 0) return out

  if (groups.length > account.ec2AutoScalingGroups) {
    out.push({
      level: "warning",
      code: "ec2-groups-quota",
      message: `${region} has ${fmt(groups.length)} Auto Scaling groups, over the account's quota of ${fmt(account.ec2AutoScalingGroups)}.`
    })
  }

  let desiredOd = 0
  let desiredSpot = 0
  let maxOd = 0
  let maxSpot = 0
  for (const m of groups) {
    const c = m.config as Settings
    const desired = Math.max(c.minSize, Math.min(c.maxSize, c.desiredCapacity))
    const atDesired = vcpusAt(c, desired)
    const atMax = vcpusAt(c, Math.max(c.maxSize, desired))
    desiredOd += atDesired.onDemand
    desiredSpot += atDesired.spot
    maxOd += atMax.onDemand
    maxSpot += atMax.spot
    if (c.minSize > c.maxSize) {
      out.push({ level: "warning", code: "ec2-min-over-max", node: m.id, message: `${m.name} has a minimum size (${fmt(c.minSize)}) above its maximum (${fmt(c.maxSize)}). AWS refuses that; the simulator runs the maximum.` })
    } else if (c.desiredCapacity < c.minSize || c.desiredCapacity > c.maxSize) {
      out.push({
        level: "warning",
        code: "ec2-desired-out-of-range",
        node: m.id,
        message: `${m.name} wants ${fmt(c.desiredCapacity)} instances, outside its size of ${fmt(c.minSize)} to ${fmt(c.maxSize)}. AWS refuses that; the simulator runs ${fmt(desired)}.`
      })
    }
    if (c.warmPool.enabled && c.spot.onDemandPercentageAboveBase < 100) {
      out.push({
        level: "warning",
        code: "ec2-warm-pool-spot",
        node: m.id,
        message: `${m.name} has a warm pool and Spot Instances. Warm pools don't support Spot in a mixed instances group; the simulator launches On-Demand only.`
      })
    }
    if (c.warmPool.enabled && c.warmPool.poolState === "Running") {
      out.push({ level: "info", code: "ec2-warm-pool-running", node: m.id, message: `${m.name} keeps its warm pool running: those instances are paid for and count against the On-Demand vCPU quota.` })
    }
  }

  const odQuota = account.ec2OnDemandStandardVcpus
  const spotQuota = account.ec2SpotStandardVcpus
  const default5 = "The default is 5 vCPUs; EC2 raises it with usage, so set your account's value in the region's quotas."
  if (desiredOd > odQuota) {
    out.push({
      level: "warning",
      code: "ec2-on-demand-vcpus",
      message: `Auto Scaling groups in ${region} need ${fmt(desiredOd)} On-Demand vCPUs at their desired sizes, over the account's ${fmt(odQuota)}: launches past it fail and are retried. ${default5}`
    })
  } else if (maxOd > odQuota) {
    out.push({
      level: "info",
      code: "ec2-on-demand-vcpus-max",
      message: `Auto Scaling groups in ${region} would need ${fmt(maxOd)} On-Demand vCPUs at their maximum sizes, over the account's ${fmt(odQuota)}: scaling out will stop short. ${default5}`
    })
  }
  if (desiredSpot > spotQuota) {
    out.push({
      level: "warning",
      code: "ec2-spot-vcpus",
      message: `Auto Scaling groups in ${region} need ${fmt(desiredSpot)} Spot vCPUs at their desired sizes, over the account's ${fmt(spotQuota)}: Spot launches past it fail and are retried. ${default5}`
    })
  } else if (maxSpot > spotQuota) {
    out.push({
      level: "info",
      code: "ec2-spot-vcpus-max",
      message: `Auto Scaling groups in ${region} would need ${fmt(maxSpot)} Spot vCPUs at their maximum sizes, over the account's ${fmt(spotQuota)}: scaling out will stop short. ${default5}`
    })
  }
  return out
}
