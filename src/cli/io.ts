import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Everything the CLI needs from the outside world, so the commands can be run in-process by tests (and by anything
 * that wants to embed them) without touching the real terminal or disk.
 */
export interface IO {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly readFile: (file: string) => string
  readonly writeFile: (file: string, text: string) => void
  readonly exists: (file: string) => boolean
  /** File names in a directory (empty if there is none). */
  readonly list: (dir: string) => ReadonlyArray<string>
  readonly cwd: () => string
  readonly env: Readonly<Record<string, string | undefined>>
  /** Whether stdout is a terminal: decides colour and the default output format. */
  readonly isTTY: boolean
  /** Where bundled files (examples, docs) live. */
  readonly assets: (name: string) => string
}

/** Files shipped with the tool: `examples/` and `docs/`. Found beside the bundle when built, in the repository otherwise. */
const assetRoot = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const candidate of [here, path.resolve(here, "..", "..")]) if (fs.existsSync(path.join(candidate, "examples"))) return candidate
  return path.resolve(here, "..", "..")
}

export const nodeIO = (): IO => ({
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  readFile: (file) => fs.readFileSync(file, "utf8"),
  writeFile: (file, text) => {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
    fs.writeFileSync(file, text)
  },
  exists: (file) => fs.existsSync(file),
  list: (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []),
  cwd: () => process.cwd(),
  env: process.env,
  isTTY: process.stdout.isTTY === true,
  assets: (name) => path.join(assetRoot(), name)
})
