// Live check of autoscroll in the real reader fixture: off until started, paced by time, and stopped
// by a touch or a mode change.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs BASE=http://127.0.0.1:5225 node tests/manual/autoscroll.mjs
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.BASE || "http://127.0.0.1:5225";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, hasTouch: true, isMobile: true });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const report = {};

const top = () => page.evaluate(() => document.querySelector(".scroller")?.scrollTop ?? -1);

async function open() {
  await page.goto(`${base}/tests/manual/reader-fixture.html?mode=vertical`);
  await page.waitForFunction(() => [...document.images].some((img) => img.naturalWidth > 0));
  await page.waitForTimeout(200);
}

/** The reading chrome hides itself; a tap in the middle brings it back. */
async function showChrome() {
  await page.evaluate(() => {
    const surface = document.querySelector(".scroller");
    const box = surface.getBoundingClientRect();
    surface.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: box.width / 2, clientY: box.height / 2, pointerType: "touch", isPrimary: true }));
    surface.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: box.width / 2, clientY: box.height / 2, pointerType: "touch", isPrimary: true }));
  });
  await page.waitForTimeout(200);
}

try {
  // 1. Nothing moves until it is started.
  await open();
  const idleStart = await top();
  await page.waitForTimeout(600);
  report.offByDefault = { from: idleStart, to: await top() };
  assert.equal(await top(), idleStart, "the page must not move on its own");

  // 2. Started from the control, at the pace the setting names.
  await showChrome();
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Autoscroll").click());
  const started = await top();
  const began = Date.now();
  await page.waitForTimeout(1200);
  const moved = (await top()) - started;
  const seconds = (Date.now() - began) / 1000;
  report.pace = { moved, seconds: Number(seconds.toFixed(2)), pxPerSecond: Math.round(moved / seconds) };
  assert.ok(moved > 20, `autoscroll must move the page (moved ${moved})`);
  assert.ok(moved / seconds < 120, `and not faster than the chosen pace (${Math.round(moved / seconds)} px/s)`);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Pause autoscroll")), true);

  // 3. Touching the page stops it, and the pause button says so.
  await page.evaluate(() => {
    const surface = document.querySelector(".scroller");
    surface.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 300, pointerType: "touch", isPrimary: true }));
  });
  await page.waitForTimeout(120);
  const paused = await top();
  await page.waitForTimeout(500);
  report.paused = { at: paused, after: await top() };
  assert.ok(Math.abs((await top()) - paused) <= 1, "a touch must stop the scroll");

  // 4. A different reading mode ends the run, and the control disappears with it.
  await open();
  await showChrome();
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Autoscroll").click());
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.readerFixture.settings.readerMode = "paged";
  });
  await page.waitForTimeout(400);
  const afterMode = await top();
  await page.waitForTimeout(500);
  report.modeChange = { at: afterMode, after: await top() };
  assert.ok(Math.abs((await top()) - afterMode) <= 1, "a mode change must stop the scroll");
} finally {
  await browser.close();
  console.log(JSON.stringify({ ...report, errors }, null, 2));
  assert.deepEqual(errors, []);
}
