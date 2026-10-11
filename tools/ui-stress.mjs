// Is the page still smooth while the engine runs flat out? Opens POS Hub at a high speed and measures frame gaps and long tasks.
//   npm run dev   then   node tools/ui-stress.mjs [speed]
import { chromium } from "playwright"
import fs from "node:fs"
const dir = process.env.HOME + "/Library/Caches/ms-playwright"
const found = fs.readdirSync(dir).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop()
const browser = await chromium.launch({ headless: true, executablePath: `${dir}/${found}/chrome-headless-shell-mac-arm64/chrome-headless-shell` })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const errors = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
page.on("dialog", (d) => d.accept())
await page.goto("http://localhost:5173/")
await page.evaluate(() => localStorage.clear())
await page.reload()
await page.waitForSelector(".node")
await page.locator(".section-toggle", { hasText: "Examples" }).click()
await page.getByRole("button", { name: /POS Hub/ }).click()
await page.waitForTimeout(1500)
// The speed bar steps between round speeds with the arrow keys: go up to the first at or above the one asked for.
const speed = Number(process.argv[2] ?? "50")
const slider = page.locator(".speed-track")
await slider.focus()
await page.keyboard.press("Home")
for (let i = 0; i < 12 && Number(await slider.getAttribute("aria-valuenow")) < speed; i++) {
  await page.keyboard.press("ArrowRight")
  await page.waitForTimeout(30)
}
// Measure the page's own responsiveness over 6 s: gaps between animation frames and long tasks.
const result = await page.evaluate(() => new Promise((resolve) => {
  const gaps = []
  const long = []
  new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(e.duration))).observe({ entryTypes: ["longtask"] })
  let last = performance.now()
  const start = last
  const loop = (t) => {
    gaps.push(t - last); last = t
    if (t - start < 6000) requestAnimationFrame(loop)
    else {
      gaps.sort((a, b) => a - b)
      resolve({ frames: gaps.length, fps: Math.round(gaps.length / ((t - start) / 1000)), p50: gaps[Math.floor(gaps.length / 2)].toFixed(1), p95: gaps[Math.floor(gaps.length * 0.95)].toFixed(1), max: gaps[gaps.length - 1].toFixed(1), longTasks: long.length, longTotalMs: Math.round(long.reduce((a, b) => a + b, 0)) })
    }
  }
  requestAnimationFrame(loop)
}))
console.log("button:", (await page.locator(".btn.primary").innerText()).trim(), "| banner:", await page.locator(".banner").allInnerTexts())
const status = await page.evaluate(() => document.querySelector(".clock")?.innerText.replace(/\n/g, " "))
console.log(`speed ${speed}x`, JSON.stringify(result), "| clock:", status, "| errors:", errors.length)
await browser.close()
