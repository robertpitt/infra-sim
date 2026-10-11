// Write the JSON Schemas of design and scenario files to schema/, from the registry. Editors read them (a design's
// `# yaml-language-server: $schema=...` line), the app's YAML editor uses them, and the site publishes them.
//   npm run schema        (a test fails when the files are out of date)
import fs from "node:fs"
import path from "node:path"
import { DesignSchema } from "#simulator"
import { registry } from "#simulator/components"

const dir = path.resolve(import.meta.dirname, "../schema")
fs.mkdirSync(dir, { recursive: true })
const write = (file: string, schema: unknown) => {
  fs.writeFileSync(path.join(dir, file), `${JSON.stringify(schema, null, 2)}\n`)
  console.log(`wrote schema/${file}`)
}
write("design.schema.json", DesignSchema.designSchema(registry))
write("scenario.schema.json", DesignSchema.scenarioSchema())
