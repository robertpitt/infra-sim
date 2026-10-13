import { Schema } from "effect"
import * as Setting from "../../../Setting.ts"
import { DEFAULT_INSTANCE_TYPE, INSTANCE_TYPE_NAMES } from "../../ec2/InstanceTypes.ts"
import { PAGES as EC2_PAGES, SPOT_INTERRUPTIONS_PER_HOUR, STATUS_CHECK_REPLACE_S } from "../../ec2/Limits.ts"
import { CPU_LABELS, CPU_UNITS } from "./fargate.ts"
import {
  AGENT_REGISTER_MS,
  LOST_TASK_MS,
  MAX_SCALING_STEP,
  MAXIMUM_PERCENT,
  MIN_SCALING_STEP,
  MINIMUM_HEALTHY_PERCENT,
  PAGES,
  PULL_MIB_PER_S,
  STOP_TIMEOUT_MAX_S,
  STOP_TIMEOUT_MIN_S,
  STOP_TIMEOUT_S,
  TARGET_CAPACITY,
  TASKS_PER_SERVICE
} from "./limits.ts"

/**
 * An ECS service's settings: the service (desired count, where its tasks run), its task definition (size, image, the
 * application's work), how it deploys, and its capacity: Fargate with a capacity provider strategy, or an EC2 Auto Scaling
 * group capacity provider with managed scaling.
 */
