import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { EXIT, main } from "./cli.ts"
import { type IO, nodeIO } from "./io.ts"

/** Run the CLI in-process, capturing what it prints. */
const cli = async (args: ReadonlyArray<string>, cwd = process.cwd()) => {
  const out: Array<string> = []
  const err: Array<string> = []
  const io: IO = { ...nodeIO(), stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), cwd: () => cwd, isTTY: false, env: {} }
  const code = await main(args, io)
  return { code, out: out.join(""), err: err.join("") }
}

const DESIGN = `
version: 1
name: zoned
seed: 2
nodes:
  web: { type: common.client, region: eu-west, settings: { arrival: constant, rps: 100 } }
  svc: { type: common.service, region: eu-west, settings: { replicas: 3, zones: 3, fanOut: none, replaceAfter: 5000, startup: 5000 } }
  db: { type: common.http-endpoint, region: eu-west, zone: eu-west-a }
edges:
  e1: { from: { node: web }, to: svc }
`

describe("zones on the command line", () => {
  it("lists zones among the targets a fault can have", async () => {
    const r = await cli(["docs", "faults"])
    expect(r.code).toBe(EXIT.ok)
    expect(r.out).toContain("zone:<placement>:<zone>")
    expect(r.out).toMatch(/Outage {2}targets: node, edge, region, zone/)
  })

  it("injects a zone outage with --fault", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "infra-sim-"))
    fs.writeFileSync(path.join(dir, "d.yaml"), DESIGN)
    const r = await cli(["run", "d.yaml", "-d", "40s", "--fault", "zone:internet:eu-west:eu-west-a Outage at=10s for=20s", "--assert", "svc.gauge.ready:max <= 2 @ 11s..14s", "--json"], dir)
    expect(r.code).toBe(EXIT.ok)
    const result = JSON.parse(r.out) as { faults: ReadonlyArray<{ target: string }>; assertions: ReadonlyArray<{ passed: boolean }> }
    expect(result.faults[0]!.target).toBe("zone:internet:eu-west:eu-west-a")
    expect(result.assertions[0]!.passed).toBe(true)
  })
})
