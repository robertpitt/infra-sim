import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../../Builder.ts"
import * as Component from "../../../Component.ts"
import * as Setting from "../../../Setting.ts"
import type { Service } from "../../../Simulation.ts"
import type { Frame } from "../../../Telemetry.ts"
import { mean, sim, simulator } from "../../../testing.ts"

const PLACEMENT = "aws:us-east-1"
/** An account that never limits, unless a test says otherwise. */
const OPEN_ACCOUNT = { sesSendingRate: 1_000_000, sesDailyQuota: 1_000_000_000 }
const FAST = { delivery: { mean: 100, cv: 0 }, complaintDelay: { mean: 1_000, cv: 0 }, retryDelay: { mean: 1_000, cv: 0 }, retryWindow: "5 minutes" }

interface Consumer {
  readonly id: string
  readonly type?: string
  readonly settings?: Record<string, unknown>
  readonly edge?: Record<string, unknown>
}

interface Options {
  readonly ses?: Record<string, unknown>
  readonly load?: Record<string, unknown>
  readonly account?: Record<string, unknown>
  readonly consumers?: ReadonlyArray<Consumer>
}

/** Clients -> SES -> event destinations. */
const mail = ({ ses = {}, load = {}, account = OPEN_ACCOUNT, consumers = [] }: Options = {}) => {
  const b = Builder.make("ses", { seed: 11 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 100, ...load } })
  const node = b.add("aws.ses", { id: "ses", settings: ses })
  b.connect(web, node)
  for (const c of consumers) {
    const target = b.add(c.type ?? "common.http-endpoint", { id: c.id, settings: c.settings ?? { latency: { mean: 5, cv: 0 } } })
    b.connect(node.port("events"), target, c.edge)
  }
  b.account(PLACEMENT, account)
  return b.build()
}

interface State {
  status: string
  sandbox: boolean
  bounceRate: number
  complaintRate: number
  daily: { used: number; quota: number }
  recipients: number
  delivered: number
  bounced: { permanent: number; transient: number }
  complaints: number
  rejected: number
  delayed: number
  suppressed: number
  suppressionList: number
  addresses: number
  throttled: { rate: number; daily: number; bandwidth: number }
  refused: number
  events: { destinations: number; pending: number; published: number; lost: number }
}

const stateAfter = (doc: ReturnType<typeof mail>, ms: number) =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const all = yield* s.advanceTo(ms)
      return { all, state: (yield* s.probe("ses")).state as State }
    }))

const rate = (all: ReadonlyArray<Frame>, name: string, from = 0, to = Infinity, id = "ses") => mean(all, "nodes", id, "rates", name, from, to)
const web = (all: ReadonlyArray<Frame>, name: string, from = 0, to = Infinity) => rate(all, name, from, to, "web")

