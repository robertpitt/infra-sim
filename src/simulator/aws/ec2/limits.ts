/**
 * Where AWS documents EC2 Auto Scaling and the EC2 behaviour it builds on, and the numbers taken from those pages. Every
 * constant names its page; README.md lists them all with the kind of limit each is (hard, quota or assumed).
 */

import { docs } from "../docs.ts"

/** The EC2 Auto Scaling user guide. */
export const AS = docs.ec2AutoScaling
/** The EC2 user guide. */
export const EC2 = "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/"

export const PAGES = {
  overview: `${AS}what-is-amazon-ec2-auto-scaling.html`,
  quotas: `${AS}ec2-auto-scaling-quotas.html`,
  healthChecks: `${AS}health-checks-overview.html`,
  grace: `${AS}health-check-grace-period.html`,
  warmup: `${AS}ec2-auto-scaling-default-instance-warmup.html`,
  cooldowns: `${AS}ec2-auto-scaling-scaling-cooldowns.html`,
  termination: `${AS}ec2-auto-scaling-termination-policies.html`,
  protection: `${AS}ec2-auto-scaling-instance-protection.html`,
  warmPools: `${AS}ec2-auto-scaling-warm-pools.html`,
  mixed: `${AS}mixed-instances-groups-set-up-overview.html`,
  distribution: "https://docs.aws.amazon.com/autoscaling/ec2/APIReference/API_InstancesDistribution.html",
  capacityRebalancing: `${AS}ec2-auto-scaling-capacity-rebalancing.html`,
  zones: `${AS}auto-scaling-benefits.html`,
  spotNotice: `${EC2}spot-instance-termination-notices.html`,
  spotQuotas: `${EC2}using-spot-limits.html`,
  onDemandQuotas: `${EC2}ec2-on-demand-instances.html`,
  instanceQuotas: "https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html",
  statusChecks: `${EC2}monitoring-system-instance-status-check.html`,
  unlimited: `${EC2}burstable-performance-instances-unlimited-mode.html`,
  spotAdvisor: "https://aws.amazon.com/ec2/spot/instance-advisor/"
} as const

/**
 * A Spot Instance interruption notice comes two minutes before EC2 stops or terminates the instance
 * (`spot-instance-termination-notices.html`). Hard: nothing extends it.
 */
export const SPOT_NOTICE_MS = 120_000

/**
 * The default health check grace period: 300 seconds for a group created in the console, 0 for one created with the
 * CLI or an SDK (`health-check-grace-period.html`). The simulator's default is the console's.
 */
export const CONSOLE_GRACE_S = 300

/**
 * The default cooldown, 300 seconds (`ec2-auto-scaling-scaling-cooldowns.html`): what target tracking and step scaling
 * policies use as the instance warmup when the group's default instance warmup isn't set
 * (`ec2-auto-scaling-default-instance-warmup.html`), and the value AWS suggests starting from.
 */
export const DEFAULT_COOLDOWN_S = 300

/** On-Demand and Spot vCPU quotas for Standard (A, C, D, H, I, M, R, T, Z) instances: 5 vCPUs each by default (`ec2-instance-quotas.html`). */
export const STANDARD_VCPU_QUOTA = 5

/** Auto Scaling groups per Region: 500 by default, adjustable (`ec2-auto-scaling-quotas.html`). */
export const GROUPS_PER_REGION = 500

/**
 * EC2 runs status checks every minute (`monitoring-system-instance-status-check.html`), and Auto Scaling "waits a few
 * minutes for AWS to fix the issue" before it marks an impaired instance unhealthy (`health-checks-overview.html`). How
 * many is not published: three minutes is the simulator's assumption.
 */
export const STATUS_CHECK_REPLACE_S = 180

/**
 * The share of Spot capacity reclaimed in a month: AWS's Spot Instance Advisor says the average over all Regions and
 * instance types "has historically been <5%". As interruptions per instance-hour (a month is 730 hours) that is about
 * 0.0000685: the simulator's default, an assumption (one band of the advisor, not a promise).
 */
export const SPOT_INTERRUPTIONS_PER_HOUR = 0.05 / 730

/**
 * How far a group may go over its maximum size to launch before terminating (AZ rebalancing, Capacity Rebalancing): 10% of
 * the desired capacity, or one instance, whichever is greater (`auto-scaling-benefits.html`,
 * `ec2-auto-scaling-capacity-rebalancing.html`).
 */
export const overMaxMargin = (desired: number): number => Math.max(1, Math.floor(desired * 0.1))
