import { describe, expect, it } from "vitest"
import * as Flow from "../Flow.ts"

describe("Flow.Lanes", () => {
  it("runs one task at a time per key, in order, and different keys side by side", () => {
    const lanes = new Flow.Lanes()
    const log: Array<string> = []
    const releases: Record<string, () => void> = {}
    const task = (name: string) => (release: () => void) => {
      log.push(`start ${name}`)
      releases[name] = release
    }
    lanes.run("a", task("a1"))
    lanes.run("a", task("a2"))
    lanes.run("b", task("b1"))
    expect(log).toEqual(["start a1", "start b1"])
    releases.a1!()
    expect(log).toEqual(["start a1", "start b1", "start a2"])
    expect(lanes.open).toBe(2)
  })

  it("leaves no lane behind once its work is done, and ignores a second release", () => {
    const lanes = new Flow.Lanes()
    let release: () => void = () => {}
    for (let i = 0; i < 1_000; i++) lanes.run(`g${i}`, (done) => (release = done))
    expect(lanes.open).toBe(1_000)
    const releases: Array<() => void> = []
    const fresh = new Flow.Lanes()
    for (let i = 0; i < 100; i++) fresh.run(`g${i}`, (done) => releases.push(done))
    for (const done of releases) {
      done()
      done() // releasing twice must not start work that is not there or corrupt the lane
    }
    expect(fresh.open).toBe(0)
    release()
  })
})

