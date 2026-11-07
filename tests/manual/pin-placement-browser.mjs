// Where the pin lives: a seat in the band beside the eye and the lock while the library is open, and
// centred in the top bar on the search row while the curtain is down — never both, never above the
// band. Synthetic in-memory fixture only.
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

  // 1. Unlocked: the pin is one seat in the band's own row, between the eye and the lock — the
  //    shelves' controls live together, and nothing floats above the band.
  assert.equal(await pin().count(), 1, "the pin is on screen");
  assert.equal(await pin().evaluate((el) => el.closest(".bandbox") !== null), true, "the pin is a seat in the band");
  const inBand = await box(pin());
  const eye = await box(page.getByRole("button", { name: /^Hidden categories:/ }));
  const lock = await box(page.getByRole("button", { name: "Lock local privacy screen" }));
  assert.ok(Math.abs(inBand.cy - eye.cy) <= 6, `pin shares the seat row (pin y ${inBand.cy}, eye y ${eye.cy})`);
  assert.ok(Math.abs(inBand.cy - lock.cy) <= 6, `pin shares the lock's row (pin y ${inBand.cy}, lock y ${lock.cy})`);
  const band = await box(page.locator(".bandbox"));
  assert.ok(inBand.y >= band.y, `the pin is not above the band (pin top ${inBand.y}, band top ${band.y})`);
  assert.ok(inBand.x > eye.x, "pin sits to the right of the eye");
  // The lock keeps the middle of the three seats.
  assert.ok(Math.abs(lock.cx - 220) <= 12, `the lock is centred in the three-seat row (lock centre ${lock.cx})`);
  evidence.push({ check: "unlocked: pin is a seat in the band, lock still centred", pinX: inBand.x, lockCentre: lock.cx, bandTop: band.y });

  // 2. Locked: the band carries only the way back, and that seat is centred — not pushed to the left
  //    by a track that no longer has a third seat in it.
  await page.evaluate(() => window.lockFixture.privacy.lock());
  await page.waitForFunction(() => document.querySelector(".bandbox")?.classList.contains("collapsed"));
  await page.waitForFunction(() => document.querySelector(".top .lockpin") !== null);
  await page.evaluate(() => window.lockFixture.privacy.toggleBand());
  await page.waitForFunction(() => document.querySelector(".bandbox")?.classList.contains("collapsed") === false);
  const unlock = await box(page.getByRole("button", { name: "Unlock local privacy screen" }));
  assert.ok(Math.abs(unlock.cx - 220) <= 12, `the Unlock seat is centred in the band (centre ${unlock.cx})`);
  assert.equal(await page.locator(".bandbox").getByRole("button", { name: /^Pinned:/ }).count(), 0, "no pin inside the band while locked");
  evidence.push({ check: "locked: the band's only seat is centred", unlockCentre: unlock.cx });

  // 3. While locked the pin is out of the band and centred in the top bar, on the search row.
  const lockedPin = await box(pin());
  const search = await box(page.getByRole("button", { name: "Search the library" }));
  const width = page.viewportSize().width;
  assert.ok(Math.abs(lockedPin.cx - width / 2) <= 6, `pin is centred horizontally (centre ${lockedPin.cx}, half ${width / 2})`);
  assert.ok(Math.abs(lockedPin.cy - search.cy) <= 10, `pin shares the search row (pin y ${lockedPin.cy}, search y ${search.cy})`);
  assert.ok(lockedPin.x > 0 && lockedPin.x + lockedPin.w < width, "pin does not overflow the bar");
  assert.equal(await pin().evaluate((el) => el.closest(".bandbox") === null), true, "the top-bar pin is outside the band");
  evidence.push({ check: "locked: pin centred in the top bar on the search row", pinCentreX: lockedPin.cx, searchCentreY: search.cy, pinCentreY: lockedPin.cy });

  // 4. The pin still works from there: tapping it cycles the label.
  const before = await pin().getAttribute("aria-label");
  await pin().click();
  const after = await pin().getAttribute("aria-label");
  assert.notEqual(after, before, "tapping the centred pin cycles its state");
  evidence.push({ check: "locked: the centred pin still cycles", before, after });

  // 5. Unlocking puts the seat back in the band and takes the top-bar copy away.
  await page.evaluate(() => window.lockFixture.unlock());
  await page.waitForFunction(() => document.querySelector(".top .lockpin") === null);
  assert.equal(await pin().evaluate((el) => el.closest(".bandbox") !== null), true, "after unlocking the pin is a seat in the band again");
  evidence.push({ check: "after unlocking: pin is back in the band" });

  console.log(JSON.stringify({ pass: true, evidence, errors }, null, 2));
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ pass: false, evidence, errors, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
