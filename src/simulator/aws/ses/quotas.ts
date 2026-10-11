import * as Setting from "../../Setting.ts"
import { sources } from "./sources.ts"

/**
 * What a new SES account is limited to while it is in the sandbox: 200 emails per 24 hours and 1 per second.
 * Source: https://docs.aws.amazon.com/ses/latest/dg/quotas.html (also the sandbox page). AWS can raise them.
 */
export const SANDBOX_DAILY_QUOTA = 200
export const SANDBOX_SENDING_RATE = 1

/**
 * What a production account is limited to. AWS publishes no default: "this number varies based on your specific use
 * case", decided when production access is granted. 50,000 a day and 14 a second are the figures most often reported for
 * a freshly approved account, but they are folklore, not documentation, so they are assumptions here.
 */
export const PRODUCTION_DAILY_QUOTA = 50_000
export const PRODUCTION_SENDING_RATE = 14

/**
 * The account-level quotas of SES. They belong to the AWS account in a region ("SES quotas are for each AWS Region that
 * you use"), so every SES node in the same region shares them, and AWS publishes the same defaults for every region.
 * Quotas are counted in recipients, not messages: an email to 10 recipients counts as 10.
 */
export const quotas = (_region: string) => ({
  sesSandbox: Setting.bool({
    default: false,
    label: "SES sandbox",
    help:
      "New SES accounts start in the sandbox, per region: mail goes only to verified addresses and the mailbox simulator, at the sandbox quota and rate. Off here (production access) because designs usually model a live system; turn it on to see what a new account hits."
  }),
  sesSandboxDailyQuota: Setting.int({
    default: SANDBOX_DAILY_QUOTA,
    min: 1,
    max: 1_000_000_000,
    unit: "recipients/24 h",
    label: "SES daily quota (sandbox)",
    help: "Recipients the account may send in a rolling 24 hours while it is in the sandbox.",
    limit: Setting.quota(sources.sandbox, "200 per 24 hours in the sandbox. AWS raises it together with a production-access request.")
  }),
  sesSandboxSendingRate: Setting.int({
    default: SANDBOX_SENDING_RATE,
    min: 1,
    max: 1_000_000,
    unit: "recipients/s",
    label: "SES sending rate (sandbox)",
    help: "Recipients per second the account may send while it is in the sandbox.",
    limit: Setting.quota(sources.sandbox, "1 message per second in the sandbox.")
  }),
  sesDailyQuota: Setting.int({
    default: PRODUCTION_DAILY_QUOTA,
    min: 1,
    max: 1_000_000_000,
    unit: "recipients/24 h",
    label: "SES daily quota (production)",
    help:
      "Recipients the account may send in a rolling 24 hours once out of the sandbox. AWS publishes no default (it depends on your use case and sending history); 50,000 is an assumption.",
    limit: Setting.quota(sources.quotas, "Production quotas are set per account when AWS grants production access, and can be raised on request.")
  }),
  sesSendingRate: Setting.int({
    default: PRODUCTION_SENDING_RATE,
    min: 1,
    max: 1_000_000,
    unit: "recipients/s",
    label: "SES sending rate (production)",
    help:
      "Recipients per second once out of the sandbox. AWS publishes no default; 14 per second is an assumption. Short bursts above it are allowed (the bucket holds one second's worth, an assumption).",
    limit: Setting.quota(sources.quotas, "Production quotas are set per account when AWS grants production access, and can be raised on request.")
  })
})
