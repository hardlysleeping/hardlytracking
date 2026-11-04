// Live check of the expanded search card's frosted-cover backdrop.
// Run against an isolated Vite server:
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs BASE=http://127.0.0.1:5219 node tests/manual/search-glass.mjs
//
// The fixture is memory-only: no database, no network source, no library rows of the user's.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.BASE || "http://127.0.0.1:5219";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, hasTouch: true, isMobile: true });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const cases = [];

const read = () =>
  page.evaluate(() => {
    const card = document.querySelector(".detail");
    if (!card) return { card: false };
    const glass = card.querySelector(".dblur");
    const hero = card.querySelector(".dcover img");
    const style = glass && getComputedStyle(glass);
    // The picture and the blur live on the clipping layer's ::before, so the box itself stays clear.
    const frosting = glass && getComputedStyle(glass, "::before");
    const buttons = [...card.querySelectorAll(".dact .btn")].map((b) => b.getBoundingClientRect());
    let overlap = false;
    for (let i = 0; i < buttons.length; i += 1) {
      for (let j = i + 1; j < buttons.length; j += 1) {
        const a = buttons[i];
        const b = buttons[j];
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) {
          overlap = true;
        }
      }
    }
    return {
      card: true,
      title: card.querySelector("h3").textContent,
      glass: glass !== null,
      display: style && style.display,
      filter: frosting && frosting.filter,
      opacity: frosting && frosting.opacity,
      pointer: style && style.pointerEvents,
      inset: frosting && frosting.inset,
      z: glass && getComputedStyle(card.querySelector(".dscroll")).zIndex,
      aria: glass && glass.getAttribute("aria-hidden"),
      samePicture:
        Boolean(hero) &&
        Boolean(glass) &&
        glass.style.getPropertyValue("--glass").includes(hero.src.slice(-48)),
      docOverflow: document.documentElement.scrollWidth - innerWidth,
      cardOverflow: card.scrollWidth - card.clientWidth,
      buttons: buttons.length,
      overlap,
      scrollY,
    };
  });

async function mount(width, height) {
  await page.setViewportSize({ width, height });
  await page.goto(`${base}/tests/manual/browse-display.html?screen=Search`);
  await page.waitForFunction(() => typeof window.qa === "object");
  await page.evaluate(() => window.qa.screen("Search"));
  await page.waitForFunction(() => document.querySelectorAll(".tile").length > 0);
}

try {
  // Tap → card, at the owner's primary geometry.
  await mount(440, 956);
  const before = await page.evaluate(() => scrollY);
  await page.evaluate(() => document.querySelectorAll(".tile")[0].click());
  await page.waitForSelector(".detail");
  await page.waitForSelector(".dblur");
  const opened = await read();
  assert.equal(opened.card, true);
  assert.equal(opened.glass, true, "the opened card must carry its cover");
  assert.match(opened.filter, /blur\(34px\)/);
  assert.equal(opened.pointer, "none", "the backdrop must not swallow taps");
  assert.equal(opened.aria, "true", "the backdrop is decorative");
  assert.equal(opened.inset, "-40px", "the blurred layer must overhang its clipping box");
  assert.equal(opened.z, "1", "the text must stack above the backdrop");
  assert.equal(opened.samePicture, true, "the backdrop must be the picture the tile resolved");
  assert.equal(opened.scrollY, before, "opening a card must not scroll the page");
  assert.equal(opened.docOverflow, 0);
  cases.push({ at: "440x956", ...opened });

  // Closing removes it, and it never outlives its title.
  await page.evaluate(() => document.querySelector(".detail .dclose").click());
  await page.waitForFunction(() => document.querySelector(".detail") === null);
  assert.equal(await page.evaluate(() => document.querySelector(".dblur") !== null), false);
  await page.evaluate(() => document.querySelectorAll(".tile")[5].click());
  await page.waitForSelector(".dblur");
  const reopened = await read();
  assert.equal(reopened.glass, true);
  assert.notEqual(reopened.title, opened.title, "a different title was opened");
  cases.push({ at: "440x956 reopen", ...reopened });

  // Reduced transparency drops the effect entirely rather than leaving a half-tinted card.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
  });
  await page.waitForFunction(() => {
    const glass = document.querySelector(".dblur");
    return glass !== null && getComputedStyle(glass).display === "none";
  });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".dblur")).display), "none");
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  await cdp.detach();

  // Geometry: no document or card overflow, no overlapping action buttons.
  for (const [width, height] of [[320, 568], [390, 844], [440, 956], [844, 390], [1024, 768], [1440, 900]]) {
    await mount(width, height);
    await page.evaluate(() => document.querySelectorAll(".tile")[0].click());
    await page.waitForSelector(".dblur");
    const measured = await read();
    assert.equal(measured.docOverflow, 0, `${width}: page must not scroll sideways`);
    assert.ok(measured.cardOverflow <= 0, `${width}: card must not overflow`);
    assert.equal(measured.overlap, false, `${width}: action buttons must not overlap`);
    assert.ok(measured.buttons >= 3, `${width}: actions must be present`);
    assert.equal(measured.glass, true, `${width}: backdrop present`);
    cases.push({ at: `${width}x${height}`, ...measured });
  }
} finally {
  await browser.close();
  console.log(JSON.stringify({ cases, errors }, null, 2));
  assert.deepEqual(errors, []);
}
