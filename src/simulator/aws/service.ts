import type { Provider } from "../Provider.ts"

/**
 * A check of what a design asks of one AWS account in one region, against that account's quotas: reservations that
 * add up to more than the account has, provisioned capacity over the account total. `members` are the nodes in the
 * placement with their decoded settings; `quotas` is the account's quota settings as decoded (see `account.ts`).
 * Return diagnostics (warnings for "this will be clamped or throttled", errors for "this can't work").
 */
export type Audit = NonNullable<Provider["audit"]>
