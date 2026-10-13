import { Effect } from "effect"
import type { Unit } from "../../Protocol.ts"
import type { Account } from "../internal/account.ts"

/**
 * The region's running EC2 vCPUs, counted against the account's Standard vCPU quotas: one ledger per placement, shared by
 * every Auto Scaling group there through `node.shared`, so two groups in a region compete for one quota as they do in AWS.
 *
 * ECS capacity providers and EKS node groups run on EC2 instances too and count against the same quotas. A component
 * that launches instances takes from the same ledger:
 *
 *   const ledger = yield* node.shared(LEDGER_KEY, Effect.sync(makeLedger))
 *   if (!take(ledger, fast.account() as Account, "onDemand", 2)) ... // refused: wait and retry
 *   give(ledger, "onDemand", 2)                                      // when the instance stops or terminates
 *
 * On-Demand counts running instances (`ec2-on-demand-instances.html`: pending, stopping, stopped and hibernated
 * instances don't count); Spot counts running and requested ones (`using-spot-limits.html`). The simulator takes the
 * vCPUs when a launch starts and gives them back when the instance is gone, so an instance counts from its launch.
 */
export interface Ledger {
  /** vCPUs of On-Demand instances running (or starting) in the region. */
  onDemand: number
  /** vCPUs of Spot instances running (or starting) in the region. */
  spot: number
  /** Launches refused for want of quota, over the region. */
  refused: number
}

export type Purchase = "onDemand" | "spot"

/** The `node.shared` key the ledger lives under: the same for every service that launches EC2 instances. */
export const LEDGER_KEY = "aws.ec2.vcpus"

export const makeLedger = (): Ledger => ({ onDemand: 0, spot: 0, refused: 0 })

/** The ledger of a node's placement. */
export const ledgerOf = (node: { readonly shared: <A>(key: string, build: Effect.Effect<A>) => Effect.Effect<A> }): Effect.Effect<Ledger> =>
  node.shared(LEDGER_KEY, Effect.sync(makeLedger))

/** The quota for one purchase option, as the account's settings say now. */
export const quotaOf = (account: Account, purchase: Purchase): number => (purchase === "onDemand" ? account.ec2OnDemandStandardVcpus : account.ec2SpotStandardVcpus)

/** Take `vcpus` for one instance, or refuse if the quota doesn't have them (VcpuLimitExceeded, MaxSpotInstanceCountExceeded). */
export const take = (ledger: Ledger, account: Account, purchase: Purchase, vcpus: number): boolean => {
  if (ledger[purchase] + vcpus > quotaOf(account, purchase)) {
    ledger.refused++
    return false
  }
  ledger[purchase] += vcpus
  return true
}

/** Give back what an instance took. */
export const give = (ledger: Ledger, purchase: Purchase, vcpus: number): void => {
  ledger[purchase] = Math.max(0, ledger[purchase] - vcpus)
}

/**
 * A fleet's `capacity` for On-Demand instances (an ECS capacity provider's, an EKS node group's): each launch takes
 * `vcpus()` from the region's quota, and each instance gives back what it took when it goes (the type may have changed).
 */
export const onDemandCapacity = (
  ledger: Ledger,
  account: () => Account,
  vcpus: () => number
): { readonly take: (unit: Unit) => boolean; readonly give: (unit: Unit) => void } => {
  /** The vCPUs each instance took from the account's quota, by instance id. */
  const held = new Map<number, number>()
  return {
    take: (unit) => {
      const n = vcpus()
      if (!take(ledger, account(), "onDemand", n)) return false
      held.set(unit.id, n)
      return true
    },
    give: (unit) => {
      give(ledger, "onDemand", held.get(unit.id) ?? 0)
      held.delete(unit.id)
    }
  }
}
