// Where the reader's exit door goes, in a real browser: the shelf the ▶ was on, not the series page.
// The depth arithmetic lives in `nav-history` (which reads real history entries), so it is proven
// here rather than in a unit test that has to be told the answer.
//
//   npx vite --host 127.0.0.1 --port 5217 --strictPort
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/manual/reader-origin-browser.mjs
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:5217";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const run = (work) => page.evaluate(work);
const depth = () => run(() => window.readerOriginFixture.depth());
const route = () => run(() => window.readerOriginFixture.route());
const origin = () => run(() => window.readerOriginFixture.readerOrigin());
const push = (hash) => page.evaluate((h) => { location.hash = h; }, hash).then(settle);
const settle = () => page.waitForTimeout(120);

try {
  // A shelf, then a series page, then the reader pushed from the series page: the old behaviour.
  await page.goto(`${BASE}/tests/manual/reader-origin-fixture.html`);
  await page.waitForFunction(() => window.readerOriginFixture !== undefined);
  await push("#/library");
  const shelfDepth = await depth();
  await push("#/series/s1");
  await push("#/read/s1/ch1");
  assert.deepEqual(await origin(), { hash: "#/series/s1", steps: 1 }, "a reader opened from the series page remembers it");
  await run(() => window.readerOriginFixture.leaveReader("s1"));
  await settle();
  assert.equal(await route(), "#/series/s1", "and goes back there");
  assert.equal(await depth(), shelfDepth + 1, "without leaving a copy of the reader in the stack");

  // The real complaint: a ▶ on the shelf resumes a chapter without a series page in between.
  await push("#/library");
  await push("#/read/s2/ch7");
  assert.deepEqual(await origin(), { hash: "#/library", steps: 1 });
  await run(() => window.readerOriginFixture.leaveReader("s2"));
  await settle();
  assert.equal(await route(), "#/library", "the shelf comes back, not the titles page");
  assert.equal(await depth(), shelfDepth + 2, "one pop, no duplicate entry");

  // Chapter jumps are reader entries too: one exit must clear all of them.
  await push("#/read/s3/ch1");
  await push("#/read/s3/ch2");
  await push("#/read/s3/ch3");
  assert.equal((await origin()).steps, 3, "three reader entries after the shelf");
  await run(() => window.readerOriginFixture.leaveReader("s3"));
  await settle();
  assert.equal(await route(), "#/library", "still the shelf, from three chapters deep");
  assert.equal(await depth(), shelfDepth + 2, "and every reader entry is gone");

  // Back afterwards leaves the shelf, so the exit did not merely draw it.
  await run(() => history.back());
  await settle();
  assert.equal(await route(), "#/series/s1", "Back goes to the entry before the shelf, not into the reader");

  // The Reader's own header door, pressed in a mounted reader: the same module, wired the way
  // `Reader.svelte` wires it, with the fixture's generated pages.
  await page.goto(`${BASE}/tests/manual/reader-origin-door.html`);
  await page.waitForFunction(() => window.readerDoor !== undefined);
  await page.waitForSelector(".reader header.top");
  await page.evaluate(() => { location.hash = "#/library"; });
  await settle();
  await page.evaluate(() => { location.hash = "#/read/fixture:series/fixture:chapter"; });
  await settle();
  const door = page.getByRole("button", { name: /^Back/ });
  assert.equal(await door.count(), 1, "the reader header has one exit door");
  await door.click();
  await settle();
  assert.equal(await page.evaluate(() => location.hash), "#/library", "pressing it returns to the shelf it was opened from");
  // The fixture mounts the reader directly, so it is not unmounted by the route change here; the
  // app unmounts it (App renders ReaderGate for the read route only). The address bar is the claim.
  assert.equal(await page.evaluate(() => window.readerDoor.route()), "#/library");

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, shelfDepth, errors }, null, 2));
} finally {
  await browser.close();
}
