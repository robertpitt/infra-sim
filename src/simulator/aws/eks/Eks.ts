import { Duration, Effect, Schema, Stream, SubscriptionRef } from "effect"
import * as Component from "../../Component.ts"
import { Fleet, type Phase } from "../../fleet/Fleet.ts"
import { Rollout } from "../../fleet/Rollout.ts"
import type { Unit } from "../../Protocol.ts"
import * as Vcpus from "../ec2/vcpus.ts"
import { handler, type WorkHost } from "../ecs/work.ts"
import * as Aws from "../provider.ts"
import { NodeAutoscaler } from "./autoscaler.ts"
import { Config, type Settings } from "./config.ts"
import { dashboard } from "./dashboard.ts"
import { BACKOFF_CAP_S, BACKOFF_FIRST_S, CONTAINER_START_MS, NODES_PER_GROUP, PAGES, PROGRESS_DEADLINE_S } from "./limits.ts"
import { NodeGroup } from "./nodes.ts"

/** A phase that never ends: a pod in CrashLoopBackOff or failing its readiness probe never becomes ready. */
const NEVER_MS = 1e13
/** Pods and nodes listed in a probe at most. */
const PROBE_UNITS = 200

/** What a pod template revision is, kept from the settings when it was current. */
interface Revision {
  readonly imageSize: number
  readonly pullRate: number
  readonly appStartMs: number
  readonly failure: Settings["pod"]["failure"]
}

/**
 * When a pod whose application is up after `appMs` passes its readiness probe: at the first probe, `initialDelay` after
 * the container starts and then every `period`, that finds it up (success threshold 1).
 */
export const readyAfter = (appMs: number, initialDelayMs: number, periodMs: number): number =>
  initialDelayMs + Math.max(0, Math.ceil((appMs - initialDelayMs) / periodMs)) * periodMs

/** CrashLoopBackOff: how many times a container has been restarted `ms` after its first crash (10 s, 20 s, 40 s... capped at 5 min apart). */
export const restartsAfter = (ms: number): number => {
  let n = 0
  let t = 0
  let gap = BACKOFF_FIRST_S * 1000
  while (t + gap <= ms && n < 10_000) {
    t += gap
    n++
    gap = Math.min(gap * 2, BACKOFF_CAP_S * 1000)
  }
  return n
}

export const State = Schema.Struct({
  /** Pods Ready (in the Service's endpoints), not counting ones on dead nodes not yet noticed. */
  ready: Schema.Number,
  /** Pods Pending: no node has room for them. */
  pending: Schema.Number,
  /** Pods scheduled and starting: pulling the image, starting, waiting for readiness (or never getting there). */
  starting: Schema.Number,
  terminating: Schema.Number,
  busy: Schema.Number,
  queued: Schema.Number,
  served: Schema.Number,
  errors: Schema.Number,
  refused: Schema.Number,
  lost: Schema.Number,
  /** Pods replaced because their node died, or was removed. */
  replaced: Schema.Number,
  evicted: Schema.Number,
  rollout: Schema.Struct({ revision: Schema.Number, rolling: Schema.Boolean, oldPods: Schema.Number, newPods: Schema.Number, progressDeadlineExceeded: Schema.Boolean }),
  nodes: Schema.Struct({ ready: Schema.Number, launching: Schema.Number, desired: Schema.Number, requestedCpu: Schema.Number, requestedMemory: Schema.Number }),
  autoscaler: Schema.Array(Schema.Struct({ t: Schema.Number, action: Schema.String, nodes: Schema.Number, reason: Schema.String })),
  nodeList: Schema.Array(Schema.Struct({ name: Schema.String, zone: Schema.optionalKey(Schema.String), state: Schema.String, alive: Schema.Boolean, pods: Schema.Number, cpu: Schema.Number, memory: Schema.Number, cordoned: Schema.Boolean })),
  podList: Schema.Array(Schema.Struct({
    name: Schema.String,
    zone: Schema.optionalKey(Schema.String),
    node: Schema.optionalKey(Schema.String),
    state: Schema.String,
    phase: Schema.optionalKey(Schema.String),
    alive: Schema.Boolean,
    revision: Schema.Number,
    restarts: Schema.Number
  }))
})

