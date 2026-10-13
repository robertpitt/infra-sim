import * as Setting from "../../Setting.ts"
import { GROUPS_PER_REGION, PAGES, STANDARD_VCPU_QUOTA } from "./Limits.ts"

/**
 * The account-level quotas EC2 Auto Scaling depends on, per region. Every instance type in the catalog is in the
 * Standard (A, C, D, H, I, M, R, T, Z) group, so one On-Demand and one Spot vCPU quota cover them all, shared by every
 * Auto Scaling group in the region (and by ECS and EKS capacity built on EC2: see `vcpus.ts`).
 *
 * AWS's published default for both vCPU quotas is 5, the same in every region (`ec2-instance-quotas.html`). It is
 * deliberately small: "Amazon EC2 automatically increases your On-Demand Instance quotas based on your usage", so an
 * established account usually has far more. That is the account's state, not a region's, so it is for the design to set
 * (the audit says when a group can't reach its size under the default).
 */
export const quotas = (_region: string) => ({
  ec2OnDemandStandardVcpus: Setting.int({
    default: STANDARD_VCPU_QUOTA,
    min: 0,
    max: 10_000_000,
    unit: "vCPUs",
    label: "EC2 running On-Demand Standard vCPUs",
    help: "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances: the vCPUs of every running On-Demand instance of those families in the region. A launch past it fails and the group retries. Stopped and pending instances don't count.",
    limit: Setting.quota(PAGES.onDemandQuotas, "Default 5; EC2 raises it automatically with usage, and on request.")
  }),
  ec2SpotStandardVcpus: Setting.int({
    default: STANDARD_VCPU_QUOTA,
    min: 0,
    max: 10_000_000,
    unit: "vCPUs",
    label: "EC2 Spot Standard vCPUs",
    help: "All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests: the vCPUs of running and requested Spot Instances in the region. A Spot launch past it fails and the group retries.",
    limit: Setting.quota(PAGES.spotQuotas, "Default 5; EC2 raises it automatically with usage, and on request.")
  }),
  ec2AutoScalingGroups: Setting.int({
    default: GROUPS_PER_REGION,
    min: 0,
    max: 100_000,
    unit: "groups",
    label: "EC2 Auto Scaling groups",
    help: "Auto Scaling groups per region. Checked by the design audit.",
    limit: Setting.quota(PAGES.quotas)
  })
})
