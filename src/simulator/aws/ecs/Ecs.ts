import { Duration, Effect, Schema, Stream, SubscriptionRef } from "effect"
import * as Component from "../../Component.ts"
import { Fleet, type Phase } from "../../fleet/Fleet.ts"
import type { Unit } from "../../Protocol.ts"
import * as Aws from "../provider.ts"
import * as Vcpus from "../ec2/vcpus.ts"
import { Ec2Capacity } from "./capacity.ts"
import { Config, type Settings } from "./config.ts"
import { dashboard } from "./dashboard.ts"
import { Deployments } from "./deployment.ts"
import * as Fargate from "./fargate.ts"
import {
  CACHED_PULL_MS,
  CRASH_AFTER_MS,
  EC2_PROVISIONING_MS,
  FARGATE_PROVISIONING_MS,
  HEALTHY_AFTER_RUNNING_MS,
  LAUNCH_RETRY_MS,
  LAZY_PULL_MS,
  PAGES,
  PROVISIONING_PER_CLUSTER,
  SERVICE_LAUNCHES_PER_MINUTE,
  UNHEALTHY_AFTER_MS
} from "./limits.ts"
import { handler, type WorkHost } from "./work.ts"

/** How often the Spot interruption process looks again at the rate and the Spot tasks running. */
const SPOT_RECHECK_MS = 10_000
/** Units listed in a probe at most. */
const PROBE_UNITS = 200

const TaskState = Schema.Struct({
  name: Schema.String,
  zone: Schema.optionalKey(Schema.String),
  state: Schema.String,
  phase: Schema.optionalKey(Schema.String),
  alive: Schema.Boolean,
  revision: Schema.Number,
  capacity: Schema.String,
  instance: Schema.optionalKey(Schema.String),
  busy: Schema.Number
})

export const State = Schema.Struct({
  /** Tasks RUNNING (serving): in their grace period or in service, not counting dead ones not yet noticed. */
  running: Schema.Number,
  /** Tasks on their way: waiting for capacity (PROVISIONING) or starting. */
  pending: Schema.Number,
  /** Tasks waiting for capacity: a Fargate quota, the launch rate, or room on an instance. */
  provisioning: Schema.Number,
  draining: Schema.Number,
  busy: Schema.Number,
  queued: Schema.Number,
  served: Schema.Number,
  errors: Schema.Number,
  refused: Schema.Number,
  lost: Schema.Number,
  replaced: Schema.Number,
  interrupted: Schema.Number,
  /** Tasks (running or starting) on Fargate Spot, and on Fargate On-Demand. */
  spot: Schema.Number,
  onDemand: Schema.Number,
  deployment: Schema.Struct({
    state: Schema.String,
    revision: Schema.Number,
    stable: Schema.Number,
    failures: Schema.Number,
    threshold: Schema.Number,
    oldTasks: Schema.Number,
    newTasks: Schema.Number,
    rollbacks: Schema.Number
  }),
  instances: Schema.optionalKey(Schema.Struct({
    running: Schema.Number,
    launching: Schema.Number,
    desired: Schema.Number,
    reservation: Schema.Number,
    cpuReservation: Schema.Number,
    memoryReservation: Schema.Number
  })),
  tasks: Schema.Array(TaskState)
})

/**
 * An Amazon ECS service: a number of copies of one task definition, kept running by the service scheduler, on AWS Fargate
 * or on the EC2 instances of an Auto Scaling group capacity provider.
 *
 * Each task is a unit of the fleet core (`fleet/Fleet.ts`): it is launched (waiting for capacity in PROVISIONING if there
 * is none: a Fargate vCPU quota, the launch rate, room on an instance), provisioned (its ENI), activated (its image pulled,
 * which takes longer the larger the image, unless it is already on the instance or lazily loaded), started, and then
 * serves: so many requests at once as its vCPUs allow, each for the service time, then calls downstream. It spreads its
 * tasks over its zones; a zone outage takes the tasks there, which ECS replaces elsewhere once it notices.
 *
 * Service auto scaling is a `core.target-tracking` controller on `desiredCount` (CPU per task, or requests per task as
 * ALB's request count per target). A new task definition revision is a rolling deployment (`deployment.ts`) with the
 * circuit breaker. On Fargate, a capacity provider strategy puts a share of tasks on Fargate Spot, which interrupts them
 * with a two-minute warning. On EC2 (`capacity.ts`), tasks are placed on container instances and managed scaling grows
 * the group when they can't be: two-level scaling.
 */
