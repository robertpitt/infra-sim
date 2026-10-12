/**
 * Where AWS documents Amazon ECS and AWS Fargate, and the numbers the simulator takes from those pages (checked October
 * 2026). Every constant names its page; README.md lists them with the kind of limit each is (hard, quota or assumed).
 */

/** The ECS developer guide and API reference. */
export const DG = "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/"
export const API = "https://docs.aws.amazon.com/AmazonECS/latest/APIReference/"

export const PAGES = {
  quotas: "https://docs.aws.amazon.com/general/latest/gr/ecs-service.html",
  throttling: `${DG}throttling.html`,
  fargateSizes: `${DG}fargate-tasks-services.html#fargate-tasks-size`,
  fargateSpot: `${DG}fargate-capacity-providers.html`,
  fargatePull: `${DG}fargate-pull-behavior.html`,
  ec2Pull: `${DG}pull-behavior.html`,
  taskLifecycle: `${DG}task-lifecycle-explanation.html`,
  taskRecommendations: `${DG}task-recommendations.html`,
  strategy: `${API}API_CapacityProviderStrategyItem.html`,
  serviceParameters: `${DG}service_definition_parameters.html`,
  circuitBreaker: `${DG}deployment-circuit-breaker.html`,
  containerDefinition: `${API}API_ContainerDefinition.html`,
  healthCheck: `${API}API_HealthCheck.html`,
  managedScaling: `${API}API_ManagedScaling.html`,
  clusterAutoScaling: `${DG}cluster-auto-scaling.html`,
  terminationProtection: `${DG}managed-termination-protection.html`,
  managedDraining: `${DG}managed-instance-draining.html`,
  placement: `${DG}task-placement-strategies.html`,
  serviceAutoScaling: `${DG}service-autoscaling-targettracking.html`,
  rebalancing: `${DG}service-rebalancing.html`,
  throttleLogic: `${DG}service-throttle-logic.html`
} as const

// ---------------------------------------------------------------------------------------------------------
// Hard limits (`ecs-service.html`: not adjustable)
// ---------------------------------------------------------------------------------------------------------

/** Tasks per service: 5,000, not adjustable. */
export const TASKS_PER_SERVICE = 5_000
/** Container instances per cluster: 5,000, not adjustable. */
export const INSTANCES_PER_CLUSTER = 5_000
/** Tasks in PROVISIONING per cluster (EC2 Auto Scaling group capacity providers only): 500, not adjustable. */
export const PROVISIONING_PER_CLUSTER = 500
/** Tasks a service launches per minute: 500 on Fargate (125 in newer Regions) and on EC2, not adjustable. */
export const SERVICE_LAUNCHES_PER_MINUTE = 500

// ---------------------------------------------------------------------------------------------------------
// Quotas (adjustable account defaults per Region, `ecs-service.html`)
// ---------------------------------------------------------------------------------------------------------

/** Fargate On-Demand vCPU resource count: 6 per Region, adjustable ("new AWS accounts might have initial lower quotas"). */
export const FARGATE_ON_DEMAND_VCPUS = 6
/** Fargate Spot vCPU resource count: 6 per Region, adjustable. */
export const FARGATE_SPOT_VCPUS = 6
/**
 * Fargate task launch rate: a token bucket of 100 refilled at 20 a second (25 and 5 in newer Regions), adjustable
 * (`ecs-service.html`, `throttling.html`: "tasks and pods token bucket size … 100 tokens, refill rate 20 tokens per second").
 */
export const FARGATE_LAUNCH_BURST = 100
export const FARGATE_LAUNCH_RATE = 20

// ---------------------------------------------------------------------------------------------------------
// Service and task defaults
// ---------------------------------------------------------------------------------------------------------

/** `maximumPercent` defaults to 200 and `minimumHealthyPercent` to 100 for a REPLICA service (`service_definition_parameters.html`). */
export const MAXIMUM_PERCENT = 200
export const MINIMUM_HEALTHY_PERCENT = 100
/**
 * With no container health check and no load balancer, the scheduler counts a task healthy 40 seconds after it is
 * RUNNING (`service_definition_parameters.html`). The simulator uses it as the time a new task needs to count as healthy
 * in a deployment; with a load balancer AWS waits for the target to pass its checks, which an ALB's first check (every
 * 30 s) makes about as long.
 */
