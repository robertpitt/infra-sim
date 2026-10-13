import type { Fleet } from "../../../fleet/Fleet.ts"
import { Rollout } from "../../../fleet/Rollout.ts"
import type { Unit } from "../../../Protocol.ts"
import type { TimerHandle } from "../../../VirtualTime.ts"
import type { Settings } from "./config.ts"
import { breakerThreshold, HEALTHY_AFTER_RUNNING_MS } from "./limits.ts"

/**
 * An ECS service's deployments: the rolling update (the `ECS` deployment controller) that replaces every task when the
 * task definition revision changes, and the deployment circuit breaker with its rollback.
 *
 * The rolling part is the fleet core's `Rollout` with ECS's bounds: at most `maximumPercent` of the desired count running
 * or pending (rounded down), at least `minimumHealthyPercent` healthy (rounded up), a new task healthy 40 s after it is
 * RUNNING (`service_definition_parameters.html`) unless it fails its health checks. What ECS adds:
 *
 *  - each revision keeps the task settings it had when it was current (its image, its start-up, what is wrong with it),
 *    so old tasks stay as they were while new ones run the new revision;
 *  - **the circuit breaker** counts new tasks that stop before RUNNING (stage 1) and new tasks that fail health checks
 *    (stage 2); a healthy new task resets the count. At the threshold (half the desired count, 3 to 200) the deployment
 *    FAILS: with rollback, the service deploys the last revision that completed; without, it launches no more new tasks
 *    (`deployment-circuit-breaker.html`).
 */

/** What a revision's tasks are: kept per revision, from the settings when it was current. */
export interface Revision {
  readonly revision: number
  readonly imageSize: number
  readonly lazyLoading: boolean
  readonly pullRate: number
  readonly appStartMs: number
  readonly failure: Settings["task"]["failure"]
}

export type DeploymentState = "COMPLETED" | "IN_PROGRESS" | "FAILED" | "ROLLED_BACK"

const revisionOf = (s: Settings, appStartMs: number): Revision => ({
  revision: s.task.revision,
  imageSize: s.task.imageSize,
  lazyLoading: s.task.lazyLoading,
  pullRate: s.task.pullRate,
  appStartMs,
  failure: s.task.failure
})

export class Deployments {
  readonly rollout: Rollout
  /** The revision tasks should run: the settings' own, unless its deployment failed. */
  current: number
  /** The last revision whose deployment completed. */
  stable: number
  state: DeploymentState = "COMPLETED"
  /** New tasks that failed in the current deployment, for the circuit breaker. */
  failures = 0
  /** Revisions whose deployment failed: not deployed again unless the settings name another revision first. */
  private readonly failed = new Set<number>()
  private readonly revisions = new Map<number, Revision>()
  private fleet: Fleet | undefined = undefined
  readonly totals = { deployments: 0, failedTasks: 0, rollbacks: 0 }

  constructor(
    private readonly settings: () => Settings,
    private readonly appStartMs: () => number,
    fast: { readonly now: () => number; readonly after: <A>(ms: number, fire: (arg: A) => void, arg: A) => TimerHandle }
  ) {
    const s = settings()
    this.current = this.stable = s.task.revision
    this.revisions.set(s.task.revision, revisionOf(s, appStartMs()))
    this.rollout = new Rollout({
      version: () => this.current,
      desired: () => this.settings().desiredCount,
      // A failed deployment that doesn't roll back starts no new tasks and stops no healthy old ones.
      maxTotal: (d) => (this.state === "FAILED" ? 0 : Math.floor((d * this.settings().deployment.maximumPercent) / 100)),
      minHealthy: (d) => (this.state === "FAILED" ? Number.POSITIVE_INFINITY : Math.ceil((d * this.settings().deployment.minimumHealthyPercent) / 100)),
      healthyAfter: () => HEALTHY_AFTER_RUNNING_MS,
      ok: (unit) => !this.broken(unit),
      now: fast.now,
      after: fast.after,
      done: (version) => {
        this.stable = version
        if (this.state === "IN_PROGRESS") this.state = "COMPLETED"
        this.failures = 0
      }
    })
  }

  attach(fleet: Fleet): void {
    this.fleet = fleet
    this.rollout.attach(fleet)
  }

  /** The fleet's desired count. */
  target(): number {
    return this.rollout.target()
  }

  /** What a unit runs. */
  revisionOf(unit: Unit): Revision {
    return this.revisions.get(this.rollout.versionOf(unit)) ?? this.revisions.get(this.stable)!
  }

  /** Whether a unit runs a revision that fails its health checks. */
  broken(unit: Unit): boolean {
    return this.revisionOf(unit).failure === "unhealthy"
  }

  /** The revision a task launching now runs; call from the fleet's `phases`. */
  launching(unit: Unit): Revision {
    this.rollout.stamp(unit)
    return this.revisionOf(unit)
  }

  /** Settings changed: keep the current revision's task settings, and deploy a new revision. */
  settingsChanged(): void {
    const s = this.settings()
    const wanted = s.task.revision
    if (wanted === this.current) this.revisions.set(wanted, revisionOf(s, this.appStartMs()))
    else if (!this.failed.has(wanted) || this.state === "COMPLETED") {
      this.failed.delete(wanted)
      this.revisions.set(wanted, revisionOf(s, this.appStartMs()))
      this.current = wanted
      this.state = "IN_PROGRESS"
      this.failures = 0
      this.totals.deployments++
    }
    this.rollout.step()
  }

  /** A task of the deploying revision stopped before RUNNING, or failed its health checks. */
  taskFailed(unit: Unit): void {
    this.totals.failedTasks++
    if (this.state !== "IN_PROGRESS" || this.rollout.versionOf(unit) !== this.current) return
    this.failures++
    const s = this.settings()
    if (!s.deployment.circuitBreaker || this.failures < breakerThreshold(s.desiredCount)) return
    this.failed.add(this.current)
    if (s.deployment.rollback && this.stable !== this.current) {
      this.state = "ROLLED_BACK"
      this.totals.rollbacks++
      this.current = this.stable
    } else this.state = "FAILED"
    this.failures = 0
    this.rollout.step()
    this.fleet?.retry()
  }

  /** A task of the deploying revision is healthy: the circuit breaker starts counting again. */
  taskHealthy(unit: Unit): void {
    if (this.state === "IN_PROGRESS" && this.rollout.versionOf(unit) === this.current) this.failures = 0
  }

  /** The circuit breaker's threshold now. */
  threshold(): number {
    return breakerThreshold(this.settings().desiredCount)
  }
}
