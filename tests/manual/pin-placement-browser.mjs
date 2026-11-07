// Where the pin lives: above the foldable band while the library is open, and centred in the top bar
// on the search row while the curtain is down. Synthetic in-memory fixture only.
//
//   npx vite --host 127.0.0.1 --port 5217 --strictPort
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/manual/pin-placement-browser.mjs
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:5217";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const evidence = [];

const pin = () => page.getByRole("button", { name: /^Pinned:/ });
const box = async (locator) => locator.evaluate((el) => {
  const rect = el.getBoundingClientRect();
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2, bottom: rect.bottom };
});

try {
  await page.goto(`${BASE}/tests/manual/library-lock-fixture.html`);
  await page.waitForFunction(() => window.lockFixture !== undefined);
  await page.waitForSelector(".bandbox");

  // 1. Unlocked: the pin exists, is outside the collapsible band, and sits above it.
  assert.equal(await pin().count(), 1, "the pin is on screen");
  assert.equal(await pin().evaluate((el) => el.closest(".bandbox") === null), true, "the pin is not inside the band");
  const above = await box(pin());
  const band = await box(page.locator(".bandbox"));
  assert.ok(above.bottom <= band.y + 2, `the pin sits above the band (pin bottom ${above.bottom}, band top ${band.y})`);
  evidence.push({ check: "unlocked: pin above the band, outside it", pinBottom: above.bottom, bandTop: band.y });

  // 2. Locked: the band folds, the pin leaves it, and appears centred in the top bar.
  await page.evaluate(() => window.lockFixture.privacy.lock());
  await page.waitForFunction(() => document.querySelector(".bandbox")?.classList.contains("collapsed"));
  await page.waitForFunction(() => document.querySelector(".top .lockpin") !== null);

  assert.equal(await page.locator(".bandbox").getByRole("button", { name: /^Pinned:/ }).count(), 0, "no pin inside the band while locked");
  const lockedPin = await box(pin());
  const search = await box(page.getByRole("button", { name: "Search the library" }));
  const width = page.viewportSize().width;
  assert.ok(Math.abs(lockedPin.cx - width / 2) <= 6, `pin is centred horizontally (centre ${lockedPin.cx}, half ${width / 2})`);
  assert.ok(Math.abs(lockedPin.cy - search.cy) <= 10, `pin shares the search row (pin y ${lockedPin.cy}, search y ${search.cy})`);
  assert.ok(lockedPin.x > 0 && lockedPin.x + lockedPin.w < width, "pin does not overflow the bar");
  evidence.push({ check: "locked: pin centred in the top bar on the search row", pinCentreX: lockedPin.cx, searchCentreY: search.cy, pinCentreY: lockedPin.cy });

  // 3. The pin still works from there: tapping it cycles the label.
  const before = await pin().getAttribute("aria-label");
  await pin().click();
  const after = await pin().getAttribute("aria-label");
  assert.notEqual(after, before, "tapping the centred pin cycles its state");
  evidence.push({ check: "locked: the centred pin still cycles", before, after });

  // 4. Unlocking puts it back above the band and out of the top bar.
  await page.evaluate(() => window.lockFixture.unlock());
  await page.waitForFunction(() => document.querySelector(".top .lockpin") === null);
  assert.equal(await pin().evaluate((el) => el.closest(".bandbox") === null), true, "after unlocking the pin is outside the band again");
  assert.ok((await box(pin())).bottom <= (await box(page.locator(".bandbox"))).y + 2, "and above it");
  evidence.push({ check: "after unlocking: pin is back above the band" });

  console.log(JSON.stringify({ pass: true, evidence, errors }, null, 2));
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ pass: false, evidence, errors, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
