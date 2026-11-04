// Live check of holding an issue row: a menu without reading, and ranges that follow the screen.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs BASE=http://127.0.0.1:5225 node tests/manual/series-hold.mjs
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.BASE || "http://127.0.0.1:5225";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, hasTouch: true, isMobile: true });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const cases = [];

async function open(order) {
  await page.goto(`${base}/tests/manual/series-hold.html?order=${order}`);
  await page.waitForFunction(() => document.querySelectorAll(".row").length === 6);
  // The view starts newest-first and flips from its own button; reading the drawn order from the DOM
  // is the only way to be sure the range is measured against what is actually on screen.
  if (order === "oldest") {
    await page.evaluate(() => {
      const chip = [...document.querySelectorAll("button")].find((b) => /first/i.test(b.textContent) && /newest|oldest/i.test(b.textContent));
      chip.click();
    });
    await page.waitForTimeout(250);
  }
  return page.evaluate(() =>
    [...document.querySelectorAll(".row .n")].map((label) => `fixture:series:${label.textContent.replace(/[^0-9]/g, "")}`),
  );
}

/**
 * Press and hold a row through the same listener chain a finger would reach.
 *
 * Chromium's raw CDP touch stream reaches this fixture's document but never its row handlers (it is
 * silently dropped without per-session touch emulation, and emulating it changes what arrives), so
 * the gesture is dispatched as the PointerEvent a WebKit touch produces. That is the code under test
 * — the timer, the movement cancel, the menu — not the browser's touch plumbing.
 */
async function hold(index) {
  const row = page.locator(".row").nth(index);
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  // A sticky header can sit over the first rows: a press at a covered point hits the header, which
  // looks exactly like "the hold did nothing".
  const reaches = await page.evaluate(
    ([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && hit.closest(".row") !== null;
    },
    [box.x + 60, box.y + box.height / 2],
  );
  assert.equal(reaches, true, `the press point must land on row ${index}`);
  await page.evaluate(
    ([x, y]) => {
      const row = document.elementFromPoint(x, y).closest(".row");
      for (const type of ["pointerdown", "touchstart"]) {
        row.dispatchEvent(new PointerEvent(type === "touchstart" ? "pointerdown" : type, { bubbles: true, clientX: x, clientY: y, pointerType: "touch", isPrimary: true }));
      }
    },
    [box.x + 60, box.y + box.height / 2],
  );
  await page.waitForTimeout(620);
  await page.evaluate(() => {
    document.querySelectorAll(".row").forEach((row) => row.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" })));
  });
  await page.waitForTimeout(250);
}

/** The iOS long-press gesture path: WebKit's own context menu event. */
async function holdViaContextMenu(index) {
  const row = page.locator(".row").nth(index);
  await row.scrollIntoViewIfNeeded();
  await row.evaluate((element) => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await page.waitForTimeout(250);
}

try {
  // Newest-first: the row drawn above the anchor is the *newer* issue.
  const drawn = await open("newest");
  const before = await page.evaluate(() => location.hash);
  await hold(2);
  const menu = await page.evaluate(() => {
    const sheet = document.querySelector("dialog, .sheet") ?? document.body;
    return [...sheet.querySelectorAll("button")].map((b) => b.textContent.replace(/\s+/g, " ").trim());
  });
  assert.equal(await page.evaluate(() => location.hash), before, "a hold must not start reading");
  assert.ok(menu.includes("Mark this and the 2 above read"), `menu was ${JSON.stringify(menu)}`);
  assert.ok(menu.some((label) => label.startsWith("Mark this and the") && label.includes("below")), "the other direction is offered");
  cases.push({ order: "newest", menu });

  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /above read/.test(b.textContent)).click());
  await page.waitForTimeout(500);
  const marks = await page.evaluate(() => window.holdFixture.marks.map((row) => row.key.replace("read:", "")));
  // Rows 0..2 in drawn order — which, newest-first, are the highest issue numbers.
  assert.deepEqual([...marks].sort(), [...drawn.slice(0, 3)].sort(), "the range must follow the drawn order");
  assert.equal(marks.length, 3);
  cases.push({ order: "newest", marked: marks, drawnHead: drawn.slice(0, 3) });

  // Oldest-first: the same gesture marks the same *screen* rows, which are the low numbers.
  const drawnOld = await open("oldest");
  await hold(2);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /above read/.test(b.textContent)).click());
  await page.waitForTimeout(500);
  const marksOld = await page.evaluate(() => window.holdFixture.marks.map((row) => row.key.replace("read:", "")));
  assert.deepEqual([...marksOld].sort(), [...drawnOld.slice(0, 3)].sort());
  cases.push({ order: "oldest", marked: marksOld, drawnHead: drawnOld.slice(0, 3) });

  // The iOS gesture itself: WebKit reports a long press as contextmenu.
  await open("newest");
  await holdViaContextMenu(4);
  const viaContext = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => /above read/.test(b.textContent)));
  assert.equal(viaContext, true, "a WebKit long press must open the same menu");
  cases.push({ viaContextMenu: viaContext });

  // The ⋯ button is the same menu without a hold, for a mouse or a keyboard.
  await open("newest");
  await page.locator(".row").nth(4).locator(".mini").first().click();
  await page.waitForTimeout(300);
  const viaButton = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => /above read/.test(b.textContent)));
  assert.equal(viaButton, true, "the menu must be reachable without a pointer hold");
  cases.push({ viaButton });

  // A drag must not open it: the timer gives up once the finger moves.
  await open("newest");
  const box = await page.locator(".row").nth(3).boundingBox();
  await page.locator(".row").nth(3).scrollIntoViewIfNeeded();
  await page.evaluate(
    async ([x, y]) => {
      const row = document.elementFromPoint(x, y).closest(".row");
      row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerType: "touch", isPrimary: true }));
      for (let step = 1; step <= 6; step += 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        row.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y - step * 12, pointerType: "touch", isPrimary: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      row.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
    },
    [box.x + 60, box.y + box.height / 2],
  );
  await page.waitForTimeout(250);
  const afterDrag = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => /above read/.test(b.textContent)));
  assert.equal(afterDrag, false, "a scroll must not open the menu");
  cases.push({ dragOpenedMenu: afterDrag });
} finally {
  await browser.close();
  console.log(JSON.stringify({ cases, errors }, null, 2));
  assert.deepEqual(errors, []);
}
