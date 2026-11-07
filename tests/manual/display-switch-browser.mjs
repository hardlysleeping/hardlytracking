// Card must not be a one-way door: every layout can be switched to from every other, repeatedly.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/manual/display-switch-browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:5217";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const evidence = [];

const setClass = () => page.locator(".set").getAttribute("class");
const chip = (name) => page.getByRole("button", { name, exact: true });

try {
  await page.goto(`${BASE}/tests/manual/display-switch.html`);
  await page.waitForSelector(".set .tile");

  // Every pair of layouts, in both directions, more than once.
  const order = ["Row", "Grid", "Card", "Row", "Card", "Grid", "Card", "Row", "Grid", "Card", "Grid"];
  for (const name of order) {
    await chip(name).click();
    await page.waitForTimeout(120);
    const cls = (await setClass()) ?? "";
    const expected = name.toLowerCase();
    if (!cls.includes(expected)) throw new Error(`tapping ${name} left the grid as "${cls}"`);
    if (await chip(name).getAttribute("aria-pressed") !== "true") throw new Error(`${name} chip does not read pressed`);
  }
  evidence.push({ check: "every layout switches from every other, repeatedly", order });

  // Back to the start: a fresh load remembers the choice rather than resetting it.
  await chip("Grid").click();
  await page.reload();
  await page.waitForSelector(".set .tile");
  const afterReload = (await setClass()) ?? "";
  if (!afterReload.includes("grid")) throw new Error(`a reload lost the layout: "${afterReload}"`);
  evidence.push({ check: "the choice survives a reload", afterReload });

  const height = await page.locator(".set .tile").first().evaluate((el) => Math.round(el.getBoundingClientRect().height));
  evidence.push({ check: "first tile height at 440x956", height });
  console.log(JSON.stringify({ pass: true, evidence, errors }, null, 2));
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ pass: false, evidence, errors, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
