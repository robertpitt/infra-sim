// The README's screenshots, taken from the running app in headless Chromium at 2x, so they can be retaken whenever the UI
// changes.
//   npm run dev   then   node tools/screenshots.mjs            (or URL=https://robertpitt.github.io/infra-sim/ node tools/screenshots.mjs)
// Writes docs/screenshots/{scenario,settings,dashboard,editor}.png.
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
  // Opening the list scrolled the sidebar down to it: show the top of the palette again.
  await page.locator(".side-scroll").evaluate((el) => { el.scrollTop = 0 })
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
  // Late enough that Route 53 has noticed (about 85 s in) and is moving US users to Europe, before us-east-1 comes back
  // at 4:00. At 50x the pause lands about ten simulated seconds after it is asked for.
  await pauseAt(page, 3 * 60 + 38)
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

// 3. A component's dashboard: the Order pipeline's orders table in its flash sale, out of write capacity and throttling.
{
  const page = await open()
  await page.evaluate(() => {
    localStorage.setItem("sim:ui:dock", "open")
    localStorage.setItem("sim:ui:dock-height", "540")
  })
  await page.reload()
  await page.waitForSelector(".node")
  await example(page, /Order pipeline/)
  await page.locator(".dock-tab", { hasText: "Scenario" }).click()
  // Another card mentions the flash sale too: this one's title starts with it.
  await page.locator(".scenario-card").filter({ hasText: /^Flash sale/ }).locator("button", { hasText: "Run" }).click()
  await page.locator('.node:has(.node-name:text-is("Orders table")) .node-head').click()
  await page.locator(".dock-tab", { hasText: "Charts" }).click()
  await page.locator('button:text-is("5m")').first().click()
  await speed(page, 8) // 50x
  // The rush (1:00 to 2:00) is over, the table is still working through the backlog at its old capacity.
  await pauseAt(page, 2 * 60 + 30)
  await shot(page, "dashboard")
  await page.close()
}

// 4. The YAML editor, completing a Lambda's settings from the design schema.
{
  const page = await open()
  await page.locator(".view-tabs button", { hasText: "Editor" }).click()
  await page.waitForSelector(".monaco-editor .view-lines", { timeout: 30000 })
  await page.waitForTimeout(1500)
  await page.locator(".monaco-editor textarea").focus()
  // The Collect Lambda's settings (the event ingestion platform opens first): find its "memory: 1024", then start a new
  // setting after it and ask what can go there.
  await page.keyboard.press("ControlOrMeta+f")
  await page.keyboard.type("memory: 1024")
  await page.keyboard.press("Enter")
  await page.keyboard.press("Escape")
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
