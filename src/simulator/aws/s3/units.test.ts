import { Duration, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { account } from "../account.ts"
import { audit } from "./audit.ts"
import { GiB, MAX_OBJECT_BYTES, MAX_PARTS, MiB, TiB } from "./limits.ts"
import { Allowance, PrefixTable, prefixIndex, SUSTAIN_GAP_MS } from "./prefixes.ts"
import { quotas } from "./quotas.ts"
import { carriesBody, newPlan, plan, tooLarge } from "./transfer.ts"

const multipart = { enabled: true, threshold: 8, partSize: 8, concurrency: 10 }
const perConnection = 100 * MiB / 1000 // 100 MiB/s, in bytes per ms

describe("aws.s3: transfer planning", () => {
  it("a plain request is one request and moves its bytes over one connection", () => {
    const p = plan(newPlan(), "put", 1, 10 * MiB, { ...multipart, enabled: false }, perConnection, 70)
    expect(p).toMatchObject({ tokens: 1, parts: 0, posts: 0, beforeMs: 0 })
    expect(p.afterMs).toBeCloseTo(100, 6)
  })

  it("a batch moves its bytes one after another", () => {
    expect(plan(newPlan(), "get", 4, 40 * MiB, { ...multipart, enabled: false }, perConnection, 40)).toMatchObject({ tokens: 4 })
    expect(plan(newPlan(), "get", 4, 40 * MiB, { ...multipart, enabled: false }, perConnection, 40).afterMs).toBeCloseTo(400, 6)
  })

  it("HEAD, LIST and DELETE have no body", () => {
    for (const kind of ["head", "list", "delete"] as const) {
      expect(carriesBody(kind)).toBe(false)
      expect(plan(newPlan(), kind, 1, 100 * MiB, multipart, perConnection, 40)).toMatchObject({ tokens: 1, parts: 0, afterMs: 0 })
    }
  })

  it("cuts an upload into parts: one request each, plus the initiate and the complete", () => {
    const p = plan(newPlan(), "put", 1, 80 * MiB, multipart, perConnection, 70)
    expect(p).toMatchObject({ parts: 10, posts: 2, tokens: 12, beforeMs: 70 })
    // 10 parts over 10 connections is one wave: 80 MiB at 1,000 MiB/s, then the complete.
    expect(p.afterMs).toBeCloseTo(80 + 70, 6)
  })

  it("every wave of parts after the first pays a first byte", () => {
    const p = plan(newPlan(), "put", 1, 160 * MiB, multipart, perConnection, 70)
    expect(p.parts).toBe(20)
    expect(p.afterMs).toBeCloseTo(70 /* second wave */ + 160 + 70 /* complete */, 6)
  })

  it("a ranged GET is a request per part with no initiate or complete", () => {
    expect(plan(newPlan(), "get", 1, 80 * MiB, multipart, perConnection, 40)).toMatchObject({ parts: 10, posts: 0, tokens: 10, beforeMs: 0 })
  })

  it("uses fewer connections than configured when there are fewer parts", () => {
    const p = plan(newPlan(), "get", 1, 16 * MiB, multipart, perConnection, 40) // 2 parts
    expect(p.afterMs).toBeCloseTo(16 / 200 * 1000, 6)
  })

  it("an object under the threshold is not split, and neither is one when multipart is off", () => {
    expect(plan(newPlan(), "put", 1, 7 * MiB, multipart, perConnection, 70).parts).toBe(0)
    expect(plan(newPlan(), "put", 1, 700 * MiB, { ...multipart, enabled: false }, perConnection, 70).parts).toBe(0)
  })

  it("never needs more than 10,000 parts", () => {
    const p = plan(newPlan(), "put", 1, TiB, { ...multipart, partSize: 5 }, perConnection, 70)
    expect(p.parts).toBeLessThanOrEqual(MAX_PARTS)
    expect(p.parts).toBeGreaterThan(MAX_PARTS - 10)
  })

  it("reuses the plan it is given", () => {
    const out = newPlan()
    expect(plan(out, "put", 1, 80 * MiB, multipart, perConnection, 70)).toBe(out)
  })
})

describe("aws.s3: size limits", () => {
  it("a body is refused over 5 GB without multipart and over 48.8 TiB with it", () => {
    expect(tooLarge("put", 5 * GiB, 1, false)).toBe(false)
    expect(tooLarge("put", 5 * GiB + 1, 1, false)).toBe(true)
    expect(tooLarge("copy", 5 * GiB + 1, 1, false)).toBe(true)
    expect(tooLarge("put", 5 * GiB + 1, 1, true)).toBe(false)
    expect(tooLarge("put", MAX_OBJECT_BYTES, 1, true)).toBe(false)
    expect(tooLarge("put", MAX_OBJECT_BYTES + 1, 1, true)).toBe(true)
  })

  it("is 48.828125 TiB: 10,000 parts of 5 GiB", () => {
    expect(MAX_OBJECT_BYTES / TiB).toBe(48.828125)
  })

  it("applies per request in a batch, and never to reads, heads, lists or deletes", () => {
    expect(tooLarge("put", 6 * GiB, 2, false)).toBe(false)
    for (const kind of ["get", "head", "list", "delete"] as const) expect(tooLarge(kind, 100 * TiB, 1, false)).toBe(false)
  })
})

describe("aws.s3: prefix allowances", () => {
  const scaling = { enabled: true, splitAfter: Duration.seconds(60), maxSplits: 2 }

  it("spreads keys evenly over the prefixes, and puts a stray key on the nearest end", () => {
    expect(prefixIndex(0, 4)).toBe(0)
    expect(prefixIndex(0.26, 4)).toBe(1)
    expect(prefixIndex(0.999999, 4)).toBe(3)
    expect(prefixIndex(1, 4)).toBe(3)
    expect(prefixIndex(-5, 4)).toBe(0)
    expect(prefixIndex(Number.NaN, 4)).toBe(0)
    expect(prefixIndex(Number.POSITIVE_INFINITY, 4)).toBe(3)
  })

  it("doubles a prefix that has been refused for the split time, up to the largest number of splits", () => {
    const a = new Allowance("k", false, 3_500)
    expect(a.refused(0, scaling)).toBe(false)
    expect(a.refused(5_000, scaling)).toBe(false)
    // Refusals closer together than the sustain gap are one run.
    for (let t = 0; t <= 60_000; t += 5_000) a.refused(t, scaling)
    expect(a.ceiling).toBe(7_000)
    for (let t = 60_000; t <= 120_000; t += 5_000) a.refused(t, scaling)
    expect(a.ceiling).toBe(14_000)
    for (let t = 120_000; t <= 400_000; t += 5_000) a.refused(t, scaling)
    expect(a.ceiling).toBe(14_000) // two splits is the most
    expect(a.splits).toBe(2)
  })

  it("a gap in the refusals starts the count again", () => {
    const a = new Allowance("k", false, 3_500)
    a.refused(0, scaling)
    a.refused(50_000, scaling)
    // 50 s of nothing but a lone refusal: not 60 s of pressure.
    expect(a.refused(50_000 + SUSTAIN_GAP_MS + 1, scaling)).toBe(false)
    expect(a.ceiling).toBe(3_500)
  })

  it("creates allowances only for prefixes that are used, and keeps reads and writes apart", () => {
    const table = new PrefixTable("bucket")
    const w = table.get(7, false, 3_500, scaling)
    const r = table.get(7, true, 5_500, scaling)
    expect(w).not.toBe(r)
    expect(table.get(7, false, 3_500, scaling)).toBe(w)
    expect(w.key).toBe("bucket/prefix7/write")
    expect(r.bucket).toEqual({ rate: 5_500, burst: 5_500 })
  })

  it("drops scaling that was switched off, lowered, or made meaningless by a new guarantee", () => {
    const table = new PrefixTable("bucket")
    const a = table.get(0, false, 3_500, scaling)
    for (let t = 0; t <= 60_000; t += 5_000) table.refuse(a, t, scaling)
    expect(table.scaled.size).toBe(1)
    expect(table.highest(false)).toBe(7_000)
    expect(table.highest(true)).toBe(0)
    expect(table.get(0, false, 3_500, scaling).ceiling).toBe(7_000)
    expect(table.get(0, false, 3_500, { ...scaling, maxSplits: 0 }).ceiling).toBe(3_500)
    expect(table.scaled.size).toBe(0)
    const b = table.get(1, false, 3_500, scaling)
    for (let t = 0; t <= 60_000; t += 5_000) table.refuse(b, t, scaling)
    expect(table.get(1, false, 3_500, { ...scaling, enabled: false }).ceiling).toBe(3_500)
    expect(table.get(1, false, 200_000, scaling).ceiling).toBe(200_000)
  })

  it("does nothing when scale-up is off", () => {
    const table = new PrefixTable("bucket")
    const a = table.get(0, false, 3_500, { ...scaling, enabled: false })
    for (let t = 0; t <= 600_000; t += 1_000) table.refuse(a, t, { ...scaling, enabled: false })
    expect(a.ceiling).toBe(3_500)
    expect(table.scaled.size).toBe(0)
  })
})

describe("aws.s3: account quotas and audit", () => {
  const decode = (overrides: object = {}) => Schema.decodeUnknownSync(account("us-east-1"))(overrides)

  it("defaults to AWS's published quotas, in every region", () => {
    for (const region of ["us-east-1", "eu-north-1", "ap-southeast-2"]) {
      expect(Schema.decodeUnknownSync(account(region))({})).toMatchObject({ s3GeneralPurposeBuckets: 10_000, s3DirectoryBuckets: 100, s3ReplicationTransferRate: 1 })
    }
    expect(Object.keys(quotas("us-east-1")).every((k) => k.startsWith("s3"))).toBe(true)
  })

  const bucket = (id: string, bucketType = "general") => ({ id, name: id, type: "aws.s3", config: { bucketType } })

  it("warns when a region holds more buckets than the account may own", () => {
    const members = [bucket("a"), bucket("b"), bucket("c"), bucket("d", "directory"), bucket("e", "directory")]
    expect(audit("us-east-1", members, decode())).toEqual([])
    const warned = audit("us-east-1", members, decode({ s3GeneralPurposeBuckets: 2, s3DirectoryBuckets: 1 }))
    expect(warned.map((d) => d.code)).toEqual(["s3-general-purpose-buckets", "s3-directory-buckets"])
    expect(warned.every((d) => d.level === "warning")).toBe(true)
  })

  it("ignores everything that is not an S3 bucket", () => {
    expect(audit("us-east-1", [{ id: "q", name: "q", type: "aws.sqs", config: {} }], decode({ s3GeneralPurposeBuckets: 1 }))).toEqual([])
  })
})
