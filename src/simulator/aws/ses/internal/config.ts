import { type Duration, Schema } from "effect"
import * as Edge from "../../../Edge.ts"
import * as Setting from "../../../Setting.ts"
import { sources } from "./sources.ts"
import { MiB } from "../../internal/units.ts"

/** At most 50 recipients (To, CC and BCC together) per message, and 50 entries per SendBulkEmail. Not adjustable. */
export const MAX_RECIPIENTS = 50
/** The largest message after MIME encoding: 10 MB through the v1 API, 40 MB through the v2 API or SMTP. Not adjustable. */
export const MAX_MESSAGE_BYTES = { v1: 10 * MiB, v2: 40 * MiB } as const
/**
 * Attachments grow when MIME-encoded: "a 5 MB attachment is about 6.85 MB in the email" (137%). The limit applies to the
 * encoded size, so the `bytes` a caller sends are multiplied by this before the check.
 */
export const MIME_OVERHEAD = 1.37
/** Above 10 MB a message is subject to bandwidth throttling "as low as 40 MB/s" (a 40 MB message per second). */
export const LARGE_MESSAGE_BYTES = 10 * MiB
export const LARGE_MESSAGE_BANDWIDTH = 40 * MiB
/**
 * How big an event record is once it reaches a queue, a topic or a function: a JSON document with the mail headers and
 * the recipients, a few KB. AWS publishes no figure; an assumption.
 */
export const EVENT_BYTES = 2_048

/**
 * Which events a destination receives: a configuration set's event destination lists "matching event types". Open and
 * click are off by default because they need open and click tracking, which costs the sender nothing but is opt-in.
 */
export const EVENT_KINDS = ["send", "delivery", "bounce", "complaint", "reject", "deliveryDelay", "open", "click"] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/**
 * What an event destination retries like. AWS does not document how SES retries a failed publish to SNS, Firehose or
 * EventBridge, so the schedule is an assumption: five attempts backing off from 1 to 30 seconds.
 */
export const Destination = Schema.Struct({
  retry: Edge.retryWith({ maxAttempts: 5, backoff: "1 second", backoffFactor: 2, maxBackoff: "30 seconds", jitter: true }),
  events: Setting.group(
    {
      send: Setting.bool({ default: true, label: "Send", help: "SES accepted the message and will try to deliver it (also counted when delivery is then suppressed)." }),
      delivery: Setting.bool({ default: true, label: "Delivery", help: "The recipient's mail server accepted the message." }),
      bounce: Setting.bool({ default: true, label: "Bounce", help: "A hard bounce, or a soft bounce SES has stopped retrying, or a send to a suppressed address." }),
      complaint: Setting.bool({ default: true, label: "Complaint", help: "The recipient marked the message as spam." }),
      reject: Setting.bool({ default: true, label: "Reject", help: "SES accepted the message, found a virus in it and did not send it." }),
      deliveryDelay: Setting.bool({ default: true, label: "Delivery delay", help: "A temporary problem delayed delivery; SES keeps retrying." }),
      open: Setting.bool({ default: false, label: "Open", help: "The recipient opened the message (needs open tracking)." }),
      click: Setting.bool({ default: false, label: "Click", help: "The recipient clicked a link (needs click tracking)." })
    },
    { label: "Event types", help: "The matching event types of this event destination." }
  )
})

/**
 * `Setting.latency` stops at 10 minutes, which is right for a request. The delays of mail are longer (a retry after
 * minutes, a complaint after hours), so this is the same mean and variability pair with a ceiling of 30 days.
 */
const slow = (o: { readonly mean: Duration.Input; readonly cv: number; readonly label: string; readonly help: string }) =>
  Setting.group(
    {
      mean: Setting.duration({ default: o.mean, min: 0, max: "30 days", label: "Average", help: "Typical time taken" }),
      cv: Setting.number({ default: o.cv, min: 0, max: 3, step: 0.05, label: "Variability", help: "Coefficient of variation: 0 is constant, 1 is heavily spread" })
    },
    { label: o.label, help: o.help }
  )

const rate = (o: { default: number; label: string; help: string }) => Setting.ratio(o)

