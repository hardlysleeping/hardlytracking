// The Available list: a catalogue you can read without searching, and languages in their own sheet.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/manual/extension-browse-browser.mjs
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const PORT = process.env.NAV_PORT ?? "5217";
const HOST = process.env.NAV_HOST ?? "localhost";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const evidence = [];

const names = () => page.locator("ul.rows .name").evaluateAll((ns) => ns.map((n) => n.textContent.trim()));
const langButton = () => page.locator(".langbtn");
const sheetRows = () => page.locator('[role="dialog"] .langrow');

try {
  await page.goto(`http://${HOST}:${PORT}/tests/manual/extension-browse-filter.html`);
  await page.waitForTimeout(400);
  await page.getByRole("tab", { name: "Available" }).click();
  await page.waitForFunction(() => document.querySelectorAll("ul.rows .name").length > 0, undefined, { timeout: 6000 });

  // 1. The list is there without typing and without picking a repository: the first index opens itself.
  const listed = await names();
  assert.equal(listed.length, 120, `expected the whole index, drew ${listed.length}`);
  assert.equal(await page.evaluate(() => window.__repoFetches), 1, "the index was read more than once");
  evidence.push({ check: "Available lists a repository's extensions on arrival, with no search and no tap", rows: listed.length });

  // 2. Alphabetical, by name, case-insensitively — a catalogue, not the publisher's order.
  const expected = [...listed].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  assert.deepEqual(listed, expected, "the list is not alphabetical");
  evidence.push({ check: "the list is alphabetical without a search", first: listed[0], last: listed.at(-1) });

  // 3. No wall of language chips in the header: one button, and the list starts near the top.
  assert.equal(await page.locator(".pin .chip[aria-pressed]").count(), 0, "language chips are still in the header");
  assert.equal(await langButton().innerText(), "Languages");
  const firstRow = await page.locator("ul.rows li").first().boundingBox();
  assert.ok(firstRow.y < 700, `the catalogue starts at y=${firstRow.y}, below the fold`);
  evidence.push({ check: "one Languages button instead of a chip wall; the first row is on screen", firstRowY: Math.round(firstRow.y) });

  // 4. The sheet is a scrollable list of toggles, with counts.
  await langButton().click();
  await page.waitForSelector('[role="dialog"]');
  const codes = await sheetRows().locator(".code").allInnerTexts();
  assert.deepEqual(codes, ["EN", "ES", "FR", "JA"]);
  assert.equal(await sheetRows().first().locator(".count").innerText(), "30");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  // 5. Picking a language narrows the list; picking a second one adds to it instead of replacing.
  await langButton().click();
  await page.locator('[role="dialog"] .langrow', { hasText: "ES" }).first().click();
  await page.waitForTimeout(200);
  await page.locator('[role="dialog"] .langrow', { hasText: "JA" }).first().click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const two = await names();
  assert.equal(two.length, 60, `two languages gave ${two.length} rows, not the union`);
  assert.equal(await langButton().innerText(), "Languages (2)");
  evidence.push({ check: "languages are a set: ES + JA gives both, not just the last one", rows: two.length, button: await langButton().innerText() });

  // 6. "Show all languages" is the way back to the whole index.
  await langButton().click();
  await page.getByRole("button", { name: "Show all languages" }).click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  assert.equal((await names()).length, 120);
  assert.equal(await langButton().innerText(), "Languages");
  evidence.push({ check: "Show all languages restores the whole index" });

  // 7. A language-heavy index scrolls inside its own box, with the header and the action fixed.
  await page.goto(`http://${HOST}:${PORT}/tests/manual/extension-browse-filter.html?langs=40`);
  await page.waitForTimeout(400);
  await page.getByRole("tab", { name: "Available" }).click();
  await page.waitForFunction(() => document.querySelectorAll("ul.rows .name").length > 0, undefined, { timeout: 6000 });
  await page.locator(".langbtn").click();
  await page.waitForSelector('[role="dialog"] .list');
  const box = await page.locator('[role="dialog"] .list').evaluate((el) => ({
    scrollable: el.scrollHeight > el.clientHeight + 1,
    height: Math.round(el.getBoundingClientRect().height),
    rows: el.querySelectorAll(".langrow").length,
    dialogBottom: Math.round(el.closest('[role="dialog"]').getBoundingClientRect().bottom),
    viewport: window.innerHeight,
  }));
  assert.equal(box.rows, 40);
  assert.ok(box.scrollable, `40 languages did not scroll: ${JSON.stringify(box)}`);
  assert.ok(box.dialogBottom <= box.viewport + 1, "the sheet runs off the bottom of the screen");
  await page.locator('[role="dialog"] .list').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(200);
  const scrolledTo = await page.locator('[role="dialog"] .list').evaluate((el) => el.scrollTop);
  assert.ok(scrolledTo > 0, "the list did not scroll");
  evidence.push({ check: "40 languages scroll inside the sheet, which stays on screen", ...box, scrolledTo });

  // 8. Switching repository drops a language the new index does not publish.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Other repo", exact: true }).click();
  await page.waitForTimeout(400);
  assert.equal((await names()).length, 30, "a filter survived into the new repository and hid rows");
  // The second index publishes a single language, so there is nothing to filter and no button.
  assert.equal(await page.locator(".langbtn").count(), 0, "a one-language index still offers a language filter");
  evidence.push({ check: "switching repository keeps no language the new index lacks", rows: 30, languageButton: "absent (single-language index)" });

  if (errors.length > 0) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log(JSON.stringify({ ok: true, evidence }, null, 2));
} finally {
  await browser.close();
}
