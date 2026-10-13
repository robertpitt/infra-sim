import { Duration, SubscriptionRef } from "effect"
import type { Fast } from "../../../Component.ts"
import type { Cancel, Config as EdgeConfig, Link } from "../../../Edge.ts"
import type { CallFailure } from "../../../Message.ts"
import type { Counter, Sampler } from "../../../Telemetry.ts"
import type { TimerHandle } from "../../../VirtualTime.ts"
import { HEALTHY_SHARE, HTTP_CONNECT_TIMEOUT_MS, HTTP_RESPONSE_TIMEOUT_MS, type RecordSettings, TCP_CONNECT_TIMEOUT_MS } from "./config.ts"

/** An edge leaving the record's `out` port: one record, and the way to its endpoint. */
export type RecordLink = Link<EdgeConfig & RecordSettings>

/** How every health check of this record is set up. */
export interface Plan {
  readonly tcp: boolean
  readonly intervalMs: number
  readonly threshold: number
  /** Health checkers per endpoint: regions times checkers in each. */
  readonly checkers: number
}

const samePlan = (a: Plan, b: Plan): boolean =>
  a.tcp === b.tcp && a.intervalMs === b.intervalMs && a.threshold === b.threshold && a.checkers === b.checkers

/**
 * Each record's endpoint, by the identity of its edge's settings (the same object on the record's link and on the edge's
 * connector): how the `aws.route53.connection` connector on an edge finds the health check it reports as that edge's
 * HealthCheckStatus. The record is made before the connectors on its edges, so it is filled by the time they look.
 */
export const endpointOfEdge = new WeakMap<object, Endpoint>()

/** HealthCheckStatus: 1 while Route 53 considers the endpoint healthy (a record without a health check always is), else 0. */
export const statusOf = (e: Endpoint): number => (e.healthy ? 1 : 0)

/** HealthCheckPercentageHealthy, 0 to 1: the share of health checkers that say healthy (1 without a health check). */
export const percentageHealthyOf = (e: Endpoint): number => (e.checked && e.checkers.length > 0 ? e.up / e.checkers.length : 1)

/** What Route 53 thinks of one record's endpoint. */
export class Endpoint {
  /** A health check watches it. Without one, a record is always healthy. */
  checked = false
  /** Route 53's verdict: more than 18% of the checkers say healthy. */
  healthy = true
  /** Checkers that say healthy right now. */
  up = 0
  checkers: Array<Checker> = []
  changedAt = 0
  plan: Plan | undefined
  /** Bumped whenever the checkers are replaced, so a late answer to an old one is ignored. */
  generation = 0
}

/** One health checker in one region, probing one endpoint on its own clock. */
class Checker {
  healthy = true
  /** Consecutive results that disagree with `healthy`. */
  streak = 0
  timer: TimerHandle | undefined
  deadline: TimerHandle | undefined
  cancel: Cancel | undefined
  /** The probe in flight: a later result for an earlier one is ignored. */
  attempt = 0
  /** When the probe in flight was sent. */
  sentAt = 0
  constructor(readonly checks: HealthChecks, readonly record: number, readonly generation: number) {}
}

/**
 * The health checkers of one record: for each record with a health check, `plan.checkers` independent checkers that
 * each send a request through the record's edge every interval (measured from the last response), call a result after
 * `threshold` consecutive results that disagree with them, and together make Route 53's verdict. The request is a real
 * call through the edge, so an endpoint that is down, slow, failing or in a region that is out is seen as such.
 */
export class HealthChecks {
  readonly endpoints: Array<Endpoint>
  /** Since the start (the counters are per frame). */
  readonly totals = { probes: 0, probeFailures: 0 }

  constructor(
    private readonly fast: Pick<Fast<unknown>, "after" | "now" | "random" | "mint">,
    private readonly links: ReadonlyArray<RecordLink>,
    private readonly counters: {
      readonly probes: Counter
      readonly probeFailures: Counter
      readonly healthChanges: Counter
      /** How long the checks the endpoint answered took (TimeToFirstByte, or ConnectionTime for TCP checks). */
      readonly checkTime: Sampler
    }
  ) {
    this.endpoints = links.map(() => new Endpoint())
    links.forEach((link, i) => endpointOfEdge.set(link.config, this.endpoints[i]!))
  }