describe("aws.ses sending quotas", () => {
  it("holds a sandbox account to 1 recipient a second", async () => {
    const { all } = await stateAfter(mail({ ses: { verifiedShare: 1 }, load: { rps: 5 }, account: { sesSandbox: true } }), 30_000)
    expect(web(all, "ok", 5_000)).toBeCloseTo(1, 0)
    expect(web(all, "fail.Throttled", 5_000)).toBeCloseTo(4, 0)
  })

  it("stops a sandbox account at 200 recipients in 24 hours, then throttles with the daily quota error", async () => {
    const { state } = await stateAfter(mail({ ses: { verifiedShare: 1 }, load: { rps: 1.5 }, account: { sesSandbox: true } }), 400_000)
    expect(state.sandbox).toBe(true)
    expect(state.daily).toEqual({ used: 200, quota: 200 })
    expect(state.recipients).toBe(200)
    expect(state.throttled.daily).toBeGreaterThan(100)
  })

  it("refuses a sandbox account's mail to recipients that are not verified, and only there", async () => {
    const sandbox = await stateAfter(mail({ ses: { verifiedShare: 0 }, load: { rps: 5 }, account: { sesSandbox: true } }), 10_000)
    expect(web(sandbox.all, "fail.Rejected", 2_000)).toBeCloseTo(5, 0)
    expect(sandbox.state.recipients).toBe(0)
    const production = await stateAfter(mail({ ses: { verifiedShare: 0 }, load: { rps: 5 } }), 10_000)
    expect(web(production.all, "fail", 2_000)).toBe(0)
  })

  it("limits a production account to its sending rate, with a one-second burst", async () => {
    const { all, state } = await stateAfter(mail({ load: { rps: 40 }, account: { sesSendingRate: 14, sesDailyQuota: 1_000_000 } }), 30_000)
    expect(web(all, "ok", 5_000)).toBeCloseTo(14, 0)
    expect(web(all, "fail.Throttled", 5_000)).toBeCloseTo(26, 0)
    expect(state.throttled.rate).toBeGreaterThan(500)
    expect(state.throttled.daily).toBe(0)
  })

  it("takes the new rate on the next call when the account's quota is raised while running", () =>
    sim(mail({ load: { rps: 40 }, account: { sesSendingRate: 5, sesDailyQuota: 1_000_000 } }), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(10_000)
        expect(web(before, "ok", 3_000)).toBeCloseTo(5, 0)
        yield* s.configureAccount(PLACEMENT, { sesSendingRate: 40, sesDailyQuota: 1_000_000 })
        const after = yield* s.advanceTo(20_000)
        expect(web(after, "fail", 12_000)).toBe(0)
        expect(web(after, "ok", 12_000)).toBeCloseTo(40, 0)
      })))

  it("counts quota in recipients and frees it as the 24 hours roll past", async () => {
    // 100 recipients a day at 1 a second: the quota is gone after 100 s and comes back 24 hours after each send (times
    // here are in ms, so 50,000,000 is a little under 14 hours and 90,000,000 a little over 25).
    const doc = mail({ load: { rps: 1 }, account: { sesSendingRate: 1_000, sesDailyQuota: 100 } })
    const run = await sim(doc, (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(50_000_000)
        const mid = (yield* s.probe("ses")).state as State
        yield* s.advanceTo(90_000_000)
        const end = (yield* s.probe("ses")).state as State
        return { mid, end }
      }), { frameMs: 60_000 })
    expect(run.mid.daily.used).toBe(100)
    expect(run.mid.throttled.daily).toBeGreaterThan(40_000)
    // By 25 hours the first sends are over 24 hours old, so more were accepted; the quota is full again or nearly.
    expect(run.end.recipients).toBeGreaterThan(100)
    expect(run.end.daily.used).toBeLessThanOrEqual(100)
  })

  it("shares one account between every SES node in the region", () => {
    const b = Builder.make("two", { seed: 4 })
    for (const id of ["one", "two"]) {
      const c = b.add("common.client", { id: `web-${id}`, settings: { arrival: "constant", rps: 50 } })
      b.connect(c, b.add("aws.ses", { id }))
    }
    b.account(PLACEMENT, { sesSendingRate: 20, sesDailyQuota: 1_000_000 })
    return sim(b.build(), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(20_000)
        const ok = mean(all, "nodes", "web-one", "rates", "ok", 5_000) + mean(all, "nodes", "web-two", "rates", "ok", 5_000)
        expect(ok).toBeCloseTo(20, 0)
      }))
  })
})

