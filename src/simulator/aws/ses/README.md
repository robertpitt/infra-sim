# SES (`aws.ses`)

Amazon Simple Email Service sends email for an application: password resets, receipts, newsletters. What goes wrong with
it is not usually the API call but what comes after: the account's sending quota and rate run out (a throttle, a dropped
message), recipients bounce and complain, and a bad enough bounce or complaint rate gets the whole account reviewed and
then paused, which stops every email the product sends. This component lets you see all of that: calls are limited by the
account's quota and rate (counted in recipients, shared by every SES node in the region), every accepted message then ends
up delivered, bounced, complained about, delayed or rejected according to settings that describe your recipients, those
outcomes are published as events to whatever you wire to the `events` port (an SNS topic, an SQS queue, a Lambda), and the
bounce and complaint rates feed a reputation that AWS acts on.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Requests** | | |
| SendEmail / SendRawEmail / SMTP | ✅ | One message to `count` x `batchSize` recipients. Size limit applies to the message. |
| SendBulkEmail | ✅ | `call: bulk`: one message per recipient, up to 50 entries, size measured per entry. |
| Templated email, rendering failures | ❌ | Same cost as any send; no `RenderingFailure` event. |
| API latency | 🟡 | One assumed lognormal; AWS publishes none. |
| **Limits and throttling** | | |
| Sending rate (recipients per second) | ✅ | Account quota; token bucket with a one-second burst. Over it: `Throttled`, message dropped. |
| Sending quota (recipients per rolling 24 h) | ✅ | Account quota; rolling window in 5-minute buckets. Over it: `Throttled`. |
| Sandbox | ✅ | Account switch: 200 per 24 h, 1 per second, unverified recipients refused (`Rejected`). Per region. |
| Production quotas | 🟡 | AWS publishes no default; 14/s and 50,000/day are assumptions you edit in the account quotas. |
| Recipients per message (50), bulk entries (50) | ✅ | `Rejected` above 50. |
| Message size (10 MB v1, 40 MB v2/SMTP, after MIME encoding) | ✅ | `bytes` x 1.37 for encoding; `Rejected` above the limit. |
| Bandwidth throttle above 10 MB (about 40 MB/s) | ✅ | Token bucket on bytes. AWS says "may be throttled to as low as". |
| Throttle errors and what the caller does | ✅ | `Throttled` with the documented messages; retry policy is the caller's edge (AWS: wait up to 10 minutes). |
| Regional quotas | ✅ | Quotas belong to the account in a region; every SES node in a region shares them. AWS publishes one default for all regions. |
| **After a message is accepted** | | |
| Delivered | ✅ | Probability complement; `delivery` after the assumed time to deliver. |
| Hard bounce | ✅ | `hardBounceRate` of new addresses. Counts toward the bounce rate. |
| Soft bounce (delayed, retried, gives up) | ✅ | A delayed message is retried; a share is delivered, the rest end as a transient bounce after the retry window. Not counted in the bounce rate. |
| Complaint | ✅ | Share of delivered mail, after the assumed feedback-loop delay. Counts toward the complaint rate. |
| Reject (virus) | ✅ | `virusRate`: accepted, never delivered, a Reject event. |
| Delivery delay | ✅ | First attempt fails for `deferredRate` of recipients; a DeliveryDelay event. |
| Open and click | 🟡 | Drawn only when a destination subscribes; no tracking pixel, links or bot flag. |
| Suppression list (account level) | ✅ | Rate model (no address map): repeat recipients land on known-bad addresses; listed ones are accepted, counted in the quota, not attempted, and reported as a bounce or complaint that stays out of the rates. |
| Global suppression list | ❌ | Fold it into `hardBounceRate`. |
| **Reputation and enforcement** | | |
| Bounce and complaint rates over a rolling window | 🟡 | Last N recipients (assumed size) in a ring of 20 slices. AWS's "representative volume" is not published. |
| Review at 5% bounces / 0.1% complaints | ✅ | Mail keeps flowing. |
| Pause at 10% / 0.5% if the review ends unresolved | ✅ | `Rejected` (SendingPausedException) until the pause ends. Review and pause lengths are assumptions. |
| Recovery | ✅ | Below the review thresholds the status returns to healthy; after the pause duration sending is restored and the window starts afresh. |
| Dedicated IPs, warm-up | ❌ | AWS documents warm-up (standard: a 45-day time-based ramp) but gives no volume schedule or delivery effect to model. |
| Pending-decision statuses, manual review, permanent suspension | ❌ | Only the automatic bounce and complaint path. |
| **Events** | | |
| Send, Delivery, Bounce, Complaint, Reject, DeliveryDelay | ✅ | Published asynchronously per destination with its own event-type filter and retry policy. |
| Event destinations | 🟡 | Any component wired to `events`: SNS, SQS, Lambda, HTTP. Firehose, EventBridge and CloudWatch have no component. |
| Event contents | 🟡 | A message carries a recipient count, not the event type, bounce subtype or addresses. |
| Metrics | ✅ | Counters, gauges and probe state below. |
| **Receiving email** | ❌ | Receipt rules to S3, SNS or Lambda are not modelled. |