  /**
   * Set which records are checked and how. A record whose checks are unchanged keeps its checkers; one whose plan changed
   * gets new checkers that start from its current verdict; one that gains a check starts healthy, as a new health check
   * does until there is enough data.
   */
  configure(wanted: ReadonlyArray<boolean>, plan: Plan): void {
    for (let i = 0; i < this.endpoints.length; i++) {
      const e = this.endpoints[i]!
      const want = wanted[i] === true
      if (!want) {
        if (e.checked) {
          this.stop(e)
          e.checked = false
          e.plan = undefined
          this.verdict(e, true)
        }
        continue
      }
      if (e.checked && e.plan !== undefined && samePlan(e.plan, plan)) continue
      this.stop(e)
      e.checked = true
      e.plan = plan
      e.generation++
      e.up = e.healthy ? plan.checkers : 0
      e.checkers = []
      for (let k = 0; k < plan.checkers; k++) {
        const checker = new Checker(this, i, e.generation)
        checker.healthy = e.healthy
        // Checkers in different places don't coordinate: each starts at its own moment within the interval.
        checker.timer = this.fast.after(plan.intervalMs * this.fast.random.nextDoubleUnsafe(), fire, checker)
        e.checkers.push(checker)
      }
    }
  }

  /** How many records have a health check. */
  get active(): number {
    let n = 0
    for (const e of this.endpoints) if (e.checked) n++
    return n
  }

  private stop(e: Endpoint): void {
    e.generation++
    for (const c of e.checkers) {
      c.timer?.cancel()
      c.deadline?.cancel()
      c.cancel?.()
    }
    e.checkers = []
  }

  private current(c: Checker): Endpoint | undefined {
    const e = this.endpoints[c.record]
    return e !== undefined && e.generation === c.generation ? e : undefined
  }

  /** Send one health check request through the record's edge. */
  probe(c: Checker): void {
    c.timer = undefined
    const e = this.current(c)
    if (e === undefined || e.plan === undefined) return
    const plan = e.plan
    const attempt = ++c.attempt
    const link = this.links[c.record]!
    // HTTP: the connection (one round trip) within 4 s, then a 2xx or 3xx within 2 s of connecting. The model can't
    // split the two, so it allows the round trip plus 2 s, or fails at 4 s when the round trip alone is longer. TCP: 10 s.
    const rtt = 2 * Duration.toMillis(SubscriptionRef.getUnsafe(link.config).latency.mean)
    const limit = plan.tcp ? TCP_CONNECT_TIMEOUT_MS : rtt > HTTP_CONNECT_TIMEOUT_MS ? HTTP_CONNECT_TIMEOUT_MS : rtt + HTTP_RESPONSE_TIMEOUT_MS
    c.deadline = this.fast.after(limit, expire, c)
    c.sentAt = this.fast.now()
    const message = this.fast.mint({ operation: "read", bytes: 0, count: 1, invocation: "sync" })
    c.cancel = link.send(message, (failure) => {
      if (attempt !== c.attempt) return
      this.counters.checkTime.add(this.fast.now() - c.sentAt)
      this.answered(c, plan.tcp ? passesTcp(failure) : failure === undefined)
    })
  }

  /** The checker gave up waiting: the endpoint failed this check. */
  expired(c: Checker): void {
    c.deadline = undefined
    if (this.current(c) === undefined) return
    c.cancel?.()
    c.attempt++
    this.answered(c, false)
  }

  private answered(c: Checker, pass: boolean): void {
    c.deadline?.cancel()
    c.deadline = undefined
    c.cancel = undefined
    const e = this.current(c)
    if (e === undefined || e.plan === undefined) return
    this.counters.probes.n++
    this.totals.probes++
    if (!pass) {
      this.counters.probeFailures.n++
      this.totals.probeFailures++
    }
    if (pass === c.healthy) c.streak = 0
    else if (++c.streak >= e.plan.threshold) {
      c.healthy = pass
      c.streak = 0
      e.up += pass ? 1 : -1
      this.verdict(e, e.up > HEALTHY_SHARE * e.checkers.length)
    }
    // The interval runs from the response, not from the request.
    c.timer = this.fast.after(e.plan.intervalMs, fire, c)
  }

  private verdict(e: Endpoint, healthy: boolean): void {
    if (healthy === e.healthy) return
    e.healthy = healthy
    e.changedAt = this.fast.now()
    this.counters.healthChanges.n++
  }
}

/** A TCP check only connects: an endpoint that answers with an error has still accepted the connection. */
const passesTcp = (failure: CallFailure | undefined): boolean =>
  failure === undefined || (failure._tag !== "Unavailable" && failure._tag !== "Timeout")

const fire = (c: Checker): void => c.checks.probe(c)
const expire = (c: Checker): void => c.checks.expired(c)