/** The settings of one SES node: how it is called, who the recipients are, and how AWS treats the account. */
export const Config = Schema.Struct({
  call: Setting.choice(["send", "bulk"], {
    default: "send",
    labels: { send: "SendEmail / SendRawEmail / SMTP", bulk: "SendBulkEmail" },
    help:
      "What each incoming call is. A send is one message to every recipient it carries, so its size is the message size. A bulk send is one message per recipient (up to 50 entries), so the size is divided between them."
  }),
  api: Setting.choice(["v2", "v1"], {
    default: "v2",
    labels: { v2: "SES v2 API or SMTP", v1: "SES v1 API" },
    help: "Decides the largest message: 40 MB through the v2 API or SMTP, 10 MB through the v1 API (both after MIME encoding; hard limits, see the README)."
  }),
  batchSize: Setting.int({
    default: 1,
    min: 1,
    max: 10_000,
    unit: "recipients",
    label: "Recipients per call",
    help:
      "How many recipients one incoming message carries (a message the caller sends with a count above 1 multiplies it). SES refuses more than 50 recipients per message or per bulk call, and quotas are counted in recipients, so this is how to see both limits bite."
  }),
  sendLatency: Setting.latency({
    mean: "30 millis",
    cv: 0.5,
    label: "API latency",
    help: "How long SendEmail takes to answer once the request arrives. AWS publishes no figure; an assumption."
  }),
  verifiedShare: Setting.ratio({
    default: 0,
    label: "Verified recipients",
    help:
      "Only matters in the sandbox, where SES refuses a message unless every recipient is a verified address or the mailbox simulator. The share of recipients that are. Zero is a real application mailing real customers."
  }),
  recipients: Setting.group(
    {
      hardBounceRate: rate({
        default: 0.01,
        label: "Hard bounce rate",
        help: "Share of new addresses that do not exist or permanently refuse mail. Counts toward the bounce rate AWS acts on. AWS asks senders to stay under 5% (it reviews the account at 5%) and suggests under 2%."
      }),
      complaintRate: rate({
        default: 0.0003,
        label: "Complaint rate",
        help: "Share of delivered mail the recipient reports as spam. AWS places the account under review at 0.1%."
      }),
      deferredRate: rate({
        default: 0.02,
        label: "Delivered late",
        help: "Share of recipients whose mail server cannot take the message at first (mailbox full, busy server). SES keeps retrying and publishes a delivery delay event."
      }),
      deferralRecovery: rate({
        default: 0.9,
        label: "Late mail that gets through",
        help: "Share of delayed messages that are delivered on a later attempt. The rest are still failing when SES stops retrying and end as a soft (transient) bounce, which does not count toward the bounce rate."
      }),
      virusRate: rate({
        default: 0,
        label: "Rejected (virus)",
        help: "Share of messages SES accepts but then rejects because it finds a virus. A Reject event, nothing is delivered."
      }),
      repeatShare: rate({
        default: 0.3,
        label: "Repeat recipients",
        help:
          "Share of sends to an address the account has mailed before. If that address hard-bounced or complained earlier, the suppression list stops the send; without it the address bounces or complains again."
      }),
      openRate: rate({
        default: 0.25,
        label: "Open rate",
        help: "Share of delivered mail that is opened. Only drawn when an event destination subscribes to Open. An assumption."
      }),
      clickRate: rate({
        default: 0.03,
        label: "Click rate",
        help: "Share of delivered mail with a link clicked. Only drawn when an event destination subscribes to Click. An assumption."
      })
    },
    { label: "Recipients", help: "How the people you mail behave. These decide what happens to each message after SES accepts it." }
  ),
  timing: Setting.group(
    {
      delivery: Setting.latency({
        mean: "800 millis",
        cv: 0.8,
        label: "Time to deliver",
        help: "From SES accepting a message to the recipient's server answering (the delivery or bounce). AWS says the first attempt is usually within milliseconds; the server's answer adds time. An assumption."
      }),
      retryDelay: slow({
        mean: "10 minutes",
        cv: 1,
        label: "Time to deliver late mail",
        help: "How long a delayed message takes to get through on a retry. AWS does not publish SES's retry schedule; an assumption."
      }),
      retryWindow: Setting.duration({
        default: "840 minutes",
        min: "5 minutes",
        max: "840 minutes",
        label: "Retry window",
        help:
          "How long SES keeps retrying a delayed message before giving up with a soft bounce. A configuration set's MaxDeliverySeconds takes 5 to 840 minutes; its default is not documented, so the maximum is assumed.",
        limit: Setting.hard(sources.deliveryOptions, "MaxDeliverySeconds is between 300 and 50,400 seconds.")
      }),
      complaintDelay: slow({
        mean: "30 minutes",
        cv: 1.5,
        label: "Time to complaint",
        help: "How long after delivery a complaint reaches SES through a feedback loop. It takes however long the recipient takes to hit Report spam; an assumption."
      }),
      engagementDelay: slow({
        mean: "20 minutes",
        cv: 2,
        label: "Time to open or click",
        help: "How long after delivery a message is opened or a link clicked. An assumption."
      })
    },
    { label: "Timing", help: "How long each step of a message's life takes (all assumptions; AWS publishes none of them)." }
  ),
  suppression: Setting.group(
    {
      enabled: Setting.bool({
        default: true,
        label: "Account-level suppression list",
        help: "On by default for accounts created after 25 November 2019. A send to a listed address is accepted and counted against the quota but not attempted."
      }),
      reasons: Setting.choice(["both", "bounces", "complaints"], {
        default: "both",
        labels: { both: "Bounces and complaints", bounces: "Bounces only", complaints: "Complaints only" },
        help: "Which outcomes put an address on the list. An address listed for another reason is mailed anyway."
      })
    },
    { label: "Suppression list" }
  ),
  reputation: Setting.group(
    {
      enforcement: Setting.bool({
        default: true,
        label: "Reputation enforcement",
        help: "SES reviews the account at 5% bounces or 0.1% complaints and may pause sending at 10% or 0.5% if the review ends unresolved. Turn off to ignore it."
      }),
      window: Setting.int({
        default: 1_000,
        min: 20,
        max: 100_000_000,
        unit: "recipients",
        label: "Representative volume",
        help: "The rates are measured over the last this-many recipients. AWS only says it uses a 'representative volume' that depends on the account; the size is an assumption."
      }),
      minVolume: Setting.int({
        default: 100,
        min: 1,
        max: 100_000_000,
        unit: "recipients",
        label: "Minimum volume",
        help: "Recipients that must be in the window before its rates can start a review or a pause: a handful of sends proves nothing. An assumption."
      }),
      reviewPeriod: Setting.duration({
        default: "7 days",
        min: "1 minute",
        max: "90 days",
        label: "Review period",
        help: "How long an account under review has to fix the problem. AWS states the end date in its notification and publishes no length; an assumption."
      }),
      pauseDuration: Setting.duration({
        default: "7 days",
        min: 0,
        max: "365 days",
        label: "Pause duration",
        help: "How long a pause lasts before AWS lifts it. In practice the owner opens a support case and AWS reviews it; the delay is an assumption. 0 keeps sending paused until enforcement is switched off."
      })
    },
    { label: "Reputation", help: "The review and pause AWS applies to accounts with a high bounce or complaint rate." }
  )
})
export type Config = typeof Config.Type
