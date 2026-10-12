import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../account.ts"
import type { Audit } from "../service.ts"
import type { Settings } from "./config.ts"
import { instanceType } from "./instanceTypes.ts"
import { onDemandOf } from "./spot.ts"

const n = (value: number): string => value.toLocaleString("en-US")

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
      message: `${region} has ${n(groups.length)} Auto Scaling groups, over the account's quota of ${n(account.ec2AutoScalingGroups)}.`
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
      out.push({ level: "warning", code: "ec2-min-over-max", node: m.id, message: `${m.name} has a minimum size (${n(c.minSize)}) above its maximum (${n(c.maxSize)}). AWS refuses that; the simulator runs the maximum.` })
    } else if (c.desiredCapacity < c.minSize || c.desiredCapacity > c.maxSize) {
      out.push({
        level: "warning",
        code: "ec2-desired-out-of-range",
        node: m.id,
        message: `${m.name} wants ${n(c.desiredCapacity)} instances, outside its size of ${n(c.minSize)} to ${n(c.maxSize)}. AWS refuses that; the simulator runs ${n(desired)}.`
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
      message: `Auto Scaling groups in ${region} need ${n(desiredOd)} On-Demand vCPUs at their desired sizes, over the account's ${n(odQuota)}: launches past it fail and are retried. ${default5}`
    })
  } else if (maxOd > odQuota) {
    out.push({
      level: "info",
      code: "ec2-on-demand-vcpus-max",
      message: `Auto Scaling groups in ${region} would need ${n(maxOd)} On-Demand vCPUs at their maximum sizes, over the account's ${n(odQuota)}: scaling out will stop short. ${default5}`
    })
  }
  if (desiredSpot > spotQuota) {
    out.push({
      level: "warning",
      code: "ec2-spot-vcpus",
      message: `Auto Scaling groups in ${region} need ${n(desiredSpot)} Spot vCPUs at their desired sizes, over the account's ${n(spotQuota)}: Spot launches past it fail and are retried. ${default5}`
    })
  } else if (maxSpot > spotQuota) {
    out.push({
      level: "info",
      code: "ec2-spot-vcpus-max",
      message: `Auto Scaling groups in ${region} would need ${n(maxSpot)} Spot vCPUs at their maximum sizes, over the account's ${n(spotQuota)}: scaling out will stop short. ${default5}`
    })
  }
  return out
}
