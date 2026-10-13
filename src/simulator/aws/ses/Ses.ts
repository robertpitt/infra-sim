import { Duration, Effect, Schema } from "effect"
import * as Component from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import * as Flow from "../../Flow.ts"
import { Rejected, Throttled } from "../../Message.ts"
import { Tally } from "../../kit/Tally.ts"
import { keyOf } from "../../Provider.ts"
import * as Aws from "../internal/provider.ts"
import {
  Config,
  Destination,
  type EventKind,
  LARGE_MESSAGE_BANDWIDTH,
  LARGE_MESSAGE_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_RECIPIENTS,
  MIME_OVERHEAD
} from "./internal/config.ts"
import { Publisher } from "./internal/events.ts"
import { decide, type Fate } from "./internal/fate.ts"
import { dashboard } from "./internal/dashboard.ts"
import {
  type Enforcement,
  HEALTHY,
  PAUSE_BOUNCE_RATE,
  PAUSE_COMPLAINT_RATE,
  PAUSED,
  REVIEW_BOUNCE_RATE,
  REVIEW_COMPLAINT_RATE,
  STATUS_NAMES
} from "./internal/reputation.ts"
import { sources } from "./internal/sources.ts"
import { AccountState } from "./internal/standing.ts"

const enforcementOf = (c: Config): Enforcement => ({
  enforcement: c.reputation.enforcement,
  minVolume: c.reputation.minVolume,
  reviewPeriodMs: Duration.toMillis(c.reputation.reviewPeriod),
  pauseMs: Duration.toMillis(c.reputation.pauseDuration)
})

/**
 * Amazon SES. A send call is checked against the account's sending quota and rate (counted in recipients) and the message
 * limits, then answered; what happens to each recipient's mail after that is drawn from the settings that describe the
 * recipients and published as events to whatever is wired to the `events` port. Bounces and complaints feed the account's
 * reputation, and a bad enough reputation gets the account reviewed and then paused. See `README.md`.
 */
