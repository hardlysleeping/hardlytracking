// A 5 000-title shelf, mounted in a real engine: does the grid stop creating tiles, do the spacers
// keep the scroll honest, and is a title still cut with an ellipsis?
//
//   PLAYWRIGHT_MODULE=/home/bazzite/apps/ada-bot/node_modules/playwright/index.mjs \
//     node tests/manual/shelf-window.mjs [chromium|webkit]
//
// Vite must be serving the repo (npm run dev). Nothing here reads a real library: the titles and
// covers are generated in the fixture page.
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE ?? "http://localhost:5299";
const engine = process.argv[2] ?? "chromium";
const browserType = engine === "webkit" ? webkit : chromium;

const browser = await browserType.launch({ headless: true });
const results = [];
let failed = 0;

function check(name, condition, detail) {
  results.push(`${condition ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (condition !== true) failed += 1;
}

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}/tests/manual/shelf-window.html`);
  await page.waitForFunction(() => window.shelfQa !== undefined && document.querySelectorAll(".set .tile").length > 0);

  const top = await page.evaluate(() => window.shelfQa.read());
  check("a 5000-title shelf mounts a window, not the shelf", top.tiles < 200, { tiles: top.tiles });
  check("the window covers the first rows", top.firstTileIndex === 0, { first: top.firstTileIndex });
  check("the missing rows are reserved by a spacer", top.pads.length > 0 && top.scrollHeight > 20000, {
    pads: top.pads,
    scrollHeight: top.scrollHeight,
  });
  check("a long title is cut with an ellipsis", top.title.ellipsised === true, top.title);
  check("the title is not clipped mid-line", top.title.clipped === false, top.title);
  check("the title uses no more than its two lines", top.title.lines <= 2, { lines: top.title.lines });

  // Scroll to the end. A windowed shelf must still reach its last title, and must still be a window.
  await page.evaluate(() => window.shelfQa.scrollTo(1));
  await page.waitForFunction(() => {
    const tiles = [...document.querySelectorAll(".set .tile")];
    return tiles.length > 0 && tiles.at(-1).dataset.seriesId === "archive:4999";
  }, undefined, { timeout: 5000 });
  const bottom = await page.evaluate(() => ({ ...window.shelfQa.read(), last: document.querySelectorAll(".set .tile").length }));
  check("the last title is reachable by scrolling", bottom.firstTileIndex > 4900, { first: bottom.firstTileIndex });
  check("the window is still a window at the end", bottom.tiles < 200, { tiles: bottom.tiles });
  check("the shelf keeps one height, so the scrollbar does not jump", Math.abs(bottom.scrollHeight - top.scrollHeight) < 40, {
    before: top.scrollHeight,
    after: bottom.scrollHeight,
  });

  // And back to the middle.
  await page.evaluate(() => window.shelfQa.scrollTo(0.5));
  await page.waitForFunction(() => {
    const first = Number(document.querySelector(".set .tile")?.dataset.seriesId.split(":")[1]);
    return first > 1000 && first < 4000;
  }, undefined, { timeout: 5000 });
  const middle = await page.evaluate(() => window.shelfQa.read());
  check("a middle scroll draws the middle of the shelf", middle.firstTileIndex > 1000 && middle.firstTileIndex < 4000, {
    first: middle.firstTileIndex,
  });
  check("a middle window has a spacer above and below", middle.pads.length === 2, { pads: middle.pads });

  check("no page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}

for (const line of results) console.log(line);
console.log(`\n${engine}: ${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
process.exitCode = failed === 0 ? 0 : 1;