export const Config = Schema.Struct({
  desiredCount: Setting.int({
    default: 2,
    min: 0,
    max: TASKS_PER_SERVICE,
    unit: "tasks",
    label: "Desired count",
    help: "How many tasks the service keeps running. Service auto scaling (a target-tracking controller, setting: desiredCount) drives it. At most 5,000 tasks per service.",
    limit: Setting.hard(PAGES.quotas, "Tasks per service: 5,000, not adjustable.")
  }),
  launchType: Setting.choice(["FARGATE", "EC2"], {
    default: "FARGATE",
    labels: { FARGATE: "Fargate", EC2: "EC2 (Auto Scaling group capacity provider)" },
    label: "Capacity",
    help: "Fargate: each task gets its own capacity, counted against the region's Fargate vCPU quotas. EC2: tasks are placed on the container instances of an Auto Scaling group the service scales with managed scaling (the EC2 group below). Read when the simulation starts: a change applies on the next run."
  }),
  zones: Setting.int({
    default: 3,
    min: 1,
    max: 6,
    unit: "zones",
    label: "Availability Zones",
    help: "The service's subnets are in this many zones of its region (the first ones). Tasks spread over them, the emptiest first, as ECS's default spread over ecs.availability-zone does; on EC2 the instances spread over them too. A zone outage takes the tasks there with it."
  }),
  task: Setting.group(
    {
      revision: Setting.int({
        default: 1,
        min: 1,
        max: 1_000_000,
        label: "Task definition revision",
        help: "Change it to deploy a new task definition: a rolling deployment replaces every task, within the deployment's minimum healthy and maximum percent. The image, start-up and failure below belong to the revision that is current when they are set."
      }),
      cpu: Setting.choice(CPU_UNITS, {
        default: "1024",
        labels: CPU_LABELS,
        label: "CPU",
        help: "The task's CPU (1,024 units to a vCPU). It sets how many requests a task works on at once (with requests per vCPU) and what it counts against the Fargate vCPU quota, or takes on an instance."
      }),
      memory: Setting.int({
        default: 2048,
        min: 512,
        max: 249_856,
        unit: "MiB",
        label: "Memory",
        help: "The task's memory. Fargate accepts only certain pairs: 0.25 vCPU with 512, 1024 or 2048 MiB; 0.5 vCPU 1-4 GB; 1 vCPU 2-8 GB; 2 vCPU 4-16 GB; 4 vCPU 8-30 GB (1 GB steps); 8 vCPU 16-60 GB (4 GB steps); 16 vCPU 32-120 GB (8 GB steps); 32 vCPU 60, 120 or 244 GB. Other values run as the next size up (the design check says so). On EC2 it is what an instance must have free.",
        limit: Setting.hard(PAGES.fargateSizes)
      }),
      requestsPerVcpu: Setting.int({
        default: 10,
        min: 1,
        max: 10_000,
        unit: "requests",
        label: "Requests per vCPU",
        help: "How many requests a task works on at once, per vCPU (at least one per task): its threads or event loop's practical limit. CPU utilization is the share of them busy. An assumption about your application."
      }),
      serviceTime: Setting.latency({ mean: "50 millis", cv: 0.5, label: "Service time", help: "How long a request keeps one of the task's workers busy, before any downstream calls." }),
      imageSize: Setting.int({
        default: 300,
        min: 1,
        max: 20_000,
        unit: "MiB",
        label: "Image size",
        help: "The container image, compressed. Fargate keeps no image cache, so every task pulls all of it; pull time grows with size (AWS recommends lazy loading over 250 MiB). On EC2 a task on an instance that already has the image skips the download."
      }),
      lazyLoading: Setting.bool({
        default: false,
        label: "SOCI lazy loading",
        help: "Seekable OCI: the task starts after pulling only an index and fetches the rest as it is read, so containers 'only spend a few seconds on the image pull'. Needs Fargate platform 1.4.0 and a private ECR image with a SOCI index."
      }),
      pullRate: Setting.int({
        default: PULL_MIB_PER_S,
        min: 1,
        max: 10_000,
        unit: "MiB/s",
        label: "Pull rate",
        help: "How fast an image is downloaded and unpacked. An assumption: AWS publishes none (a large image on EC2 'might take 10-20 seconds')."
      }),
      appStart: Setting.duration({
        default: "5 seconds",
        min: 0,
        max: "30 minutes",
        label: "Application start",
        help: "From the container starting until the application serves. An assumption about your application."
      }),
      failure: Setting.choice(["none", "crash", "unhealthy"], {
        default: "none",
        labels: { none: "None: it works", crash: "Crashes as it starts", unhealthy: "Fails its health checks" },
        label: "What's wrong with it",
        help: "A bad revision. Crashes: the essential container exits as it starts, so the task stops before RUNNING. Fails its health checks: it runs, answers every request with 500, and its container health check marks it UNHEALTHY after 90 s (3 checks 30 s apart; a target group's checks may find it sooner). ECS replaces such tasks; the deployment circuit breaker counts them."
      })
    },
    { label: "Task definition" }
  ),
  queueLimit: Setting.int({
    default: 100,
    min: 0,
    max: 10_000_000,
    unit: "requests",
    label: "Queue limit",
    help: "Requests that may wait for a free worker: in one line in front of the service when it is called directly, or in front of each task when a load balancer's target group picks tasks. Beyond it they are refused at once with 503. An assumption about your application's accept queue."
  }),
  fanOut: Setting.choice(["sequential", "parallel", "weighted", "none"], {
    default: "sequential",
    label: "Downstream calls",
    help: "After its own work, call every output one after another, all at once, pick one by weight, or call none."
  }),
  healthCheckGracePeriod: Setting.duration({
    default: 0,
    min: 0,
    max: "7 days",
    label: "Health check grace period",
    help: "healthCheckGracePeriodSeconds: how long after a task starts ECS ignores failing load balancer and container health checks. Default 0 (AWS allows up to 2,147,483,647 s).",
    limit: Setting.hard(PAGES.serviceParameters)
  }),
  stopTimeout: Setting.duration({
    default: `${STOP_TIMEOUT_S} seconds`,
    min: `${STOP_TIMEOUT_MIN_S} seconds`,
    max: `${STOP_TIMEOUT_MAX_S} seconds`,
    label: "Stop timeout",
    help: "From SIGTERM to SIGKILL when a task is stopped (scaled in, replaced, deployed over, or interrupted on Fargate Spot): it takes no new requests and finishes what it holds meanwhile. 30 s by default, 2-120 s on Fargate. A load balancer's deregistration delay can keep a draining task longer.",
    limit: Setting.hard(PAGES.containerDefinition)
  }),
  lostTaskDetection: Setting.duration({
    default: `${LOST_TASK_MS / 1000} seconds`,
    min: 0,
    max: "1 hour",
    label: "Notices a lost task after",
    help: "How long until ECS notices on its own that a task died with its host or zone and starts another. An assumption: AWS publishes no figure. A target group's health checks may notice sooner."
  }),
  deployment: Setting.group(
    {
      minimumHealthyPercent: Setting.int({
        default: MINIMUM_HEALTHY_PERCENT,
        min: 0,
        max: 100,
        unit: "%",
        label: "Minimum healthy percent",
        help: "During a deployment, at least this share of the desired count (rounded up) stays healthy: old tasks are stopped only while it holds. A new task counts as healthy 40 s after it is RUNNING.",
        limit: Setting.hard(PAGES.serviceParameters)
      }),
      maximumPercent: Setting.int({
        default: MAXIMUM_PERCENT,
        min: 100,
        max: 1_000,
        unit: "%",
        label: "Maximum percent",
        help: "During a deployment, at most this share of the desired count (rounded down) runs or is pending, old and new together: room to start new tasks before stopping old ones. AWS publishes no upper bound; the simulator allows 1,000%.",
        limit: Setting.hard(PAGES.serviceParameters)
      }),
      circuitBreaker: Setting.bool({
        default: false,
        label: "Deployment circuit breaker",
        help: "Fail a deployment whose new tasks keep failing: half the desired count of failures (at least 3, at most 200), counting tasks that stop before RUNNING and tasks that fail health checks. A healthy new task resets the count. A failed deployment launches no more new tasks."
      }),
      rollback: Setting.bool({
        default: true,
        label: "Roll back on failure",
        help: "With the circuit breaker: a failed deployment rolls back to the last revision that completed, replacing the failed revision's tasks."
      })
    },
    { label: "Deployment (rolling update)" }
  ),
  fargate: Setting.group(
    {
      base: Setting.int({
        default: 0,
        min: 0,
        max: 100_000,
        unit: "tasks",
        label: "FARGATE base",
        help: "The first tasks always run on Fargate (On-Demand) capacity; the rest are split by weight.",
        limit: Setting.hard(PAGES.strategy)
      }),
      weight: Setting.int({ default: 1, min: 0, max: 1_000, label: "FARGATE weight", help: "Relative share of tasks beyond the base on Fargate (On-Demand). 0 places none there.", limit: Setting.hard(PAGES.strategy) }),
      spotWeight: Setting.int({
        default: 0,
        min: 0,
        max: 1_000,
        label: "FARGATE_SPOT weight",
        help: "Relative share of tasks beyond the base on Fargate Spot: spare capacity at a discount, taken back with a two-minute warning. Fargate never falls back to On-Demand when Spot is short; the tasks wait.",
        limit: Setting.hard(PAGES.strategy)
      }),
      spotInterruptionsPerTaskHour: Setting.number({
        default: SPOT_INTERRUPTIONS_PER_HOUR,
        min: 0,
        max: 1_000,
        step: 0.0001,
        unit: "per task-hour",
        label: "Spot interruptions",
        help: "How often a Fargate Spot task is interrupted. AWS publishes no rate: the default is EC2's Spot Instance Advisor's under 5% a month, an assumption. Raise it in a scenario for an interruption wave. Each interrupted task gets SIGTERM at the warning and stops after its stop timeout; a replacement starts at once, on whatever capacity the strategy picks."
      })
    },
    { label: "Fargate capacity provider strategy" }
  ),
  ec2: Setting.group(
    {
      instanceType: Setting.choice(INSTANCE_TYPE_NAMES, {
        default: DEFAULT_INSTANCE_TYPE,
        label: "Instance type",
        help: "The Auto Scaling group's instances: tasks are packed into their vCPUs and memory, and they count against the region's EC2 On-Demand vCPU quota."
      }),
      minSize: Setting.int({ default: 0, min: 0, max: 5_000, unit: "instances", label: "Minimum size" }),
      maxSize: Setting.int({
        default: 10,
        min: 0,
        max: 5_000,
        unit: "instances",
        label: "Maximum size",
        help: "At most 5,000 container instances per cluster.",
        limit: Setting.hard(PAGES.quotas)
      }),
      desiredSize: Setting.int({
        default: 2,
        min: 0,
        max: 5_000,
        unit: "instances",
        label: "Instances at the start",
        help: "How many instances the group runs when the simulation starts. Managed scaling moves it from there."
      }),
      managedScaling: Setting.bool({
        default: true,
        label: "Managed scaling",
        help: "ECS scales the group on CapacityProviderReservation (instances needed ÷ instances running × 100) toward the target capacity: out after one minute's data point, in after 15 minutes of them and 15 minutes after a scale-out. Off: the group stays at its starting size."
      }),
      targetCapacity: Setting.int({
        default: TARGET_CAPACITY,
        min: 1,
        max: 100,
        unit: "%",
        label: "Target capacity",
        help: "100: no spare instances. Lower keeps spare ones, so new tasks start without waiting for an instance (90: about a tenth spare).",
        limit: Setting.hard(PAGES.managedScaling)
      }),
      minimumScalingStepSize: Setting.int({ default: MIN_SCALING_STEP, min: 1, max: 10_000, unit: "instances", label: "Minimum scaling step", limit: Setting.hard(PAGES.managedScaling) }),
      maximumScalingStepSize: Setting.int({ default: MAX_SCALING_STEP, min: 1, max: 10_000, unit: "instances", label: "Maximum scaling step", limit: Setting.hard(PAGES.managedScaling) }),
      managedTerminationProtection: Setting.bool({
        default: false,
        label: "Managed termination protection",
        help: "Instances running tasks are protected from scale-in: only empty ones are terminated, so the group may stay larger than managed scaling asks until binpacking empties some."
      }),
      managedDraining: Setting.bool({
        default: true,
        label: "Managed instance draining",
        help: "An instance being terminated is drained first: its tasks are replaced elsewhere and stop gracefully. On by default. Off: they stop with the instance."
      }),
      placement: Setting.choice(["spread", "binpack"], {
        default: "spread",
        labels: { spread: "Spread over instances", binpack: "Binpack on memory" },
        label: "Placement strategy",
        help: `Within a zone, the instance with the most room (spread on instanceId) or the least memory left that fits (binpack), which empties whole instances for scale-in. Zones come first either way, as ECS's default spread over ecs.availability-zone does (${PAGES.placement}).`
      }),
      pending: Setting.duration({ default: "30 seconds", min: 0, max: "15 minutes", label: "Instance pending", help: "From launch until EC2 reports it running. An assumption." }),
      boot: Setting.duration({ default: "30 seconds", min: 0, max: "15 minutes", label: "Instance boot", help: "The operating system boots. An assumption." }),
      register: Setting.duration({
        default: `${AGENT_REGISTER_MS / 1000} seconds`,
        min: 0,
        max: "15 minutes",
        label: "Agent registers",
        help: "The ECS container agent starts and registers the instance with the cluster: then tasks can be placed on it. An assumption."
      }),
      replaceAfter: Setting.duration({
        default: `${STATUS_CHECK_REPLACE_S} seconds`,
        min: 0,
        max: "1 hour",
        label: "Replaces a failed instance after",
        help: `How long until the group finds an instance dead (EC2 status checks) and replaces it; its tasks are replaced then too, if ECS hasn't already. An assumption: AWS says it waits "a few minutes" (${EC2_PAGES.healthChecks}).`
      })
    },
    { label: "EC2 capacity provider (Auto Scaling group)" }
  )
})

export type Settings = typeof Config.Type
