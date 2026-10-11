import { Duration } from "effect"
import { describe, expect, it } from "vitest"
import { Provisioned } from "./provisioned.ts"
import { Environments } from "./environments.ts"
import { audit } from "./audit.ts"
import { claimOf, provisionedOf, type Settings } from "./config.ts"
import { Concurrency, makeRegion } from "./concurrency.ts"
import type { Account } from "../account.ts"

/** The mechanisms on their own, without an engine: the bookkeeping the behaviour tests rely on. */

describe("lambda environments", () => {
  it("reuses the most recently used idle environment and lets the oldest expire by idleness", () => {
    const pool = new Environments()
    for (let i = 0; i < 3; i++) pool.created()
    pool.release(100, 0, 0)
    pool.release(200, 10, 0)
    pool.release(300, 20, 0)
    expect(pool.alive).toBe(3)
    expect(pool.take(310, 1_000, 0)).toBe(20) // last used first
    pool.release(320, 20, 0)
    // At 1,150 the ones idle since 100 and 200 are past a 900 ms lifetime; the one idle since 320 is not.
    expect(pool.idleCount(1_150, 900)).toBe(1)
    expect(pool.alive).toBe(1)
  })

  it("retires an environment that has reached its maximum lifetime, when it is taken and when it is released", () => {
    const pool = new Environments()
    pool.created()
    pool.created()
    pool.release(1_000, 0, 5_000) // young enough
    pool.release(1_000, 500, 5_000)
    expect(pool.take(5_200, 60_000, 5_000)).toBe(500) // 4,700 ms old: still fine
    pool.release(5_300, 500, 5_000) // 4,800 ms old when it comes back: fine
    expect(pool.take(5_600, 60_000, 5_000)).toBe(-1) // both are now over 5 s old (5,100 and 5,600 ms) and are retired as they are met
    expect(pool.alive).toBe(0)
    pool.created()
    pool.release(9_000, 0, 5_000) // 9 s old on release: never goes back
    expect(pool.alive).toBe(0)
  })

  it("keeps no maximum lifetime when it is 0", () => {
    const pool = new Environments()
    pool.created()
    pool.release(10, 0, 0)
    expect(pool.take(100_000_000, 200_000_000, 0)).toBe(0)
  })

  it("counts a discarded environment out", () => {
    const pool = new Environments()
    pool.created()
    pool.discard()
    expect(pool.alive).toBe(0)
  })

  it("grows no bigger than what is alive: expired environments are reclaimed", () => {
    const pool = new Environments()
    for (let i = 0; i < 5_000; i++) {
      pool.created()
      pool.release(i, i, 0)
    }
    pool.expire(4_999, 1_000) // everything idle since before 4,000 is past the idle lifetime
    expect(pool.alive).toBe(1_000)
    expect(pool.idleCount(4_999, 1_000)).toBe(1_000)
  })
})

describe("lambda provisioned concurrency", () => {
  const timers = () => {
    const armed: Array<{ ms: number; fire: () => void; cancelled: boolean }> = []
    return {
      armed,
      after: ((ms: number, fire: () => void) => {
        const t = { ms, fire, cancelled: false }
        armed.push(t)
        return { cancel: () => void (t.cancelled = true) }
      }) as never
    }
  }

  it("starts with what the design asks for already allocated", () => {
    const p = new Provisioned(5)
    expect(p.free).toBe(5)
    expect(p.take()).toBe(true)
    expect(p.free).toBe(4)
  })

  it("raising it takes the warm-up plus the allocation time, and none of it is usable before then", () => {
    const p = new Provisioned(0)
    const t = timers()
    p.retarget(12_000, { after: t.after }, 90_000)
    expect(p.free).toBe(0)
    // 90 s of preparation plus 12,000 environments at 6,000 a minute.
    expect(t.armed[0]!.ms).toBe(90_000 + 120_000)
    t.armed[0]!.fire()
    expect(p.allocated).toBe(12_000)
  })

  it("lowering it applies at once, cancels a pending allocation, and busy environments retire when they finish", () => {
    const p = new Provisioned(10)
    const t = timers()
    p.take()
    p.take()
    p.retarget(20, { after: t.after }, 1_000)
    p.retarget(1, { after: t.after }, 1_000)
    expect(t.armed[0]!.cancelled).toBe(true)
    expect(p.allocated).toBe(1)
    expect(p.free).toBe(0) // two are busy and only one is allocated: never negative
    expect(p.take()).toBe(false)
    p.give()
    expect(p.free).toBe(0) // one busy, one allocated
    p.give()
    expect(p.free).toBe(1)
  })
})

