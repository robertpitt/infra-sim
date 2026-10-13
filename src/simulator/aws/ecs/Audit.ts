import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../internal/account.ts"
import { instanceType } from "../ec2/InstanceTypes.ts"
import { type Audit, fmt } from "../internal/service.ts"
import type { Settings } from "./internal/config.ts"
import { CPU_LABELS, fargateMemory, isValidSize, pick, vcpusOf } from "./internal/fargate.ts"

/** How a service's desired tasks split between Fargate and Fargate Spot under its strategy. */
const split = (c: Settings): { readonly onDemand: number; readonly spot: number } => {
  let onDemand = 0
  let spot = 0
  for (let i = 0; i < c.desiredCount; i++) {
    if (pick(onDemand, spot, c.fargate.base, c.fargate.weight, c.fargate.spotWeight) === "onDemand") onDemand++
    else spot++
  }
  return { onDemand, spot }
}

/**
 * Static checks of a region's ECS services: Fargate tasks the account's vCPU quotas can't hold at the desired count (they
 * would wait in PROVISIONING), task sizes Fargate doesn't offer, tasks too big for their capacity provider's instances, the
 * EC2 vCPUs capacity providers need at their maximum size, and deployment settings that can't make progress. Pure and cheap.
 */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  const services = members.filter((m) => m.type === "aws.ecs")
  if (services.length === 0) return out

  let onDemand = 0
  let spot = 0
  let ec2Vcpus = 0
  for (const m of services) {
    const c = m.config as Settings
    const vcpus = vcpusOf(c.task.cpu)
    if (c.launchType === "FARGATE") {
      const s = split(c)
      onDemand += s.onDemand * vcpus
      spot += s.spot * vcpus
      if (!isValidSize(c.task.cpu, c.task.memory)) {
        out.push({
          level: "warning",
          code: "ecs-fargate-size",
          node: m.id,
          message: `${m.name} asks Fargate for ${CPU_LABELS[c.task.cpu]} with ${fmt(c.task.memory)} MiB, a pair Fargate doesn't offer: AWS would refuse the task definition. The simulator runs it with ${fmt(fargateMemory(c.task.cpu, c.task.memory))} MiB.`
        })
      }
      if (c.fargate.weight === 0 && c.fargate.spotWeight === 0 && c.desiredCount > c.fargate.base) {
        out.push({
          level: "warning",
          code: "ecs-strategy-weights",
          node: m.id,
          message: `${m.name}'s capacity provider strategy gives both FARGATE and FARGATE_SPOT a weight of 0: tasks beyond the base of ${fmt(c.fargate.base)} run on Fargate here, but AWS places none.`
        })
      }
    } else {
      const t = instanceType(c.ec2.instanceType)
      ec2Vcpus += c.ec2.maxSize * t.vcpus
      if (vcpus > t.vcpus || c.task.memory > t.memoryGiB * 1024) {
        out.push({
          level: "error",
          code: "ecs-task-too-big",
          node: m.id,
          message: `${m.name}'s tasks (${CPU_LABELS[c.task.cpu]}, ${fmt(c.task.memory)} MiB) don't fit on a ${t.name} (${t.vcpus} vCPUs, ${fmt(t.memoryGiB * 1024)} MiB): none can ever be placed.`
        })
      }
      if (c.ec2.maxSize < c.ec2.minSize) {
        out.push({ level: "error", code: "ecs-capacity-sizes", node: m.id, message: `${m.name}'s capacity provider has a maximum size (${fmt(c.ec2.maxSize)}) below its minimum (${fmt(c.ec2.minSize)}).` })
      }
    }
    if (c.deployment.minimumHealthyPercent >= 100 && Math.floor((c.desiredCount * c.deployment.maximumPercent) / 100) <= c.desiredCount && c.desiredCount > 0) {
      out.push({
        level: "warning",
        code: "ecs-deployment-stuck",
        node: m.id,
        message: `${m.name} keeps ${c.deployment.minimumHealthyPercent}% of its tasks healthy during a deployment with ${c.deployment.maximumPercent}% at most: it can neither stop an old task nor start a new one, so a deployment never progresses.`
      })
    }
  }

  if (onDemand > account.fargateOnDemandVcpus) {
    out.push({
      level: "warning",
      code: "ecs-fargate-quota",
      message: `ECS services in ${region} want ${fmt(onDemand)} Fargate On-Demand vCPUs at their desired counts, over the account's quota of ${fmt(account.fargateOnDemandVcpus)}: tasks past it wait in PROVISIONING. Raise the quota in the region's account settings.`
    })
  }
  if (spot > account.fargateSpotVcpus) {
    out.push({
      level: "warning",
      code: "ecs-fargate-spot-quota",
      message: `ECS services in ${region} want ${fmt(spot)} Fargate Spot vCPUs at their desired counts, over the account's quota of ${fmt(account.fargateSpotVcpus)}: Spot tasks past it wait (Fargate never moves them to On-Demand).`
    })
  }
  if (ec2Vcpus > account.ec2OnDemandStandardVcpus) {
    out.push({
      level: "info",
      code: "ecs-ec2-vcpus",
      message: `ECS capacity providers in ${region} can grow to ${fmt(ec2Vcpus)} EC2 vCPUs, past the account's On-Demand Standard quota of ${fmt(account.ec2OnDemandStandardVcpus)} (shared with every EC2 instance in the region): instances past it can't launch, and tasks wait for them.`
    })
  }
  return out
}
