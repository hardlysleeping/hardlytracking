// Nothing on a phone-width screen can be dragged sideways.
//
//   PLAYWRIGHT_MODULE=/home/bazzite/apps/ada-bot/node_modules/playwright/index.mjs \
//     node tests/manual/horizontal-overflow.mjs
//
// Vite must be serving the repo (`npm run dev`). The fixture generates its own titles and issues in
// an in-memory store; no real library, source or database is read.
//
// The question is not "does anything look wrong" but "can a finger move it": every element with
// horizontal room *and* a scrollable `overflow-x` is a positive finding, and `moved` proves the
// browser actually honoured it rather than merely allowing the value. A check that reports nothing
// on a page known to overflow is a broken instrument, so the fixture is asked for the shelf first and
// the title's issue list second, and the run fails if either screen is empty.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE ?? "http://localhost:5299";
// The owner's iPhone 17 Pro Max, in CSS pixels, with the safe-area insets a notch and a home
// indicator take away from it.
const PHONE = { width: 440, height: 956 };

const browser = await chromium.launch({ headless: true });
const results = [];
let failed = 0;

function check(name, condition, detail) {
  results.push(`${condition ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (condition !== true) failed += 1;
}

try {
  const page = await browser.newPage({ viewport: PHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}/tests/manual/series-issues-fixture.html`);
  await page.waitForFunction(() => window.overflowQa !== undefined, null, { timeout: 20000 });
  await page.evaluate(() => window.overflowQa.settle(600));

  // Positive control: the shelf is a real list, so the instrument has content to report on.
  const shelf = await page.evaluate(() => window.overflowQa.measure());
  check("the fixture drew the shelf", shelf.tiles === 24, { tiles: shelf.tiles, viewport: shelf.viewport });
  check("the shelf cannot be moved sideways", shelf.scroller.scrollWidth <= shelf.scroller.clientWidth + 1, shelf.scroller);
  check("no shelf element sticks out of the screen", shelf.outside.length === 0, shelf.outside.slice(0, 6));

  // The screen the owner reported: a title and all its issues. A phone is not in the library's split
  // layout, so picking a tile navigates to this page — which is what the fixture mounts.
  await page.evaluate(() => window.overflowQa.show("series", "archive:0"));
  await page.evaluate(() => window.overflowQa.settle(800));

  const title = await page.evaluate(() => window.overflowQa.measure());
  check("the title's issue list is on screen", title.chapters >= 20, { rows: title.chapters });
  check("the scroller is the app's own, not the document", title.doc.scrollWidth <= title.doc.clientWidth, title.doc);
  check("the page cannot be moved sideways", title.scroller.scrollWidth <= title.scroller.clientWidth + 1, title.scroller);
  check("the page holds more vertically than the screen", title.scroller.scrollHeight > title.scroller.clientHeight, {
    scrollHeight: title.scroller.scrollHeight,
    clientHeight: title.scroller.clientHeight,
  });
  check("no element sticks out of the screen", title.outside.length === 0, title.outside.slice(0, 6));
  check("nothing can be dragged sideways", title.scrollers.length === 0, title.scrollers.slice(0, 4));
  check("no page errors", errors.length === 0, errors.slice(0, 3));

  // Clipping the sideways axis must not cost the heading its stickiness — that rule and this one
  // live in different files, so the pair is measured rather than assumed.
  const stuck = await page.evaluate(() => window.overflowQa.scroll(600));
  check("the heading still sticks after scrolling", stuck.scrollTop > 0 && Math.abs(stuck.barTop) <= 1, stuck);
  check("the heading is exactly the width of the screen", stuck.barWidth === PHONE.width, stuck);

  // The same questions with the phone on its side: a wide, short window is where a fixed-width
  // listing stops fitting.
  await page.setViewportSize({ width: 956, height: 440 });
  await page.evaluate(() => window.overflowQa.settle(600));
  const landscape = await page.evaluate(() => window.overflowQa.measure());
  check("landscape: no element sticks out of the screen", landscape.outside.length === 0, landscape.outside.slice(0, 6));
  check("landscape: nothing can be dragged sideways", landscape.scrollers.length === 0, landscape.scrollers.slice(0, 4));
} finally {
  await browser.close();
}

console.log(results.join("\n"));
console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);