describe("aws.ses message limits", () => {
  it("accepts up to 50 recipients a call and refuses more", async () => {
    const fifty = await stateAfter(mail({ ses: { batchSize: 50 }, load: { rps: 5 } }), 5_000)
    expect(web(fifty.all, "fail", 1_000)).toBe(0)
    expect(fifty.state.recipients).toBeGreaterThan(200)
    const many = await stateAfter(mail({ ses: { batchSize: 51 }, load: { rps: 5 } }), 5_000)
    expect(web(many.all, "fail.Rejected", 1_000)).toBeCloseTo(5, 0)
    expect(many.state.recipients).toBe(0)
    expect(many.state.refused).toBeGreaterThan(20)
  })

  it("counts every recipient against the rate: a 50-recipient message at 14 a second is throttled", async () => {
    const { state } = await stateAfter(mail({ ses: { batchSize: 50 }, load: { rps: 1 }, account: { sesSendingRate: 14, sesDailyQuota: 1_000_000 } }), 20_000)
    // Bigger than the bucket, so each takes the whole bucket: about one every 3.5 s refills, never 1 a second.
    expect(state.throttled.rate).toBeGreaterThan(5)
  })

  it("limits a message to 40 MB after MIME encoding (v2 API) or 10 MB (v1 API)", async () => {
    // 28,000 KB is 39.3 MB once encoded (x1.37); 30,000 KB is 42 MB.
    const fits = await stateAfter(mail({ load: { rps: 0.5, payload: 28_000 } }), 10_000)
    expect(web(fits.all, "fail", 0)).toBe(0)
    const big = await stateAfter(mail({ load: { rps: 0.5, payload: 30_000 } }), 10_000)
    expect(web(big.all, "fail.Rejected", 0)).toBeGreaterThan(0.3)
    // 7,000 KB is 9.8 MB encoded; 7,600 KB is 10.7 MB.
    const v1ok = await stateAfter(mail({ ses: { api: "v1" }, load: { rps: 1, payload: 7_000 } }), 5_000)
    expect(web(v1ok.all, "fail", 0)).toBe(0)
    const v1big = await stateAfter(mail({ ses: { api: "v1" }, load: { rps: 1, payload: 7_600 } }), 5_000)
    expect(web(v1big.all, "fail.Rejected", 0)).toBeGreaterThan(0.6)
  })

  it("measures a bulk call's size per message, not for the whole batch", async () => {
    // 20 MB encoded is over the v1 limit as one message, but 20 entries of 1 MB each are fine.
    const send = await stateAfter(mail({ ses: { api: "v1", call: "send", batchSize: 20 }, load: { rps: 1, payload: 14_000 } }), 5_000)
    expect(web(send.all, "fail.Rejected", 0)).toBeGreaterThan(0.6)
    const bulk = await stateAfter(mail({ ses: { api: "v1", call: "bulk", batchSize: 20 }, load: { rps: 1, payload: 14_000 } }), 5_000)
    expect(web(bulk.all, "fail", 0)).toBe(0)
  })

  it("throttles the bandwidth of messages over 10 MB to about 40 MB a second", async () => {
    // 20,000 KB is 28 MB encoded: at most 1.4 a second get through 40 MB/s.
    const { all, state } = await stateAfter(mail({ load: { rps: 4, payload: 20_000 } }), 30_000)
    expect(web(all, "ok", 5_000)).toBeCloseTo(1.4, 0)
    expect(state.throttled.bandwidth).toBeGreaterThan(50)
  })

  it("accepts the smallest message and survives extreme rates", async () => {
    const tiny = await stateAfter(mail({ load: { rps: 10, payload: 0.001 } }), 5_000)
    expect(web(tiny.all, "fail", 0)).toBe(0)
    const flood = await stateAfter(mail({ load: { rps: 20_000 }, account: { sesSendingRate: 14, sesDailyQuota: 1_000_000 } }), 3_000)
    expect(flood.state.recipients).toBeGreaterThan(0)
    expect(flood.state.recipients).toBeLessThan(80)
    expect(flood.state.throttled.rate).toBeGreaterThan(30_000)
  })
})

describe("what becomes of an accepted message", () => {
  const recipients = { hardBounceRate: 0.02, complaintRate: 0.01, deferredRate: 0.05, deferralRecovery: 0.8, virusRate: 0.01, repeatShare: 0 }

  it("delivers, bounces, complains, delays and rejects in the proportions the settings give", async () => {
    // 120 s at 100 a second is 12,000 recipients, then the client stops and the retry window (5 minutes) runs out.
    const state = await sim(mail({ ses: { recipients, timing: FAST, reputation: { enforcement: false } }, load: { rps: 100 } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(120_000)
        yield* s.configureNode("web", { arrival: "constant", rps: 0 })
        yield* s.advanceTo(450_000)
        return (yield* s.probe("ses")).state as State
      }))
    const n = state.recipients
    expect(n).toBeGreaterThan(11_000)
    const share = (x: number) => x / n
    expect(share(state.bounced.permanent)).toBeCloseTo(0.02, 2)
    expect(share(state.rejected)).toBeCloseTo(0.01, 2)
    expect(share(state.delayed)).toBeCloseTo(0.05, 2)
    expect(state.bounced.transient / state.delayed).toBeCloseTo(0.2, 1) // delayed and never delivered
    // Delivered is everything that reached the recipient on the first try, plus the delayed that got through.
    expect(share(state.delivered)).toBeCloseTo(1 - 0.01 - 0.02 - 0.05 * 0.2, 2)
    expect(state.complaints / state.delivered).toBeCloseTo(0.01, 2)
    expect(state.suppressed).toBe(0)
  })

  it("leaves soft bounces out of the bounce rate", async () => {
    const { state } = await stateAfter(
      mail({ ses: { recipients: { hardBounceRate: 0, complaintRate: 0, deferredRate: 0.3, deferralRecovery: 0, repeatShare: 0 }, timing: FAST }, load: { rps: 50 } }),
      420_000
    )
    expect(state.bounced.transient).toBeGreaterThan(1_000)
    expect(state.bounceRate).toBe(0)
    expect(state.status).toBe("healthy")
  })

  it("is repeatable: the same design and seed give the same outcome", async () => {
    const run = () => stateAfter(mail({ ses: { recipients, timing: FAST, reputation: { enforcement: false } }, load: { rps: 100 } }), 20_000)
    const [a, b] = [await run(), await run()]
    expect(a.state).toEqual(b.state)
  })
})

