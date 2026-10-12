import * as Setting from "../../Setting.ts"
import { FARGATE_LAUNCH_BURST, FARGATE_LAUNCH_RATE, FARGATE_ON_DEMAND_VCPUS, FARGATE_SPOT_VCPUS, PAGES } from "./limits.ts"

/**
 * The account-level quotas ECS on Fargate contributes, per region: the vCPUs every Fargate task in the region shares, and
 * the rate at which tasks can be launched. Each is AWS's published default (`ecs-service.html`), adjustable.
 *
 * AWS publishes one vCPU default for every Region (6), and says new accounts may start lower. The launch rate is 20 tasks
 * a second with a burst of 100 in most Regions and 5 with a burst of 25 in newer ones; the page doesn't list which are
 * newer, so the default is the common one and a design in a newer Region should lower it.
 */
export const quotas = (_region: string) => ({
  fargateOnDemandVcpus: Setting.int({
    default: FARGATE_ON_DEMAND_VCPUS,
    min: 0,
    max: 10_000_000,
    unit: "vCPUs",
    label: "Fargate On-Demand vCPUs",
    help: "The vCPUs of every Fargate (On-Demand) task running in the region, together. A task past it waits in PROVISIONING and is tried again. 6 is the default; established accounts usually have far more.",
    limit: Setting.quota(PAGES.quotas, "Fargate On-Demand vCPU resource count: 6 per Region by default, adjustable. New accounts may start lower.")
  }),
  fargateSpotVcpus: Setting.int({
    default: FARGATE_SPOT_VCPUS,
    min: 0,
    max: 10_000_000,
    unit: "vCPUs",
    label: "Fargate Spot vCPUs",
    help: "The vCPUs of every Fargate Spot task running in the region. Spot tasks past it wait; Fargate never moves them to On-Demand.",
    limit: Setting.quota(PAGES.quotas, "Fargate Spot vCPU resource count: 6 per Region by default, adjustable.")
  }),
  fargateLaunchRate: Setting.number({
    default: FARGATE_LAUNCH_RATE,
    min: 0.01,
    max: 100_000,
    unit: "tasks/s",
    label: "Fargate task launch rate",
    help: "Fargate tasks launched per second in the region, sustained (a token bucket refilled at this rate). Launches past it wait and are tried again. 5 in newer Regions.",
    limit: Setting.quota(PAGES.quotas, "Fargate On-Demand and Spot task launch rate: 20 a second sustained (5 in newer Regions), adjustable.")
  }),
  fargateLaunchBurst: Setting.int({
    default: FARGATE_LAUNCH_BURST,
    min: 1,
    max: 1_000_000,
    unit: "tasks",
    label: "Fargate task launch burst",
    help: "Fargate tasks that can be launched at once before the rate applies. 25 in newer Regions.",
    limit: Setting.quota(PAGES.throttling, "Burst 100 (25 in newer Regions), adjustable.")
  })
})