/**
 * An Amazon EKS workload: a Kubernetes Deployment of pods scheduled onto the nodes of a managed node group, with what
 * scales each level. Pods are a fleet (`fleet/Fleet.ts`) placed on a second fleet, the nodes, through a host pool
 * (`fleet/Hosts.ts`): a pod asks for CPU and memory, and the scheduler finds it a node with that much allocatable left,
 * spread over zones; with none, it is Pending until a node autoscaler (`autoscaler.ts`: the Cluster Autoscaler or
 * Karpenter) adds one. A pod on a node pulls its image (once per node), starts, and passes its readiness probe before it
 * gets traffic. The Horizontal Pod Autoscaler is a `core.target-tracking` controller on `replicas`. A node that dies takes
 * its pods with it; Kubernetes replaces them only when it evicts them, 5 min 50 s later by default.
 */
export const Eks = Aws.component({
  type: "aws.eks",
  service: "EKS",
  title: "EKS workload",
  description:
    "A Kubernetes Deployment on Amazon EKS: pods with CPU and memory requests scheduled onto a managed node group, readiness probes, rolling updates, node failure and eviction, and node autoscaling by the Cluster Autoscaler or Karpenter: two-level scaling with the HPA.",
  category: "compute",
  icon: "container",
  accent: "#ed7100",
  docs: Aws.docs.eks,
  limits: [
    { label: "Nodes per managed node group", value: `${NODES_PER_GROUP}`, adjustable: true, source: PAGES.quotas },
    { label: "Managed node groups per cluster", value: "30", adjustable: true, source: PAGES.quotas },
    { label: "Progress deadline", value: `${PROGRESS_DEADLINE_S} s: a stalled rollout is reported, never rolled back`, adjustable: true, source: PAGES.deployment }
  ],
  dashboard,
  highlights: [
    { gauge: "ready", label: "ready" },
    { gauge: "pending", label: "pending" },
    { gauge: "nodes", label: "nodes" }
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
      const totals = { served: 0, errors: 0, refused: 0, lost: 0 }
      const ledger = yield* Vcpus.ledgerOf(node)
      const group = new NodeGroup(node, s, account, ledger)
      const demand = () => ({ cpu: s().pod.cpu / 1000, memory: s().pod.memory })
      const workersPerPod = () => Math.max(1, Math.floor((s().pod.cpu / 1000) * s().pod.requestsPerCore))

      // Pod template revisions, each with the settings it had when it was current.
      const revisionOf = (c: Settings): Revision => ({ imageSize: c.pod.imageSize, pullRate: c.pod.pullRate, appStartMs: ms(c.pod.appStart), failure: c.pod.failure })
      const revisions = new Map<number, Revision>([[s().pod.revision, revisionOf(s())]])
      let rolloutStarted = 0
      const rollout = new Rollout({
        version: () => s().pod.revision,
        desired: () => s().replicas,
        maxTotal: (d) => d + Math.ceil((d * s().rollingUpdate.maxSurge) / 100),
        minHealthy: (d) => d - Math.floor((d * s().rollingUpdate.maxUnavailable) / 100),
        healthyAfter: () => 0,
        now: fast.now,
        after: fast.after,
        // An evicted pod is recreated by its own ReplicaSet, from its own template.
        replaceInKind: true
      })
      const revision = (unit: Unit): Revision => revisions.get(rollout.versionOf(unit)) ?? revisionOf(s())

      /** A pod's start-up once scheduled on a node: its image (unless the node has it), the container, then readiness. */
      const phases = (unit: Unit): ReadonlyArray<Phase> => {
        rollout.stamp(unit)
        const rev = revision(unit)
        const full = (rev.imageSize / rev.pullRate) * 1000
        const pull = group.images.pullMs(group.pool.hostOf(unit), `revision-${rollout.versionOf(unit)}`, full, 0, 0)
        if (rev.failure !== "none") {
          return [{ name: "pulling image", ms: pull }, { name: "starting", ms: CONTAINER_START_MS }, { name: rev.failure === "crash" ? "CrashLoopBackOff" : "not ready", ms: NEVER_MS }]
        }
        const r = s().readiness
        return [
          { name: "pulling image", ms: pull },
          { name: "starting", ms: CONTAINER_START_MS },
          { name: "readiness", ms: readyAfter(rev.appStartMs, ms(r.initialDelay), Math.max(1, ms(r.period))) }
        ]
      }

      const nf = () => s().nodeFailure
      const pods: Fleet = new Fleet(node, {
        desired: () => rollout.target(),
        zones: () => node.zones.all.slice(0, s().zones),
        phases,
        workers: workersPerPod,
        line: () => s().queueLimit,
        backlog: () => s().queueLimit,
        drain: () => ms(s().terminationGracePeriod),
        // Pods on a node that stopped reporting: NotReady after the grace period, evicted after the toleration.
        detect: () => ms(nf().monitorGracePeriod) + ms(nf().tolerationSeconds),
        hosts: group.pool.tenants({ demand, spread: () => s().topologySpread }),
        // Kubernetes never moves a running pod to even out zones.
        rebalance: () => false,
        name: (id) => `pod-${id}`
      })
      rollout.attach(pods)
      group.images.seed(group.pool.hosts, `revision-${s().pod.revision}`)
      const autoscaler = new NodeAutoscaler(group, () => pods, demand, s, fast)

      const host: WorkHost = {
        id: node.id,
        fast,
        out: node.out("out"),
        serviceTime: () => s().pod.serviceTime,
        fanOut: () => s().fanOut,
        broken: () => false,
        totals
      }
      const serve = handler(pods, host)

      const zoneGauges = new Set<string>()
      const gaugeZones = (): void => {
        for (const zone of pods.zonesList()) {
          if (zoneGauges.has(zone)) continue
          zoneGauges.add(zone)
          node.meter.gaugeUnsafe(`ready.${zone}`, () => pods.servingIn(zone))
          node.meter.gaugeUnsafe(`nodes.${zone}`, () => group.fleet.servingIn(zone))
        }
      }
      yield* node.spawn(
        SubscriptionRef.changes(node.config).pipe(
          Stream.runForEach(() =>
            Effect.sync(() => {
              const c = s()
              if (!revisions.has(c.pod.revision)) rolloutStarted = fast.now()
              revisions.set(c.pod.revision, revisionOf(c))
              rollout.step()
              group.refresh()
              pods.refresh()
              gaugeZones()
            })
          )
        )
      )

      const meter = node.meter
      const nodeTotals = () => group.pool.totalsNow()
      meter.gaugeUnsafe("replicas", () => s().replicas)
      meter.gaugeUnsafe("ready", () => pods.serving)
      meter.gaugeUnsafe("pending", () => pods.count.requested)
      meter.gaugeUnsafe("starting", () => pods.count.starting)
      meter.gaugeUnsafe("terminating", () => pods.count.draining)
      meter.gaugeUnsafe("busy", () => pods.busy)
      meter.gaugeUnsafe("queued", () => pods.waiting)
      meter.gaugeUnsafe("cpu", () => pods.utilization)
      // Pods' worth of CPU in use, relative to requests: what the HPA's CPU target divides (replicas = ceil(this / target)).
      meter.gaugeUnsafe("cpuPods", () => pods.busy / workersPerPod())
      meter.gaugeUnsafe("oldPods", () => rollout.status().old)
      meter.gaugeUnsafe("nodes", () => nodeTotals().hosts)
      meter.gaugeUnsafe("nodesLaunching", () => group.fleet.pending)
      meter.gaugeUnsafe("nodesDesired", () => group.desired)
      meter.gaugeUnsafe("requestedCpu", () => share(nodeTotals(), "cpu"))
      meter.gaugeUnsafe("requestedMemory", () => share(nodeTotals(), "memory"))
      // As Container Insights reports them: CPU in use over the nodes' allocatable (node_cpu_utilization; a busy worker is
      // its share of the pod's CPU request), pods of the revision being rolled out, and pods in CrashLoopBackOff.
      meter.gaugeUnsafe("nodeCpu", () => {
        const room = nodeTotals().room.cpu
        return room > 0 ? ((pods.busy / workersPerPod()) * demand().cpu) / room : 0
      })
      meter.gaugeUnsafe("newPods", () => rollout.status().fresh)
      meter.gaugeUnsafe("crashLooping", () => {
        let n = 0
        for (const u of pods.units) if (u.state === "starting" && u.phaseName === "CrashLoopBackOff") n++
        return n
      })
      gaugeZones()

      return {
        call: (message) => serve(message, undefined),
        fleet: pods.offer((unit, message) => serve(message, unit)),
        probe: Effect.sync(() => {
          const now = fast.now()
          const status = rollout.status()
          const t = nodeTotals()
          return {
            ready: pods.serving,
            pending: pods.count.requested,
            starting: pods.count.starting,
            terminating: pods.count.draining,
            busy: pods.busy,
            queued: pods.waiting,
            ...totals,
            replaced: pods.totals.replaced,
            evicted: group.pool.totals.evicted,
            rollout: {
              revision: status.version,
              rolling: status.rolling,
              oldPods: status.old,
              newPods: status.fresh,
              progressDeadlineExceeded: status.rolling && now - rolloutStarted > PROGRESS_DEADLINE_S * 1000
            },
            nodes: { ready: t.hosts, launching: group.fleet.pending, desired: group.desired, requestedCpu: share(t, "cpu"), requestedMemory: share(t, "memory") },
            autoscaler: [...autoscaler.decisions],
            nodeList: group.fleet.units.slice(0, PROBE_UNITS).map((u) => {
              const h = group.pool.host(u)
              return {
                name: u.name,
                ...(u.zone === undefined ? {} : { zone: u.zone }),
                state: u.state,
                alive: u.alive,
                pods: h?.tenants.size ?? 0,
                cpu: h === undefined || h.room.cpu === 0 ? 0 : h.cpu / h.room.cpu,
                memory: h === undefined || h.room.memory === 0 ? 0 : h.memory / h.room.memory,
                cordoned: h?.cordoned ?? false
              }
            }),
            podList: pods.units.slice(0, PROBE_UNITS).map((u) => {
              const nodeName = group.pool.hostOf(u)?.name
              const crashing = u.state === "starting" && u.phaseName === "CrashLoopBackOff"
              return {
                name: u.name,
                ...(u.zone === undefined ? {} : { zone: u.zone }),
                ...(nodeName === undefined ? {} : { node: nodeName }),
                state: u.state === "requested" ? "Pending" : u.state,
                ...(u.phaseName === undefined ? {} : { phase: u.phaseName }),
                alive: u.alive,
                revision: rollout.versionOf(u),
                restarts: crashing ? restartsAfter(now - u.since) : 0
              }
            })
          }
        })
      }
    })
})

/** Requests over allocatable across the ready nodes, 0-1: how full the cluster is by what pods asked for. */
const share = (t: { readonly room: { readonly cpu: number; readonly memory: number }; readonly used: { readonly cpu: number; readonly memory: number } }, what: "cpu" | "memory"): number =>
  t.room[what] > 0 ? t.used[what] / t.room[what] : 0
