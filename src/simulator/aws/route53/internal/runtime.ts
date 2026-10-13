import { Duration, Effect, SubscriptionRef } from "effect"
import * as Distribution from "../../../Distribution.ts"
import type { Cancel } from "../../../Edge.ts"
import * as Flow from "../../../Flow.ts"
import { type Call, type CallFailure, type Message, Rejected, type Reply } from "../../../Message.ts"
import type * as Aws from "../../internal/provider.ts"
import { type Config, continentOf, HEALTHY_SHARE, MAX_POLICY_RECORDS, MAX_SIMPLE_VALUES, type ports } from "./config.ts"
import { HealthChecks, percentageHealthyOf, type Plan } from "./health.ts"
import { NONE, ResolverCaches } from "./resolvers.ts"
import { choose, type Records } from "./routing.ts"

/** How often the record looks at its settings and the account quota to set up its health checks again. */
const RECONCILE_MS = 1_000

export type Route53Node = Aws.Node<typeof import("./config.ts").Config, typeof ports>

/**
 * The account's health checks, shared by every record in the placement. AWS refuses to create a health check past the
 * quota, so a record that asks for one when none are left has none, and is always healthy. Each record claims what it
 * wants; the claims of the others are what is left for it.
 */
export class HealthCheckLedger {
  private readonly claims = new Map<string, number>()
  grant(owner: string, wanted: number, quota: number): number {
    let others = 0
    for (const [who, n] of this.claims) if (who !== owner) others += n
    const granted = Math.max(0, Math.min(wanted, quota - others))
    this.claims.set(owner, granted)
    return granted
  }
}

/**
 * The record at run time. A call is answered by the resolver cache its key falls in: from the cache while the cached
 * answer lives (no delay: Route 53 is not in the data path), otherwise by asking Route 53, which picks a record by the
 * routing policy and its health checks' verdicts, at the cost of one lookup. Either way the call then goes straight to
 * the endpoint the answer names. See `README.md`.
 */
