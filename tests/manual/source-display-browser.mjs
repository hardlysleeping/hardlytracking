// The Discover page: card must not trap the layout, and the grid must offer both title placements.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/manual/source-display-browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:5217";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const evidence = [];

const chip = (name) => page.getByRole("button", { name, exact: true });
const setClass = () => page.locator(".set").first().getAttribute("class");
const tileHeight = async () => Math.round(await page.locator(".set .tile").first().evaluate((el) => el.getBoundingClientRect().height));

try {
  await page.goto(`${BASE}/tests/manual/source-display.html`);
  await page.waitForSelector(".set .tile");

  // 1. The layout chips work on this page too, in every direction, including out of Card.
  for (const name of ["Card", "Grid", "Card", "Row", "Card", "Grid"]) {
    await chip(name).click();
    await page.waitForTimeout(120);
    const cls = (await setClass()) ?? "";
    if (!cls.includes(name.toLowerCase())) throw new Error(`tapping ${name} left the grid as "${cls}"`);
  }
  evidence.push({ check: "layout chips switch on the Discover page, out of Card included" });

  // 2. Grid with the title below: the title is its own row, under the artwork.
  await page.evaluate(() => window.sourceFixture.settings.set("browseTitle", "below"));
  await page.waitForTimeout(150);
  const below = await page.locator(".set .tile").first().evaluate((el) => {
    const art = el.querySelector(".art").getBoundingClientRect();
    const title = el.querySelector(".meta .title").getBoundingClientRect();
    return { gap: Math.round(title.top - art.bottom), titleInArt: el.querySelector(".art .over-title") !== null };
  });
  if (below.gap < 0 || below.gap > 6) throw new Error(`title below should sit within 6px of the cover, not ${below.gap}`);
  if (below.titleInArt) throw new Error("no cover title expected when the title is below");
  evidence.push({ check: "title below the cover", ...below });

  // 3. Grid with the title on the cover: no title row, the title sits inside the artwork.
  await page.evaluate(() => window.sourceFixture.settings.set("browseTitle", "overlay"));
  await page.waitForTimeout(150);
  const overlay = await page.locator(".set .tile").first().evaluate((el) => {
    const art = el.querySelector(".art").getBoundingClientRect();
    const over = el.querySelector(".art .over-title");
    const rect = over?.getBoundingClientRect();
    return {
      insideArt: over !== null && rect.bottom <= art.bottom + 1 && rect.top >= art.top - 1,
      hasMetaTitle: el.querySelector(".meta .title") !== null,
      tileHeight: Math.round(el.getBoundingClientRect().height),
    };
  });
  if (!overlay.insideArt) throw new Error("the overlay title is not inside the cover");
  if (overlay.hasMetaTitle) throw new Error("the overlay title must replace the row title, not duplicate it");
  evidence.push({ check: "title on the cover", ...overlay });

  const taller = overlay.tileHeight;
  await page.evaluate(() => window.sourceFixture.settings.set("browseTitle", "below"));
  await page.waitForTimeout(150);
  const shorter = await tileHeight();
  if (!(shorter > taller)) throw new Error(`a tile with a title row (${shorter}) should be taller than one without (${taller})`);
  evidence.push({ check: "the overlay saves the whole title row", overlayTile: taller, belowTile: shorter });

  // 4. Card is compact: smaller cover, tighter padding, two lines of description.
  await chip("Card").click();
  await page.waitForTimeout(150);
  const card = await page.locator(".set.card .tile").first().evaluate((el) => {
    const style = getComputedStyle(el);
    const art = el.querySelector(".art").getBoundingClientRect();
    const description = el.querySelector(".description");
    return {
      padding: style.padding,
      coverWidth: Math.round(art.width),
      descriptionLines: description === null ? 0 : getComputedStyle(description).webkitLineClamp,
    };
  });
  if (card.padding !== "8px") throw new Error(`card padding should be 8px, got ${card.padding}`);
  if (card.coverWidth > 140) throw new Error(`card cover should be at most 140px, got ${card.coverWidth}`);
  if (String(card.descriptionLines) !== "2") throw new Error(`card description should clamp at 2 lines, got ${card.descriptionLines}`);
  evidence.push({ check: "card is compact", ...card });

  // 6. A desktop window offers twelve columns, and the shelf really draws twelve.
  const wide = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  wide.on("pageerror", (error) => errors.push(error.message));
  await wide.goto(`${BASE}/tests/manual/source-display.html`);
  await wide.waitForSelector(".set .tile");
  const ceiling = await wide.locator('input[aria-label="Grid columns"]').getAttribute("max");
  if (ceiling !== "12") throw new Error(`a 1440px window should offer 12 columns, the slider caps at ${ceiling}`);
  await wide.evaluate(() => window.sourceFixture.settings.set("browseColumns", 12));
  await wide.waitForTimeout(200);
  const drawn = await wide.locator(".set").first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  if (drawn !== 12) throw new Error(`12 columns were asked for and the grid drew ${drawn}`);
  const label = await wide.locator('input[aria-label="Grid columns"]').inputValue();
  evidence.push({ check: "desktop grid goes to 12 across", ceiling, drawn, slider: label });
  await wide.close();

  console.log(JSON.stringify({ pass: true, evidence, errors }, null, 2));
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ pass: false, evidence, errors, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