export const HEALTHY_AFTER_RUNNING_MS = 40_000
/** The circuit breaker's threshold: half the desired count, rounded up, at least 3 and at most 200 (`deployment-circuit-breaker.html`). */
export const breakerThreshold = (desired: number): number => Math.min(200, Math.max(3, Math.ceil(0.5 * desired)))
/** `stopTimeout`: 30 s by default, 2-120 s on Fargate (`API_ContainerDefinition.html`). */
export const STOP_TIMEOUT_S = 30
export const STOP_TIMEOUT_MIN_S = 2
export const STOP_TIMEOUT_MAX_S = 120
/** A Fargate Spot task is interrupted with a two-minute warning (`fargate-capacity-providers.html`). */
export const SPOT_WARNING_MS = 120_000

// ---------------------------------------------------------------------------------------------------------
// Capacity providers on EC2 (`API_ManagedScaling.html`, `cluster-auto-scaling.html`)
// ---------------------------------------------------------------------------------------------------------

/** `targetCapacity` 1-100, default 100. */
export const TARGET_CAPACITY = 100
/** `minimumScalingStepSize` default 1, `maximumScalingStepSize` default 10,000 (both 1-10,000). */
export const MIN_SCALING_STEP = 1
export const MAX_SCALING_STEP = 10_000
/** Scaling out from zero instances launches two (`cluster-auto-scaling.html`). */
export const SCALE_OUT_FROM_ZERO = 2
/**
 * Scale-in: the CapacityProviderReservation alarm needs 15 data points (15 minutes) below the target, and ECS waits 15
 * minutes after a scale-out before any scale-in (`cluster-auto-scaling.html`).
 */
export const SCALE_IN_AFTER_MS = 15 * 60_000
/** The metric is published every minute; the scale-out alarm acts on one data point. */
export const METRIC_PERIOD_MS = 60_000

// ---------------------------------------------------------------------------------------------------------
// Assumptions (AWS publishes no figure)
// ---------------------------------------------------------------------------------------------------------

/**
 * PROVISIONING on Fargate: finding capacity and attaching the task's ENI. AWS says only that the awsvpc ENI "adds an
 * overhead of several seconds" (`task-recommendations.html`). Assumed 10 s.
 */
export const FARGATE_PROVISIONING_MS = 10_000
/** PROVISIONING on an EC2 instance: attaching the ENI in awsvpc mode, "several seconds". Assumed 5 s. */
export const EC2_PROVISIONING_MS = 5_000
/**
 * How fast an image is pulled and unpacked, in MiB a second. AWS says only that pull time grows with image size
 * (`fargate-pull-behavior.html`), and that a large image on EC2 "might take 10-20 seconds" (`pull-behavior.html`).
 * Assumed 25 MiB/s, so a 500 MiB image takes 20 s.
 */
export const PULL_MIB_PER_S = 25
/** With SOCI lazy loading "containers only spend a few seconds on the image pull" (`fargate-pull-behavior.html`). Assumed 3 s. */
export const LAZY_PULL_MS = 3_000
/** An image already on an EC2 instance: the pull only checks the manifest. Assumed 1 s. */
export const CACHED_PULL_MS = 1_000
/** How long ECS takes to notice a task whose host or zone is gone and replace it. Assumed 60 s. */
export const LOST_TASK_MS = 60_000
/** An ECS container instance, once EC2 has booted it: the ECS agent starts and registers with the cluster. Assumed 15 s. */
export const AGENT_REGISTER_MS = 15_000
/** How often the service scheduler tries again to launch tasks a quota or the launch rate refused. Assumed 5 s. */
export const LAUNCH_RETRY_MS = 5_000
/**
 * A container health check that fails from the start: the task is marked UNHEALTHY after `retries` failed checks
 * `interval` apart, by default 3 and 30 s (`API_HealthCheck.html`), with no start period: 90 s after RUNNING.
 */
export const UNHEALTHY_AFTER_MS = 3 * 30_000
/** A task whose essential container exits as it starts: how long after the container starts. Assumed 5 s. */
export const CRASH_AFTER_MS = 5_000