describe("aws.ses event publishing", () => {
  it("publishes events to every destination, each with the event types it asked for", async () => {
    const { all, state } = await stateAfter(
      mail({
        ses: { recipients: { hardBounceRate: 0.1, complaintRate: 0, deferredRate: 0, repeatShare: 0 }, timing: FAST, reputation: { enforcement: false } },
        load: { rps: 100 },
        consumers: [
          { id: "all" },
          { id: "bounces", edge: { events: { send: false, delivery: false, complaint: false, reject: false, deliveryDelay: false } } }
        ]
      }),
      30_000
    )
    // The first sees a Send for every call, then a Delivery and a Bounce for each (calls carry one recipient).
    expect(rate(all, "in", 5_000, Infinity, "all")).toBeGreaterThan(190)
    expect(rate(all, "in", 5_000, Infinity, "all")).toBeLessThan(205)
    // The second only the Bounce events: about 10 a second.
    expect(rate(all, "in", 5_000, Infinity, "bounces")).toBeGreaterThan(8)
    expect(rate(all, "in", 5_000, Infinity, "bounces")).toBeLessThan(13)
    expect(state.events.destinations).toBe(2)
    expect(state.events.lost).toBe(0)
    expect(rate(all, "events.published", 5_000)).toBeGreaterThan(200)
  })

  it("draws open and click events only when a destination subscribes to them", async () => {
    const quiet = await stateAfter(mail({ ses: { timing: FAST }, load: { rps: 50 }, consumers: [{ id: "all" }] }), 20_000)
    expect(rate(quiet.all, "open", 0)).toBe(0)
    const tracked = await stateAfter(
      mail({ ses: { timing: { ...FAST, engagementDelay: { mean: 500, cv: 0 } }, recipients: { openRate: 0.5, clickRate: 0.1 } }, load: { rps: 50 }, consumers: [{ id: "all", edge: { events: { open: true, click: true } } }] }),
      30_000
    )
    expect(rate(tracked.all, "open", 5_000)).toBeGreaterThan(22)
    expect(rate(tracked.all, "open", 5_000)).toBeLessThan(28)
    expect(rate(tracked.all, "click", 5_000)).toBeGreaterThan(3.5)
    expect(rate(tracked.all, "click", 5_000)).toBeLessThan(6.5)
  })

  it("reaches an SQS queue, and keeps the sender fast when a destination is slow", async () => {
    const doc = mail({
      load: { rps: 50 },
      ses: { timing: FAST },
      consumers: [{ id: "queue", type: "aws.sqs", settings: {} }, { id: "slow", settings: { latency: { mean: 5_000, cv: 0 } } }]
    })
    const { all, state } = await stateAfter(doc, 20_000)
    expect(web(all, "fail", 0)).toBe(0)
    expect(state.events.pending).toBeGreaterThan(100) // the slow endpoint is still working on them
    const p95 = all.flatMap((f) => (f.nodes.web?.dist.latency ? [f.nodes.web.dist.latency.p95] : []))
    expect(Math.max(...p95)).toBeLessThan(200)
  })

  it("counts events a destination never takes, and still sends the mail", async () => {
    const down = { id: "down", settings: { errorRate: 1, latency: { mean: 5, cv: 0 } }, edge: { retry: { maxAttempts: 2, backoff: 10, jitter: false } } }
    const { all, state } = await stateAfter(mail({ load: { rps: 20 }, ses: { timing: FAST }, consumers: [down] }), 20_000)
    expect(state.events.lost).toBeGreaterThan(100)
    expect(state.events.published).toBe(0)
    expect(web(all, "fail", 0)).toBe(0)
    expect(state.delivered).toBeGreaterThan(300)
  })

  it("works with nothing wired to the events port", async () => {
    const { all, state } = await stateAfter(mail({ load: { rps: 50 }, ses: { timing: FAST } }), 10_000)
    expect(web(all, "fail", 0)).toBe(0)
    expect(state.events).toEqual({ destinations: 0, pending: 0, published: 0, lost: 0 })
    expect(state.delivered).toBeGreaterThan(300)
  })

  it("takes a destination's changed event types on its next event", () =>
    sim(mail({ load: { rps: 50 }, ses: { timing: FAST }, consumers: [{ id: "all", edge: { events: { send: true, delivery: false } } }] }), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(10_000)
        const edge = Object.keys((yield* s.inspect).edges)[1]!
        yield* s.configureEdge(edge, { events: { send: false, delivery: true } })
        const after = yield* s.advanceTo(20_000)
        // Send and Delivery are each about 50 a second: the count holds, but the mix changed.
        expect(rate(before, "in", 3_000, 9_000, "all")).toBeCloseTo(50, -1)
        expect(rate(after, "in", 13_000, Infinity, "all")).toBeCloseTo(50, -1)
        expect(rate(after, "events.published", 13_000)).toBeCloseTo(50, -1)
      })))
})

