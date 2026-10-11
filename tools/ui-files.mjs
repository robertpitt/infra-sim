// Open, Save and Import in headless Chromium, with real file choosers and downloads.
//   npm run dev   then   node tools/ui-files.mjs
import { chromium } from "playwright"
import fs from "node:fs"
import YAML from "yaml"

const dir = process.env.HOME + "/Library/Caches/ms-playwright"
const found = fs.readdirSync(dir).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop()
const browser = await chromium.launch({ headless: true, executablePath: `${dir}/${found}/chrome-headless-shell-mac-arm64/chrome-headless-shell` })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
const page = await ctx.newPage()
const errors = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
page.on("dialog", (d) => d.accept())
fs.mkdirSync(".tmp", { recursive: true })

let failed = 0
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failed++ }
const menu = async (item) => { await page.getByRole("button", { name: "File" }).click(); await page.locator(".menu-item", { hasText: item }).click() }
const nodes = () => page.locator(".node").count()
const open = async (item, file) => {
  const chooser = page.waitForEvent("filechooser")
  await menu(item)
  await (await chooser).setFiles(file)
}

await page.goto("http://localhost:5173/")
await page.evaluate(() => localStorage.clear())
await page.reload()
await page.waitForSelector(".node")

// Menu layout
await page.getByRole("button", { name: "File" }).click()
const items = await page.locator(".menu-pop .menu-item, .menu-pop .menu-label").allInnerTexts()
check("File menu offers Open, Save (YAML), Save as JSON and an Import section", ["Open", "Save (YAML)", "Save as JSON", "Import", "CloudFormation template"].every((t) => items.some((i) => i.toLowerCase().includes(t.toLowerCase()))), items.map((i) => i.split("\n")[0]).join(" | "))
await page.keyboard.press("Escape")
await page.mouse.click(700, 400)

// Open a YAML design
await open("Open…", "examples/03-multi-region.yaml")
await page.waitForTimeout(500)
check("Open reads a YAML design", (await nodes()) === 11 || (await nodes()) >= 9, `${await nodes()} nodes`)
check("no import dialog for a design file", (await page.locator(".dialog").count()) === 0)

// Open a JSON design
const json = JSON.stringify(YAML.parse(fs.readFileSync("examples/01-orders.yaml", "utf8")))
fs.writeFileSync(".tmp/orders.json", json)
await open("Open…", ".tmp/orders.json")
await page.waitForTimeout(500)
check("Open reads a JSON design", (await nodes()) === 7, `${await nodes()} nodes`)

// Save as YAML and JSON
let dl = page.waitForEvent("download")
await menu("Save (YAML)")
let d = await dl
check("Save writes a .yaml file", d.suggestedFilename().endsWith(".yaml"), d.suggestedFilename())
await d.saveAs(".tmp/saved.yaml")
const saved = YAML.parse(fs.readFileSync(".tmp/saved.yaml", "utf8"))
check("the saved YAML is the design", saved.version === 1 && Object.keys(saved.nodes).length === 7)
check("it is YAML, not JSON", !fs.readFileSync(".tmp/saved.yaml", "utf8").trimStart().startsWith("{"))
dl = page.waitForEvent("download")
await menu("Save as JSON")
d = await dl
check("Save as JSON writes a .json file", d.suggestedFilename().endsWith(".json"), d.suggestedFilename())
await d.saveAs(".tmp/saved.json")
check("the saved JSON parses", JSON.parse(fs.readFileSync(".tmp/saved.json", "utf8")).version === 1)
dl = page.waitForEvent("download")
await page.keyboard.press("Meta+s")
d = await dl
check("⌘S saves YAML", d.suggestedFilename().endsWith(".yaml"))

// Import a CloudFormation template through the Import menu
await open("CloudFormation template", "examples/imports/orders-sam.yaml")
await page.waitForSelector(".dialog")
const stats = await page.locator(".stat-tile b").allInnerTexts()
check("import shows its report", stats.length === 4 && Number(stats[0]) >= 6, `stats ${stats.join(", ")}`)
check("the report names what was left out", (await page.locator(".dialog").innerText()).toLowerCase().includes("left out"))
await page.screenshot({ path: ".tmp/import-report.png" })
await page.keyboard.press("Escape")
check("Esc closes the report", (await page.locator(".dialog").count()) === 0)
check("the template became a design with a region box and clients", (await page.locator(".group-box").count()) === 1 && (await nodes()) >= 8, `${await nodes()} nodes`)
check("no error banner", (await page.locator(".banner.error").count()) === 0)
await page.waitForTimeout(2500)
check("it simulates", (await page.locator(".clock").innerText()) !== "00:00.0")
await page.screenshot({ path: ".tmp/imported.png" })

// Opening a CloudFormation file with plain Open is recognised
await open("Open…", "examples/imports/fanout-cfn.yaml")
await page.waitForSelector(".dialog")
check("Open recognises a CloudFormation template and imports it", (await page.locator(".dialog h2").innerText()).includes("fanout-cfn.yaml"))
await page.keyboard.press("Escape")

// Not a design at all
fs.writeFileSync(".tmp/nonsense.yaml", "hello: world\n")
await open("Open…", ".tmp/nonsense.yaml")
await page.waitForTimeout(400)
check("a file that isn't a design says so, and changes nothing", (await page.locator(".toast").innerText()).includes("Couldn't open") && (await page.locator(".dialog").count()) === 0)

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "))
await browser.close()
console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
