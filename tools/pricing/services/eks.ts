import type { ServiceMap } from "../map.ts"

/**
 * EKS: the cluster (its control plane) by the hour, and the extra hour of a cluster on a Kubernetes version in extended
 * support. The nodes are EC2 instances, priced as EC2 (`ec2`'s `instance/*`).
 * https://aws.amazon.com/eks/pricing/
 *
 * Usage types (after the region prefix): `AmazonEKS-Hours:perCluster` (standard support), and
 * `AmazonEKS-Hours:extendedSupport`, which is billed on top of it: a cluster in extended support pays both.
 * Left out:
 *  - Fargate for EKS (`Fargate-*` in this offer, the same prices as ECS's x86 Fargate): the simulator's pods run on
 *    node groups, not Fargate profiles.
 *  - EKS Auto Mode's management fee per instance (`Auto:<type>`): the simulator's nodes come from managed node groups
 *    or self-managed Karpenter.
 *  - Provisioned control plane tiers, Hybrid Nodes, EKS Capabilities (ACK, Argo CD, KRO), local clusters on Outposts:
 *    not modelled.
 */
export const eks: ServiceMap = {
  id: "eks",
  title: "Amazon EKS",
  offers: ["AmazonEKS"],
  dimensions: {
    cluster: {
      unit: "hour",
      description: "A cluster running (standard support)"
    },
    "extended-support": {
      unit: "hour",
      description: "A cluster on a Kubernetes version in extended support, on top of the cluster hour"
    }
  },
  classify: (row) => {
    // us-east-1's file keeps its `USE1-` prefix: most of its rows (Auto Mode's) have none, so it isn't stripped.
    const usage = row.usage.replace(/^[A-Z0-9]+-(?=AmazonEKS-)/, "")
    switch (usage) {
      case "AmazonEKS-Hours:perCluster":
        return { dimension: "cluster" }
      case "AmazonEKS-Hours:extendedSupport":
        return { dimension: "extended-support" }
      default:
        return undefined
    }
  }
}
