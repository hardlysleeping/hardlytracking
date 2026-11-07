// Row view: a list, not small cards. And getting out of an opened item: a floating caret, or a tap
// anywhere that is not the item.
//
//   PLAYWRIGHT_MODULE=... node tests/manual/row-view-browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:5217";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const evidence = [];

const chip = (name) => page.getByRole("button", { name, exact: true });
const caret = () => page.getByRole("button", { name: "Collapse details", exact: true });

try {
  await page.goto(`${BASE}/tests/manual/source-display.html`);
  await page.waitForSelector(".set .tile");
  await chip("Row").click();
  await page.waitForTimeout(200);

  // 1. A row is a list line: short, hairline-separated, three lines of text beside a small cover.
  const row = await page.locator(".set.row .tile").first().evaluate((el) => {
    const style = getComputedStyle(el);
    const art = el.querySelector(".art").getBoundingClientRect();
    return {
      height: Math.round(el.getBoundingClientRect().height),
      artWidth: Math.round(art.width),
      gap: style.gap,
      radius: style.borderTopLeftRadius,
      lines: [...el.querySelectorAll(".meta > span")].map((node) => node.textContent.trim().slice(0, 40)),
      hasPreview: el.querySelector(".meta .preview") !== null,
    };
  });
  if (row.height > 84) throw new Error(`a row should be a list line, not ${row.height}px tall`);
  if (row.artWidth > 52) throw new Error(`row cover should be at most 52px wide, got ${row.artWidth}`);
  if (row.lines.length < 3) throw new Error(`a row should carry title, preview and facts, got ${row.lines.length} lines`);
  if (!row.hasPreview) throw new Error("a row with a description should show one line of it");
  evidence.push({ check: "a row is a compact three-line list line", ...row });

  const separated = await page.locator(".set.row .tile").nth(1).evaluate((el) => getComputedStyle(el).borderTopWidth);
  if (separated !== "1px") throw new Error(`rows should be separated by a hairline, got ${separated}`);
  evidence.push({ check: "rows are separated by a hairline, not a gap", separated });

  // 2. Opening a row: the panel appears, and there is no "Close details" button in it.
  await page.locator(".set.row .tile").first().click();
  await page.waitForSelector(".issue-panel");
  const closeButtons = await page.getByRole("button", { name: /close details/i }).count();
  if (closeButtons !== 0) throw new Error("the Close details button is still there");
  if ((await caret().count()) !== 1) throw new Error("no floating collapse control appeared");
  const caretBox = await caret().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  evidence.push({ check: "an opened item has no in-panel close button, and gains a floating caret", caretBox });

  // 3. The caret collapses it.
  await caret().click();
  await page.waitForTimeout(200);
  if ((await page.locator(".issue-panel").count()) !== 0) throw new Error("the caret did not collapse the panel");
  if ((await caret().count()) !== 0) throw new Error("the caret stayed after collapsing");
  evidence.push({ check: "the caret collapses the item" });

  // 4. Tapping outside collapses it too — here, the mode row above the grid.
  await page.locator(".set.row .tile").first().click();
  await page.waitForSelector(".issue-panel");
  // The mode row is a tablist on a source page, and it is outside both the panel and the tile.
  await page.getByRole("tab", { name: "Popular", exact: true }).click();
  await page.waitForTimeout(250);
  if ((await page.locator(".issue-panel").count()) !== 0) throw new Error("a tap outside did not collapse the panel");
  evidence.push({ check: "a tap outside the item collapses it" });

  // 5. Tapping another item swaps the panel rather than stacking two.
  await page.waitForSelector(".set .tile");
  await page.locator(".set .tile").first().click();
  await page.waitForSelector(".issue-panel");
  await page.locator(".set .tile").nth(2).click();
  await page.waitForTimeout(250);
  const panels = await page.locator(".issue-panel").count();
  if (panels !== 1) throw new Error(`a second item should replace the first, not add a panel (${panels})`);
  evidence.push({ check: "tapping another item switches the open one", panels });

  console.log(JSON.stringify({ pass: true, evidence, errors }, null, 2));
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ pass: false, evidence, errors, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