describe("aws.ses suppression list", () => {
  const recipients = { hardBounceRate: 0.1, complaintRate: 0, deferredRate: 0, repeatShare: 0.8, virusRate: 0 }
  const run = (suppression: Record<string, unknown>) =>
    stateAfter(mail({ ses: { recipients, suppression, timing: FAST, reputation: { enforcement: false } }, load: { rps: 100 } }), 60_000)

  it("stops repeat sends to addresses that bounced, which keeps them out of the bounce rate", async () => {
    const on = await run({ enabled: true })
    const off = await run({ enabled: false })
    // Without the list a repeat to a bad address bounces again: about 10% of everything. With it, only new addresses bounce.
    expect(off.state.bounceRate).toBeGreaterThan(0.08)
    expect(on.state.bounceRate).toBeLessThan(0.04)
    expect(on.state.suppressed).toBeGreaterThan(on.state.recipients * 0.05)
    expect(on.state.suppressionList).toBeGreaterThan(100)
    expect(off.state.suppressed).toBe(0)
    expect(off.state.suppressionList).toBe(0)
  })

  it("still counts suppressed sends against the daily quota and publishes them as bounces", async () => {
    const { state } = await stateAfter(
      mail({ ses: { recipients, timing: FAST, reputation: { enforcement: false } }, load: { rps: 100 }, consumers: [{ id: "all", edge: { events: { send: false, delivery: false } } }] }),
      30_000
    )
    expect(state.daily.used).toBe(state.recipients)
    // Permanent bounces are the new addresses that bounced plus every send the list stopped.
    expect(state.suppressed).toBeGreaterThan(100)
    expect(state.bounced.permanent).toBeGreaterThan(state.suppressed)
    expect(state.bounced.permanent - state.suppressed).toBeLessThan(state.recipients * 0.05)
  })

  it("lists complaints too, unless the account only suppresses bounces", async () => {
    const complaints = { hardBounceRate: 0, complaintRate: 0.05, deferredRate: 0, repeatShare: 0.8 }
    const list = (reasons: string) =>
      stateAfter(mail({ ses: { recipients: complaints, suppression: { enabled: true, reasons }, timing: FAST, reputation: { enforcement: false } }, load: { rps: 100 } }), 60_000)
    const both = await list("both")
    const bouncesOnly = await list("bounces")
    expect(both.state.suppressed).toBeGreaterThan(100)
    expect(bouncesOnly.state.suppressed).toBe(0)
    expect(bouncesOnly.state.complaintRate).toBeGreaterThan(both.state.complaintRate)
  })

  it("keeps its memory bounded: a long, busy run adds counters, not addresses", async () => {
    const { state } = await stateAfter(mail({ ses: { recipients, timing: FAST, reputation: { enforcement: false } }, load: { rps: 500 } }), 120_000)
    expect(state.addresses).toBeGreaterThan(10_000)
    expect(Number.isFinite(state.suppressionList)).toBe(true)
  })
})

