import { describe, expect, it } from "vitest"
import { audit } from "../../Audit.ts"
import { HEALTHY, PAUSED, REVIEW, Reputation, type Enforcement } from "../reputation.ts"
import { BUCKET_MS, DailyWindow } from "../window.ts"
import { DAY_MS } from "../../../internal/units.ts"

const policy: Enforcement = { enforcement: true, minVolume: 100, reviewPeriodMs: 10_000, pauseMs: 20_000 }

describe("the rolling 24-hour quota window", () => {
  it("counts recipients sent in the last 24 hours and gives them back after", () => {
    const w = new DailyWindow()
    w.add(0, 100)
    w.add(DAY_MS / 2, 50)
    expect(w.used(DAY_MS / 2)).toBe(150)
    // The first 100 leave within one bucket of 24 hours; the later 50 are still counted.
    expect(w.used(DAY_MS - 1)).toBe(150)
    expect(w.used(DAY_MS + BUCKET_MS)).toBe(50)
    expect(w.used(DAY_MS * 1.5 + BUCKET_MS)).toBe(0)
  })

  it("keeps a send for the whole day however many buckets later it is asked", () => {
    const w = new DailyWindow()
    for (let t = 0; t < DAY_MS; t += BUCKET_MS) w.add(t, 1)
    expect(w.used(DAY_MS - 1)).toBe(DAY_MS / BUCKET_MS)
    // One bucket slides out every five minutes.
    expect(w.used(DAY_MS + BUCKET_MS - 1)).toBe(DAY_MS / BUCKET_MS - 1)
    expect(w.used(DAY_MS + 2 * BUCKET_MS)).toBe(DAY_MS / BUCKET_MS - 3)
  })

  it("forgets everything after a long idle gap and never goes backwards", () => {
    const w = new DailyWindow()
    w.add(1_000, 10)
    expect(w.used(5 * DAY_MS)).toBe(0)
    w.add(5 * DAY_MS, 3)
    expect(w.used(5 * DAY_MS - 1_000)).toBe(3) // a clock that did not move forward changes nothing
  })
})

describe("the reputation window and AWS's enforcement", () => {
  const send = (r: Reputation, sent: number, bounces: number, complaints = 0) => {
    r.addSent(sent, 1_000)
    r.addBounces(bounces)
    r.addComplaints(complaints)
  }

  it("measures the bounce and complaint rates over a bounded, rolling window of recipients", () => {
    const r = new Reputation()
    send(r, 1_000, 100) // 10%
    expect(r.bounceRate).toBeCloseTo(0.1, 5)
    send(r, 1_000, 0) // a window's worth of clean mail pushes the bounces out
    expect(r.volume).toBeLessThanOrEqual(1_050)
    expect(r.bounceRate).toBeLessThan(0.01)
    // A million recipients later the window is still no bigger than it was.
    for (let i = 0; i < 1_000; i++) r.addSent(1_000, 1_000)
    expect(r.volume).toBeLessThanOrEqual(1_050)
  })

  it("puts the account under review at 5% bounces, and at 0.1% complaints", () => {
    const bounces = new Reputation()
    send(bounces, 1_000, 49)
    expect(bounces.update(0, policy)).toBe(HEALTHY)
    send(bounces, 0, 2) // 51 of 1,000
    expect(bounces.update(1, policy)).toBe(REVIEW)

    const complaints = new Reputation()
    send(complaints, 1_000, 0, 1) // exactly 0.1%: "0.1% or greater"
    expect(complaints.update(0, policy)).toBe(REVIEW)
  })

  it("ignores rates until the window holds enough mail to mean something", () => {
    const r = new Reputation()
    send(r, 10, 5) // 50% of 10
    expect(r.update(0, policy)).toBe(HEALTHY)
  })

  it("pauses sending only if the review ends with a rate at 10% bounces or 0.5% complaints", () => {
    const r = new Reputation()
    send(r, 1_000, 70) // 7%: review, but under the pause threshold
    expect(r.update(0, policy)).toBe(REVIEW)
    expect(r.update(10_000, policy)).toBe(REVIEW) // the review is extended, not ended in a pause
    send(r, 0, 60) // now 13%
    expect(r.update(19_999, policy)).toBe(REVIEW)
    expect(r.update(20_000, policy)).toBe(PAUSED)
  })

  it("is healthy again when a review's rate falls back under the thresholds, and a pause lifts after its duration", () => {
    const r = new Reputation()
    send(r, 1_000, 120)
    r.update(0, policy)
    send(r, 2_000, 0)
    expect(r.update(1, policy)).toBe(HEALTHY)

    send(r, 1_000, 500)
    r.update(100, policy)
    expect(r.update(10_100, policy)).toBe(PAUSED)
    expect(r.update(29_000, policy)).toBe(PAUSED)
    expect(r.update(30_100, policy)).toBe(HEALTHY)
    expect(r.volume).toBe(0) // AWS counts only what happens after the fix
  })

  it("never lifts a pause with a pause duration of 0, and ignores everything with enforcement off", () => {
    const r = new Reputation()
    send(r, 1_000, 500)
    r.update(0, { ...policy, pauseMs: 0 })
    r.update(10_000, { ...policy, pauseMs: 0 })
    expect(r.update(1e12, { ...policy, pauseMs: 0 })).toBe(PAUSED)
    expect(r.update(1e12, { ...policy, enforcement: false })).toBe(HEALTHY)
  })
})

describe("the SES audit", () => {
  const quotas = (sandbox: boolean) => ({ sesSandbox: sandbox, sesSandboxDailyQuota: 200, sesSandboxSendingRate: 1 }) as never
  const node = (id: string, config: Record<string, unknown>) => ({
    id,
    name: id,
    type: "aws.ses",
    config: { verifiedShare: 1, batchSize: 1, recipients: { hardBounceRate: 0.01, complaintRate: 0.0003 }, ...config }
  })

  it("says nothing about a region with no SES", () => {
    expect(audit("us-east-1", [{ id: "x", name: "x", type: "aws.sqs", config: {} }], quotas(false))).toEqual([])
  })

  it("warns about a bounce or complaint rate that would put the account under review", () => {
    const codes = audit("us-east-1", [node("a", { recipients: { hardBounceRate: 0.06, complaintRate: 0.002 } })], quotas(false)).map((d) => d.code)
    expect(codes).toEqual(["ses-bounce-rate", "ses-complaint-rate"])
  })

  it("explains the sandbox, warns about unverified recipients, and about more than 50 recipients a call", () => {
    const found = audit("us-east-1", [node("a", { verifiedShare: 0, batchSize: 60 }), node("b", {})], quotas(true))
    expect(found.map((d) => d.code).sort()).toEqual(["ses-recipients", "ses-sandbox", "ses-sandbox-unverified", "ses-shared-account"])
  })
})
