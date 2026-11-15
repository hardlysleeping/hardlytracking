/**
 * The reader's four fits, its page size, and the place a screen was left.
 *
 * Measured on a 390x844 viewport with generated 800x1600 pages:
 *
 *   - whole page (`contain`) put the first page at top = -75 px, because the scroller centred
 *     content that was taller than itself: the top of page one was clipped and scrolled out of
 *     reach. It is `safe center` now, which centres only what fits.
 *   - height fit stacked full-height pages without snapping, so every swipe landed part-way into a
 *     page and "Height" behaved like "Width with taller pages".
 *   - page size stopped at 100 %, which is the fit — so a phone could never zoom *in*: the slider
 *     had no room above the fit and pinch-zooms the whole app instead of the page.
 *
 * The CSS is asserted from source because these are layout declarations with no pure function to
 * call; the numbers above are the measurement that justified each one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SCALE_DEFAULT,
  SCALE_MAX,
  SCALE_MIN,
  SCALE_MAX_PERCENT,
  scaleOf,
} from "../../src/lib/reader-scale.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const reader = readFileSync(join(root, "src/views/Reader.svelte"), "utf8");

/** The selector's own declaration block, whitespace-collapsed. */
function block(selector) {
  const at = reader.indexOf(selector + " {");
  assert.notEqual(at, -1, `${selector} is missing`);
  return reader.slice(at + selector.length, reader.indexOf("}", at)).replace(/\s+/g, " ").trim();
}

test("whole page centres what fits and never clips the start of a long chapter", () => {
  assert.match(block(".scroller[data-fit='contain']"), /justify-content: safe center/);
});

test("height fit snaps one page at a time, and only when pages stack vertically", () => {
  // `.scroller[data-fit='height'] .page` is declared twice (size, then snapping), so this reads the
  // declarations from the whole file rather than the first block.
  const fits = reader.replace(/\s+/g, " ");
  assert.match(fits, /\.scroller\[data-fit='height'\]:not\(\.horizontal\) \{ scroll-snap-type: y mandatory; \}/);
  assert.match(fits, /\.scroller\[data-fit='height'\] \.page \{ scroll-snap-align: start; \}/);
});

test("page size goes past the fit, so a phone can zoom in", () => {
  assert.ok(SCALE_MAX > SCALE_DEFAULT, `the fit is ${SCALE_DEFAULT}; ${SCALE_MAX} is no zoom at all`);
  assert.equal(SCALE_MAX_PERCENT, SCALE_MAX * 100);
  assert.equal(scaleOf(SCALE_MAX), SCALE_MAX);
  // Still clamped: an exported pref cannot blow a page past the range.
  assert.equal(scaleOf(SCALE_MAX + 5), SCALE_MAX);
  assert.equal(scaleOf(SCALE_MIN - 5), SCALE_MIN);
  assert.equal(scaleOf("2"), SCALE_DEFAULT);
});