describe("aws.ses reputation and enforcement", () => {
  /** A rate of hard bounces well over the pause threshold, a short review and a short pause so a test can watch them. */
  const unhealthy = {
    recipients: { hardBounceRate: 0.15, complaintRate: 0, deferredRate: 0, repeatShare: 0 },
    timing: FAST,
    reputation: { window: 500, minVolume: 100, reviewPeriod: "1 minute", pauseDuration: "2 minutes" }
  }
  const statusAt = (s: Service, ms: number) =>
    Effect.gen(function*() {
      const frames = yield* s.advanceTo(ms)
      return { frames, state: (yield* s.probe("ses")).state as State }
    })

  it("reviews the account at 5% bounces, then pauses sending if the review ends over 10%", () =>
    sim(mail({ ses: unhealthy, load: { rps: 50 } }), (s) =>
      Effect.gen(function*() {
        const review = yield* statusAt(s, 20_000)
        expect(review.state.status).toBe("review")
        expect(review.state.bounceRate).toBeGreaterThan(0.1)
        // Under review mail still flows.
        expect(web(review.frames, "fail", 10_000)).toBe(0)
        const paused = yield* statusAt(s, 90_000)
        expect(paused.state.status).toBe("paused")
        expect(web(paused.frames, "fail.Rejected", 80_000)).toBeCloseTo(50, 0)
        const gauges = paused.frames.map((f) => f.nodes.ses?.gauges.reputationStatus)
        expect(gauges).toContain(1)
        expect(gauges[gauges.length - 1]).toBe(2)
      })))

  it("blocks every send while paused, and lets mail through again when AWS lifts the pause", () =>
    sim(mail({ ses: unhealthy, load: { rps: 50 } }), (s) =>
      Effect.gen(function*() {
        const paused = yield* statusAt(s, 100_000)
        expect(paused.state.status).toBe("paused")
        const sentWhilePaused = paused.state.recipients
        yield* s.configureNode("ses", { ...unhealthy, recipients: { hardBounceRate: 0.001, complaintRate: 0, deferredRate: 0, repeatShare: 0 } })
        const still = yield* statusAt(s, 150_000)
        expect(still.state.recipients).toBe(sentWhilePaused) // nothing accepted while paused
        // The pause (2 minutes) was lifted at about 180 s; after that a clean list keeps the account healthy.
        const lifted = yield* statusAt(s, 260_000)
        expect(lifted.state.status).toBe("healthy")
        expect(lifted.state.recipients).toBeGreaterThan(sentWhilePaused + 1_000)
        expect(web(lifted.frames, "fail", 200_000)).toBe(0)
      })))

  it("recovers during the review when the list is cleaned up in time, and is never paused", () =>
    sim(mail({ ses: unhealthy, load: { rps: 50 } }), (s) =>
      Effect.gen(function*() {
        const review = yield* statusAt(s, 20_000)
        expect(review.state.status).toBe("review")
        yield* s.configureNode("ses", { ...unhealthy, recipients: { hardBounceRate: 0.005, complaintRate: 0, deferredRate: 0, repeatShare: 0 } })
        // A window of 500 recipients at 50 a second turns over in 10 s.
        const healed = yield* statusAt(s, 40_000)
        expect(healed.state.status).toBe("healthy")
        expect(healed.state.bounceRate).toBeLessThan(0.05)
        const later = yield* statusAt(s, 200_000)
        expect(later.state.status).toBe("healthy")
        expect(web(later.frames, "fail", 0)).toBe(0)
      })))

  it("reviews the account at 0.1% complaints and pauses it at 0.5%", () =>
    sim(
      mail({
        ses: { recipients: { hardBounceRate: 0, complaintRate: 0.02, deferredRate: 0, repeatShare: 0 }, timing: FAST, reputation: { window: 5_000, reviewPeriod: "1 minute", pauseDuration: "1 hour" } },
        load: { rps: 100 }
      }),
      (s) =>
        Effect.gen(function*() {
          const review = yield* statusAt(s, 20_000)
          expect(review.state.status).toBe("review")
          expect(review.state.complaintRate).toBeGreaterThan(0.005)
          const paused = yield* statusAt(s, 90_000)
          expect(paused.state.status).toBe("paused")
        })
    ))

  it("does not act at all with enforcement off", async () => {
    const { state, all } = await stateAfter(mail({ ses: { ...unhealthy, reputation: { ...unhealthy.reputation, enforcement: false } }, load: { rps: 50 } }), 200_000)
    expect(state.status).toBe("healthy")
    expect(state.bounceRate).toBeGreaterThan(0.1)
    expect(web(all, "fail", 0)).toBe(0)
  })

  it("shares one reputation between the SES nodes of an account: a bad sender gets everyone paused", () => {
    const b = Builder.make("two", { seed: 4 })
    const bad = b.add("common.client", { id: "web-bad", settings: { arrival: "constant", rps: 50 } })
    const good = b.add("common.client", { id: "web-good", settings: { arrival: "constant", rps: 5 } })
    b.connect(bad, b.add("aws.ses", { id: "bad", settings: unhealthy }))
    b.connect(good, b.add("aws.ses", { id: "good", settings: { timing: FAST, reputation: unhealthy.reputation } }))
    b.account(PLACEMENT, OPEN_ACCOUNT)
    return sim(b.build(), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(100_000)
        expect(mean(all, "nodes", "web-good", "rates", "fail.Rejected", 80_000)).toBeCloseTo(5, 0)
      }))
  })

  it("exposes the reputation metrics as gauges", async () => {
    const { all } = await stateAfter(mail({ ses: unhealthy, load: { rps: 50 } }), 15_000)
    const last = all[all.length - 1]!.nodes.ses!.gauges
    expect(last.bounceRate).toBeGreaterThan(0.1)
    expect(last.complaintRate).toBe(0)
    expect(last.reputationStatus).toBe(1)
    expect(last.quotaUsed).toBeGreaterThan(0)
    expect(last.dailyUsed).toBeGreaterThan(500)
  })
})

