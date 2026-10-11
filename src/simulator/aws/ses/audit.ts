import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../account.ts"
import type { Audit } from "../service.ts"
import { type Config, MAX_RECIPIENTS } from "./config.ts"
import { REVIEW_BOUNCE_RATE, REVIEW_COMPLAINT_RATE } from "./reputation.ts"

const pct = (fraction: number): string => `${+(fraction * 100).toFixed(2)}%`

/**
 * What the SES nodes of a region ask of the account, judged from their settings alone (the traffic is not known to a
 * static check): a recipient population that would put the account under review, a message that SES would refuse, and
 * the sandbox's restrictions.
 */
export const audit: Audit = (region, members, quotas) => {
  const nodes = members.filter((m) => m.type === "aws.ses")
  if (nodes.length === 0) return []
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  if (account.sesSandbox) {
    out.push({
      level: "info",
      code: "ses-sandbox",
      message: `SES in ${region} is in the sandbox: mail goes only to verified recipients, at most ${account.sesSandboxDailyQuota.toLocaleString("en-US")} recipients a day and ${account.sesSandboxSendingRate.toLocaleString("en-US")} a second. Request production access to lift it.`
    })
  }
  if (nodes.length > 1) {
    out.push({
      level: "info",
      code: "ses-shared-account",
      message: `${nodes.length} SES nodes run in ${region}. They are one account: they share its sending quota and rate, and one bounce and complaint rate decides whether it is reviewed or paused.`
    })
  }
  for (const m of nodes) {
    const c = m.config as Config
    if (account.sesSandbox && c.verifiedShare < 1) {
      out.push({
        level: "warning",
        code: "ses-sandbox-unverified",
        node: m.id,
        message: `${m.name} mails recipients that are not all verified, and the account is in the sandbox, so SES refuses those messages.`
      })
    }
    if (c.recipients.hardBounceRate >= REVIEW_BOUNCE_RATE) {
      out.push({
        level: "warning",
        code: "ses-bounce-rate",
        node: m.id,
        message: `${m.name} has a hard bounce rate of ${pct(c.recipients.hardBounceRate)}. AWS places an account under review at ${pct(REVIEW_BOUNCE_RATE)} and may pause its sending at 10%.`
      })
    }
    if (c.recipients.complaintRate >= REVIEW_COMPLAINT_RATE) {
      out.push({
        level: "warning",
        code: "ses-complaint-rate",
        node: m.id,
        message: `${m.name} has a complaint rate of ${pct(c.recipients.complaintRate)}. AWS places an account under review at ${pct(REVIEW_COMPLAINT_RATE)} and may pause its sending at 0.5%.`
      })
    }
    if (c.batchSize > MAX_RECIPIENTS) {
      out.push({
        level: "warning",
        code: "ses-recipients",
        node: m.id,
        message: `${m.name} sends ${c.batchSize.toLocaleString("en-US")} recipients per call, but SES accepts at most ${MAX_RECIPIENTS} per message or bulk call.`
      })
    }
  }
  return out
}
