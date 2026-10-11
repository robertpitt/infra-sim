// End-to-end check of the UI in headless Chromium: sidebar, settings, regions, faults, drag and resize.
//   npm run dev   (in another terminal)   then   node tools/ui-check.mjs      Screenshots go to .tmp/ (or $SHOTS).
import { chromium } from "playwright"
import fs from "node:fs"

const dir = process.env.HOME + "/Library/Caches/ms-playwright"
const found = fs.readdirSync(dir).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop()
const browser = await chromium.launch({ headless: true, executablePath: `${dir}/${found}/chrome-headless-shell-mac-arm64/chrome-headless-shell` })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const errors = []
page.on("pageerror", (e) => errors.push("pageerror: " + e.message))
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()))
page.on("dialog", (d) => d.accept())
const shots = process.env.SHOTS ?? ".tmp"
fs.mkdirSync(shots, { recursive: true })
let failed = 0
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`)
  if (!ok) failed++
}
const count = (sel) => page.locator(sel).count()
const saved = async () => {
  await page.waitForTimeout(600)
  return page.evaluate(() => JSON.parse(localStorage.getItem("sim:design:v2")))
}

await page.goto("http://localhost:5173/")
await page.evaluate(() => localStorage.clear())
await page.reload()
await page.waitForSelector(".node")

// 1. One sidebar, showing a condensed picker.
check("a single sidebar, no palette or inspector", (await count(".sidebar")) === 1 && (await count(".palette")) === 0 && (await count(".inspector")) === 0)
check("picker shows component tiles", (await count(".tile")) >= 8, `${await count(".tile")} tiles`)
check("picker has Region and VPC boundaries", (await count('.tile:has-text("Region")')) >= 1 && (await count('.tile:has-text("VPC")')) >= 1)
await page.screenshot({ path: `${shots}/1-picker.png` })

// search
await page.locator(".search input").fill("dynamo")
const matching = await count(".tile")
check("search filters tiles", matching >= 1 && matching <= 2, `${matching} tiles (DynamoDB, and the VPC endpoint that names it)`)
await page.locator(".search input").fill("")

// 2. Selecting a node turns it into settings.
await page.locator(".node").first().click()
await page.waitForTimeout(150)
check("selecting a node shows its settings", (await count(".back")) === 1 && (await count(".tile")) === 0)
check("settings have sliders", (await count("input.slider")) >= 3, `${await count("input.slider")} sliders`)
await page.keyboard.press("Escape")
await page.locator('.node:has(.node-type:has-text("Lambda"))').first().click()
await page.waitForTimeout(150)
check("limit pills are shown on service settings", (await count(".pill")) >= 1, `${await count(".pill")} pills`)
await page.screenshot({ path: `${shots}/2-node.png` })
await page.keyboard.press("Escape")
await page.waitForTimeout(100)
check("Escape returns to the picker", (await count(".tile")) >= 8)

// 3. A slider edits the setting.
const lambda = page.locator('.node:has(.node-type:has-text("Lambda"))').first()
await lambda.click()
const lambdaId = await lambda.evaluate((el) => el.dataset.nodeId)
const memory = page.locator(".field.num", { hasText: "Memory" }).first()
await memory.locator("input.slider").fill("500")
await page.waitForTimeout(200)
const memText = await memory.locator(".number-box input").inputValue()
const d1 = await saved()
check("dragging a slider updates the number and the design", Number(memText) > 128 && d1.nodes[lambdaId].settings?.memory === Number(memText), `memory ${memText} stored ${d1.nodes[lambdaId].settings?.memory}`)
const timeout = page.locator(".field.num", { hasText: "Timeout" }).first()
await timeout.locator(".number-box input").fill("45s")
await timeout.locator(".number-box input").press("Enter")
await page.waitForTimeout(200)
const d2 = await saved()
check("durations take units", d2.nodes[lambdaId].settings?.timeout === 45000, String(d2.nodes[lambdaId].settings?.timeout))
await page.keyboard.press("Escape")

// 4. Multi-region example draws region boxes.
await page.locator(".section-toggle", { hasText: "Examples" }).click()
await page.getByRole("button", { name: /Multi-region/ }).click()
await page.waitForTimeout(500)
check("multi-region draws two region boxes", (await count(".group-box")) === 2)
check("no design errors", (await count(".banner.error")) === 0)
await page.screenshot({ path: `${shots}/3-multiregion.png` })
const d3 = await saved()
check("nodes are parented to their region", d3.nodes["api-us"].parent === "region-us" && d3.nodes["fn-eu"].parent === "region-eu")

// 5. Selecting a region box shows its quotas and region faults.
await page.locator('[data-node-id="region-us"]').click()
await page.waitForTimeout(200)
check("region box shows account quotas", (await count('h3:has-text("Account quotas")')) === 1)
check("region box has fault controls", (await count('h3:has-text("Faults")')) === 1)
const lc = page.locator(".field.num", { hasText: "Lambda concurrent" }).first()
await lc.locator(".number-box input").fill("250")
await page.waitForTimeout(250)
const d4 = await saved()
check("editing a quota stores an account override", d4.accounts?.["aws:us-east-1"]?.lambdaConcurrency === 250, JSON.stringify(d4.accounts))
await page.screenshot({ path: `${shots}/4-region.png` })

// 6. Regional outage shows on the box.
await page.getByRole("button", { name: "Outage" }).first().click()
await page.getByRole("button", { name: /Inject outage/i }).click()
await page.waitForTimeout(400)
check("a region outage marks the box", (await count(".group-box[data-down]")) === 1)
check("outage hits region traffic", (await page.locator('[data-node-id="fn-us"] .stat').nth(1).innerText()).length > 0)
await page.screenshot({ path: `${shots}/5-outage.png` })
await page.getByRole("button", { name: /Clear all|Clear fault/ }).first().click().catch(() => {})
await page.keyboard.press("Escape")

// 7. Dragging a node out of one region into another re-parents it.
const box = async (sel) => (await page.locator(sel).boundingBox())
const before = (await saved()).nodes["bookkeeper"]
const head = await box('[data-node-id="bookkeeper"] .node-head')
const eu = await box('[data-group-id="region-eu"]')
check("bookkeeper starts in the US", before.parent === "region-us")
await page.mouse.move(head.x + 40, head.y + 15)
await page.mouse.down()
await page.mouse.move(eu.x + eu.width - 120, eu.y + eu.height / 2, { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(500)
const after = (await saved()).nodes["bookkeeper"]
check("dropping it in the EU box re-parents it", after.parent === "region-eu", JSON.stringify(after.parent))
await page.locator('[data-node-id="bookkeeper"]').click()
await page.waitForTimeout(150)
const regionSel = page.locator('select[aria-label="Region"]')
check("its region is now set by the box", (await regionSel.isDisabled()) && (await regionSel.inputValue()) === "eu-west-1")
await page.screenshot({ path: `${shots}/6-moved.png` })

// 8. Moving a box moves what is inside.
await page.keyboard.press("Escape")
const apiBefore = await box('[data-node-id="api-eu"]')
const euHead = await box('[data-node-id="region-eu"]')
await page.mouse.move(euHead.x + 30, euHead.y + 12)
await page.mouse.down()
await page.mouse.move(euHead.x + 30, euHead.y + 62, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(300)
const apiAfter = await box('[data-node-id="api-eu"]')
check("dragging a box carries its contents", Math.abs(apiAfter.y - apiBefore.y - 50) < 6, `moved ${apiAfter.y - apiBefore.y}`)

// 9. Resizing.
const resize = await box('[data-group-id="region-eu"] .group-resize')
const size0 = (await saved()).nodes["region-eu"].size
await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2)
await page.mouse.down()
await page.mouse.move(resize.x + resize.width / 2 + 100, resize.y + resize.height / 2 + 70, { steps: 6 })
await page.mouse.up()
const size1 = (await saved()).nodes["region-eu"].size
check("a box can be resized", size1.w > size0.w + 100 && size1.h > size0.h + 60, `${size0.w}x${size0.h} -> ${size1.w}x${size1.h}`)

// 10. Narrow window: the sidebar is a drawer.
await page.setViewportSize({ width: 820, height: 800 })
await page.waitForTimeout(300)
await page.locator(".scrim").click({ position: { x: 20, y: 300 } }).catch(() => {})
await page.locator(".node").first().click()
await page.waitForTimeout(250)
const sb = await page.locator(".sidebar").boundingBox()
check("narrow window shows the sidebar as a drawer when something is selected", sb !== null && sb.x > 400)
await page.screenshot({ path: `${shots}/7-narrow.png` })

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "))
await browser.close()
console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