/**
 * A caller that sends messages with a recipient count of its own choosing, which a `common.client` never does (its
 * messages always carry one record).
 */
const Sender = Component.make({
  type: "test.sender",
  title: "Sender",
  category: "traffic",
  inputs: false,
  config: Schema.Struct({ count: Setting.int({ default: 1, min: 0, max: 100_000 }), bytes: Setting.int({ default: 1_024, min: 0, max: 1_000_000_000 }) }),
  make: (node) =>
    Effect.sync(() => {
      const links = node.out("out")
      const tick = (): void => {
        const c = node.fast.settings()
        for (const link of links) link.send(node.fast.mint({ count: c.count, bytes: c.bytes }))
        node.fast.after(100, tick, undefined)
      }
      node.fast.after(0, tick, undefined)
      return {}
    })
})

const withSenders = simulator([Sender])

const withSender = (settings: Record<string, unknown>, ses: Record<string, unknown> = {}) => {
  const b = Builder.make("recipients", { seed: 3 })
  b.connect(b.add("test.sender", { id: "app", settings }), b.add("aws.ses", { id: "ses", settings: ses }))
  b.account(PLACEMENT, OPEN_ACCOUNT)
  return withSenders.sim(b.build(), (s) =>
    Effect.gen(function*() {
      const all = yield* s.advanceTo(5_000)
      return { all, state: (yield* s.probe("ses")).state as State }
    }))
}

describe("aws.ses recipient counts", () => {
  it("refuses a call with no recipients without counting anything", async () => {
    const { all, state } = await withSender({ count: 0 })
    expect(rate(all, "fail.Rejected", 1_000, Infinity, "app")).toBe(0) // the sender does not listen; the node does
    expect(rate(all, "fail.Rejected", 1_000)).toBeGreaterThan(5)
    expect(state.recipients).toBe(0)
    expect(state.daily.used).toBe(0)
  })

  it("counts a call's recipients against the quota, up to 50, and refuses a message to 51", async () => {
    const fifty = await withSender({ count: 50 })
    expect(fifty.state.recipients).toBeGreaterThan(1_000)
    expect(fifty.state.recipients % 50).toBe(0)
    expect(fifty.state.daily.used).toBe(fifty.state.recipients)
    const over = await withSender({ count: 51 })
    expect(over.state.recipients).toBe(0)
    expect(over.state.refused).toBeGreaterThan(30)
    // Two recipients a message, three messages a call: six recipients.
    const six = await withSender({ count: 3 }, { batchSize: 2 })
    expect(six.state.recipients % 6).toBe(0)
    expect(six.state.recipients).toBeGreaterThan(100)
  })

  it("refuses a message far over the size limit without crashing", async () => {
    const huge = await withSender({ count: 1, bytes: 1_000_000_000 })
    expect(huge.state.recipients).toBe(0)
    expect(huge.state.refused).toBeGreaterThan(30)
  })
})
