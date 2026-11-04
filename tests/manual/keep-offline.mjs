// Live check of the keep-offline panel at phone widths: off by default, categories persist, the
// button answers, and nothing overflows.
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs BASE=http://127.0.0.1:5225 node tests/manual/keep-offline.mjs
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.BASE || "http://127.0.0.1:5225";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, hasTouch: true, isMobile: true });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const cases = [];

async function open(width, height) {
  await page.setViewportSize({ width, height });
  await page.goto(`${base}/tests/manual/keep-offline.html`);
  await page.waitForFunction(() => document.querySelectorAll("button.chip").length >= 2);
}

try {
  await open(440, 956);

  // Off by default, and the sentence says so.
  const start = await page.evaluate(() => ({
    checked: document.querySelector('input[type="checkbox"]').checked,
    hint: [...document.querySelectorAll("p.hint")].map((p) => p.textContent.trim()),
    chips: [...document.querySelectorAll("button.chip")].map((b) => ({ label: b.textContent.trim(), pressed: b.getAttribute("aria-pressed") })),
  }));
  assert.equal(start.checked, false, "keeping new titles must be off by default");
  assert.ok(start.hint.some((line) => line.includes("Nothing is downloaded unless you ask")));
  assert.deepEqual(start.chips.map((chip) => chip.pressed), ["false", "false"]);
  cases.push({ at: "440x956", start });

  // Toggling a category is remembered, and the sentence changes with it.
  await page.evaluate(() => [...document.querySelectorAll("button.chip")].find((b) => b.textContent.includes("Fixture category A")).click());
  await page.waitForTimeout(200);
  const afterChip = await page.evaluate(() => ({
    pressed: [...document.querySelectorAll("button.chip")].map((b) => b.getAttribute("aria-pressed")),
    stored: window.keep.written.map((row) => [row.key, row.value]),
    hint: [...document.querySelectorAll("p.hint")].map((p) => p.textContent.trim()).join(" | "),
  }));
  assert.deepEqual(afterChip.pressed, ["true", "false"]);
  assert.ok(afterChip.stored.some(([key, value]) => key === "settings.keepCategories" && Array.isArray(value) && value.includes("fixture-a")));
  assert.match(afterChip.hint, /1 category is kept/);
  cases.push({ at: "440x956", afterChip });

  // The fetch button answers with what happened.
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Fetch the selected categories/.test(b.textContent)).click());
  await page.waitForTimeout(300);
  const fetched = await page.evaluate(() => ({
    calls: window.keep.calls(),
    note: [...document.querySelectorAll("p.hint")].map((p) => p.textContent.trim()).join(" | "),
  }));
  assert.equal(fetched.calls, 1);
  assert.match(fetched.note, /Queued 3 issues from 1 title/);
  cases.push({ at: "440x956", fetched });

  // Toggling the switch on is stored too.
  await page.evaluate(() => document.querySelector('input[type="checkbox"]').click());
  await page.waitForTimeout(200);
  const switchStored = await page.evaluate(() => window.keep.written.filter((row) => row.key === "settings.keepOnAdd").map((row) => row.value));
  assert.deepEqual(switchStored, [true]);
  cases.push({ switchStored });

  // No sideways scroll anywhere a thumb can reach.
  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1024, 768]]) {
    await open(width, height);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.equal(overflow, 0, `${width}: the panel must not scroll sideways`);
    const tooSmall = await page.evaluate(() =>
      [...document.querySelectorAll("button.chip")].some((b) => b.getBoundingClientRect().height < 32),
    );
    assert.equal(tooSmall, false, `${width}: chips must stay tappable`);
    cases.push({ at: `${width}x${height}`, overflow });
  }
} finally {
  await browser.close();
  console.log(JSON.stringify({ cases, errors }, null, 2));
  assert.deepEqual(errors, []);
}
