// The display menu: every layout reachable from every other, the row shapes switch and stick, the
// sideways door is a bare glyph on the left, and Escape/outside-press closes the menu.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/manual/display-switch-browser.mjs
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:5217";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const evidence = [];

const wrap = () => page.locator(".set").getAttribute("class");
const door = () => page.getByRole("button", { name: /^Layout:/ });
const item = (label) => page.getByRole("menuitemradio", { name: new RegExp(`^${label}`) });

async function pickLayout(label) {
  if ((await page.locator(".menu").count()) === 0) await door().click();
  await item(label).click();
  await page.waitForTimeout(120);
}

try {
  await page.goto(`${BASE}/tests/manual/display-switch.html`);
  await page.waitForSelector(".set .tile");

  // One door, not three buttons: the layout buttons are gone from the row itself.
  assert.equal(await page.getByRole("button", { name: "Grid", exact: true }).count(), 0, "no separate layout buttons");
  assert.equal(await door().count(), 1, "one menu door names the layout");
  assert.match((await door().getAttribute("aria-label")) ?? "", /^Layout: Grid/, "the door says the current layout");

  // Every pair of layouts, in both directions, more than once.
  const MODE = { Rows: "row", Grid: "grid", Cards: "card" };
  const order = ["Rows", "Grid", "Cards", "Rows", "Cards", "Grid", "Cards", "Rows", "Grid", "Cards", "Grid"];
  for (const label of order) {
    await pickLayout(label);
    const cls = (await wrap()) ?? "";
    assert.match(cls, new RegExp(`\\b${MODE[label]}\\b`), `picking ${label} left the grid as "${cls}"`);
  }
  evidence.push({ check: "every layout switches from every other, repeatedly", order });

  // The row shapes: three candidates, each a class the grid can be read by.
  await pickLayout("Rows");
  for (const [label, cls] of [["Preview", "row-preview"], ["Table", "row-table"], ["Line", "row"]]) {
    await pickLayout(label);
    const set = (await wrap()) ?? "";
    assert.ok(set.includes(cls), `row shape ${label} did not reach the grid ("${set}")`);
  }
  evidence.push({ check: "row shapes switch", shapes: ["line", "preview", "table"] });

  // The sideways door: first control in the row, glyph only, no word.
  await page.keyboard.press("Escape");
  const controls = page.locator(".display > button, .display > .picker");
  const first = controls.first();
  assert.match((await first.getAttribute("aria-label")) ?? "", /^Sideways/, "sideways is the first control");
  assert.equal((await first.innerText()).trim(), "", "and carries no label");
  const sidewaysBox = await first.boundingBox();
  const doorBox = await door().boundingBox();
  assert.ok(sidewaysBox.x < doorBox.x, "aligned left of the layout door");
  evidence.push({ check: "sideways is a bare glyph on the far left", x: Math.round(sidewaysBox.x) });

  // Escape closes the menu, and a press outside closes it.
  await door().click();
  assert.equal(await page.locator(".menu").count(), 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
  assert.equal(await page.locator(".menu").count(), 0, "Escape closes the menu");
  await door().click();
  await page.locator(".set").click({ position: { x: 4, y: 4 } });
  await page.waitForTimeout(80);
  assert.equal(await page.locator(".menu").count(), 0, "a press elsewhere closes the menu");
  evidence.push({ check: "Escape and outside press close the menu" });

  // A choice is remembered: grid + overlay title survives a reload.
  await pickLayout("Grid");
  await item("On cover").click();
  await page.reload();
  await page.waitForSelector(".set .tile");
  const afterReload = (await wrap()) ?? "";
  assert.ok(afterReload.includes("grid"), `a reload lost the layout: "${afterReload}"`);
  assert.ok(afterReload.includes("overtitle"), `a reload lost the title placement: "${afterReload}"`);
  evidence.push({ check: "layout and title placement survive a reload" });

  // Row shape survives too.
  await pickLayout("Rows");
  await pickLayout("Table");
  await page.reload();
  await page.waitForSelector(".set .tile");
  assert.ok(((await wrap()) ?? "").includes("row-table"), "the row shape survives a reload");
  evidence.push({ check: "the row shape survives a reload" });

  // A selected/current mark is drawn inside the thing it marks: an outline outside the artwork
  // lands on the neighbouring tile in a tight grid and is cut by a row's own hairline.
  const rings = await page.locator(".set .tile").first().evaluate((el) => {
    const cover = el.querySelector(".cover");
    const tile = getComputedStyle(el);
    const art = cover ? getComputedStyle(cover) : null;
    return { tileShadow: tile.boxShadow, artOffset: art?.outlineOffset ?? null, artStyle: art?.outlineStyle ?? null };
  });
  assert.equal(rings.artOffset, "-2px", `the row's thumbnail ring is inset (${rings.artOffset})`);
  await pickLayout("Grid");
  const gridRing = await page.locator(".set .tile").first().evaluate((el) => getComputedStyle(el.querySelector(".cover")).outlineOffset);
  assert.equal(gridRing, "-2px", `the grid ring is inset (${gridRing})`);
  await pickLayout("Cards");
  const cardRing = await page.locator(".set .tile").first().evaluate((el) => getComputedStyle(el.querySelector(".cover")).outlineOffset);
  assert.equal(cardRing, "-2px", `the card ring is inset (${cardRing})`);
  evidence.push({ check: "the selection ring is drawn inside the tile in every layout", rings });

  await pickLayout("Rows");
  await pickLayout("Table");
  const height = await page.locator(".set .tile").first().evaluate((el) => Math.round(el.getBoundingClientRect().height));
  evidence.push({ check: "first table row height at 440x956", height });

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pass: true, evidence, errors }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ pass: false, evidence, errors, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
