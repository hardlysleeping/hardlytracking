/**
 * Dragging a seam: the arithmetic, at the edges.
 *
 * Three pointer handlers in `Library.svelte` used to carry their own copy of this clamp, which is
 * why the edges are where the bugs were — the middle of a drag is easy, and where a pane is pinned
 * against its floor is where a wrong number squeezes a column to nothing. These tests are all edges,
 * and one of them is the edge that does not exist: a box that cannot be measured must answer the
 * ratio the seam already had, never `NaN`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { seriesShareAt, shelfShareAt, splitRatioAt } from "../../src/lib/pane-drag.ts";
import {
  DEFAULT_SERIES_SHARE,
  DEFAULT_SHELF_SHARE3,
  DEFAULT_SPLIT_RATIO,
  MIN_DETAIL_WIDTH,
  MIN_SHELF_WIDTH,
  libraryLayout,
} from "../../src/lib/layout-modes.ts";

const BOX = { left: 100, width: 1000 };

/* ---- two panes ---- */

test("the shelf seam follows the pointer through the middle", () => {
  const ratio = splitRatioAt(600, { box: BOX, minGrid: 200, minDetail: 340, fallback: 0.58 });
  assert.equal(ratio, 0.5);
});

test("a pointer at or past the shelf's floor cannot ask for less than the floor", () => {
  for (const clientX of [100, 0, -500]) {
    const ratio = splitRatioAt(clientX, { box: BOX, minGrid: 200, minDetail: 340, fallback: 0.58 });
    assert.equal(ratio, 0.2, `clientX ${clientX} produced ${ratio}`);
  }
});

test("a pointer at or past the detail's floor cannot squeeze the detail", () => {
  for (const clientX of [1100, 2000]) {
    const ratio = splitRatioAt(clientX, { box: BOX, minGrid: 200, minDetail: 340, fallback: 0.58 });
    assert.equal(ratio, 0.66, `clientX ${clientX} produced ${ratio}`);
  }
});

test("a box too narrow for both floors keeps the shelf's floor rather than going negative", () => {
  // 400 px cannot hold a 200 px shelf and a 340 px detail. The floor still wins, and no width is NaN.
  const ratio = splitRatioAt(300, { box: { left: 0, width: 400 }, minGrid: 200, minDetail: 340, fallback: 0.58 });
  assert.equal(ratio, 0.5);
  const layout = libraryLayout(500, 900, { splitRatio: ratio, pane: "split" });
  assert.ok(Number.isFinite(layout.gridWidth) && Number.isFinite(layout.detailWidth));
});

test("an unmeasurable box answers the ratio the seam already had", () => {
  assert.equal(splitRatioAt(600, { box: { left: 0, width: 0 }, minGrid: 200, minDetail: 340, fallback: 0.42 }), 0.42);
  assert.equal(splitRatioAt(Number.NaN, { box: BOX, minGrid: 200, minDetail: 340, fallback: 0.42 }), 0.42, "a NaN pointer produced NaN");
  assert.equal(shelfShareAt(Number.NaN, { box: BOX, minGrid: 200, slack: 200, fallback: 0.31 }), 0.31);
  assert.equal(
    seriesShareAt(Number.NaN, { box: BOX, gridWidth: 600, minGrid: 600, minDetail: 340, slack: 200, fallback: 0.4 }),
    0.4,
  );
});

/* ---- three panes ---- */

test("the shelf's three-pane seam divides the slack, not the window", () => {
  const options = { box: { left: 0, width: 1440 }, minGrid: 200, slack: 200, fallback: 0.58 };
  assert.equal(shelfShareAt(200, options), 0, "the seam at the shelf's floor is share zero");
  assert.equal(shelfShareAt(400, options), 1, "a full slack further right is share one");
  assert.equal(shelfShareAt(300, options), 0.5);
});

test("a three-pane seam cannot leave the slack it was given", () => {
  const options = { box: { left: 0, width: 1440 }, minGrid: 200, slack: 200, fallback: 0.58 };
  assert.equal(shelfShareAt(-1000, options), 0);
  assert.equal(shelfShareAt(99999, options), 1);
});

test("with no slack to divide, a three-pane seam keeps its share", () => {
  assert.equal(shelfShareAt(500, { box: { left: 0, width: 1440 }, minGrid: 200, slack: 0, fallback: 0.31 }), 0.31);
  assert.equal(shelfShareAt(500, { box: { left: 0, width: 0 }, minGrid: 200, slack: 200, fallback: 0.31 }), 0.31);
});

test("the series seam is measured from the shelf's edge and the series' floor", () => {
  const options = {
    box: { left: 0, width: 1440 },
    gridWidth: 600,
    minGrid: 600,
    minDetail: 340,
    slack: 200,
    fallback: 0.4,
  };
  assert.equal(seriesShareAt(940, options), 0, "the seam at the series' floor is share zero");
  assert.equal(seriesShareAt(1140, options), 1);
  assert.equal(seriesShareAt(700, options), 0, "a pointer over the shelf cannot pull the reader left");
  assert.equal(seriesShareAt(1400, options), 1);
});

/* ---- and the numbers a drag produces are the numbers the layout receives ---- */

test("a dragged ratio always lands on a layout that keeps every floor", () => {
  for (const width of [1000, 1280, 1440, 1920, 2560]) {
    for (const ratio of [0, 0.1, 0.58, 0.9, 1]) {
      const layout = libraryLayout(width, 900, { splitRatio: ratio, pane: "split", collectionCount: 6 });
      assert.equal(layout.mode, "split", `${width}@${ratio} lost its split`);
      assert.ok(layout.gridWidth >= MIN_SHELF_WIDTH, `${width}@${ratio}: shelf ${layout.gridWidth}`);
      assert.ok(layout.detailWidth >= MIN_DETAIL_WIDTH, `${width}@${ratio}: detail ${layout.detailWidth}`);
      const space = layout.gridWidth + layout.detailWidth + layout.thirdWidth;
      const usable = width - 76 - 32;
      assert.equal(space, usable - layout.sidebarWidth, `${width}@${ratio}: the columns do not fill the room`);
    }
  }
});

test("the defaults a double-click restores are the ones the layout ships with", () => {
  assert.equal(DEFAULT_SPLIT_RATIO, 0.58);
  assert.equal(DEFAULT_SHELF_SHARE3, 0.58);
  assert.equal(DEFAULT_SERIES_SHARE, 0.4);
  // And the layout's own answer with no memory is those numbers.
  assert.equal(libraryLayout(1440, 900, { pane: "split" }).splitRatio, DEFAULT_SPLIT_RATIO);
});