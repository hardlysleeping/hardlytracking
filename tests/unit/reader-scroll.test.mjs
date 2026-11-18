/**
 * Following a scroll without measuring the chapter.
 *
 * The reader used to find "the page I am on" by walking every `[data-page]` node on every scroll
 * event and forcing a layout for each — a 214-page webtoon laid out 214 boxes per event. Two rules
 * replace it, tested here: the observer's report is a set membership question, and the current page
 * is chosen from the boxes that are actually on screen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { currentPage, remember } from "../../src/lib/reader-scroll.ts";

const reader = readFileSync(new URL("../../src/views/Reader.svelte", import.meta.url), "utf8");

test("boxes entering and leaving the viewport update the same set", () => {
  const seen = new Set();
  remember(seen, [
    { index: 4, visible: true },
    { index: 5, visible: true },
  ]);
  assert.deepEqual([...seen].sort(), [4, 5]);
  remember(seen, [
    { index: 4, visible: false },
    { index: 6, visible: true },
  ]);
  assert.deepEqual([...seen].sort(), [5, 6]);
});

test("a box reported twice is a set member, not a duplicate", () => {
  const seen = new Set();
  for (let index = 0; index < 5; index += 1) remember(seen, [{ index: 2, visible: true }]);
  assert.deepEqual([...seen], [2]);
});

test("the nearest leading edge is the page being read", () => {
  assert.equal(
    currentPage([
      { index: 11, distance: 40 },
      { index: 12, distance: 3 },
      { index: 13, distance: 220 },
    ], 11),
    12,
  );
});

test("with nothing measured, the reader stays where it is instead of snapping to page one", () => {
  assert.equal(currentPage([], 37), 37);
  assert.equal(currentPage([{ index: 3, distance: Number.NaN }], 9), 9);
});

test("the scroll handler measures only the boxes the observer reports", () => {
  const onScroll = /function onScroll\(\)[\s\S]*?\n  \}/.exec(reader)?.[0] ?? "";
  assert.ok(onScroll.length > 0, "onScroll is gone");
  assert.doesNotMatch(onScroll, /querySelectorAll/, "the scroll handler still walks every page");
  assert.doesNotMatch(onScroll, /getBoundingClientRect/, "the scroll handler still measures on the event");

  const measure = /function measureCurrent\(\)[\s\S]*?\n  \}/.exec(reader)?.[0] ?? "";
  assert.match(measure, /for \(const pageIndex of seen\)/, "the measurement does not iterate the visible set");
  assert.doesNotMatch(measure, /querySelectorAll/, "the measurement still scans the chapter");
  assert.match(reader, /use:trackPage/, "page boxes are not registered with the observer");
  assert.match(reader, /root: host/, "the observer is not rooted at the scroller");
});