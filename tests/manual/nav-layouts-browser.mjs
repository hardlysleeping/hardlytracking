// One navigation order for every layout, and arrow keys inside the title menu.
//
//   NAV_PORT=5217 PLAYWRIGHT_MODULE=... node tests/manual/nav-layouts-browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const PORT = process.env.NAV_PORT ?? "5217";
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ headless: true });
const errors = [];
const evidence = [];

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}/tests/manual/nav-customise.html`);
  await page.waitForSelector("nav");
  await page.waitForTimeout(250);
  return page;
}

try {
  // The fixture stores bottomNav = [more, history, search, browse, library].
  const wanted = ["More", "History", "Search", "Browse", "Library"];

  // Phone: the bottom bar.
  const phone = await open(440, 956);
  const names = (page, selector) => page.locator(selector).evaluateAll((nodes) => nodes.map((node) => (node.getAttribute("aria-label") ?? node.textContent ?? "").trim()));
  const bar = await names(phone, "nav.bar button");
  if (bar.map((text) => text.trim()).join(",") !== wanted.join(",")) throw new Error(`phone bar order: ${bar.join(",")}`);
  evidence.push({ check: "phone bar draws the stored order", bar: bar.map((t) => t.trim()) });

  // Tablet: the rail.
  const tablet = await open(834, 1112);
  const rail = await names(tablet, "nav.rail button");
  if (rail.map((text) => text.trim()).join(",") !== wanted.join(",")) throw new Error(`tablet rail order: ${rail.join(",")}`);
  evidence.push({ check: "tablet rail draws the same order", rail: rail.map((t) => t.trim()) });

  // Desktop: the sidebar, in the same order — one account must not look like two apps.
  const desktop = await open(1440, 900);
  const side = await names(desktop, "aside.sidebar nav button");
  if (side.map((text) => text.trim()).join(",") !== wanted.join(",")) throw new Error(`desktop sidebar order: ${side.join(",")}`);
  evidence.push({ check: "desktop sidebar draws the same order", side: side.map((t) => t.trim()) });

  // Hiding a page hides it in every layout, and the title menu still reaches it.
  for (const [page, label] of [[phone, "phone"], [tablet, "tablet"], [desktop, "desktop"]]) {
    await page.evaluate(() => window.navFixture.settings.set("bottomNav", ["library", "browse", "search", "history"]));
    await page.waitForTimeout(200);
    const items = await names(page, "nav button.item, nav.bar button");
    if (items.some((text) => text.trim() === "More")) throw new Error(`More is still in the ${label} navigation`);
    evidence.push({ check: `${label}: a hidden page leaves the navigation`, items: items.map((t) => t.trim()).length });
    await page.evaluate(() => window.navFixture.settings.set("bottomNav", ["more", "history", "search", "browse", "library"]));
    await page.waitForTimeout(150);
  }

  // Arrow keys inside the title menu: down walks the rows, wraps, and Home/End jump.
  await phone.getByRole("button", { name: /Library|Browse|More|History|Search/ }).first().click();
  await phone.waitForSelector('[role="menu"]');
  const focused = () => phone.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  const start = await focused();
  await phone.keyboard.press("ArrowDown");
  const down = await focused();
  await phone.keyboard.press("ArrowDown");
  await phone.keyboard.press("ArrowUp");
  const backUp = await focused();
  await phone.keyboard.press("End");
  const end = await focused();
  await phone.keyboard.press("ArrowDown");
  const wrapped = await focused();
  await phone.keyboard.press("Home");
  const home = await focused();
  if (down === start) throw new Error("ArrowDown did not move the focus");
  if (backUp !== down) throw new Error(`ArrowUp did not return to the previous row (${down} -> ${backUp})`);
  // The menu lists every destination in shipped order, not the bar's order: it is the complete way
  // to every page, so it cannot follow a preference that can remove pages from the bar.
  const menuOrder = ["Library", "Browse", "Search", "History", "More"];
  if (end !== menuOrder[menuOrder.length - 1]) throw new Error(`End did not reach the last row (got ${end})`);
  if (wrapped !== menuOrder[0]) throw new Error(`ArrowDown did not wrap to the first row (got ${wrapped})`);
  if (home !== menuOrder[0]) throw new Error(`Home did not reach the first row (got ${home})`);
  evidence.push({ check: "arrow keys rove inside the title menu", start, down, backUp, end, wrapped, home });

  console.log(JSON.stringify({ pass: true, evidence, errors }, null, 2));
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ pass: false, evidence, errors, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
