// Measure the vertical gaps in the library header stack on a phone. Synthetic fixture only.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/manual/library-spacing-browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:5217";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

await page.goto(`${BASE}/tests/manual/library-lock-fixture.html`);
await page.waitForFunction(() => window.lockFixture !== undefined);
await page.waitForSelector(".bandbox");
await page.waitForTimeout(300);

const gaps = await page.evaluate(() => {
  const rect = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
  };
  const header = rect(".top");
  const tabs = rect(".library-tabs");
  const band = rect(".bandbox");
  const firstItem = rect(".body");
  return { header, tabs, band, firstItem, viewport: window.innerHeight };
});

console.log(JSON.stringify({ gaps, errors }, null, 2));
await browser.close();
