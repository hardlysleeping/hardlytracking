// The navigation editor's live preview: the bar picture must follow the pref, follow the arrows, and
// move rather than jump. Synthetic memory DB only, never a real library.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/manual/nav-preview-browser.mjs
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const PORT = process.env.NAV_PORT ?? "5217";
const HOST = process.env.NAV_HOST ?? "localhost";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const evidence = [];

const previewLabels = () =>
  page.locator('[data-preview="true"] button').evaluateAll((ns) => ns.map((n) => n.getAttribute("aria-label")));
const barLabels = () => page.locator("nav.bar:not([data-preview]) button").evaluateAll((ns) => ns.map((n) => n.getAttribute("aria-label")));
const pref = () => page.evaluate(() => [...window.navFixture.settings.bottomNav]);

try {
  await page.goto(`http://${HOST}:${PORT}/tests/manual/nav-customise.html`);
  await page.waitForFunction(() => window.navFixture);
  await page.evaluate(() => {
    location.hash = "#settings";
  });
  await page.waitForSelector(".navedit");
  await page.waitForTimeout(500);

  // 1. The picture is the pref, and it is the same list the real bar draws.
  assert.deepEqual(await pref(), ["more", "history", "search", "browse", "library"]);
  assert.deepEqual(await previewLabels(), ["Settings", "History", "Search", "Browse", "Library"], "preview is not the pref order");
  assert.deepEqual(await previewLabels(), await barLabels(), "preview and the real bar disagree");

  // 2. The preview is a picture, not a second set of controls.
  assert.equal(await page.locator('[data-preview="true"]').first().getAttribute("inert"), "", "the preview is not inert");
  assert.equal(await page.locator('[data-preview="true"] button').first().evaluate((el) => el.tabIndex), -1);
  evidence.push({ check: "preview mirrors the pref and the real bar, and cannot be operated" });

  // 3. An arrow moves the picture, and it moves *through* the space rather than teleporting: the
  //    flip animation is what makes a reorder read as a change of layout instead of a redraw.
  const motion = await page.evaluate(async () => {
    const items = () => [...document.querySelectorAll('[data-preview="true"] button')];
    const byLabel = (label) => items().find((el) => el.getAttribute("aria-label") === label);
    const startX = byLabel("Settings").getBoundingClientRect().x;
    const targetX = byLabel("History").getBoundingClientRect().x;
    [...document.querySelectorAll(".navedit button")].find((el) => el.getAttribute("aria-label") === "Move Settings down").click();
    const samples = [];
    const until = performance.now() + 400;
    await new Promise((done) => {
      const tick = () => {
        const node = byLabel("Settings");
        if (node) samples.push(node.getBoundingClientRect().x);
        if (performance.now() < until) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    return { startX, targetX, samples };
  });
  const final = await page.locator('[data-preview="true"] button').evaluateAll((ns) => ns.map((n) => n.getAttribute("aria-label")));
  assert.deepEqual(final, ["History", "Settings", "Search", "Browse", "Library"], "the preview did not follow the arrow");
  assert.deepEqual(await pref(), ["history", "more", "search", "browse", "library"], "the pref was not written");
  assert.deepEqual(await barLabels(), final, "the real bar did not follow the arrow");
  const low = Math.min(motion.startX, motion.targetX) + 1;
  const high = Math.max(motion.startX, motion.targetX) - 1;
  const inFlight = motion.samples.some((x) => x > low && x < high);
  assert.ok(inFlight, `the preview jumped instead of animating: ${JSON.stringify(motion.samples.slice(0, 12))}`);
  evidence.push({ check: "the moved button is drawn in flight, not teleported", ...motion, frames: motion.samples.length });

  // 4. Taking a page off the bar takes it out of the picture too.
  await page.getByRole("button", { name: "Hide Browse in the navigation" }).click();
  await page.waitForTimeout(350);
  assert.deepEqual(await previewLabels(), ["History", "Settings", "Search", "Library"], "a hidden page is still drawn in the preview");
  assert.deepEqual(await barLabels(), ["History", "Settings", "Search", "Library"]);
  evidence.push({ check: "a page taken off the bar leaves the preview with it" });

  // 5. And putting it back lands it at the end, where the preview shows it.
  await page.getByRole("button", { name: "Show Browse in the navigation" }).click();
  await page.waitForTimeout(350);
  assert.deepEqual(await previewLabels(), ["History", "Settings", "Search", "Library", "Browse"]);
  evidence.push({ check: "a page put back appears where the preview shows it", preview: await previewLabels() });

  const overflow = await page.evaluate(() =>
    document.querySelector(".pvscreen").scrollWidth > document.querySelector(".pvscreen").clientWidth + 1,
  );
  assert.equal(overflow, false, "the preview overflows its frame sideways");
  evidence.push({ check: "the preview stays inside its frame with five items" });

  if (errors.length > 0) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log(JSON.stringify({ ok: true, evidence }, null, 2));
} finally {
  await browser.close();
}
