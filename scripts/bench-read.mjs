/**
 * Read the shelf bench out of a real browser (the number half of TEST-04, `#30`).
 *
 *   BASE=http://localhost:5299 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/bench-read.mjs
 *
 * `perf/bench.html` prints its numbers into the page and `document.title`; this asks the same page
 * for `window.__bench` and prints **one JSON line**, so the acceptance gate has the frame array
 * (and therefore the worst frame) rather than a p95 it would have to guess at.
 *
 * Nothing here is app state: the page generates its own titles. The only input is `BENCH_ROWS`.
 */
const modulePath = process.env.PLAYWRIGHT_MODULE ?? "playwright";
const { chromium } = await import(modulePath);
const BASE = (process.env.BASE ?? "http://localhost:5299").replace(/\/$/, "");
const rows = process.env.BENCH_ROWS ?? "5000";
const timeout = Number(process.env.BENCH_TIMEOUT_MS ?? 120_000);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${BASE}/perf/bench.html?rows=${encodeURIComponent(rows)}`, { waitUntil: "load" });
  // The title is written in the same callback that fills `window.__bench`, so one wait covers both.
  await page.waitForFunction(() => document.title.includes("scroll"), null, { timeout });
  const numbers = await page.evaluate(() => globalThis.__bench ?? null);

  if (numbers === null || numbers === undefined) {
    throw new Error(`the bench finished without exposing its measurement${errors.length > 0 ? `: ${errors.join("; ")}` : ""}`);
  }
  if (errors.length > 0) {
    throw new Error(`the bench page raised: ${errors.join("; ")}`);
  }
  process.stdout.write(`${JSON.stringify(numbers)}\n`);
} finally {
  await browser.close();
}