## Settings

Account quotas (shown in the Account quotas panel of a Region box; one set per account and region):

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `sesSandbox` | off | on/off | quota (switch) | New accounts start in the sandbox. Off here: designs usually model a live system. |
| `sesSandboxDailyQuota` | 200 | 1 to 1e9 | quota | Recipients per rolling 24 h in the sandbox. |
| `sesSandboxSendingRate` | 1 | 1 to 1e6 | quota | Recipients per second in the sandbox. |
| `sesDailyQuota` | 50,000 | 1 to 1e9 | quota (default assumed) | Recipients per rolling 24 h in production. |
| `sesSendingRate` | 14 | 1 to 1e6 | quota (default assumed) | Recipients per second in production; one-second burst. |

Node settings:

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `call` | send | send, bulk | hard | Whether a call is one message to many recipients or one message per recipient. |
| `api` | v2 | v2, v1 | hard | v2 API/SMTP: 40 MB; v1 API: 10 MB. |
| `batchSize` | 1 | 1 to 10,000 | model | Recipients per incoming message (multiplies the caller's `count`). Over 50 is refused. |
| `sendLatency` | 30 ms, cv 0.5 | 0 to 10 min | assumed | API response time. |
| `verifiedShare` | 0 | 0 to 1 | model | Sandbox only: share of recipients that are verified. |
| `recipients.hardBounceRate` | 1% | 0 to 1 | model | Share of new addresses that permanently bounce. |
| `recipients.complaintRate` | 0.03% | 0 to 1 | model | Share of delivered mail reported as spam. |
| `recipients.deferredRate` | 2% | 0 to 1 | model | Share whose first attempt is delayed. |
| `recipients.deferralRecovery` | 90% | 0 to 1 | model | Share of delayed mail that gets through on a retry. |
| `recipients.virusRate` | 0 | 0 to 1 | model | Share rejected for a virus. |
| `recipients.repeatShare` | 30% | 0 to 1 | model | Share of sends to an address mailed before (drives the suppression list). |
| `recipients.openRate` / `clickRate` | 25% / 3% | 0 to 1 | assumed | Engagement, drawn only when subscribed. |
| `timing.delivery` | 800 ms, cv 0.8 | 0 to 10 min | assumed | Accept to the recipient server's answer. |
| `timing.retryDelay` | 10 min, cv 1 | 0 to 30 d | assumed | Time to deliver a delayed message. |
| `timing.retryWindow` | 840 min | 5 to 840 min | hard range, default assumed | How long SES retries before a soft bounce. |
| `timing.complaintDelay` | 30 min, cv 1.5 | 0 to 30 d | assumed | Delivery to complaint. |
| `timing.engagementDelay` | 20 min, cv 2 | 0 to 30 d | assumed | Delivery to open or click. |
| `suppression.enabled` | on | on/off | model | Account-level suppression list. |
| `suppression.reasons` | both | both, bounces, complaints | model | What puts an address on it. |
| `reputation.enforcement` | on | on/off | model | Whether AWS reviews and pauses. |
| `reputation.window` | 1,000 recipients | 20 to 1e8 | assumed | "Representative volume" the rates are measured over. |
| `reputation.minVolume` | 100 recipients | 1 to 1e8 | assumed | Recipients needed before the rates can start a review. |
| `reputation.reviewPeriod` | 7 days | 1 min to 90 d | assumed | Length of a review. |
| `reputation.pauseDuration` | 7 days | 0 to 365 d | assumed | How long a pause lasts; 0 means until enforcement is switched off. |

Settings on each edge leaving the `events` port: `events.send`, `delivery`, `bounce`, `complaint`, `reject`,
`deliveryDelay`, `open`, `click` (the destination's matching event types; the last two off by default) and `retry`
(5 attempts, 1 to 30 s backoff, an assumption), plus the universal edge settings.

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Sandbox | verified recipients only, 200 per 24 h, 1 per second, per region | quota (raised with production access) | [request-production-access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) |
| Production sending quota and rate | "varies based on your specific use case" | quota; defaults assumed | [quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html) |
| Quotas are counted in recipients | an email to 10 recipients counts as 10; suppressed sends count | hard | [manage-sending-quotas](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html), [suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html) |
| Daily quota window | rolling 24 hours, not a calendar day | hard | [manage-sending-quotas](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html) |
| Sending rate | can be exceeded "for short bursts, but not for sustained periods" | hard (burst size assumed) | [manage-sending-quotas](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html) |
| Throttle errors | `ThrottlingException`: "Maximum sending rate exceeded", "Daily message quota exceeded"; SMTP `454 Throttling failure`; the message is dropped; retry after up to 10 minutes | hard | [manage-sending-quotas-errors](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas-errors.html) |
| Recipients per message | 50 (To, CC, BCC); 50 destinations per templated or bulk call | hard | [quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html) |
| Message size | 10 MB (v1 API), 40 MB (v2 API, SMTP), after base64 / MIME encoding (about 137% of an attachment) | hard | [quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), [manage-sending-quotas](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html) |
| Large messages | over 10 MB are subject to bandwidth throttling, possibly to as low as 40 MB/s | hard (documented as a possibility) | [quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html) |
| Review thresholds | bounce rate 5%, complaint rate 0.1% ("or greater") | hard | [reputation messages](https://docs.aws.amazon.com/ses/latest/dg/reputationdashboardmessages.html), [enforcement FAQ](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html) |
| Pause thresholds | bounce rate 10%, complaint rate 0.5% ("might pause" if unresolved at the end of the review) | hard | same |
| What counts as a bounce | hard bounces only, to unverified domains; soft bounces, suppressed sends and the mailbox simulator do not count | hard | [enforcement FAQ](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html), [suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html) |
| Rate window | a "representative volume", not a fixed period | hard (size assumed) | [enforcement FAQ](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html) |
| Retry window | `MaxDeliverySeconds` 300 to 50,400 s (5 to 840 min); default not documented | hard range | [DeliveryOptions](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_DeliveryOptions.html) |
| Event destinations | 10 per configuration set; CloudWatch, Firehose, SNS, EventBridge | hard | [quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), [event publishing](https://docs.aws.amazon.com/ses/latest/dg/monitor-using-event-publishing.html) |
| Account suppression list | no size limit; stays until removed; deleted after 90 days of a paused account | hard | [suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html) |

Regional differences: none are published. Sandbox status and quotas are per region, and the simulator keeps one set per
region.

## Behaviour

**A call.** In order: a paused account refuses everything (`Rejected`, SendingPausedException); recipients are
`count x batchSize` and must be 1 to 50; the message (`bytes` x 1.37 for MIME encoding, divided between the recipients in
a bulk call) must fit the API's limit (`Rejected`); in the sandbox every recipient must be verified, which fails the call
with probability `1 - verifiedShare^recipients` (`Rejected`); then the throttles. If the rolling 24-hour total plus this
call is over the daily quota the call is `Throttled` ("Daily message quota exceeded"); if the token bucket (rate = the
account's sending rate, burst = one second of it) cannot cover the recipients it is `Throttled` ("Maximum sending rate
exceeded"); a message over 10 MB also needs its bytes from a 40 MB/s bucket. A throttled message is dropped, never
queued, takes no quota, and the caller's edge retry policy decides whether to try again. A call with more recipients than
the bucket holds takes the whole bucket rather than starving forever (the shared limiter's rule). An accepted call is
answered after `sendLatency`.

**The fate of what was accepted.** Decided in one step at acceptance, per recipient, from the settings; one timer then
publishes the outcomes together. Each recipient is a repeat (probability `repeatShare`) or a new address.

- A *new* address is rejected (virus) with probability `virusRate`, hard-bounces with `hardBounceRate`, is delayed with
  `deferredRate`, and otherwise is delivered (one draw, in that order). A delivered one complains with `complaintRate`.
- A *repeat* is a draw from the addresses mailed so far. The account keeps five counters (addresses, bad listed, bad
  unlisted, complained listed, complained unlisted), so the chance of a known-bad address is bad/addresses and memory is
  constant. A known-bad address is stopped by the suppression list if it covers that reason (accepted, counted in the
  quota, not attempted, reported as a bounce or complaint, left out of the reputation rates) and otherwise bounces or
  complains again. Any other repeat is a known-good address, which can only be delayed.
- A *delayed* message gets a DeliveryDelay event at the first attempt. With probability `deferralRecovery` it is delivered
  after `timing.retryDelay`; otherwise SES gives up at the retry window and publishes a transient (soft) bounce, which
  AWS leaves out of the bounce rate.
- Complaints arrive `timing.complaintDelay` after delivery and are the only way a complaint reaches the rate, so a
  reputation problem from complaints shows up late, as it does in AWS.
- Events: Send at acceptance (for every non-rejected recipient, suppressed or not), then at `timing.delivery` the
  Delivery, Bounce, Reject and DeliveryDelay events, later the Complaint, Open and Click events. One event per call and
  kind carries the number of recipients it covers as its `count`.

**Reputation.** The account keeps the last `reputation.window` recipients (not counting suppressed sends) in a ring of 20
slices and the hard bounces and complaints among them. Rates are acted on once the window holds `minVolume` recipients.
Status is evaluated lazily (when mail is sent, when a bounce or complaint arrives, when a gauge is read), so there are no
timers to leak:

- healthy to *under review* when the bounce rate is at least 5% or the complaint rate at least 0.1%; mail keeps flowing;
- under review back to healthy as soon as both rates are below those thresholds; at the end of `reviewPeriod`, if the
  bounce rate is at least 10% or the complaint rate at least 0.5%, *sending paused*; in between the review is extended
  (AWS says only that it "might" pause);
- paused: every call is `Rejected` until `pauseDuration` has passed, then sending is restored and the window starts
  afresh (AWS counts only what happens after a fix). `pauseDuration` of 0 never restores; switching `enforcement` off
  restores at once.

All the SES nodes of one account and region share the quota, the rate, the suppression counters and the reputation, so
one careless sender can get everyone paused; the review and window settings are read from whichever node is acting.

**Where the model departs from AWS.** AWS excludes verified domains from the bounce rate and measures the complaint rate
only over mail to domains that send feedback; the simulator treats all recipients alike. The review and pause lengths
and the window size are not published. AWS may pause without a review for serious problems; the simulator always reviews
first. Open and click draw their own rates only when someone listens.

## Connections

- **In:** any component can call it (a Lambda, an API Gateway integration, a client). The message's `count` is the number
  of recipients (times `batchSize`), `bytes` the message size.
- **Out, port `events`** ("Event destinations"): each wired edge is an event destination of a configuration set. Events are
  sent with `link.send`, asynchronously (`invocation: async`), so a slow or failing destination never slows the sender;
  they carry `bytes` of 2 KB (assumed). Each edge picks its event types and has its own retry policy. A destination that
  never accepts an event counts under `events.lost`.
- **Wiring** (`importers/internal/cloudformation/ses.ts`, `infer.ts`): `AWS::SES::ConfigurationSet` is the SES node.
  `SuppressionOptions.SuppressedReasons` maps to `suppression` (an empty list turns it off; `BOUNCE` and `COMPLAINT` to
  `bounces`, `complaints` or `both`), and `DeliveryOptions.MaxDeliverySeconds` to `timing.retryWindow` (outside AWS's
  5 minutes to 14 hours it is brought into range and reported). `SendingEnabled: false` is not modelled: the node still
  sends, and the report says so. `AWS::SES::ConfigurationSetEventDestination` becomes an edge from the node's `events`
  port to its SNS topic (`SnsDestination.TopicARN`), named by `Name`, with `events` set to exactly the
  `MatchingEventTypes` (`SEND`, `DELIVERY`, `BOUNCE`, `COMPLAINT`, `REJECT`, `DELIVERY_DELAY`, `OPEN`, `CLICK`; the
  others are off, so `open` and `click` are on only if asked for). `RENDERING_FAILURE` and `SUBSCRIPTION` have no
  equivalent and are dropped with a report; `Enabled: false` leaves the destination out quietly; Firehose, EventBridge
  and CloudWatch destinations, and a topic or configuration set not in the template, are skipped with a reason.
  **Who sends is inferred:** a function that names the configuration set (environment variable, policy resource), has a
  SAM `SESCrudPolicy` or bulk policy, or whose own policy (not a role shared by several functions) allows `ses:SendEmail`,
  `SendRawEmail`, `SendTemplatedEmail`, `ses:Send*` or `ses:*` (a bare `*` does not count) gets an edge into the node,
  and the node gets an assumed traffic source if nothing else feeds it. A template that sends but has no configuration
  set gets an SES node added; with several sets and no name, nothing is guessed and the function is reported. If every
  sender uses only `SendBulkEmail` or `SendBulkTemplatedEmail` the node's `call` is `bulk`; a mix keeps `send`, with a
  report. A configuration set nothing sends through and that reports nowhere is reported as idle. Identities,
  templates, contact lists, dedicated IP pools and receipt rules and filters have no behaviour here and are skipped
  quietly with a reason. Sandbox status and quotas are not in CloudFormation.

## Metrics and state

Counters (per second in frames; names follow the SES event and metric types):

| Name | Meaning |
| --- | --- |
| `recipients` | recipients accepted |
| `send` | Send events (accepted and not rejected) |
| `delivery` | recipients delivered, including late deliveries |
| `bounce`, `bounce.permanent`, `bounce.transient` | Bounce events: hard bounces and suppressed sends, soft bounces after retries |
| `complaint` | complaints, including those reported for suppressed sends |
| `reject` | virus rejections |
| `deliveryDelay` | recipients delayed at first attempt |
| `open`, `click` | engagement events (when subscribed) |
| `suppressed` | recipients stopped by the suppression list |
| `events.published`, `events.lost` | events a destination took, and gave up on |
| `throttled.rate`, `throttled.daily`, `throttled.bandwidth` | sends refused by the maximum send rate, the daily quota, large-message bandwidth |
| `fail.Throttled`, `fail.Rejected` | recorded for every node: throttles; refusals, paused sends and sandbox refusals |

Gauges: `bounceRate` and `complaintRate` (the `Reputation.BounceRate` and `Reputation.ComplaintRate` metrics, as
fractions, shown on the node), `reputationStatus` (0 healthy, 1 under review, 2 paused), `dailyUsed`, `quotaUsed` (share of
the daily quota), `suppressionList` (addresses on it), `pending` (events being delivered), `dailyQuota` and `maxSendRate`
(GetSendQuota's Max24HourSend and MaxSendRate), and the reputation thresholds as constant lines: `bounceRateReview`,
`bounceRatePause`, `complaintRateReview`, `complaintRatePause`.

The node's dashboard (`internal/dashboard.ts`) charts these under SES's event and CloudWatch names. Not charted, because not
modelled: RenderingFailure, Subscription, and the per-configuration-set and per-ISP dimensions.

Probe state: `status`, `sandbox`, `bounceRate`, `complaintRate`, `daily {used, quota}`, `recipients`, `delivered`,
`bounced {permanent, transient}`, `complaints`, `rejected`, `delayed`, `suppressed`, `suppressionList`, `addresses`,
`throttled {rate, daily, bandwidth}`, `refused`, `events {destinations, pending, published, lost}`.

## Not yet simulated

1. **Event type on the message.** A destination hears a count and cannot tell a Bounce from a Delivery unless it is the
   only type its edge subscribes to (a Lambda that handles bounces by removing addresses cannot be modelled). It needs a
   field on `Message` for what kind of event it is.
2. **Verified identities.** `verifiedShare` stands in for them; sending from an unverified identity is not modelled.
3. **Dedicated IPs, warm-up and the VDM dashboard.** AWS documents a 45-day automatic ramp but no volume schedule or
   effect on delivery, so there is nothing to calibrate against.
4. **Receiving.** Receipt rules to S3, SNS and Lambda, and the Mail Manager.
5. **Global suppression list, mailbox simulator, configuration-set suppression overrides, tenants.**
6. **Pause without a review, permanent suspension, the manual-review statuses.**
7. **Per-domain complaint feedback and verified-domain exclusion** in the rates.
8. **Templated email and rendering failures, subscription events and list management.**

## Assumptions

Every number that is not from AWS, and why:

- Production quota 50,000 per day and rate 14 per second: the figures most often reported for a newly approved account;
  AWS publishes none. Burst of one second of the rate.
- API latency 30 ms; time to deliver 800 ms (cv 0.8); time to deliver a delayed message 10 min; time to complaint 30 min;
  time to open or click 20 min. AWS says the first delivery attempt is usually within milliseconds and publishes nothing
  else.
- Retry window 840 minutes: AWS does not document the default; this is the largest value `MaxDeliverySeconds` takes.
- Reputation window 1,000 recipients and minimum 100: AWS says only "representative volume". Review 7 days and pause
  7 days: AWS states the dates in its notices and publishes no lengths.
- Recipient rates (1% hard bounces, 0.03% complaints, 2% delayed, 90% of those recover, 30% repeat recipients, open 25%,
  click 3%): plausible values for a healthy list, kept under the thresholds. AWS recommends staying under 5% bounces (its
  FAQ also says under 2%) and 0.1% complaints.
- Event destination retry (5 attempts, 1 to 30 s) and a 2 KB event: AWS documents neither.
- Complaints and bounces are recorded in the slice that is current when they arrive, not the one of the send they belong
  to (bounded memory; the effect is a slightly later reaction).

## References

- [Service quotas in Amazon SES](https://docs.aws.amazon.com/ses/latest/dg/quotas.html)
- [Managing your sending limits](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html) and
  [errors at the limits](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas-errors.html)
- [Request production access (the sandbox)](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- [Reputation metrics messages](https://docs.aws.amazon.com/ses/latest/dg/reputationdashboardmessages.html),
  [reputation dashboard](https://docs.aws.amazon.com/ses/latest/dg/reputation-dashboard-dg.html) and
  [sending review FAQs](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html)
- [How email sending works](https://docs.aws.amazon.com/ses/latest/dg/send-email-concepts-process.html)
- [Account-level suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)
- [Event publishing](https://docs.aws.amazon.com/ses/latest/dg/monitor-using-event-publishing.html),
  [event contents](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html) and
  [CloudWatch metrics](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-cloudwatch.html)
- [Warming up dedicated IPs](https://docs.aws.amazon.com/ses/latest/dg/dedicated-ip-warming.html)
- [SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html),
  [SendBulkEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendBulkEmail.html) and
  [DeliveryOptions](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_DeliveryOptions.html)
