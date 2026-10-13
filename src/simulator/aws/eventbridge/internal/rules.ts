import { Duration, SubscriptionRef } from "effect"
import type * as Edge from "../../../Edge.ts"
import { API_DESTINATION_TIMEOUT_MS, MAX_TARGETS_PER_RULE, type RuleTargetEdge } from "../Config.ts"
import { type Policy, Target } from "../Delivery.ts"
import { memoByIdentity } from "../../../internal/memo.ts"

/**
 * The bus's rules, read from its `out` edges. Each edge is a rule target; edges naming the same rule are that rule's
 * targets. Rules and targets past AWS's limits are kept out, as AWS would refuse to create them: a rule has at most five
 * targets, and a bus at most the account's rules-per-bus quota.
 */

/** One target as the rules use it: the edge, its settings as last read, and the policy they give. */
export interface Wired {
  readonly target: Target<RuleTargetEdge>
  readonly config: RuleTargetEdge
  readonly policy: Policy
}

export interface Rule {
  readonly name: string
  /** The targets an event that matches this rule goes to, in wiring order. */
  readonly targets: ReadonlyArray<Wired>
  /** Targets wired to this rule beyond the five it may have, or every target of a rule beyond the bus's quota. */
  readonly ignored: ReadonlyArray<Wired>
}

/** A target's policy, memoised on its edge settings (they only change when someone edits them). */
const policyOf = memoByIdentity((c: RuleTargetEdge): Policy => {
  const api = c.apiDestination.enabled
  return {
    maxRetries: c.retryPolicy.maxRetries,
    maxEventAgeMs: Duration.toMillis(c.retryPolicy.maxEventAge),
    deadLetter: c.deadLetterQueue,
    targetRate: api ? c.apiDestination.rate : 0,
    attemptTimeoutMs: api ? API_DESTINATION_TIMEOUT_MS : Infinity
  }
})

export class Rules {
  readonly targets: ReadonlyArray<Target<RuleTargetEdge>>
  private seen: Array<RuleTargetEdge | undefined> = []
  private quota = -1
  private active: ReadonlyArray<Rule> = []
  private all: ReadonlyArray<Rule & { readonly active: boolean }> = []

  constructor(links: ReadonlyArray<Edge.Link<RuleTargetEdge>>) {
    this.targets = links.map((link) => new Target(link))
  }

  /**
   * The rules in force. Grouping is redone only when an edge's settings or the rules quota changed since the last
   * call, so the per-event cost is one settings read per edge.
   */
  current(rulesQuota: number): ReadonlyArray<Rule> {
    let changed = rulesQuota !== this.quota
    const targets = this.targets
    for (let i = 0; i < targets.length; i++) {
      const c = SubscriptionRef.getUnsafe(targets[i]!.link.config)
      if (c !== this.seen[i]) {
        this.seen[i] = c
        changed = true
      }
    }
    if (changed) this.regroup(rulesQuota)
    return this.active
  }

  /** Every rule, with the ones past the quota marked inactive, for the probe. */
  describe(rulesQuota: number): ReadonlyArray<Rule & { readonly active: boolean }> {
    this.current(rulesQuota)
    return this.all
  }

  private regroup(rulesQuota: number): void {
    this.quota = rulesQuota
    const byName = new Map<string, Array<Wired>>()
    this.targets.forEach((target, i) => {
      const config = this.seen[i]!
      // An unnamed edge is a rule of its own; the edge id keeps it apart from every other.
      const name = config.rule.trim() === "" ? `(${target.link.id})` : config.rule.trim()
      let list = byName.get(name)
      if (list === undefined) byName.set(name, (list = []))
      list.push({ target, config, policy: policyOf(config) })
    })
    const all: Array<Rule & { readonly active: boolean }> = []
    let index = 0
    for (const [name, wired] of byName) {
      const active = index++ < rulesQuota
      all.push({
        name,
        active,
        targets: active ? wired.slice(0, MAX_TARGETS_PER_RULE) : [],
        ignored: active ? wired.slice(MAX_TARGETS_PER_RULE) : wired
      })
    }
    this.all = all
    this.active = all.filter((r) => r.active)
  }
}
