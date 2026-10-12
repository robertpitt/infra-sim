import { Duration, Effect, Stream, SubscriptionRef } from "effect"
import * as Component from "../../Component.ts"
import { Fleet, type Phase } from "../../fleet/Fleet.ts"
import { type Call, type CallFailure, type Message, type Reply, Unavailable } from "../../Message.ts"
import type { Unit } from "../../Protocol.ts"
import type { Account } from "../account.ts"
import * as Aws from "../provider.ts"
import { Config, type Settings } from "./config.ts"
import { instanceType } from "./instanceTypes.ts"
import { overMaxMargin, PAGES } from "./limits.ts"
import { type Cpu, cpuOf, PerMinute } from "./metrics.ts"
import { Request, type RequestHost } from "./request.ts"
import { onDemandOf, SpotInterruptions } from "./spot.ts"
import { State } from "./state.ts"
import { pick } from "./termination.ts"
import { give, ledgerOf, type Purchase, take } from "./vcpus.ts"
import { WarmPool } from "./warmPool.ts"

/** How long a launch EC2 refused (quota, no Spot capacity) waits before the group tries again. AWS publishes no figure: an assumption. */
export const LAUNCH_RETRY_MS = 30_000

const ms = (d: Duration.Duration): number => Duration.toMillis(d)

/** What the group knows of an instance from its launch to its termination. */
interface Instance {
  readonly purchase: Purchase
  readonly vcpus: number
  readonly launchedAt: number
  /** How it started: there before the simulation, launched from scratch, or taken from the warm pool. */
  start: "initial" | "cold" | "warm"
  /** Let go (scale-in, replacement, interruption): no longer counted in the purchase split. */
  draining: boolean
}

/**
 * An Amazon EC2 Auto Scaling group: a fleet of identical instances, spread over the group's Availability Zones, kept at
 * its desired capacity between its minimum and maximum size. Built on the fleet core (`fleet/Fleet.ts`): each instance
 * is a unit with a zone, a life and workers (its vCPUs). The modules beside this file hold the AWS mechanisms: the
 * instance types (`instanceTypes.ts`), the vCPU quotas (`vcpus.ts`), the warm pool (`warmPool.ts`), Spot and Capacity
 * Rebalancing (`spot.ts`), the termination policy (`termination.ts`) and the scaling metrics (`metrics.ts`). README.md
 * documents them against AWS.
 */
