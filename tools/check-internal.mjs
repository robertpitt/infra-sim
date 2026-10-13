// Enforce the internal/ and tests/ conventions (see AGENTS.md, "Public modules and internal/" and "Tests"):
//   1. `X/internal/` is private to the folder X: only files under X/ may import it.
//   2. A module outside an `internal/` folder is public and named in PascalCase (index.ts, testing.ts and
//      tests excepted). A lower-case helper belongs in its folder's internal/.
//   3. A test of `X/Foo.ts` lives in `X/tests/Foo.test.ts`: every `*.test.ts(x)` under src/ has `tests` as its folder.
import fs from "node:fs"
import path from "node:path"

const root = "src/simulator"
const files = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (/\.tsx?$/.test(entry.name)) files.push(p)
  }
}
walk("src")
walk("tools")

const problems = []
for (const file of files) {
  const source = fs.readFileSync(file, "utf8")
  for (const [, spec] of source.matchAll(/["'](\.\.?\/[^"'\n?]+)/g)) {
    const target = path.normalize(path.join(path.dirname(file), spec))
    const at = target.split(path.sep).lastIndexOf("internal")
    if (at < 0) continue
    const owner = target.split(path.sep).slice(0, at).join(path.sep) + path.sep
    if (!file.startsWith(owner)) problems.push(`${file}: imports ${spec}, which is internal to ${owner}`)
  }
  const base = path.basename(file)
  const exempt = /^(index|testing)\.ts$|\.test\.tsx?$/.test(base)
  if (file.startsWith(root + path.sep) && !file.split(path.sep).includes("internal") && /^[a-z]/.test(base) && !exempt) {
    problems.push(`${file}: a lower-case module outside internal/ (move it to internal/, or name it in PascalCase if it is public)`)
  }
  if (file.startsWith("src" + path.sep) && /\.test\.tsx?$/.test(base) && path.basename(path.dirname(file)) !== "tests") {
    problems.push(`${file}: a test outside a tests/ folder (move it to ${path.join(path.dirname(file), "tests", base)})`)
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"))
  console.error(`\n${problems.length} internal/ or tests/ convention problem(s). See AGENTS.md, "Public modules and internal/" and "Tests".`)
  process.exit(1)
}
