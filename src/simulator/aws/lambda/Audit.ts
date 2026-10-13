import { Duration } from "effect"
import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../internal/account.ts"
import { type Audit, fmt } from "../internal/service.ts"
import type { Settings } from "./internal/config.ts"
import { claimOf } from "./internal/config.ts"
import { MIN_UNRESERVED } from "./internal/limits.ts"

/**
 * Static checks of a region's Lambda functions against the account's concurrency quota and against each other:
 * reservations and provisioned concurrency that add up to more than can be held back, provisioned concurrency over a
 * reservation, SnapStart combined with provisioned concurrency, a function that can never run, and a cold start longer
 * than the timeout. Pure and cheap: it reads decoded settings and nothing else.
 */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  const functions = members.filter((m) => m.type === "aws.lambda")

  const held = functions.reduce((sum, m) => sum + claimOf(m.config as Settings), 0)
  const reservable = Math.max(0, account.lambdaConcurrency - MIN_UNRESERVED)
  if (held > reservable) {
    out.push({
      level: "warning",
      code: "lambda-reservations",
      message: `Lambda in ${region} reserves or provisions ${fmt(held)} concurrent executions, but only ${fmt(reservable)} can be held back (AWS keeps ${MIN_UNRESERVED} of the ${fmt(account.lambdaConcurrency)} unreserved).`
    })
  }

  for (const m of functions) {
    const c = m.config as Settings
    if (c.reserved.enabled && c.provisioned > c.reserved.concurrency) {
      out.push({
        level: "warning",
        code: "lambda-provisioned-over-reserved",
        node: m.id,
        message: `${m.name} provisions ${fmt(c.provisioned)} environments but reserves only ${fmt(c.reserved.concurrency)}. AWS doesn't allow more provisioned than reserved concurrency; the simulator uses ${fmt(c.reserved.concurrency)}.`
      })
    }
    if (c.coldStart.snapStart && c.provisioned > 0) {
      out.push({
        level: "warning",
        code: "lambda-snapstart-provisioned",
        node: m.id,
        message: `${m.name} has both SnapStart and provisioned concurrency. AWS doesn't support the two together; the simulator ignores SnapStart.`
      })
    }
    if (c.reserved.enabled && c.reserved.concurrency === 0) {
      out.push({
        level: "info",
        code: "lambda-reserved-zero",
        node: m.id,
        message: `${m.name} has reserved concurrency 0: every synchronous call is throttled and asynchronous events go straight to the failure destination.`
      })
    }
    // The timeout does not cover a normal cold start, but it does cover the one that repeats an Init that overran 10 s.
    const timeout = Duration.toMillis(c.timeout)
    const init = Duration.toMillis(c.coldStart.init.mean)
    if (init > 10_000 && init >= timeout) {
      out.push({
        level: "warning",
        code: "lambda-init-over-timeout",
        node: m.id,
        message: `${m.name} takes ${fmt(init)} ms to initialise on average, past the 10 s Init limit: Lambda retries Init inside the first invocation, where the ${fmt(timeout)} ms timeout is too short for it, so cold starts will time out.`
      })
    }
  }
  return out
}
