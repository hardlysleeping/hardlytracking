// The cover title ("Title on cover") must end in an ellipsis, never a chopped line.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/manual/overlay-title-browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE ?? "http://localhost:5217";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const evidence = [];

try {
  await page.goto(`${BASE}/tests/manual/source-tabs.html?source=tabs&long=1`);
  await page.waitForSelector(".set .tile");
  await page.evaluate(() => window.tabsFixture.settings.set("browseTitle", "overlay"));
  await page.waitForTimeout(300);

  const read = async () => page.locator(".set .tile .art .over-title").first().evaluate((el) => {
    const style = getComputedStyle(el);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const box = el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    const lines = range.getClientRects().length;
    return {
      text: el.textContent ?? "",
      lines,
      boxHeight: Math.round(box.height),
      twoLines: Math.round(lineHeight * 2 + (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)),
      clipped: el.scrollHeight > el.clientHeight + 1,
      lastLine: (() => {
        const rects = [...range.getClientRects()];
        return rects.length === 0 ? null : Math.round(rects.at(-1).bottom);
      })(),
      boxBottom: Math.round(box.bottom),
    };
  });

  const longTitle = await read();
  if (!longTitle.text.endsWith("…")) throw new Error(`a long title was not ellipsised: "${longTitle.text}"`);
  if (longTitle.clipped) throw new Error("the title is still being cut by overflow, not by the clamp");
  if (longTitle.lines > 2) throw new Error(`the title took ${longTitle.lines} lines`);
  if (longTitle.text.length >= 95) throw new Error(`the title was not shortened at all: ${longTitle.text.length} chars`);
  evidence.push({ check: "a title too long for the cover ends in an ellipsis on two whole lines", ...longTitle });

  // A short title must be left completely alone — no ellipsis, no shrinking.
  await page.goto(`${BASE}/tests/manual/source-tabs.html?source=tabs`);
  await page.waitForSelector(".set .tile");
  await page.evaluate(() => window.tabsFixture.settings.set("browseTitle", "overlay"));
  await page.waitForTimeout(300);
  const shortTitle = await read();
  if (shortTitle.text !== "trending 1") throw new Error(`a short title was altered: "${shortTitle.text}"`);
  if (shortTitle.clipped) throw new Error("a short title was clipped");
  evidence.push({ check: "a title that fits is untouched", ...shortTitle });

  // The title *below* the cover is the same defect and must be fixed with it: two lines in a grid,
  // one in a row, ellipsis rather than a chopped line.
  await page.goto(`${BASE}/tests/manual/source-tabs.html?source=tabs&long=1`);
  await page.waitForSelector(".set .tile");
  for (const [placement, mode] of [["below", "Grid"], ["below", "Row"], ["below", "Card"]]) {
    await page.evaluate((p) => window.tabsFixture.settings.set("browseTitle", p), placement);
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page.waitForTimeout(250);
    const titles = await page.locator(".set .tile .meta .title").evaluateAll((els) =>
      els.map((el) => ({ text: el.textContent ?? "", clipped: el.scrollHeight > el.clientHeight + 1 })),
    );
    const clipped = titles.filter((row) => row.clipped);
    if (clipped.length > 0) throw new Error(`${mode} below-title still hard-clipped: "${clipped[0].text}"`);
    const truncated = titles.filter((row) => row.text.endsWith("…"));
    if (truncated.length === 0) throw new Error(`${mode} below-title is not ellipsised at all`);
    evidence.push({ check: `${mode}: the title below the cover ellipsises instead of clipping`, sample: truncated[0].text });
  }

  // Rotation/re-flow re-measures instead of leaving the old cut in place.
  await page.setViewportSize({ width: 340, height: 800 });
  await page.waitForTimeout(400);
  await page.goto(`${BASE}/tests/manual/source-tabs.html?source=tabs&long=1`);
  await page.waitForSelector(".set .tile");
  await page.evaluate(() => window.tabsFixture.settings.set("browseTitle", "overlay"));
  await page.waitForTimeout(300);
  const narrow = await read();
  if (!narrow.text.endsWith("…")) throw new Error(`narrow grid: not ellipsised — "${narrow.text}"`);
  evidence.push({ check: "a narrower grid re-measures", width: 340, ...narrow });

  if (errors.length > 0) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log(JSON.stringify({ ok: true, evidence }, null, 2));
} finally {
  await browser.close();
}
