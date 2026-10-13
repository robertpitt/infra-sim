import { Schema } from "effect"
import * as Setting from "../../../Setting.ts"
import { DEFAULT_INSTANCE_TYPE, INSTANCE_TYPE_NAMES } from "../InstanceTypes.ts"
import { CONSOLE_GRACE_S, DEFAULT_COOLDOWN_S, PAGES, SPOT_INTERRUPTIONS_PER_HOUR, STATUS_CHECK_REPLACE_S } from "../Limits.ts"

/**
 * An Auto Scaling group's settings. Names follow the AWS API where there is one (`minSize`, `maxSize`,
 * `desiredCapacity`, `healthCheckType`, `onDemandBaseCapacity`...), so a design reads like the group it models. Numbers
 * AWS doesn't publish (how long an instance takes to boot, what an application needs to start) say so in their help.
 */

/** The largest group the simulator runs. AWS publishes no maximum group size; this bounds the forms, not AWS. */
export const MAX_GROUP = 10_000

export const TERMINATION_POLICIES = ["Default", "OldestInstance", "NewestInstance", "ClosestToNextInstanceHour"] as const
export type TerminationPolicy = (typeof TERMINATION_POLICIES)[number]

export const WARM_POOL_STATES = ["Stopped", "Running", "Hibernated"] as const
export type WarmPoolState = (typeof WARM_POOL_STATES)[number]