export const Ecs = Aws.component({
  type: "aws.ecs",
  service: "ECS",
  title: "ECS service",
  description:
    "An Amazon ECS service of tasks on Fargate or on EC2 instances (a capacity provider with managed scaling): task sizes and quotas, image pulls, Fargate Spot interruptions, rolling deployments with the circuit breaker, zones. Reachable task by task through a load balancer's target group.",
  category: "compute",
  icon: "container",
  accent: "#ed7100",
  docs: Aws.docs.ecs,
  limits: [
    { label: "Tasks per service", value: "5,000", adjustable: false, source: PAGES.quotas },
    { label: "Tasks a service launches", value: `${SERVICE_LAUNCHES_PER_MINUTE} a minute (125 on Fargate in newer Regions)`, adjustable: false, source: PAGES.quotas },
    { label: "Tasks in PROVISIONING per cluster", value: `${PROVISIONING_PER_CLUSTER} (EC2 capacity providers)`, adjustable: false, source: PAGES.quotas },
    { label: "Fargate Spot interruption warning", value: "2 minutes", adjustable: false, source: PAGES.fargateSpot }
  ],
  dashboard,
  highlights: [
    { gauge: "running", label: "running" },
    { gauge: "cpu", label: "CPU", format: "percent" },
    { gauge: "provisioning", label: "provisioning" }
  ],
  fleet: true,
  config: Config,
  ports: { out: Component.port.many("Downstream") },
  state: State,
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const s = (): Settings => fast.settings()
      const ms = (d: Duration.Duration) => Duration.toMillis(d)
      const account = () => fast.account() as Aws.Account
      const onFargate = s().launchType === "FARGATE"
      const vcpus = () => Fargate.vcpusOf(s().task.cpu)
      const memory = () => (onFargate ? Fargate.fargateMemory(s().task.cpu, s().task.memory) : s().task.memory)
      const workersPerTask = () => Math.max(1, Math.floor(vcpus() * s().task.requestsPerVcpu))
      const totals = { served: 0, errors: 0, refused: 0, lost: 0 }
      const counts = { interrupted: 0 }
      // Task churn, as the service's events tell it: tasks launched (a crash-looping deployment launches over and over),
      // tasks stopped, tasks that failed (crashed, or failed their health checks), and Fargate Spot interruptions.
      const taskLaunches = node.meter.counter("taskLaunches")
      const taskStops = node.meter.counter("taskStops")
      const taskFailures = node.meter.counter("taskFailures")
      const spotInterruptions = node.meter.counter("spotInterruptions")
      /** Tasks that launched, so a stop counts only them (not a request for a task given up before it found capacity). */
      const launched = new WeakSet<Unit>()

      // The service's own launch pace (500 tasks a minute, not adjustable) and the region's Fargate launch rate.
      const serviceKey = `${node.id}/ecs-launches`
      const serviceBucket = { rate: SERVICE_LAUNCHES_PER_MINUTE / 60, burst: SERVICE_LAUNCHES_PER_MINUTE }
      const regionKey = `aws:${node.placement.region}/fargate-launches`
      const regionBucket = () => ({ rate: account().fargateLaunchRate, burst: account().fargateLaunchBurst })
      const fargateLedger = yield* Fargate.ledgerOf(node)
      const ec2Ledger = yield* Vcpus.ledgerOf(node)

      const deployments = new Deployments(s, () => ms(s().task.appStart), fast)

      // Which capacity each task holds (Fargate or Fargate Spot, and how many vCPUs), by task id.
      const held = new Map<number, { readonly unit: Unit; readonly purchase: Fargate.Purchase; readonly vcpus: number }>()
      /** Tasks running or starting on each capacity: what the strategy splits (a task stopping no longer counts). */
      const split = () => {
        let onDemand = 0
        let spot = 0
        for (const h of held.values()) {
          if (h.unit.state === "draining" || h.unit.state === "terminated") continue
          if (h.purchase === "spot") spot++
          else onDemand++
        }
        return { onDemand, spot }
      }
      const holding = { onDemand: 0, spot: 0 }
      const capacity = {
        // Launches wait for the service's and the region's launch rates, then (on Fargate) for the vCPU quota of the
        // capacity the strategy picks. The rate tokens are spent when the task actually launches (`phases`).
        take: (unit: Unit): boolean => {
          if (!node.limiter.fitsUnsafe(serviceKey, serviceBucket)) return false
          if (!onFargate) return true
          if (!node.limiter.fitsUnsafe(regionKey, regionBucket())) return false
          const f = s().fargate
          const now = split()
          const purchase = Fargate.pick(now.onDemand, now.spot, f.base, f.weight, f.spotWeight)
          const v = vcpus()
          if (!Fargate.take(fargateLedger, account(), purchase, v)) return false
          held.set(unit.id, { unit, purchase, vcpus: v })
          holding[purchase]++
          return true
        },
        give: (unit: Unit): void => {
          const h = held.get(unit.id)
          if (h === undefined) return
          held.delete(unit.id)
          holding[h.purchase]--
          Fargate.give(fargateLedger, h.purchase, h.vcpus)
        },
        retryMs: LAUNCH_RETRY_MS
      }

      let tasks: Fleet | undefined
      const ec2 = onFargate
        ? undefined
        : new Ec2Capacity(node, s, account, ec2Ledger, () => ({ cpu: vcpus(), memory: memory() }), () => tasks?.count.requested ?? 0)

      /** A task's start-up, decided as it launches (after it found capacity, and on EC2 an instance). */
      const phases = (unit: Unit): ReadonlyArray<Phase> => {
        taskLaunches.n++
        launched.add(unit)
        node.limiter.takeUnsafe(serviceKey, serviceBucket)
        if (onFargate) node.limiter.takeUnsafe(regionKey, regionBucket())
        const rev = deployments.launching(unit)
        const provisioning = onFargate ? FARGATE_PROVISIONING_MS : EC2_PROVISIONING_MS
        const full = onFargate && rev.lazyLoading ? LAZY_PULL_MS : (rev.imageSize / rev.pullRate) * 1000
        const pull = ec2 === undefined ? full : ec2.images.pullMs(ec2.pool.hostOf(unit), `revision-${rev.revision}`, full, CACHED_PULL_MS, provisioning)
        if (rev.failure === "crash") {
          // The essential container exits as it starts: the task stops before RUNNING.
          fast.after(provisioning + pull + CRASH_AFTER_MS, crash, unit)
          return [{ name: "provisioning", ms: provisioning }, { name: "activating", ms: pull }, { name: "starting", ms: CRASH_AFTER_MS + rev.appStartMs + 1 }]
        }
        return [{ name: "provisioning", ms: provisioning }, { name: "activating", ms: pull }, { name: "starting", ms: rev.appStartMs }]
      }

      tasks = new Fleet(node, {
        desired: () => deployments.target(),
        zones: () => node.zones.all.slice(0, s().zones),
        phases,
        grace: () => ms(s().healthCheckGracePeriod),
        workers: workersPerTask,
        line: () => s().queueLimit,
        backlog: () => s().queueLimit,
        drain: () => ms(s().stopTimeout),
        detect: () => ms(s().lostTaskDetection),
        capacity,
        ...(ec2 === undefined ? {} : { hosts: ec2.pool.tenants({ demand: () => ({ cpu: vcpus(), memory: memory() }), spread: () => "zones" }) }),
        // ECS's AZ rebalancing (on by default) needs room above the desired count.
        rebalance: () => s().deployment.maximumPercent > 100,
        name: (id) => `task-${id}`
      })
      const fleet = tasks
      deployments.attach(fleet)
      ec2?.images.seed(ec2.pool.hosts, `revision-${s().task.revision}`)

      // Health: a task of a broken revision fails its checks; a task counts toward the circuit breaker once.
      const failedOnce = new WeakSet<Unit>()
      const taskFailed = (unit: Unit): void => {
        if (failedOnce.has(unit)) return
        failedOnce.add(unit)
        taskFailures.n++
        deployments.taskFailed(unit)
      }
      const crash = (unit: Unit): void => {
        if (unit.state !== "starting") return
        taskFailed(unit)
        fleet.kill(unit, "essential container exited")
      }
      const base = fleet.offer((unit, message) => serve(message, unit))
      const offer = {
        ...base,
        // A target group's health checks: an unhealthy task counts toward the circuit breaker.
        report: (unit: Unit, healthy: boolean) => {
          if (!healthy) taskFailed(unit)
          base.report(unit, healthy)
        }
      }
      const containerCheckFails = (unit: Unit): void => {
        if (unit.state !== "grace" && unit.state !== "inService") return
        offer.report(unit, false)
      }
      const healthyYet = (unit: Unit): void => {
        if ((unit.state === "grace" || unit.state === "inService") && !deployments.broken(unit)) deployments.taskHealthy(unit)
      }
      fleet.observe((unit, event) => {
        if (event === "gone" && launched.has(unit)) taskStops.n++
        if (event !== "up") return
        if (deployments.broken(unit)) {
          fleet.setHealthy(unit, false)
          fast.after(UNHEALTHY_AFTER_MS, containerCheckFails, unit)
        } else fast.after(HEALTHY_AFTER_RUNNING_MS, healthyYet, unit)
      })

      // Fargate Spot interruptions: a Poisson process over the Spot tasks running, from a stream of its own.
      const spotRandom = fast.random.fork("fargate-spot")
      const spotServing = (): Array<Unit> => fleet.units.filter((u) => u.alive && (u.state === "grace" || u.state === "inService") && held.get(u.id)?.purchase === "spot")
      const nextInterruption = (): void => {
        const rate = s().fargate.spotInterruptionsPerTaskHour
        const n = held.size === 0 ? 0 : spotServing().length
        if (rate <= 0 || n === 0) {
          fast.after(SPOT_RECHECK_MS, interruptionDue, false)
          return
        }
        // The process is memoryless, so a wait longer than the recheck can be drawn again then: a rate raised meanwhile
        // (a scenario's interruption wave) takes effect within the recheck.
        const wait = -Math.log(1 - spotRandom.nextDoubleUnsafe()) / ((rate * n) / 3_600_000)
        if (wait > SPOT_RECHECK_MS) fast.after(SPOT_RECHECK_MS, interruptionDue, false)
        else fast.after(wait, interruptionDue, true)
      }
      const interruptionDue = (due: boolean): void => {
        if (due && s().fargate.spotInterruptionsPerTaskHour > 0) {
          const spot = spotServing()
          const victim = spot[Math.floor(spotRandom.nextDoubleUnsafe() * spot.length)]
          if (victim !== undefined) {
            counts.interrupted++
            spotInterruptions.n++
            // SIGTERM comes with the warning; the task stops after its stop timeout, and a replacement starts at once.
            fleet.interrupt(victim, Math.min(120_000, ms(s().stopTimeout)))
          }
        }
        nextInterruption()
      }
      if (onFargate) nextInterruption()

      const host: WorkHost = {
        id: node.id,
        fast,
        out: node.out("out"),
        serviceTime: () => s().task.serviceTime,
        fanOut: () => s().fanOut,
        broken: (unit) => deployments.broken(unit),
        totals
      }
      const serve = handler(fleet, host)

      // Running tasks per zone, for each zone it spreads over (registered when it first does).
      const zoneGauges = new Set<string>()
      const gaugeZones = (): void => {
        for (const zone of fleet.zonesList()) {
          if (zoneGauges.has(zone)) continue
          zoneGauges.add(zone)
          node.meter.gaugeUnsafe(`running.${zone}`, () => fleet.servingIn(zone))
        }
      }
      yield* node.spawn(
        SubscriptionRef.changes(node.config).pipe(
          Stream.runForEach(() =>
            Effect.sync(() => {
              deployments.settingsChanged()
              ec2?.refresh()
              fleet.refresh()
              gaugeZones()
            })
          )
        )
      )

      const meter = node.meter
      meter.gaugeUnsafe("desired", () => s().desiredCount)
      meter.gaugeUnsafe("running", () => fleet.serving)
      meter.gaugeUnsafe("pending", () => fleet.pending)
      meter.gaugeUnsafe("provisioning", () => fleet.count.requested)
      meter.gaugeUnsafe("draining", () => fleet.count.draining)
      meter.gaugeUnsafe("busy", () => fleet.busy)
      meter.gaugeUnsafe("queued", () => fleet.waiting)
      meter.gaugeUnsafe("cpu", () => fleet.utilization)
      // Tasks' worth of CPU in use: what target tracking per task keeps near a target (desiredCount = ceil(this / target)).
      meter.gaugeUnsafe("cpuTasks", () => fleet.busy / workersPerTask())
      meter.gaugeUnsafe("spot", () => holding.spot)
      meter.gaugeUnsafe("oldTasks", () => deployments.rollout.status().old)
      meter.gaugeUnsafe("revision", () => deployments.current)
      meter.gaugeUnsafe("breakerFailures", () => deployments.failures)
      // The rest of what the console and Container Insights show: tasks on Fargate On-Demand (on Fargate only), tasks of
      // the revision being deployed, and the circuit breaker's threshold.
      if (onFargate) meter.gaugeUnsafe("fargate", () => holding.onDemand)
      meter.gaugeUnsafe("newTasks", () => deployments.rollout.status().fresh)
      meter.gaugeUnsafe("breakerThreshold", () => deployments.threshold())
      if (ec2 !== undefined) {
        meter.gaugeUnsafe("instances", () => ec2.pool.totalsNow().hosts)
        meter.gaugeUnsafe("instancesLaunching", () => ec2.instances.pending)
        meter.gaugeUnsafe("instancesDesired", () => ec2.view.desired)
        meter.gaugeUnsafe("capacityReservation", () => ec2.view.reservation)
        meter.gaugeUnsafe("cpuReservation", () => share(ec2.pool.totalsNow(), "cpu"))
        meter.gaugeUnsafe("memoryReservation", () => share(ec2.pool.totalsNow(), "memory"))
        // CapacityProviderReservation and managed scaling's target, as shares (1 is 100%) to chart with the reservations.
        meter.gaugeUnsafe("capacityProviderReservation", () => ec2.view.reservation / 100)
        meter.gaugeUnsafe("targetCapacity", () => s().ec2.targetCapacity / 100)
      }
      gaugeZones()

      const capacityOf = (unit: Unit): string => {
        if (!onFargate) return "EC2"
        const h = held.get(unit.id)
        return h === undefined ? "-" : h.purchase === "spot" ? "FARGATE_SPOT" : "FARGATE"
      }

      return {
        call: (message) => serve(message, undefined),
        fleet: offer,
        probe: Effect.sync(() => {
          const status = deployments.rollout.status()
          const t = ec2?.pool.totalsNow()
          return {
            running: fleet.serving,
            pending: fleet.pending,
            provisioning: fleet.count.requested,
            draining: fleet.count.draining,
            busy: fleet.busy,
            queued: fleet.waiting,
            ...totals,
            replaced: fleet.totals.replaced,
            interrupted: counts.interrupted,
            spot: holding.spot,
            onDemand: holding.onDemand,
            deployment: {
              state: deployments.state,
              revision: deployments.current,
              stable: deployments.stable,
              failures: deployments.failures,
              threshold: deployments.threshold(),
              oldTasks: status.old,
              newTasks: status.fresh,
              rollbacks: deployments.totals.rollbacks
            },
            ...(ec2 === undefined || t === undefined ? {} : {
              instances: {
                running: t.hosts,
                launching: ec2.instances.pending,
                desired: ec2.view.desired,
                reservation: ec2.view.reservation,
                cpuReservation: share(t, "cpu"),
                memoryReservation: share(t, "memory")
              }
            }),
            tasks: fleet.units.slice(0, PROBE_UNITS).map((u) => {
              const instance = ec2?.pool.hostOf(u)?.name
              return {
                name: u.name,
                ...(u.zone === undefined ? {} : { zone: u.zone }),
                state: u.state,
                ...(u.phaseName === undefined ? {} : { phase: u.phaseName }),
                alive: u.alive,
                revision: deployments.rollout.versionOf(u),
                capacity: capacityOf(u),
                ...(instance === undefined ? {} : { instance }),
                busy: u.running
              }
            })
          }
        })
      }
    })
})

/** The cluster's CPUReservation or MemoryReservation: what tasks reserved over what the instances have, 0-1. */
const share = (t: { readonly room: { readonly cpu: number; readonly memory: number }; readonly used: { readonly cpu: number; readonly memory: number } }, what: "cpu" | "memory"): number =>
  t.room[what] > 0 ? t.used[what] / t.room[what] : 0
