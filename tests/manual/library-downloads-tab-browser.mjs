// Downloads is a Library section: a tab beside Titles and Updates, reachable from the Library, and
// gone from More. Browser emulation at 440x956; synthetic store only.
//
//   NAV_PORT=5217 PLAYWRIGHT_MODULE=... node tests/manual/library-downloads-tab-browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const PORT = process.env.NAV_PORT ?? "5217";
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const evidence = [];

const tabs = () => page.locator(".library-tabs button").allInnerTexts();

try {
  await page.goto(`${BASE}/tests/manual/nav-customise.html`);
  await page.waitForSelector(".library-tabs button");

  // 1. Three sections, in the stored order (the fixture stores updates first).
  const labels = await tabs();
  if (labels.join(",") !== "Updates,Titles,Downloads") throw new Error(`unexpected sections: ${labels.join(",")}`);
  evidence.push({ check: "the Library has a Downloads section", labels });

  // 2. Tapping it opens the Downloads section inside the Library: no second "Downloads" heading.
  await page.getByRole("button", { name: "Downloads", exact: true }).click();
  await page.waitForFunction(() => location.hash.includes("downloads"));
  await page.waitForTimeout(250);
  const headings = await page.locator("h1").allInnerTexts();
  if (headings.filter((text) => text.trim() === "Downloads").length > 1) throw new Error("the Downloads page title is drawn twice");
  const current = await page.locator('.library-tabs [aria-current="page"]').innerText();
  if (current !== "Downloads") throw new Error(`the tab does not read as current: ${current}`);
  const tabBar = await page.locator(".library-tabs").isVisible();
  if (!tabBar) throw new Error("the section tabs disappear on the Downloads section");
  evidence.push({ check: "the section opens under the same tabs, with one heading", headings, current });

  // 3. The page itself is still the downloads screen, not an empty library.
  const body = (await page.locator(".view").first().innerText()).toLowerCase();
  if (!/download|queue|paste|chapter/.test(body)) throw new Error("the downloads screen did not render");
  evidence.push({ check: "the downloads screen renders inside it", sample: body.slice(0, 120) });

  // 4. More no longer offers a Downloads row.
  await page.goto(`${BASE}/tests/manual/nav-customise.html#/more`);
  await page.waitForSelector(".row");
  const moreRows = await page.locator(".row .t").allInnerTexts();
  if (moreRows.some((text) => text.trim() === "Downloads")) throw new Error("Downloads is still in More");
  evidence.push({ check: "More no longer lists Downloads", moreRows });

  console.log(JSON.stringify({ pass: true, evidence, errors }, null, 2));
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ pass: false, evidence, errors, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
