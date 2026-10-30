import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chromeAttributes,
  contentGap,
  contentPadding,
  paneMode,
  paneRatio,
  spaceSavers,
  squeezed,
} from "../../src/lib/view-options.ts";

test("margins shrink the padding, and none means the edge", () => {
  assert.deepEqual(contentPadding("comfortable"), { x: 16, y: 16 });
  assert.deepEqual(contentPadding("compact"), { x: 10, y: 12 });
  assert.deepEqual(contentPadding("none"), { x: 4, y: 8 });
  assert.ok(contentGap("none") < contentGap("compact"));
});

test("two panes are a preference, but a narrow window gets one", () => {
  assert.equal(paneMode("split", 1200), "split");
  assert.equal(paneMode("split", 700), "single");
  assert.equal(paneMode("single", 1600), "single");
  assert.equal(paneMode("auto", 1600), "split");
  assert.equal(paneMode("auto", 900), "single");
});

test("a squeezed split says so instead of drawing a 40px list", () => {
  assert.equal(squeezed("split", 700), true);
  assert.equal(squeezed("split", 1200), false);
  assert.equal(squeezed("auto", 700), false);
});

test("the pane ratio keeps both sides usable", () => {
  assert.equal(paneRatio(0.5, 1200), 0.5);
  assert.ok(paneRatio(0.05, 1200) >= 0.35);
  assert.ok(paneRatio(0.95, 1200) <= 0.7);
  assert.equal(paneRatio(Number.NaN, 1200), 0.5);
});

test("maximize space hides comfort only, never navigation", () => {
  assert.deepEqual(spaceSavers(true), { hideHeading: true, hideContinue: true, padY: 6 });
  assert.equal(spaceSavers(false).hideHeading, false);
});

test("one call produces the attributes the stylesheet keys off", () => {
  assert.deepEqual(chromeAttributes({ margins: "none", maximize: true, density: "compact" }), {
    "data-margins": "none",
    "data-space": "max",
    "data-density": "compact",
  });
});