export const Config = Schema.Struct({
  instanceType: Setting.choice(INSTANCE_TYPE_NAMES, {
    default: DEFAULT_INSTANCE_TYPE,
    label: "Instance type",
    help: "From the launch template. Its vCPUs set how many requests an instance works on at once (with requests per vCPU) and what it counts against the account's vCPU quotas. A change applies to every instance at once (the simulator has no instance refresh)."
  }),
  minSize: Setting.int({ default: 2, min: 0, max: MAX_GROUP, unit: "instances", label: "Minimum size", help: "MinSize: the group never has fewer, whatever its desired capacity says." }),
  maxSize: Setting.int({
    default: 10,
    min: 0,
    max: MAX_GROUP,
    unit: "instances",
    label: "Maximum size",
    help: "MaxSize: the group never has more, except briefly while rebalancing zones (up to 10% or one instance over). A warm pool holds MaxSize minus desired by default."
  }),
  desiredCapacity: Setting.int({
    default: 2,
    min: 0,
    max: MAX_GROUP,
    unit: "instances",
    label: "Desired capacity",
    help: "How many instances it should run, kept between the minimum and maximum. A target-tracking controller drives this (setting: desiredCapacity). Instances it adds take the launch time to serve; instances it removes are terminated by the termination policy."
  }),
  availabilityZones: Setting.int({
    default: 3,
    min: 1,
    max: 6,
    unit: "zones",
    label: "Availability Zones",
    help: "The group's subnets: the first N zones of its region. Launches go to the zone with the fewest instances; a zone outage loses its instances, which are replaced in the other zones, and the group rebalances (AZRebalance) when the zone is back.",
    limit: Setting.hard(PAGES.zones, "As many as the region has: us-east-1 has six.")
  }),
  requestsPerVcpu: Setting.int({
    default: 1,
    min: 1,
    max: 1_000,
    unit: "requests",
    label: "Requests per vCPU",
    help: "How many requests one vCPU works on at once. 1 for CPU-bound work, where a request holds a vCPU for its service time and busy workers are CPU utilization; more for an application whose threads block on I/O. A modelling choice, not an AWS figure."
  }),
  serviceTime: Setting.latency({ mean: "50 millis", cv: 0.5, label: "Service time", help: "How long a request keeps a worker (a vCPU) busy, before any downstream calls. An instance releases the worker while it waits on downstream calls." }),
  queueLimit: Setting.int({
    default: 100,
    min: 0,
    max: 100_000,
    unit: "requests",
    label: "Queue per instance",
    help: "Requests that may wait for a worker on each instance (the server's accept backlog). Past it a request is refused with 503. Called through a plain edge, the group has one line of this many per serving instance. An assumption about the application."
  }),
  errorRate: Setting.ratio({ default: 0, label: "Error rate", help: "Fraction of requests the application fails (500) after working on them." }),
  fanOut: Setting.choice(["sequential", "parallel", "weighted", "none"], {
    default: "sequential",
    label: "Downstream calls",
    help: "After its own work, call every output one after another, all at once, pick one by weight, or call none."
  }),
  launch: Setting.group(
    {
      pending: Setting.duration({
        default: "30 seconds",
        min: 0,
        max: "15 minutes",
        label: "Pending",
        help: "From the launch request until the instance is running: EC2 finds a host and starts it. AWS publishes no figure: an assumption."
      }),
      boot: Setting.duration({ default: "30 seconds", min: 0, max: "15 minutes", label: "Boot", help: "The operating system boots and cloud-init starts. An assumption: it depends on the AMI." }),
      userData: Setting.duration({
        default: "90 seconds",
        min: 0,
        max: "1 hour",
        label: "User data",
        help: "The user data script: installing packages, fetching the application and its configuration. The part a warm pool saves. An assumption: it is your script."
      }),
      appStart: Setting.duration({
        default: "30 seconds",
        min: 0,
        max: "1 hour",
        label: "Application start",
        help: "The application starts and is ready to serve (and to pass a load balancer's health check). An assumption."
      })
    },
    { label: "Launch timings", help: "What a new instance goes through before it is InService: about three minutes by default. AWS publishes none of these numbers." }
  ),
  healthCheckType: Setting.choice(["EC2", "ELB"], {
    default: "EC2",
    labels: { EC2: "EC2 status checks", ELB: "EC2 and ELB health checks" },
    label: "Health check type",
    help: "EC2 (the default): an instance is replaced only when it stops running or fails its status checks. ELB: also when the load balancer's target group reports it unhealthy, so an instance whose application is broken is replaced too (wire it through a target group)."
  }),
  healthCheckGracePeriod: Setting.duration({
    default: `${CONSOLE_GRACE_S} seconds`,
    min: 0,
    max: "2 hours",
    label: "Health check grace period",
    help: "How long after a new instance is InService before its health checks count. 300 seconds is the console's default; a group created with the CLI or an SDK gets 0. An instance found dead during it is replaced when it ends."
  }),
  statusCheckReplace: Setting.duration({
    default: `${STATUS_CHECK_REPLACE_S} seconds`,
    min: 0,
    max: "30 minutes",
    label: "Replaces an impaired instance after",
    help: "How long until Auto Scaling replaces an instance that stopped answering (its zone failed, its host died). EC2 runs status checks every minute and Auto Scaling waits 'a few minutes' before acting: three is an assumption. With ELB health checks a target group may notice sooner."
  }),
  defaultInstanceWarmup: Setting.duration({
    default: `${DEFAULT_COOLDOWN_S} seconds`,
    min: 0,
    max: "1 hour",
    label: "Instance warmup",
    help: "How long after an instance is InService before its CPU counts in the group's average (the cpu gauge, and cpuTotal through it), so start-up doesn't skew scaling. Not set by default, in which case scaling policies use the default cooldown, 300 seconds: the default here."
  }),
  shutdownGrace: Setting.duration({
    default: "30 seconds",
    min: 0,
    max: "1 hour",
    label: "Shutdown grace",
    help: "How long an instance being terminated (scale-in, replacement, rebalancing) has to finish its in-flight requests, when nothing else holds it (a target group holds it for its deregistration delay). The application's own SIGTERM handling: an assumption."
  }),
  terminationPolicy: Setting.choice(TERMINATION_POLICIES, {
    default: "Default",
    label: "Termination policy",
    help: "Which instance goes on scale-in, after the zones are balanced (always first). Default: the purchase option out of proportion first, then the instance closest to its next billing hour. Oldest or newest instance. ClosestToNextInstanceHour."
  }),
  brokenLaunches: Setting.ratio({
    default: 0,
    label: "Broken launches",
    help: "Share of new instances whose application never becomes healthy: a bad AMI or launch template version, user data that fails. They run (EC2 status checks pass) but fail a load balancer's health checks and answer every request with 500. With ELB health checks they are replaced, again and again."
  }),
  warmPool: Setting.group(
    {
      enabled: Setting.bool({ default: false, label: "Enabled", help: "Keep pre-initialised instances beside the group, so a scale-out starts them instead of launching from scratch." }),
      poolState: Setting.choice(WARM_POOL_STATES, {
        default: "Stopped",
        label: "Pool state",
        help: "Stopped: start, boot and start the application (user data already ran). Hibernated: start with memory restored, so the application is already up. Running: ready at once, but paid for and counted against the vCPU quota like any running instance."
      }),
      minSize: Setting.int({ default: 0, min: 0, max: MAX_GROUP, unit: "instances", label: "Minimum size", help: "Instances kept in the pool however large the group is. AWS's default is none." }),
      maxGroupPreparedCapacity: Setting.int({
        default: 0,
        min: 0,
        max: MAX_GROUP,
        unit: "instances",
        label: "Maximum prepared capacity",
        help: "The pool holds this minus the desired capacity (at least its minimum). 0: not set, so the pool holds the maximum size minus the desired capacity, AWS's default."
      })
    },
    { label: "Warm pool", help: "Pre-initialised instances that start much faster than a launch. Not available with Spot Instances." }
  ),
  spot: Setting.group(
    {
      onDemandBaseCapacity: Setting.int({
        default: 0,
        min: 0,
        max: MAX_GROUP,
        unit: "instances",
        label: "On-Demand base",
        help: "The first instances of the group are On-Demand. AWS's default is 0."
      }),
      onDemandPercentageAboveBase: Setting.int({
        default: 100,
        min: 0,
        max: 100,
        unit: "%",
        label: "On-Demand above base",
        help: "The share of instances beyond the base that are On-Demand; the rest are Spot. A fraction rounds up in favour of On-Demand. AWS's default is 100: no Spot.",
        limit: Setting.hard(PAGES.distribution)
      }),
      interruptionsPerHour: Setting.number({
        default: SPOT_INTERRUPTIONS_PER_HOUR,
        min: 0,
        max: 100,
        step: 0.0001,
        unit: "per instance-hour",
        label: "Interruption rate",
        help: "How often EC2 reclaims a Spot Instance. AWS's Spot Instance Advisor puts the historical average under 5% of instances a month, about 0.00007 an hour: the default, an assumption. Raise it for an interruption storm."
      }),
      insufficientCapacity: Setting.ratio({
        default: 0,
        label: "Launches without capacity",
        help: "Share of Spot launch attempts EC2 can't fulfil (InsufficientInstanceCapacity). The group keeps retrying Spot; it never falls back to On-Demand. An assumption to set, not an AWS figure."
      }),
      capacityRebalance: Setting.bool({
        default: false,
        label: "Capacity Rebalancing",
        help: "On a rebalance recommendation, launch a replacement and terminate the at-risk instance once the new one is InService, instead of waiting for the interruption. Off by default."
      }),
      rebalanceLead: Setting.duration({
        default: "5 minutes",
        min: 0,
        max: "1 hour",
        label: "Recommendation lead",
        help: "How long before the two-minute interruption notice the rebalance recommendation arrives. AWS says it may come earlier or with the notice, and publishes no figure: an assumption."
      })
    },
    { label: "Spot and On-Demand", help: "The group's instances distribution: how many are Spot, how often Spot is reclaimed (with a two-minute notice), and Capacity Rebalancing." }
  ),
  scaleInProtection: Setting.bool({
    default: false,
    label: "Protect new instances from scale-in",
    help: "NewInstancesProtectedFromScaleIn: instances the group launches while this is on are protected, so lowering the desired capacity terminates none of them and the group stays larger. Turning it off doesn't unprotect them (AWS's per-instance SetInstanceProtection isn't simulated). Health-check replacement and Spot interruptions still take them. Instances there at the start are not protected."
  })
})

export type Settings = typeof Config.Type
