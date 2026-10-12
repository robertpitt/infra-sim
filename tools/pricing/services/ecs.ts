import type { ServiceMap } from "../map.ts"

/**
 * ECS on AWS Fargate: a task's vCPUs and memory by the hour (billed by the second, a minute at least), by
 * architecture. ECS itself is free; ECS on EC2 is priced as the EC2 instances it runs on (`ec2`'s `instance/*`).
 * https://aws.amazon.com/fargate/pricing/
 *
 * Usage types (after the region prefix): `Fargate-vCPU-Hours:perCPU` and `Fargate-GB-Hours` (x86), `Fargate-ARM-vCPU-
 * Hours:perCPU` and `Fargate-ARM-GB-Hours` (Graviton). AWS's unit for both is `hours`: per vCPU, and per GB.
 * Left out:
 *  - Fargate Spot: AWS's price list has none (its price moves, like EC2 Spot's), though the simulator models Spot tasks.
 *  - Ephemeral storage past the free 20 GB (`Fargate-EphemeralStorage-GB-Hours`): the simulator doesn't model it.
 *  - Windows tasks (`Fargate-Windows-*`, and its per-vCPU OS licence): the simulator runs Linux tasks.
 *  - ECS Managed Instances' management fee, ECS Anywhere: not modelled. `ECS-EC2-*-Hours` are metering rows at 0.
 */
export const ecs: ServiceMap = {
  id: "ecs",
  title: "Amazon ECS (AWS Fargate)",
  offers: ["AmazonECS"],
  dimensions: {
    "fargate-vcpu/x86_64": {
      unit: "vCPU-hour",
      description: "Fargate task vCPUs on x86, while the task runs"
    },
    "fargate-memory/x86_64": {
      unit: "GB-hour",
      description: "Fargate task memory on x86, while the task runs"
    },
    "fargate-vcpu/arm64": {
      unit: "vCPU-hour",
      description: "Fargate task vCPUs on Arm (Graviton), while the task runs"
    },
    "fargate-memory/arm64": {
      unit: "GB-hour",
      description: "Fargate task memory on Arm (Graviton), while the task runs"
    }
  },
  classify: (row) => {
    // us-east-1's file keeps its `USE1-` prefix: most of its rows (ECS Managed Instances') have none, so it isn't stripped.
    const usage = row.usage.replace(/^[A-Z0-9]+-(?=Fargate-)/, "")
    switch (usage) {
      case "Fargate-vCPU-Hours:perCPU":
        return { dimension: "fargate-vcpu/x86_64" }
      case "Fargate-GB-Hours":
        return { dimension: "fargate-memory/x86_64" }
      case "Fargate-ARM-vCPU-Hours:perCPU":
        return { dimension: "fargate-vcpu/arm64" }
      case "Fargate-ARM-GB-Hours":
        return { dimension: "fargate-memory/arm64" }
      default:
        return undefined
    }
  }
}
