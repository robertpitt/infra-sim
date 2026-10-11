// The README's screenshots, taken from the running app in headless Chromium at 2x, so they can be retaken whenever the UI
// changes.
//   npm run dev   then   node tools/screenshots.mjs            (or URL=https://robertpitt.github.io/infra-sim/ node tools/screenshots.mjs)
// Writes docs/screenshots/{scenario,settings,editor}.png.
import { chromium } from "playwright"
import fs from "node:fs"

const url = process.env.URL ?? "http://localhost:5173/"
const out = "docs/screenshots"
fs.mkdirSync(out, { recursive: true })

const dir = process.env.HOME + "/Library/Caches/ms-playwright"
const found = fs.readdirSync(dir).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop()
const browser = await chromium.launch({ headless: true, executablePath: `${dir}/${found}/chrome-headless-shell-mac-arm64/chrome-headless-shell` })

/** A fresh page on the app, with nothing remembered from earlier runs. */
const open = async () => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage()
  page.on("dialog", (d) => d.accept())
  await page.goto(url)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.waitForSelector(".node")
  return page
}
const example = async (page, name) => {
  await page.locator(".section-toggle", { hasText: "Examples" }).click()
  await page.getByRole("button", { name }).click()
  await page.waitForTimeout(600)
  await page.locator(".section-toggle", { hasText: "Examples" }).click()
}
/** Simulated time on the clock, in seconds. */
const clock = async (page) => {
  const [m, s] = (await page.locator(".clock").textContent()).split(":").map(Number)
  return m * 60 + s
}
const speed = async (page, presses) => {
  await page.locator(".speed-track").focus()
  await page.keyboard.press("Home")
  for (let i = 0; i < presses; i++) await page.keyboard.press("ArrowRight")
}
const pauseAt = async (page, seconds) => {
  while ((await clock(page)) < seconds) await page.waitForTimeout(50)
  await page.locator(".btn.primary", { hasText: "Pause" }).click()
  await page.waitForTimeout(400)
}
const shot = async (page, name) => {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.mouse.move(1, 1)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/${name}.png` })
  console.log(`wrote ${out}/${name}.png`)
}

// 1. A scenario mid-outage: Multi-region losing us-east-1, its alerts, and the scenario's checks as they stand.
{
  const page = await open()
  await example(page, /Multi-region/)
  await page.locator(".dock-tab", { hasText: "Scenario" }).click()
  await page.locator('.scenario-card:has-text("Lose us-east-1") button:has-text("Run")').click()
  await speed(page, 8) // 50x
  await pauseAt(page, 3 * 60 + 15)
  await page.keyboard.press("f")
  await shot(page, "scenario")
  await page.close()
}

// 2. Selection: the path a node is on, its settings dialog, and its charts.
{
  const page = await open()
  await example(page, /Fan-out/)
  // The canvas gets the whole width, and the design sits left of where the dialog opens.
  await page.locator('.btn[title="Sidebar"]').click()
  await speed(page, 6) // 10x
  await pauseAt(page, 75)
  await page.keyboard.press("f")
  await page.keyboard.press("-")
  await page.waitForTimeout(300)
  const left = await page.evaluate(() => Math.min(...[...document.querySelectorAll(".react-flow__node")].map((n) => n.getBoundingClientRect().left)))
  await page.mouse.move(700, 400)
  await page.mouse.wheel(left - 48, 0)
  await page.waitForTimeout(300)
  await page.locator('.node:has(.node-name:text-is("Emailer")) .node-head').dblclick()
  await page.locator(".dock-tab", { hasText: "Charts" }).click()
  await page.waitForTimeout(400)
  await shot(page, "settings")
  await page.close()
}

// 3. The YAML editor, completing a Lambda's settings from the design schema.
{
  const page = await open()
  await page.locator(".view-tabs button", { hasText: "Editor" }).click()
  await page.waitForSelector(".monaco-editor .view-lines", { timeout: 30000 })
  await page.waitForTimeout(1500)
  await page.locator(".monaco-editor textarea").focus()
  // The Ingest Lambda's settings: after "memory: 512", start a new setting and ask what can go there.
  // Scrolled to the top, Monaco renders lines in order from the first, so the index is the line number less one. (It
  // draws spaces as non-breaking ones.)
  const line = await page.evaluate(() => [...document.querySelectorAll(".monaco-editor .view-line")].findIndex((l) => l.textContent?.replace(/\u00a0/g, " ").trim() === "memory: 512"))
  await page.keyboard.press("Control+g")
  await page.keyboard.type(String(line + 1))
  await page.keyboard.press("Enter")
  await page.waitForTimeout(400)
  await page.keyboard.press("End")
  await page.keyboard.press("Enter")
  await page.waitForTimeout(300)
  await page.keyboard.press("Control+Space")
  await page.waitForTimeout(1500)
  // A second Control+Space shows the details of the highlighted setting beside the list.
  await page.keyboard.press("Control+Space")
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${out}/editor.png` })
  console.log(`wrote ${out}/editor.png`)
  await page.close()
}

await browser.close()
