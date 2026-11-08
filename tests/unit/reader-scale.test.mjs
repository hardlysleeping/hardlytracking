/**
 * Page scale: the fit is 1, below it the page shrinks and centres, and the choice is the title's.
 *
 * The failures this prevents are all "the reader's page size did nothing": a hand-edited export or
 * a value from a wider range shrinking a page to a stamp, the map keeping an entry that means
 * "unchanged" so a reset never looks like one, and the reader drawing a scale from a series id the
 * route named wrongly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SCALE_DEFAULT,
  SCALE_MAX,
  SCALE_MIN,
  scaleFor,
  scaleMapOf,
  scaleOf,
  scalePercent,
  withScale,
} from "../../src/lib/reader-scale.ts";

const view = readFileSync(new URL("../../src/views/Reader.svelte", import.meta.url), "utf8");

test("a stored scale is clamped, and nonsense is the fit", () => {
  assert.equal(scaleOf(0.75), 0.75);
  assert.equal(scaleOf(1), 1);
  assert.equal(scaleOf(0.2), SCALE_MIN);
  assert.equal(scaleOf(4), SCALE_MAX);
  for (const bad of [undefined, null, "0.5", NaN, Infinity, {}, []]) {
    assert.equal(scaleOf(bad), SCALE_DEFAULT, `${String(bad)} is the fit`);
  }
});

test("a scale is a title's: absent is the fit, and another title is untouched", () => {
  const map = withScale({}, "mihon:1", 0.8);
  assert.deepEqual(map, { "mihon:1": 0.8 });
  assert.equal(scaleFor(map, "mihon:1"), 0.8);
  assert.equal(scaleFor(map, "mihon:2"), SCALE_DEFAULT);
  assert.equal(scaleFor(undefined, "mihon:1"), SCALE_DEFAULT);
  // A new map, so a stored one is never mutated under a live pref.
  assert.deepEqual(withScale(map, "mihon:2", 0.6), { "mihon:1": 0.8, "mihon:2": 0.6 });
  assert.deepEqual(map, { "mihon:1": 0.8 });
});

test("back to the fit leaves no entry behind", () => {
  const map = withScale({ "mihon:1": 0.8 }, "mihon:1", 1);
  assert.deepEqual(map, {});
  // Rounded to the slider's own steps, so 0.999 is still the fit.
  assert.deepEqual(withScale({}, "mihon:1", 0.999), {});
  assert.deepEqual(withScale({}, "", 0.7), {});
});

test("a foreign or corrupt map loads as the fit, entry by entry", () => {
  assert.deepEqual(scaleMapOf(null), {});
  assert.deepEqual(scaleMapOf("nope"), {});
  assert.deepEqual(scaleMapOf([0.5]), {});
  assert.deepEqual(scaleMapOf({ "mihon:1": 0.7, "mihon:2": 1, "mihon:3": "x", "": 0.5 }), { "mihon:1": 0.7 });
  assert.deepEqual(scaleMapOf({ "mihon:4": 0.01 }), { "mihon:4": SCALE_MIN });
});

test("the label reads the slider's steps", () => {
  assert.equal(scalePercent(0.5), 50);
  assert.equal(scalePercent(1), 100);
  assert.equal(scalePercent(0.734), 73);
});

test("the view draws the scale, and it does not scale the fit away", () => {
  // The scroller carries the scale as one custom property; every fit multiplies it.
  assert.match(view, /style:--page-scale=\{pageScale\}/);
  assert.match(view, /class:scaled/);
  assert.match(view, /width: calc\(min\(var\(--reader-width\), 900px\) \* var\(--page-scale\)\)/);
  assert.match(view, /height: calc\(var\(--reader-height\) \* var\(--page-scale\)\)/);
  assert.match(view, /max-height: calc\(var\(--reader-height\) \* var\(--page-scale\)\)/);
  // Scaled pages centre in their slot, and only then: the fit's own look is untouched.
  assert.match(view, /\.scroller\.scaled \.page \{[^}]*align-items: center/);
});