const settings = (over: Partial<Settings> & { reserved?: Partial<Settings["reserved"]> } = {}): Settings => {
  const base = {
    reserved: { enabled: false, concurrency: 100 },
    provisioned: 0,
    timeout: Duration.seconds(3),
    coldStart: { init: { mean: Duration.millis(300), cv: 0.5 }, snapStart: false }
  } as unknown as Settings
  return { ...base, ...over, reserved: { ...base.reserved, ...over.reserved } } as Settings
}

describe("lambda concurrency accounting", () => {
  const account = (lambdaConcurrency: number) => ({ lambdaConcurrency }) as Account

  it("claims are what a function holds back: its reservation, else its provisioned concurrency", () => {
    expect(claimOf(settings({ reserved: { enabled: true, concurrency: 50 }, provisioned: 20 }))).toBe(50)
    expect(claimOf(settings({ provisioned: 20 }))).toBe(20)
    // Provisioned concurrency can't exceed the reservation it lives in.
    expect(provisionedOf(settings({ reserved: { enabled: true, concurrency: 5 }, provisioned: 20 }))).toBe(5)
    expect(provisionedOf(settings({ provisioned: 20 }))).toBe(20)
  })

  it("the shared pool is the account limit minus every claim, but never below 100", () => {
    const region = makeRegion()
    let a = settings({ reserved: { enabled: true, concurrency: 300 } })
    let acct = account(1_000)
    const mk = (id: string, read: () => Settings) => new Concurrency(id, region, { settings: read, account: () => acct })
    const fa = mk("a", () => a)
    const fb = mk("b", () => settings())
    expect(fa.standing().limit).toBe(300)
    expect(fb.standing().pool).toBe(700)
    a = settings({ reserved: { enabled: true, concurrency: 5_000 } })
    expect(fa.standing().limit).toBe(5_000) // a reservation is honoured as given
    expect(fb.standing().pool).toBe(100) // but the pool keeps 100 for everyone else
    acct = account(2_000)
    expect(fb.standing().pool).toBe(100) // a bigger account holds back more (1,900), still leaving 100
    a = settings({ reserved: { enabled: true, concurrency: 0 } })
    fa.standing() // a function registers its new claim as soon as it notices its settings changed
    expect(fb.standing().pool).toBe(2_000)
  })

  it("a function with provisioned concurrency and no reservation can use the pool on top of it", () => {
    const region = makeRegion()
    const c = new Concurrency("a", region, { settings: () => settings({ provisioned: 400 }), account: () => account(1_000) })
    const s = c.standing()
    expect(s.pool).toBe(600)
    expect(s.limit).toBe(1_000)
  })
})

describe("lambda audit", () => {
  const member = (id: string, c: Settings) => ({ id, name: id, type: "aws.lambda", config: c }) as never
  const run = (members: ReadonlyArray<ReturnType<typeof member>>, concurrency = 1_000) => audit("us-east-1", members, { lambdaConcurrency: concurrency } as never)
  const codes = (members: ReadonlyArray<ReturnType<typeof member>>, concurrency?: number) => run(members, concurrency).map((d) => d.code)

  it("warns when reservations and provisioned concurrency add up to more than can be held back", () => {
    const a = member("a", settings({ reserved: { enabled: true, concurrency: 600 } }))
    const b = member("b", settings({ provisioned: 400 }))
    expect(codes([a, b])).toContain("lambda-reservations") // 1,000 held, 900 allowed
    expect(codes([a, b], 2_000)).not.toContain("lambda-reservations")
  })

  it("warns about provisioned concurrency over the reservation and about SnapStart with provisioned concurrency", () => {
    expect(codes([member("a", settings({ reserved: { enabled: true, concurrency: 5 }, provisioned: 10 }))])).toContain("lambda-provisioned-over-reserved")
    const snap = settings({ provisioned: 2 })
    expect(codes([member("a", { ...snap, coldStart: { ...snap.coldStart, snapStart: true } })])).toContain("lambda-snapstart-provisioned")
  })

  it("notes a function reserved at zero, and an Init that can't fit in the timeout", () => {
    expect(codes([member("a", settings({ reserved: { enabled: true, concurrency: 0 } }))])).toContain("lambda-reserved-zero")
    const slow = settings()
    expect(codes([member("a", { ...slow, coldStart: { ...slow.coldStart, init: { mean: Duration.seconds(20), cv: 0 } } })])).toContain("lambda-init-over-timeout")
  })

  it("says nothing about a plain function", () => {
    expect(run([member("a", settings())])).toEqual([])
  })
})