export const makeRuntime = (node: Route53Node, ledger: HealthCheckLedger) => {
  const { fast } = node
  const links = node.out("out")
  /** Where the callers are: the node stands with them (see the README), so its region is their location. */
  const continent = continentOf(node.placement.region)

  const queries = node.meter.counter("queries")
  const cacheHits = node.meter.counter("cacheHits")
  const noAnswer = node.meter.counter("noAnswer")
  const probes = node.meter.counter("probes")
  const probeFailures = node.meter.counter("probeFailures")
  const healthChanges = node.meter.counter("healthChanges")
  const checkTime = node.meter.sampler("healthCheckTime")
  const total = { queries: 0, cacheHits: 0, noAnswer: 0 }

  const health = new HealthChecks(fast, links, { probes, probeFailures, healthChanges, checkTime })
  const caches = new ResolverCaches()
  const table: Records = {
    n: 0,
    weight: links.map(() => 0),
    secondary: links.map(() => false),
    location: links.map(() => "default" as const),
    latencyMs: links.map(() => 0),
    healthy: links.map(() => true)
  }
  const seen: Array<unknown> = links.map(() => undefined)
  const unhealthy = (record: number): boolean => {
    const e = health.endpoints[record]
    return e !== undefined && e.checked && !e.healthy
  }

  // Settings-derived values, recomputed only when the settings object is replaced (every edit replaces it).
  let derivedFrom: Config | undefined
  let ttlMs = 0
  let ignoringMs = 0
  let ignoring = 0
  const refresh = (c: Config): void => {
    derivedFrom = c
    caches.resize(c.resolvers.count)
    ttlMs = Duration.toMillis(c.ttl)
    // A resolver that ignores the TTL keeps an answer longer than it, never shorter.
    ignoringMs = Math.max(ttlMs, Duration.toMillis(c.resolvers.ignoreTtlFor))
    ignoring = Math.round(c.resolvers.ignoreTtlShare * c.resolvers.count)
  }

  /** Bring the table a query reads up to date with the edges' settings and Route 53's verdicts. */
  const sync = (c: Config): void => {
    table.n = Math.min(links.length, c.policy === "simple" ? MAX_SIMPLE_VALUES : MAX_POLICY_RECORDS)
    for (let i = 0; i < links.length; i++) {
      const cfg = SubscriptionRef.getUnsafe(links[i]!.config)
      if (cfg !== seen[i]) {
        seen[i] = cfg
        table.weight[i] = cfg.weight
        table.secondary[i] = cfg.role === "secondary"
        table.location[i] = cfg.location
        table.latencyMs[i] = Duration.toMillis(cfg.latency.mean)
      }
      table.healthy[i] = !unhealthy(i)
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Health checks: which records have one, under the account's quota
  // ---------------------------------------------------------------------------------------------------------------

  let refused = 0
  const reconcile = (): void => {
    const c = fast.settings()
    const account = fast.account() as Aws.Account
    // Simple routing has no health checks; other policies check the records that ask, up to AWS's cap on records.
    const cap = c.policy === "simple" ? 0 : Math.min(links.length, MAX_POLICY_RECORDS)
    const wanted = links.map((link, i) => i < cap && SubscriptionRef.getUnsafe(link.config).healthCheck)
    let asked = 0
    for (const w of wanted) if (w) asked++
    const granted = ledger.grant(node.id, asked, account.route53HealthChecks)
    refused = asked - granted
    let given = 0
    for (let i = 0; i < wanted.length; i++) {
      if (!wanted[i]) continue
      if (given >= granted) wanted[i] = false
      else given++
    }
    const plan: Plan = {
      tcp: c.healthCheck.type === "tcp",
      intervalMs: Number(c.healthCheck.interval) * 1000,
      threshold: c.healthCheck.failureThreshold,
      checkers: c.healthCheck.regions * c.healthCheck.checkersPerRegion
    }
    health.configure(wanted, plan)
  }
  const tick = (): void => {
    reconcile()
    fast.after(RECONCILE_MS, tick, undefined)
  }
  refresh(fast.settings())
  tick()

  // ---------------------------------------------------------------------------------------------------------------
  // The call
  // ---------------------------------------------------------------------------------------------------------------

  /** Go to the endpoint once the lookup is done. */
  const after = (wait: number, link: (typeof links)[number], message: Message): Call =>
    Effect.callback<Reply, CallFailure>((resume) => {
      let cancel: Cancel | undefined
      const timer = fast.after(wait, () => {
        cancel = link.send(message, (failure, items) => resume(failure !== undefined ? Effect.fail(failure) : items === undefined ? Effect.void : Effect.succeed(items)))
      }, undefined)
      return Effect.sync(() => {
        timer.cancel()
        cancel?.()
      })
    })

  const call = (message: Message): Call => {
    const c = fast.settings()
    if (c !== derivedFrom) refresh(c)
    const now = fast.now()
    const cache = caches.of(message.key)
    const held = caches.cached(cache, now)
    if (held !== NONE && held < links.length) {
      cacheHits.n++
      total.cacheHits++
      return links[held]!.invoke(message)
    }

    // The resolver has no live answer: it asks Route 53, and the call waits for the lookup.
    queries.n++
    total.queries++
    sync(c)
    const record = choose(c.policy, table, fast.random, continent)
    const wait = Distribution.latencyMs(c.resolvers.lookup, fast.random)
    if (record === NONE) {
      // Nothing to answer with: no records at all, or none for the callers' location and no default. Retrying won't help.
      noAnswer.n++
      total.noAnswer++
      const reason = links.length === 0 ? "NXDOMAIN: the name has no records" : "no answer: no record for the callers' location and no default"
      return Flow.delayed(fast, wait, () => Rejected({ node: node.id, reason }))
    }
    caches.store(cache, record, now, cache < ignoring ? ignoringMs : ttlMs, fast.random)
    const link = links[record]!
    return wait > 0 ? after(wait, link, message) : link.invoke(message)
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Gauges and probe
  // ---------------------------------------------------------------------------------------------------------------

  const unhealthyRecords = (): number => {
    let n = 0
    for (let i = 0; i < links.length; i++) if (unhealthy(i)) n++
    return n
  }
  const cachedUnhealthy = (): number => {
    const counted = caches.count(fast.now(), unhealthy)
    return counted.live > 0 ? counted.bad / counted.live : 0
  }
  /** HealthCheckStatus summed over the records: how many health-checked records are healthy. */
  const healthyChecks = (): number => {
    let n = 0
    for (const e of health.endpoints) if (e.checked && e.healthy) n++
    return n
  }
  /** The lowest HealthCheckPercentageHealthy of the records' health checks (1 when none has one): what to alarm on. */
  const lowestPercentageHealthy = (): number => {
    let lowest = 1
    for (const e of health.endpoints) if (e.checked) lowest = Math.min(lowest, percentageHealthyOf(e))
    return lowest
  }
  node.meter.gaugeUnsafe("unhealthyRecords", unhealthyRecords)
  node.meter.gaugeUnsafe("cachedUnhealthy", cachedUnhealthy)
  node.meter.gaugeUnsafe("healthChecks", () => health.active)
  node.meter.gaugeUnsafe("healthyChecks", healthyChecks)
  node.meter.gaugeUnsafe("lowestPercentageHealthy", lowestPercentageHealthy)
  // The line a health check's percentage must stay above for Route 53 to call the endpoint healthy.
  node.meter.gaugeUnsafe("healthyThreshold", () => HEALTHY_SHARE)

  const probe = Effect.sync(() => {
    const c = fast.settings()
    if (c !== derivedFrom) refresh(c)
    const now = fast.now()
    const counted = caches.count(now, unhealthy)
    const held = caches.perRecord(now, links.length)
    return {
      policy: c.policy,
      ttlSeconds: ttlMs / 1000,
      records: links.map((link, i) => {
        const e = health.endpoints[i]!
        return {
          edge: link.id,
          to: link.to,
          healthChecked: e.checked,
          healthy: !unhealthy(i),
          checkersHealthy: e.checked ? e.up : 0,
          checkers: e.checkers.length,
          changedAt: e.changedAt,
          cachedShare: counted.live > 0 ? held[i]! / counted.live : 0
        }
      }),
      resolvers: caches.size,
      cached: counted.live,
      cachedUnhealthy: counted.live > 0 ? counted.bad / counted.live : 0,
      queries: total.queries,
      cacheHits: total.cacheHits,
      noAnswer: total.noAnswer,
      probes: health.totals.probes,
      probeFailures: health.totals.probeFailures,
      healthChecks: health.active,
      healthChecksRefused: refused
    }
  })

  return { call, probe }
}
