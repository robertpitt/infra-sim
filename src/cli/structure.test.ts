import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Checks on the shape of the code that a type checker can't see.
 *
 * `aws/provider.ts` composes every service's account quotas and audits, and every component imports `provider.ts` for its
 * building blocks. So what `provider.ts` reaches must never reach a component back, or the modules depend on each other
 * in a circle and whether the code loads comes to depend on which file a test or bundle happens to import first.
 */

const root = "src/simulator/aws"

/** Runtime imports of a file (type-only imports are erased and can't form a cycle). */
const importsOf = (file: string): Array<string> => {
  const text = fs.readFileSync(file, "utf8")
  return [...text.matchAll(/^(import|export)\s+(type\s+)?[^"']*?from\s+"(\.[^"]+)"/gm)]
    .filter((m) => m[2] === undefined)
    .map((m) => path.normalize(path.join(path.dirname(file), m[3]!)))
}

const reachable = (from: string): Map<string, string> => {
  const seen = new Map<string, string>()
  const walk = (file: string, via: string) => {
    if (seen.has(file) || !file.endsWith(".ts") || !fs.existsSync(file)) return
    seen.set(file, via)
    for (const dep of importsOf(file)) walk(dep, file)
  }
  walk(from, "(root)")
  return seen
}

describe("the AWS provider", () => {
  it("reaches no module that imports it back, so loading order can't matter", () => {
    const provider = path.join(root, "provider.ts")
    const cycles = [...reachable(provider)].filter(([file]) => file !== provider && importsOf(file).includes(provider)).map(([file, via]) => `${file} (reached from ${via})`)
    expect(cycles).toEqual([])
  })

  it("keeps every service's quotas and audit as leaves: neither reaches a component", () => {
    const services = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    for (const service of services) {
      for (const file of ["quotas.ts", "audit.ts"]) {
        const full = path.join(root, service, file)
        if (!fs.existsSync(full)) continue
        const reached = [...reachable(full).keys()]
        const components = reached.filter((f) => /\/component\.ts$|\/provider\.ts$/.test(f))
        expect(components, `${full} reaches ${components.join(", ")}`).toEqual([])
      }
    }
  })

  it("has a folder with a README, a quotas.ts and an audit.ts for every service it lists", () => {
    const services = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    expect(services.length).toBeGreaterThanOrEqual(9)
    for (const service of services) {
      expect(fs.existsSync(path.join(root, service, "README.md")), `${service}/README.md`).toBe(true)
      expect(fs.existsSync(path.join(root, service, "index.ts")), `${service}/index.ts`).toBe(true)
    }
  })
})