export const Ec2 = Aws.component({
  type: "aws.ec2",
  service: "EC2 Auto Scaling",
  title: "EC2 Auto Scaling group",
  description:
    "A group of EC2 instances across Availability Zones: minutes to launch, a warm pool to start faster, Spot with two-minute interruptions, health checks and replacement, and vCPU quotas shared by the region.",
  docs: PAGES.overview,
  category: "compute",
  icon: "server",
  accent: "#ed7100",
  limits: [
    { label: "Spot interruption notice", value: "2 minutes", adjustable: false, source: PAGES.spotNotice },
    { label: "Over maximum while rebalancing", value: "10% of desired capacity or 1 instance, whichever is greater", adjustable: false, source: PAGES.zones },
    { label: "Running On-Demand and Spot vCPUs", value: "set per region in the account quotas (default 5 each)", adjustable: true, source: PAGES.instanceQuotas },
    { label: "Auto Scaling groups", value: "500 per region", adjustable: true, source: PAGES.quotas },
    { label: "Warm pools", value: "not with Spot Instances", adjustable: false, source: PAGES.warmPools },
    { label: "T3 CPU credits", value: "unlimited mode by default: never throttled (surplus credits are billed)", adjustable: false, source: PAGES.unlimited, note: "Standard-mode credits are not simulated." }
  ],
  highlights: [
    { gauge: "inService", label: "in service" },
    { gauge: "cpu", label: "CPU", format: "percent" },
    { gauge: "pending", label: "launching" }
  ],
  fleet: true,
  config: Config,
  ports: { out: Component.port.many("Downstream") },
  state: State,
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const settings = (): Settings => fast.settings()
      const account = (): Account => fast.account() as Account
      const out = node.out("out")
      const ledger = yield* ledgerOf(node)
      const totals = { served: 0, errors: 0, refused: 0, lost: 0 }
      const instances = new Map<number, Instance>()
      const upAt = new Map<number, number>()
      const broken = new Set<number>()
      const protectedIds = new Set<number>()
      const spotRandom = fast.random.fork("ec2.spot")
      const launchRandom = fast.random.fork("ec2.launch")
      const counters = {
        refused: node.meter.counter("launchRefused"),
        launched: node.meter.counter("launches"),
        warm: node.meter.counter("warmStarts"),
        interruptions: node.meter.counter("spotInterruptions"),
        recommendations: node.meter.counter("rebalanceRecommendations")
      }

      // Workers per instance: its vCPUs times requests per vCPU, worked out again only when the settings change.
      let workersMemo: { c: Settings; n: number } | undefined
      const workers = (): number => {
        const c = settings()
        if (workersMemo?.c !== c) workersMemo = { c, n: instanceType(c.instanceType).vcpus * c.requestsPerVcpu }
        return workersMemo.n
      }
      const desired = (): number => {
        const c = settings()
        return Math.max(c.minSize, Math.min(c.maxSize, c.desiredCapacity))
      }
      const zones = (): ReadonlyArray<string> => node.zones.all.slice(0, settings().availabilityZones)

      /** Live instances by purchase option, from what the group launched (draining ones don't count). */
      const split = (): { onDemand: number; total: number } => {
        let onDemand = 0
        let total = 0
        for (const i of instances.values()) {
          if (i.draining) continue
          total++
          if (i.purchase === "onDemand") onDemand++
        }
        return { onDemand, total }
      }

      /** The purchase option of the next launch: whichever is short of the split for the group's size after it. */
      const nextPurchase = (c: Settings): Purchase => {
        if (c.warmPool.enabled || c.spot.onDemandPercentageAboveBase >= 100) return "onDemand"
        const { onDemand, total } = split()
        return onDemand < onDemandOf(total + 1, c.spot.onDemandBaseCapacity, c.spot.onDemandPercentageAboveBase) ? "onDemand" : "spot"
      }

      let fleetRef: Fleet | undefined
      const fleet = (): Fleet => fleetRef!

      const spot = new SpotInterruptions({
        settings,
        now: fast.now,
        after: fast.after,
        random: spotRandom,
        fleet,
        purchaseOf: (unit) => instances.get(unit.id)?.purchase,
        count: (event) => void (event === "interruption" ? counters.interruptions.n++ : counters.recommendations.n++)
      })

      /** The phases a launch goes through: from scratch, or from the warm pool (which skips what was done before). */
      const phases = (unit: Unit): ReadonlyArray<Phase> => {
        const c = settings()
        const l = c.launch
        const warm = pool.take(unit.zone)
        const instance = instances.get(unit.id)
        if (instance !== undefined) instance.start = warm === undefined ? "cold" : "warm"
        counters.launched.n++
        if (warm !== undefined) counters.warm.n++
        if (c.scaleInProtection) protectedIds.add(unit.id)
        if (c.brokenLaunches > 0 && launchRandom.nextDoubleUnsafe() < c.brokenLaunches) {
          broken.add(unit.id)
          fleet().setHealthy(unit, false)
        }
        switch (warm) {
          case undefined:
            return [
              { name: "pending", ms: ms(l.pending) },
              { name: "boot", ms: ms(l.boot) },
              { name: "user data", ms: ms(l.userData) },
              { name: "application start", ms: ms(l.appStart) }
            ]
          case "Stopped":
            return [
              { name: "pending (from the warm pool)", ms: ms(l.pending) },
              { name: "boot", ms: ms(l.boot) },
              { name: "application start", ms: ms(l.appStart) }
            ]
          case "Hibernated":
            return [
              { name: "pending (from the warm pool)", ms: ms(l.pending) },
              { name: "resume from hibernation", ms: ms(l.boot) }
            ]
          case "Running":
            return []
        }
      }

      fleetRef = new Fleet(node, {
        desired: () => settings().desiredCapacity + spot.extra,
        min: () => settings().minSize,
        max: () => settings().maxSize + Math.min(spot.extra, overMaxMargin(desired())),
        zones,
        phases,
        grace: () => ms(settings().healthCheckGracePeriod),
        workers,
        // One line of the per-instance queue for every instance serving: none serving, nothing listening (503).
        line: () => settings().queueLimit * (fleetRef?.serving ?? 0),
        backlog: () => settings().queueLimit,
        drain: () => ms(settings().shutdownGrace),
        detect: () => ms(settings().statusCheckReplace),
        replaceUnhealthy: () => settings().healthCheckType === "ELB",
        capacity: {
          take: (unit) => {
            const c = settings()
            const purchase = nextPurchase(c)
            // EC2 has no Spot capacity for this launch (InsufficientInstanceCapacity): the group keeps trying Spot. The
            // instances there at the start (while the fleet is being made) already have theirs.
            const starting = fleetRef === undefined
            if (purchase === "spot" && !starting && c.spot.insufficientCapacity > 0 && spotRandom.nextDoubleUnsafe() < c.spot.insufficientCapacity) {
              counters.refused.n++
              return false
            }
            const vcpus = instanceType(c.instanceType).vcpus
            if (!take(ledger, account(), purchase, vcpus)) {
              counters.refused.n++
              return false
            }
            instances.set(unit.id, { purchase, vcpus, launchedAt: fast.now(), start: "initial", draining: false })
            return true
          },
          // Called as an instance is terminated, announced or not (one terminated while launching never comes up, so
          // never goes either): everything kept about it goes too.
          give: (unit) => {
            broken.delete(unit.id)
            protectedIds.delete(unit.id)
            upAt.delete(unit.id)
            const instance = instances.get(unit.id)
            if (instance === undefined) return
            give(ledger, instance.purchase, instance.vcpus)
            instances.delete(unit.id)
          },
          retryMs: LAUNCH_RETRY_MS
        },
        protect: (unit) => protectedIds.has(unit.id),
        scaleIn: () => (settings().terminationPolicy === "NewestInstance" ? "newest" : "oldest"),
        pick: (candidates) => pick(settings(), candidates, (u) => instances.get(u.id), split(), fast.now()),
        name: (id) => `i-${id}`
      })

      // Made after the fleet, which it spreads beside; the fleet only asks it for launches, which come later.
      const pool = new WarmPool({
        settings,
        account,
        now: fast.now,
        after: fast.after,
        ledger,
        zones: () => zones().filter((z) => !node.zones.down(z)),
        groupIn: (zone) => {
          let n = 0
          for (const m of fleet().units) if (m.live && m.zone === zone) n++
          return n
        },
        desired,
        coldMs: () => {
          const l = settings().launch
          return ms(l.pending) + ms(l.boot) + ms(l.userData) + ms(l.appStart)
        },
        retryMs: LAUNCH_RETRY_MS
      })

      fleet().observe((unit, event) => {
        switch (event) {
          case "up":
            upAt.set(unit.id, fast.now())
            spot.up(unit)
            break
          case "draining": {
            const instance = instances.get(unit.id)
            if (instance !== undefined) instance.draining = true
            break
          }
          case "gone":
            spot.gone(unit)
            break
          case "dead":
            break
        }
        spot.schedule()
      })
      spot.schedule()

      const host: RequestHost = { id: node.id, fast, out, broken, totals }
      const requests = new PerMinute()
      /** One request: wait for a worker (on `unit`, if a balancer chose one), work for the service time, then call downstream. */
      const handle = (message: Message, unit: Unit | undefined): Call =>
        Effect.callback<Reply, CallFailure>((resume) => {
          requests.add(fast.now())
          const request = new Request(host, message, resume)
          const admitted = fleet().admit(request, unit)
          if (typeof admitted === "string") {
            totals.refused++
            resume(Effect.fail(Unavailable({ node: node.id, reason: admitted })))
            return Effect.void
          }
          request.ticket = admitted
          return Effect.sync(() => request.abandon())
        })

      // CPU of the instances past their warmup, worked out once per instant however many gauges read it.
      let cpuMemo: { t: number; value: Cpu } | undefined
      const cpu = (): Cpu => {
        const now = fast.now()
        if (cpuMemo?.t !== now) cpuMemo = { t: now, value: cpuOf(fleet().units, workers(), ms(settings().defaultInstanceWarmup), now, (id) => upAt.get(id)) }
        return cpuMemo.value
      }

      // In service per zone, for each zone the group spreads over (registered when it first does).
      const zoneGauges = new Set<string>()
      const gaugeZones = (): void => {
        for (const zone of fleet().zonesList()) {
          if (zoneGauges.has(zone)) continue
          zoneGauges.add(zone)
          node.meter.gaugeUnsafe(`inService.${zone}`, () => fleet().servingIn(zone))
        }
      }

      // Settings edited while running (by a person, a scenario or an autoscaler) apply at once.
      yield* node.spawn(
        SubscriptionRef.changes(node.config).pipe(
          Stream.runForEach(() =>
            Effect.sync(() => {
              fleet().refresh()
              pool.refresh()
              spot.schedule()
              gaugeZones()
            })
          )
        )
      )
      // A raised quota lets waiting launches go at once rather than at their next retry.
      yield* node.spawn(SubscriptionRef.changes(node.account).pipe(Stream.runForEach(() => Effect.sync(() => {
        fleet().retry()
        pool.refresh()
      }))))

      const groupVcpus = (): number => {
        let n = pool.vcpus
        for (const i of instances.values()) n += i.vcpus
        return n
      }
      const count = (purchase: Purchase): number => {
        let n = 0
        for (const i of instances.values()) if (!i.draining && i.purchase === purchase) n++
        return n
      }

      const meter = node.meter
      meter.gaugeUnsafe("desired", desired)
      meter.gaugeUnsafe("inService", () => fleet().serving)
      meter.gaugeUnsafe("pending", () => fleet().pending)
      meter.gaugeUnsafe("draining", () => fleet().count.draining)
      meter.gaugeUnsafe("busy", () => fleet().busy)
      meter.gaugeUnsafe("queued", () => fleet().waiting)
      meter.gaugeUnsafe("utilization", () => fleet().utilization)
      meter.gaugeUnsafe("cpu", () => cpu().average)
      meter.gaugeUnsafe("cpuTotal", () => cpu().average * cpu().serving)
      meter.gaugeUnsafe("requestCount", () => requests.value(fast.now()))
      meter.gaugeUnsafe("requestCountPerTarget", () => requests.value(fast.now()) / Math.max(1, fleet().serving))
      meter.gaugeUnsafe("onDemand", () => count("onDemand"))
      meter.gaugeUnsafe("spot", () => count("spot"))
      meter.gaugeUnsafe("vcpus", groupVcpus)
      meter.gaugeUnsafe("warm", () => pool.ready)
      meter.gaugeUnsafe("warmPreparing", () => pool.preparing)
      meter.gaugeUnsafe("spotNoticed", () => spot.noticed)
      gaugeZones()

      return {
        call: (message) => handle(message, undefined),
        fleet: fleet().offer((unit, message) => handle(message, unit)),
        probe: Effect.sync(() => {
          const f = fleet()
          const warm = pool.snapshot()
          return {
            desired: desired(),
            inService: f.serving,
            pending: f.pending,
            draining: f.count.draining,
            onDemand: count("onDemand"),
            spot: count("spot"),
            vcpus: groupVcpus(),
            warmPool: { ready: warm.ready, preparing: warm.preparing, target: warm.target },
            busy: f.busy,
            queued: f.waiting,
            ...totals,
            launched: f.totals.launched,
            warmStarts: pool.totals.warmStarts,
            refusedLaunches: f.totals.refusedLaunches,
            replaced: f.totals.replaced,
            spotInterruptions: spot.totals.interruptions,
            instances: f.snapshot().map((u) => {
              const i = instances.get(u.id)
              return {
                name: u.name,
                ...(u.zone === undefined ? {} : { zone: u.zone }),
                state: u.state,
                ...(u.phase === undefined ? {} : { phase: u.phase }),
                purchase: i?.purchase ?? "requested",
                start: i?.start ?? "requested",
                alive: u.alive,
                broken: broken.has(u.id),
                busy: u.busy,
                queued: u.queued
              }
            })
          }
        })
      }
    })
})
