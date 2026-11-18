// The library's panes, measured in a real engine.
//
//   PLAYWRIGHT_MODULE=/home/bazzite/apps/ada-bot/node_modules/playwright/index.mjs \
//     node tests/manual/panes-window.mjs
//
// Vite must be serving the repo (npm run dev). The fixture generates its own titles; no real
// library, source or database is touched. The fixture also emulates the shell: `main` is the only
// scroller in the app and it sits beside a 76 px rail, which is what `libraryLayout` is told about.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE ?? "http://localhost:5299";

const browser = await chromium.launch({ headless: true });
const results = [];
let failed = 0;

function check(name, condition, detail) {
  results.push(`${condition ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (condition !== true) failed += 1;
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}/tests/manual/panes-window.html`);
  await page.waitForFunction(() => window.panesQa !== undefined && document.querySelectorAll(".set .tile").length > 0);
  await page.evaluate(() => window.panesQa.settle(400));

  const layout = await page.evaluate(() => window.panesQa.measure());
  check("three columns are drawn: shelf, seam, detail", layout.divider !== null && layout.detail !== null, {
    seam: layout.divider?.height,
    shelf: layout.column?.width,
    detail: layout.detail?.width,
  });
  check("a two-hundred-title shelf is taller than the window", layout.column.height > layout.viewport.height * 2, {
    shelf: layout.column.height,
    window: layout.viewport.height,
  });
  check(
    "the seam is bounded by the window, not the shelf",
    layout.divider.height <= layout.viewport.height && layout.divider.height > 0,
    { seam: layout.divider.height, shelf: layout.column.height, window: layout.viewport.height },
  );
  check("the detail pane scrolls on its own", layout.detail.overflowY === "auto", {
    overflowY: layout.detail.overflowY,
  });
  check("the detail pane is height-bounded by the window", layout.detail.maxHeight <= layout.viewport.height, {
    maxHeight: layout.detail.maxHeight,
    window: layout.viewport.height,
  });
  check(
    "the shelf gets the width the layout promised, minus only the seam",
    Math.abs(layout.column.width - (layout.layout.gridWidth - 29)) <= 2,
    { rendered: layout.column.width, promised: layout.layout.gridWidth },
  );
  check("every pane is above its floor", layout.column.width >= 200 && layout.detail.width >= 340, {
    shelf: layout.column.width,
    detail: layout.detail.width,
  });

  // The shelf's own position survives picking another title in the pane.
  const before = await page.evaluate(() => window.panesQa.scrollShelf(900));
  check("the shelf scrolls", before > 500, { scrollTop: before });
  await page.evaluate(() => window.panesQa.pick(3));
  await page.evaluate(() => window.panesQa.settle(600));
  const afterPick = await page.evaluate(() => window.panesQa.measure());
  check("picking another title does not move the shelf", afterPick.doc.scrollTop === before, {
    before,
    after: afterPick.doc.scrollTop,
  });
  check(
    "scrolled down, the seam sits inside the window instead of riding the shelf",
    afterPick.divider.top >= 0 && afterPick.divider.bottom <= afterPick.viewport.height + 1,
    { top: afterPick.divider.top, bottom: afterPick.divider.bottom, window: afterPick.viewport.height },
  );
  check("the seam is still there after the scroll", afterPick.divider.height === layout.divider.height, {
    before: layout.divider.height,
    after: afterPick.divider.height,
  });

  // Dragging the seam to the far left stops at the shelf's floor instead of collapsing it.
  const box = await page.locator(".panes .divider").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(4, box.y + 200, { steps: 8 });
  await page.mouse.up();
  await page.evaluate(() => window.panesQa.settle(300));
  const dragged = await page.evaluate(() => window.panesQa.measure());
  check("dragging left stops at the shelf's floor", dragged.column.width >= 200, {
    shelf: dragged.column.width,
  });
  check("dragging left does not put the detail under its floor", dragged.detail.width >= 340, {
    detail: dragged.detail.width,
  });
  check("a drag produces a real width, never NaN", Number.isFinite(dragged.column.width) && Number.isFinite(dragged.detail.width), {
    shelf: dragged.column.width,
    detail: dragged.detail.width,
  });
  check("the drag narrowed the shelf and widened the detail", dragged.column.width < layout.column.width && dragged.detail.width > layout.detail.width, {
    shelf: [layout.column.width, dragged.column.width],
    detail: [layout.detail.width, dragged.detail.width],
  });

  // Double-clicking the seam puts it back to the shipped default.
  await page.evaluate(() => window.panesQa.setRatio(0.8));
  await page.evaluate(() => window.panesQa.settle(250));
  const wide = await page.evaluate(() => window.panesQa.measure());
  await page.evaluate(() => window.panesQa.resetSeam());
  await page.evaluate(() => window.panesQa.settle(300));
  const reset = await page.evaluate(() => window.panesQa.measure());
  check("a double-click restores the shipped ratio", reset.splitRatio === 0.58, { ratio: reset.splitRatio });
  check("a double-click makes the shelf narrower again", reset.column.width < wide.column.width, {
    wide: wide.column.width,
    reset: reset.column.width,
  });
  check("the reset lands on the width it started at", reset.column.width === layout.column.width, {
    start: layout.column.width,
    reset: reset.column.width,
  });
  check("both panes keep their floors after the reset", reset.column.width >= 200 && reset.detail.width >= 340, {
    shelf: reset.column.width,
    detail: reset.detail.width,
  });

  check("no page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}

for (const line of results) console.log(line);
console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
process.exitCode = failed === 0 ? 0 : 1;