export const Ses = Aws.component({
  type: "aws.ses",
  service: "SES",
  title: "SES email",
  description:
    "Sends email. Calls are limited by the account's sending quota and rate; each accepted message then ends up delivered, bounced, complained about or delayed, published as events, and the bounce and complaint rates decide whether AWS reviews or pauses the account.",
  docs: sources.sendingQuotas,
  category: "messaging",
  icon: "mail",
  accent: "#dd344c",
  limits: [
    { label: "Sending quota", value: "recipients per rolling 24 hours: 200 in the sandbox; production set per account (account quotas)", adjustable: true, source: sources.sendingQuotas, note: "Counted in recipients, not messages; suppressed sends count too." },
    { label: "Sending rate", value: "recipients per second: 1 in the sandbox; production set per account (account quotas)", adjustable: true, source: sources.sendingQuotas, note: "Short bursts above it are allowed." },
    { label: "Over a limit", value: "ThrottlingException 'Maximum sending rate exceeded' or 'Daily message quota exceeded' (SMTP 454). The message is dropped; wait up to 10 minutes and retry", adjustable: false, source: sources.quotaErrors },
    { label: "Sandbox", value: "verified recipients only, 200 per 24 hours, 1 per second", adjustable: false, source: sources.sandbox, note: "Per region." },
    { label: "Recipients per message", value: "50 (To, CC and BCC together); 50 entries per SendBulkEmail", adjustable: false, source: sources.quotas },
    { label: "Message size", value: "10 MB (v1 API) or 40 MB (v2 API, SMTP), after base64 / MIME encoding", adjustable: false, source: sources.quotas, note: "Encoding adds about 37% to attachments." },
    { label: "Large messages", value: "over 10 MB are bandwidth-throttled, possibly to 40 MB/s", adjustable: false, source: sources.quotas },
    { label: "Reputation review", value: "bounce rate 5% or complaint rate 0.1%", adjustable: false, source: sources.reputation },
    { label: "Reputation pause", value: "bounce rate 10% or complaint rate 0.5%, if the review ends unresolved", adjustable: false, source: sources.reputation },
    { label: "Event destinations", value: "10 per configuration set; CloudWatch, Firehose, SNS, EventBridge", adjustable: false, source: sources.quotas }
  ],
  dashboard,
  highlights: [
    { gauge: "bounceRate", label: "bounce rate", format: "percent" },
    { gauge: "complaintRate", label: "complaint rate", format: "percent" },
    { gauge: "quotaUsed", label: "daily quota", format: "percent" },
    { rate: "fail.Throttled", label: "429/s" }
  ],
  config: Config,
  ports: { events: Component.port.many("Event destinations", Destination) },
  state: Schema.Struct({
    status: Schema.Literals(STATUS_NAMES),
    sandbox: Schema.Boolean,
    bounceRate: Schema.Number,
    complaintRate: Schema.Number,
    daily: Schema.Struct({ used: Schema.Number, quota: Schema.Number }),
    recipients: Schema.Number,
    delivered: Schema.Number,
    bounced: Schema.Struct({ permanent: Schema.Number, transient: Schema.Number }),
    complaints: Schema.Number,
    rejected: Schema.Number,
    delayed: Schema.Number,
    suppressed: Schema.Number,
    suppressionList: Schema.Number,
    addresses: Schema.Number,
    throttled: Schema.Struct({ rate: Schema.Number, daily: Schema.Number, bandwidth: Schema.Number }),
    refused: Schema.Number,
    events: Schema.Struct({ destinations: Schema.Number, pending: Schema.Number, published: Schema.Number, lost: Schema.Number })
  }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      // SES quotas and reputation belong to the account in a region, so every SES node placed here shares one account.
      const account = yield* node.shared<AccountState>("ses", Effect.sync(() => new AccountState()))
      const reputation = account.reputation
      const rateKey = `${keyOf(node.placement)}/ses/rate`
      const bandwidthKey = `${keyOf(node.placement)}/ses/bandwidth`

      // Each tally is a per-second rate (its counter, reset every frame) and a running total for the probe; the plain
      // counters are rates only, and `refused` is a total only.
      const tally = (name: string): Tally => new Tally(node.meter.counter(name))
      const m = {
        recipients: tally("recipients"),
        send: node.meter.counter("send"),
        delivered: tally("delivery"),
        bounce: node.meter.counter("bounce"),
        permanent: tally("bounce.permanent"),
        transient: tally("bounce.transient"),
        complaints: tally("complaint"),
        rejected: tally("reject"),
        delayed: tally("deliveryDelay"),
        open: node.meter.counter("open"),
        click: node.meter.counter("click"),
        suppressed: tally("suppressed"),
        published: tally("events.published"),
        lost: tally("events.lost"),
        // Sends refused by each limit (all are fail.Throttled): the per-second rate, the rolling daily quota, large-message bandwidth.
        throttledRate: tally("throttled.rate"),
        throttledDaily: tally("throttled.daily"),
        throttledBandwidth: tally("throttled.bandwidth"),
        refused: new Tally(undefined)
      }

      const publisher = new Publisher(node.out("events"), (failure) => (failure === undefined ? m.published : m.lost).add(1))

      /** Count `n` recipients' outcome on `tally` and publish it as an event of `kind`. */
      const outcome = (tally: Tally, kind: EventKind, f: Fate, n: number): void => {
        tally.add(n)
        publisher.publish(kind, f.message, n)
      }

      const listsBounces = (c: Config): boolean => c.suppression.enabled && c.suppression.reasons !== "complaints"
      const listsComplaints = (c: Config): boolean => c.suppression.enabled && c.suppression.reasons !== "bounces"

      // ----- what happens after SES accepts a message -----------------------------------------------------------

      /** The recipient's mail server has answered (or SES has scanned the message): every first-attempt outcome. */
      const onSettle = (f: Fate): void => {
        const c = fast.settings()
        const hard = f.hardNew + f.hardRepeat
        if (f.rejected > 0) outcome(m.rejected, "reject", f, f.rejected)
        // A send to a suppressed address is reported as a permanent bounce, which does not count toward the bounce rate.
        const bounces = hard + f.suppressedBounce
        if (bounces > 0) {
          m.bounce.n += bounces
          outcome(m.permanent, "bounce", f, bounces)
        }
        if (f.suppressedComplaint > 0) outcome(m.complaints, "complaint", f, f.suppressedComplaint)
        if (f.delivered > 0) outcome(m.delivered, "delivery", f, f.delivered)
        const delayed = f.deferredOk + f.deferredFail
        if (delayed > 0) {
          outcome(m.delayed, "deliveryDelay", f, delayed)
          const windowMs = Duration.toMillis(c.timing.retryWindow)
          if (f.deferredOk > 0) fast.after(Math.min(Distribution.latencyMs(c.timing.retryDelay, fast.random), windowMs), onRecovered, f)
          if (f.deferredFail > 0) fast.after(windowMs, onGaveUp, f)
        }
        if (f.complaints > 0) fast.after(Distribution.latencyMs(c.timing.complaintDelay, fast.random), onComplaint, f)
        if (f.opens > 0 || f.clicks > 0) fast.after(Distribution.latencyMs(c.timing.engagementDelay, fast.random), onEngaged, f)
        if (f.hardNew > 0) {
          if (listsBounces(c)) account.badListed += f.hardNew
          else account.badUnlisted += f.hardNew
        }
        if (hard > 0) {
          reputation.addBounces(hard)
          reputation.update(fast.now(), enforcementOf(c))
        }
      }

      /** A delayed message got through on a retry. */
      const onRecovered = (f: Fate): void => outcome(m.delivered, "delivery", f, f.deferredOk)

      /** SES stopped retrying: a soft bounce (transient), which AWS leaves out of the bounce rate. */
      const onGaveUp = (f: Fate): void => {
        m.bounce.n += f.deferredFail
        outcome(m.transient, "bounce", f, f.deferredFail)
      }

      /** A complaint arrived through a feedback loop. */
      const onComplaint = (f: Fate): void => {
        const c = fast.settings()
        outcome(m.complaints, "complaint", f, f.complaints)
        if (f.complaintsNew > 0) {
          if (listsComplaints(c)) account.complainedListed += f.complaintsNew
          else account.complainedUnlisted += f.complaintsNew
        }
        reputation.addComplaints(f.complaints)
        reputation.update(fast.now(), enforcementOf(c))
      }

      const onEngaged = (f: Fate): void => {
        if (f.opens > 0) {
          m.open.n += f.opens
          publisher.publish("open", f.message, f.opens)
        }
        if (f.clicks > 0) {
          m.click.n += f.clicks
          publisher.publish("click", f.message, f.clicks)
        }
      }

      // ----- gauges ---------------------------------------------------------------------------------------------

      const standing = (c: Config): number => {
        if (reputation.status !== HEALTHY) reputation.update(fast.now(), enforcementOf(c))
        return reputation.status
      }
      const dailyQuota = (q: Aws.Account): number => (q.sesSandbox ? q.sesSandboxDailyQuota : q.sesDailyQuota)
      node.meter.gaugeUnsafe("bounceRate", () => reputation.bounceRate)
      node.meter.gaugeUnsafe("complaintRate", () => reputation.complaintRate)
      node.meter.gaugeUnsafe("reputationStatus", () => standing(fast.settings()))
      node.meter.gaugeUnsafe("dailyUsed", () => account.daily.used(fast.now()))
      node.meter.gaugeUnsafe("quotaUsed", () => account.daily.used(fast.now()) / dailyQuota(fast.account() as Aws.Account))
      node.meter.gaugeUnsafe("suppressionList", () => account.listed)
      node.meter.gaugeUnsafe("pending", () => publisher.pending)
      // The account's limits as GetSendQuota reports them (Max24HourSend, MaxSendRate), and the reputation thresholds at
      // which AWS reviews, then may pause, the account: the lines the dashboard reads the rest against.
      node.meter.gaugeUnsafe("dailyQuota", () => dailyQuota(fast.account() as Aws.Account))
      node.meter.gaugeUnsafe("maxSendRate", () => {
        const q = fast.account() as Aws.Account
        return q.sesSandbox ? q.sesSandboxSendingRate : q.sesSendingRate
      })
      node.meter.gaugeUnsafe("bounceRateReview", () => REVIEW_BOUNCE_RATE)
      node.meter.gaugeUnsafe("bounceRatePause", () => PAUSE_BOUNCE_RATE)
      node.meter.gaugeUnsafe("complaintRateReview", () => REVIEW_COMPLAINT_RATE)
      node.meter.gaugeUnsafe("complaintRatePause", () => PAUSE_COMPLAINT_RATE)

      const refuse = (reason: string) => {
        m.refused.add(1)
        return Effect.fail(Rejected({ node: node.id, reason }))
      }

      return {
        call: (message) => {
          const c = fast.settings()
          const q = fast.account() as Aws.Account
          const now = fast.now()
          if (reputation.status !== HEALTHY) reputation.update(now, enforcementOf(c))
          if (reputation.status === PAUSED) {
            return refuse("SendingPausedException: the account's ability to send email is currently paused")
          }

          // Recipients: an incoming message carries `count`, and each is `batchSize` recipients wide.
          const n = message.count * c.batchSize
          if (!(n >= 1)) return refuse("BadRequestException: the message has no recipients")
          if (n > MAX_RECIPIENTS) return refuse(`MessageRejected: ${n} recipients, at most ${MAX_RECIPIENTS} per message`)

          // Size, as SES measures it: after MIME encoding, and per message (a bulk call is one message per recipient).
          const bytes = message.bytes > 0 ? message.bytes : 0
          const encoded = bytes * MIME_OVERHEAD
          const perMessage = c.call === "bulk" ? encoded / n : encoded
          if (perMessage > MAX_MESSAGE_BYTES[c.api]) {
            return refuse(`MessageRejected: message over the ${MAX_MESSAGE_BYTES[c.api] / 1024 / 1024} MB limit`)
          }

          // In the sandbox every recipient must be verified.
          if (q.sesSandbox && c.verifiedShare < 1 && !(c.verifiedShare > 0 && fast.random.nextDoubleUnsafe() < c.verifiedShare ** n)) {
            return refuse("MessageRejected: email address is not verified (the account is in the sandbox)")
          }

          // The rolling daily quota first, then the per-second rate: a throttled send is dropped, not queued, and takes nothing.
          if (account.daily.used(now) + n > dailyQuota(q)) {
            m.throttledDaily.add(1)
            return Effect.fail(Throttled({ node: node.id, reason: "ThrottlingException: Daily message quota exceeded" }))
          }
          const rate = q.sesSandbox ? q.sesSandboxSendingRate : q.sesSendingRate
          if (!node.limiter.takeUnsafe(rateKey, { rate, burst: rate }, n)) {
            m.throttledRate.add(1)
            return Effect.fail(Throttled({ node: node.id, reason: "ThrottlingException: Maximum sending rate exceeded" }))
          }
          if (perMessage > LARGE_MESSAGE_BYTES && !node.limiter.takeUnsafe(bandwidthKey, { rate: LARGE_MESSAGE_BANDWIDTH, burst: LARGE_MESSAGE_BANDWIDTH }, encoded)) {
            m.throttledBandwidth.add(1)
            return Effect.fail(Throttled({ node: node.id, reason: "ThrottlingException: bandwidth throttling of large messages" }))
          }

          // Accepted. From here the message has a life of its own, whatever happens to the caller's request.
          account.daily.add(now, n)
          const f = decide(message, n, c.recipients, c.suppression, account, fast.random, publisher.wants("open"), publisher.wants("click"))
          const suppressed = f.suppressedBounce + f.suppressedComplaint
          // Suppressed sends are left out of the rates (the Bounce and Complaint metrics still count them).
          reputation.addSent(n - suppressed, c.reputation.window)
          m.recipients.add(n)
          if (suppressed > 0) m.suppressed.add(suppressed)
          const sent = n - f.rejected
          if (sent > 0) {
            m.send.n += sent
            publisher.publish("send", message, sent)
          }
          fast.after(Distribution.latencyMs(c.timing.delivery, fast.random), onSettle, f)
          return Flow.wait(fast, Distribution.latencyMs(c.sendLatency, fast.random))
        },
        probe: Effect.sync(() => {
          const c = fast.settings()
          const q = fast.account() as Aws.Account
          return {
            status: STATUS_NAMES[standing(c)]!,
            sandbox: q.sesSandbox,
            bounceRate: reputation.bounceRate,
            complaintRate: reputation.complaintRate,
            daily: { used: account.daily.used(fast.now()), quota: dailyQuota(q) },
            recipients: m.recipients.total,
            delivered: m.delivered.total,
            bounced: { permanent: m.permanent.total, transient: m.transient.total },
            complaints: m.complaints.total,
            rejected: m.rejected.total,
            delayed: m.delayed.total,
            suppressed: m.suppressed.total,
            suppressionList: account.listed,
            addresses: account.unique,
            throttled: { rate: m.throttledRate.total, daily: m.throttledDaily.total, bandwidth: m.throttledBandwidth.total },
            refused: m.refused.total,
            events: { destinations: node.out("events").length, pending: publisher.pending, published: m.published.total, lost: m.lost.total }
          }
        })
      }
    })
})
