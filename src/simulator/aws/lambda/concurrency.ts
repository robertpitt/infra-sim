import type { Account } from "../account.ts"
import { claimOf, type Settings } from "./config.ts"
import { MIN_UNRESERVED } from "./limits.ts"

/**
 * Per-region bookkeeping every Lambda function in a placement shares (built once per placement through
 * `node.shared`). The regional concurrency is one pool: reservations are carved out of it, and what is left is shared
 * by every function without one.
 */
export interface Region {
  /** Executions currently running on the shared, unreserved pool. */
  unreservedInUse: number
  /** What each function holds back from the pool: its reservation, or its provisioned concurrency. */
  readonly claims: Map<string, number>
  /** Changes whenever a claim does, so each function knows when to work out its standing again. */
  version: number
}

export const makeRegion = (): Region => ({ unreservedInUse: 0, claims: new Map(), version: 0 })

/**
 * Where a function stands against the limits right now: its reservation if it has one, otherwise the shared regional
 * pool, which is the account limit minus what every function has claimed (never below 100).
 */
export interface Standing {
  readonly reserved: boolean
  readonly reservation: number
  /** Size of the shared, unreserved pool right now. */
  readonly pool: number
  /** The most concurrent executions this function is allowed right now. */
  readonly limit: number
}

type Settled = { readonly settings: () => Settings; readonly account: () => unknown }

/**
 * One function's view of the regional concurrency accounting. The claim is registered when the function is built and
 * whenever its settings change (so an idle function still holds back what it reserves), and the standing is
 * memoised against the identity of the settings, the account quotas and everyone's claims: it is worked out again
 * only when one of them changes, not per call.
 */
export class Concurrency {
  private memo: { c: Settings; account: Account; version: number; value: Standing } | undefined

  constructor(
    private readonly id: string,
    private readonly region: Region,
    private readonly fast: Settled
  ) {}

  /** Tell the region what this function holds back, if it changed. */
  claim(c: Settings): void {
    const mine = claimOf(c)
    if (this.region.claims.get(this.id) !== mine) {
      this.region.claims.set(this.id, mine)
      this.region.version++
    }
  }

  standing(): Standing {
    const c = this.fast.settings()
    const account = this.fast.account() as Account
    this.claim(c)
    const memo = this.memo
    if (memo !== undefined && memo.c === c && memo.account === account && memo.version === this.region.version) return memo.value
    let claimed = 0
    for (const v of this.region.claims.values()) claimed += v
    // AWS keeps at least 100 unreserved, so reservations (and provisioned concurrency) can total at most the quota minus 100.
    const pool = account.lambdaConcurrency - Math.min(claimed, Math.max(0, account.lambdaConcurrency - MIN_UNRESERVED))
    const value: Standing = {
      reserved: c.reserved.enabled,
      reservation: c.reserved.concurrency,
      pool,
      limit: c.reserved.enabled ? c.reserved.concurrency : pool + c.provisioned
    }
    this.memo = { c, account, version: this.region.version, value }
    return value
  }
}
