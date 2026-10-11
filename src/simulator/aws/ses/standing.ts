import { DailyWindow } from "./window.ts"
import { Reputation } from "./reputation.ts"

/**
 * Everything SES keeps per AWS account and region, shared by every SES node placed there (`node.shared`): the rolling
 * 24-hour quota, the reputation, and the address book behind the suppression list.
 *
 * The suppression list is a rate model, not a map of addresses (which would grow for ever). The account has mailed
 * `unique` different addresses; `bad*` of them hard-bounced and `complained*` complained. A repeat recipient is a uniform
 * draw from those addresses, so with probability bad/unique it is a known-bad address: on the suppression list (the send is
 * accepted but not attempted) or, if the list is off or the reason not covered, it bounces again. Five counters, however
 * many addresses.
 */
export class AccountState {
  readonly daily = new DailyWindow()
  readonly reputation = new Reputation()
  /** Different addresses mailed so far. */
  unique = 0
  /** Addresses that hard-bounced and went on the suppression list / that hard-bounced with no list to catch them. */
  badListed = 0
  badUnlisted = 0
  /** The same for complaints. */
  complainedListed = 0
  complainedUnlisted = 0

  /** Addresses on the account-level suppression list. */
  get listed(): number {
    return this.badListed + this.complainedListed
  }
}
