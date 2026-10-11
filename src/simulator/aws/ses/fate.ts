import type { Source } from "../../Distribution.ts"
import type { Message } from "../../Message.ts"
import type { Config } from "./config.ts"
import type { AccountState } from "./standing.ts"

/**
 * What becomes of one accepted call, decided in one go when SES accepts it. The counts are recipients: a call may carry
 * up to 50 and each has its own fate. Nothing here waits; the timers that publish the outcomes read these numbers.
 */
export class Fate {
  /** First attempt succeeds. */
  delivered = 0
  /** Hard bounces of new addresses (they join the suppression list or the unlisted bad addresses) and of repeats. */
  hardNew = 0
  hardRepeat = 0
  /** Sends stopped by the suppression list, for a bounce or a complaint earlier. */
  suppressedBounce = 0
  suppressedComplaint = 0
  /** Virus found: accepted, never delivered. */
  rejected = 0
  /** Not accepted at first by the recipient's server: those that a retry delivers, and those still failing at the end. */
  deferredOk = 0
  deferredFail = 0
  /** Complaints to come from what is delivered, how many from addresses not seen before, and opens and clicks. */
  complaints = 0
  complaintsNew = 0
  opens = 0
  clicks = 0

  constructor(readonly message: Message, readonly n: number) {}
}

/** The recipient behaviour settings and the suppression list, as they are now. */
type Recipients = Config["recipients"]
type Suppression = Config["suppression"]

/**
 * Decide the fate of `n` recipients. Each is either a repeat of an address the account has mailed (with probability
 * `repeatShare`) or a new one. A repeat is a draw from the addresses seen so far, so it lands on a known-bad address with
 * the share of bad addresses (suppressed if the list covers it, bouncing or complaining again if not); any other repeat
 * is a known-good address, which can only be delayed. A new address is rejected (virus), hard-bounces, is delayed or is
 * delivered, in that order of a single draw, and a delivered one may then complain.
 */
export const decide = (
  message: Message,
  n: number,
  r: Recipients,
  s: Suppression,
  account: AccountState,
  random: Source,
  wantOpen: boolean,
  wantClick: boolean
): Fate => {
  const f = new Fate(message, n)
  const listBounces = s.enabled && s.reasons !== "complaints"
  const listComplaints = s.enabled && s.reasons !== "bounces"
  const hardEdge = r.virusRate + r.hardBounceRate
  const deferEdge = hardEdge + r.deferredRate
  for (let i = 0; i < n; i++) {
    let known = false
    if (r.repeatShare > 0 && account.unique > 0 && random.nextDoubleUnsafe() < r.repeatShare) {
      let x = random.nextDoubleUnsafe() * account.unique
      if ((x -= account.badListed) < 0) {
        if (listBounces) f.suppressedBounce++
        else f.hardRepeat++
        continue
      }
      if ((x -= account.badUnlisted) < 0) {
        f.hardRepeat++
        continue
      }
      if ((x -= account.complainedListed) < 0) {
        if (listComplaints) f.suppressedComplaint++
        else {
          f.delivered++
          f.complaints++
        }
        continue
      }
      if ((x -= account.complainedUnlisted) < 0) {
        f.delivered++
        f.complaints++
        continue
      }
      known = true
    } else {
      account.unique++
    }
    const x = random.nextDoubleUnsafe()
    if (!known && x < r.virusRate) {
      f.rejected++
    } else if (!known && x < hardEdge) {
      f.hardNew++
    } else if (x >= hardEdge && x < deferEdge) {
      if (random.nextDoubleUnsafe() < r.deferralRecovery) f.deferredOk++
      else f.deferredFail++
    } else {
      f.delivered++
      if (!known && r.complaintRate > 0 && random.nextDoubleUnsafe() < r.complaintRate) {
        f.complaints++
        f.complaintsNew++
      }
      if (wantOpen && random.nextDoubleUnsafe() < r.openRate) f.opens++
      if (wantClick && random.nextDoubleUnsafe() < r.clickRate) f.clicks++
    }
  }
  return f
}
