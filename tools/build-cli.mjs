// Bundle the CLI into dist-cli/infra-sim.mjs: one file, with the examples and docs beside it, so it runs anywhere with Node 22+.
import { build } from "esbuild"
import fs from "node:fs"

fs.rmSync("dist-cli", { recursive: true, force: true })
fs.mkdirSync("dist-cli/docs", { recursive: true })
await build({
  entryPoints: ["src/cli/main.ts"],
  outfile: "dist-cli/infra-sim.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "warning"
})
fs.chmodSync("dist-cli/infra-sim.mjs", 0o755)
fs.cpSync("examples", "dist-cli/examples", { recursive: true })
fs.copyFileSync("docs/CLI.md", "dist-cli/docs/CLI.md")
fs.copyFileSync("package.json", "dist-cli/package.json")
console.log("built dist-cli/infra-sim.mjs")
