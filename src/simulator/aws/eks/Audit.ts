import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../internal/account.ts"
import { instanceType } from "../ec2/InstanceTypes.ts"
import { type Audit, fmt } from "../internal/service.ts"
import type { Settings } from "./internal/config.ts"
import { EVICTION_MIB, reservedCpu, reservedMemoryMiB } from "./internal/limits.ts"

/**
 * Static checks of a region's EKS workloads: pods that no node of their instance type can hold (they would be Pending
 * forever), a rolling update that can't move (no surge and no unavailability), and the EC2 vCPUs the node groups can grow
 * to against the account's On-Demand quota they share with every instance in the region. Pure and cheap.
 */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  const workloads = members.filter((m) => m.type === "aws.eks")
  if (workloads.length === 0) return out
  let vcpus = 0
  for (const m of workloads) {
    const c = m.config as Settings
    const t = instanceType(c.nodes.instanceType)
    vcpus += c.nodes.maxSize * t.vcpus
    const cpu = t.vcpus - reservedCpu(t.vcpus)
    const memory = t.memoryGiB * 1024 - reservedMemoryMiB(c.nodes.maxPods) - EVICTION_MIB
    if (c.pod.cpu / 1000 > cpu || c.pod.memory > memory) {
      out.push({
        level: "error",
        code: "eks-pod-too-big",
        node: m.id,
        message: `${m.name}'s pods request ${fmt(c.pod.cpu)}m CPU and ${fmt(c.pod.memory)} MiB, more than a ${t.name} node has allocatable (${fmt(Math.floor(cpu * 1000))}m, ${fmt(Math.floor(memory))} MiB): they would stay Pending, and no node autoscaler can help.`
      })
    }
    const surge = Math.ceil((c.replicas * c.rollingUpdate.maxSurge) / 100)
    const unavailable = Math.floor((c.replicas * c.rollingUpdate.maxUnavailable) / 100)
    if (c.replicas > 0 && surge === 0 && unavailable === 0) {
      out.push({
        level: "warning",
        code: "eks-rollout-stuck",
        node: m.id,
        message: `${m.name}'s rolling update allows no surge and no unavailable pod at ${fmt(c.replicas)} replicas: Kubernetes rejects maxSurge and maxUnavailable both 0, and a rollout couldn't move.`
      })
    }
    if (c.nodes.maxSize < c.nodes.minSize) {
      out.push({ level: "error", code: "eks-node-sizes", node: m.id, message: `${m.name}'s node group has a maximum size (${fmt(c.nodes.maxSize)}) below its minimum (${fmt(c.nodes.minSize)}).` })
    }
  }
  if (vcpus > account.ec2OnDemandStandardVcpus) {
    out.push({
      level: "info",
      code: "eks-ec2-vcpus",
      message: `EKS node groups in ${region} can grow to ${fmt(vcpus)} EC2 vCPUs, past the account's On-Demand Standard quota of ${fmt(account.ec2OnDemandStandardVcpus)} (shared with every EC2 instance in the region): nodes past it can't launch, and pods stay Pending.`
    })
  }
  return out
}
