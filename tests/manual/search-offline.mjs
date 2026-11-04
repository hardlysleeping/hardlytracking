// Live check: a query whose source is silent still paints what this device already answered, and an
// opened card still lists stored issues. Memory store + stubbed provider only — no real library.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs BASE=http://127.0.0.1:5219 node tests/manual/search-offline.mjs
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.BASE || "http://127.0.0.1:5219";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, hasTouch: true, isMobile: true });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const report = {};

try {
  await page.goto(`${base}/tests/manual/browse-display.html?screen=Search`);
  await page.waitForFunction(() => typeof window.qa === "object");
  await page.evaluate(() => window.qa.screen("Search"));
  await page.waitForFunction(() => document.querySelectorAll(".tile").length > 0);

  // Store an answer the way a previous visit would have, then take the source away.
  report.seeded = await page.evaluate(async () => {
    const { store, items, library } = window.qa;
    const source = library.sources[0];
    const key = `${source.id}\u0000fixture`;
    await store.putSearchCache(key, { key, sourceId: source.id, query: "fixture", items: items.slice(0, 4), at: Date.now() - 60 * 60_000 });
    // An hour old: past the ten-minute freshness, still the right answer to show.
    library.profile.providers[0].search = () => Promise.reject(new Error("source is off the network"));
    return (await store.getSearchCache(key)) !== undefined;
  });
  assert.equal(report.seeded, true);

  await page.evaluate(() => {
    const field = document.querySelector('input[type="search"], input[type="text"]');
    field.value = "fixture";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Search").click());
  await page.waitForTimeout(900);

  report.offline = await page.evaluate(() => ({
    tiles: document.querySelectorAll(".tile").length,
    notice: [...document.querySelectorAll("*")].some((el) => el.children.length === 0 && /Showing the last answer from this device/.test(el.textContent)),
  }));
  assert.equal(report.offline.tiles, 4, "the stored answer must still be on screen");
  assert.equal(report.offline.notice, true, "and it must say that is what you are looking at");

  // A card whose issues are stored opens with its list even though the source will not answer.
  await page.evaluate(async () => {
    const { store, library } = window.qa;
    const id = library.library[0].id;
    library.chapters = () => Promise.reject(new Error("source is off the network"));
    const chapters = [{ id: `${id}:1`, name: "Issue 1", number: 1, pageCount: 24 }, { id: `${id}:2`, name: "Issue 2", number: 2, pageCount: 22 }];
    const key = `issues\u0000${id}`;
    await store.putSearchCache(key, { key, seriesId: id, chapters, at: Date.now() - 3 * 24 * 60 * 60_000 });
    document.querySelectorAll(".tile")[0].click();
  });
  await page.waitForTimeout(900);
  report.issues = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".dirow")].map((row) => row.textContent.replace(/\s+/g, " ").trim());
    return { rows, error: document.body.textContent.includes("did not arrive") };
  });
  assert.equal(report.issues.rows.length, 2, "a three-day-old list is still the list");
  assert.equal(report.issues.error, false, "and it must not be replaced by an error");
} finally {
  await browser.close();
  console.log(JSON.stringify({ ...report, errors }, null, 2));
  assert.deepEqual(errors, []);
}
