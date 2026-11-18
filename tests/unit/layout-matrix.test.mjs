/**
 * The layout, width by width — the table a regression has to keep.
 *
 * `layout-modes.test.mjs` asks the resolver a question at a time. This file is the opposite: every
 * width the plan names, crossed with every pane preference, so a rule that only holds at 1440 is
 * caught at 1000 and on a 2560 monitor. The numbers are the plan's own (a 600–1000 rail, a desktop
 * split), and the floors are `#3`'s promise: no column under its minimum, and a preference that a
 * narrow window hides but never rewrites.
 *
 * Widths are the window; the resolver takes the shell's rail (76 px) and the page's padding (32 px)
 * out itself, which is why 1000 is where a split first fits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CATEGORY_SIDEBAR_AUTO_AT,
  DEFAULT_SERIES_SHARE,
  DEFAULT_SHELF_SHARE3,
  DEFAULT_SPLIT_RATIO,
  LIBRARY_SPLIT_MIN_WIDTH,
  MIN_DETAIL_WIDTH,
  MIN_GRID_WIDTH,
  MIN_READER_WIDTH,
  MIN_SHELF_WIDTH,
  MIN_SIDEBAR_WIDTH,
  libraryLayout,
} from "../../src/lib/layout-modes.ts";

const view = readFileSync(new URL("../../src/views/Library.svelte", import.meta.url), "utf8");

/** The widths the issue names, plus the two ends of a large monitor. */
const WIDTHS = [600, 800, 1000, 1280, 1440, 2560];
const PANES = ["auto", "single", "split", "three"];

/** The room the resolver divides, given the shell and the page padding it is told about. */
function usable(width) {
  return width - 76 - 32;
}

/* ---- the matrix ---- */

test("every width, every pane preference: a mode, floors, and no NaN", () => {
  for (const width of WIDTHS) {
    for (const pane of PANES) {
      const layout = libraryLayout(width, 900, { pane, collectionCount: 6 });
      assert.ok(["single", "split"].includes(layout.mode), `${width}/${pane}: ${layout.mode}`);
      assert.equal(layout.splitRatio > 0, layout.mode === "split", `${width}/${pane}: a single pane kept a ratio`);
      if (layout.mode === "single") {
        assert.equal(layout.detailWidth, 0, `${width}/${pane}: a single pane reported a detail`);
        assert.equal(layout.thirdWidth, 0, `${width}/${pane}: a single pane reported a reader`);
        assert.equal(layout.gridWidth, usable(width) - layout.sidebarWidth, `${width}/${pane}: the shelf does not fill the page`);
        continue;
      }
      assert.ok(layout.gridWidth >= MIN_SHELF_WIDTH, `${width}/${pane}: shelf ${layout.gridWidth}`);
      assert.ok(layout.detailWidth >= MIN_DETAIL_WIDTH, `${width}/${pane}: detail ${layout.detailWidth}`);
      assert.ok(Number.isFinite(layout.gridWidth) && Number.isFinite(layout.detailWidth), `${width}/${pane}: NaN width`);
      assert.equal(
        layout.gridWidth + layout.detailWidth + layout.thirdWidth + layout.sidebarWidth,
        usable(width),
        `${width}/${pane}: the columns do not add up to the room`,
      );
    }
  }
});

test("the named rows are exactly what the plan promised", () => {
  // 600 and 800 are phones on their side / small windows: one pane, the bar, no sidebar.
  for (const width of [600, 800]) {
    const layout = libraryLayout(width, 900, { pane: "split", collectionCount: 6 });
    assert.equal(layout.mode, "single", `${width}: a split appeared below the threshold`);
    assert.equal(layout.categoryNav.mode, "tabs", `${width}: a sidebar appeared`);
    assert.equal(layout.gridWidth, usable(width));
  }

  // 1000 is where the room after the rail (892) clears the 750 px split threshold — but only while
  // the category bar is the bar. A sidebar takes 200 of those px and the split goes away again.
  const thousand = libraryLayout(1000, 900, { pane: "auto", collectionCount: 6 });
  assert.equal(thousand.mode, "split");
  assert.equal(thousand.categoryNav.mode, "tabs", "six collections fit on the bar");
  assert.equal(thousand.gridWidth, 517);
  assert.equal(thousand.detailWidth, 375);
  const thousandSidebar = libraryLayout(1000, 900, { pane: "auto", nav: "sidebar" });
  assert.equal(thousandSidebar.mode, "single", "a 1000 px window can hold a sidebar or a split, not both");
  assert.equal(thousandSidebar.gridWidth, 692);

  // 1280 and 1440: the desktop shape, sidebar and split.
  const twelve = libraryLayout(1280, 900, { pane: "auto", collectionCount: 6 });
  assert.deepEqual([twelve.mode, twelve.categoryNav.mode, twelve.gridWidth, twelve.detailWidth], ["split", "sidebar", 564, 408]);
  const fourteen = libraryLayout(1440, 900, { pane: "auto", collectionCount: 6 });
  assert.deepEqual([fourteen.mode, fourteen.categoryNav.mode, fourteen.gridWidth, fourteen.detailWidth], ["split", "sidebar", 657, 475]);

  // An ultrawide is the same layout with more room in both columns, not a third shape.
  const ultra = libraryLayout(2560, 900, { pane: "auto", collectionCount: 6 });
  assert.equal(ultra.mode, "split");
  assert.equal(ultra.detailWidth, 946, "the detail stopped following the window");
  assert.equal(ultra.gridWidth + ultra.detailWidth + ultra.sidebarWidth, usable(2560));
});

test("the split lives above its threshold, not above the raw window width", () => {
  assert.equal(MIN_SHELF_WIDTH, 200);
  assert.equal(MIN_DETAIL_WIDTH, 340);
  // The threshold is on the room the resolver divides (the window minus the 76 px rail and the
  // 32 px page padding), so 750 px of room is an 858 px window.
  const below = libraryLayout(LIBRARY_SPLIT_MIN_WIDTH + 107, 900, { pane: "split" });
  const above = libraryLayout(LIBRARY_SPLIT_MIN_WIDTH + 108, 900, { pane: "split" });
  assert.equal(below.gridWidth, LIBRARY_SPLIT_MIN_WIDTH - 1, "a single pane does not fill its page");
  assert.equal(below.mode, "single");
  assert.equal(above.mode, "split");
  assert.equal(above.gridWidth + above.detailWidth, LIBRARY_SPLIT_MIN_WIDTH, "the room is not the window minus the chrome");
});

/* ---- categories: the bar, the overflow, the sidebar ---- */

test("the category bar never becomes a scroller, and the sidebar only appears with room to spare", () => {
  for (const width of WIDTHS) {
    const automatic = libraryLayout(width, 900, { collectionCount: 30, pinnedCount: 2 });
    if (automatic.categoryNav.mode !== "sidebar") {
      assert.ok(automatic.categoryNav.visible < 30, `${width}: 30 chips were all drawn`);
      assert.equal(
        automatic.categoryNav.visible + automatic.categoryNav.overflow,
        30,
        `${width}: the overflow control lost a collection`,
      );
    } else {
      assert.equal(automatic.sidebarWidth, MIN_SIDEBAR_WIDTH);
      assert.ok(automatic.gridWidth >= MIN_GRID_WIDTH || automatic.mode === "split", `${width}: the sidebar ate the grid`);
    }
  }
});

test("automatic waits for its threshold; a manual sidebar may come earlier, if it fits", () => {
  // The threshold is 1050 px of *room*: the window has to be 1050 + 76 + 32 before automatic
  // asks for a sidebar.
  const justBelow = libraryLayout(CATEGORY_SIDEBAR_AUTO_AT + 107, 900, { collectionCount: 6 });
  const atThreshold = libraryLayout(CATEGORY_SIDEBAR_AUTO_AT + 108, 900, { collectionCount: 6 });
  assert.equal(justBelow.categoryNav.mode, "tabs", "six collections fit on the bar");
  assert.equal(atThreshold.categoryNav.mode, "sidebar");

  // A manual sidebar is honoured below the automatic threshold…
  const manualEarly = libraryLayout(800, 900, { nav: "sidebar", collectionCount: 6 });
  assert.equal(manualEarly.categoryNav.mode, "sidebar");
  assert.ok(manualEarly.gridWidth >= MIN_GRID_WIDTH);
  // …but never when it would take the grid under its minimum.
  const manualTooNarrow = libraryLayout(600, 900, { nav: "sidebar", collectionCount: 30 });
  assert.equal(manualTooNarrow.categoryNav.mode, "overflow", "the sidebar was drawn without room for the grid");
  assert.equal(manualTooNarrow.sidebarWidth, 0);
});

test("choosing the bar at a desktop width gives the grid the whole row", () => {
  const desktop = libraryLayout(1440, 900, { nav: "tabs", pane: "single", collectionCount: 30 });
  assert.equal(desktop.categoryNav.mode, "overflow", "the bar is the bar, even when it overflows");
  assert.equal(desktop.sidebarWidth, 0);
  assert.equal(desktop.gridWidth, usable(1440), "the grid did not take the sidebar's room back");
});

/* ---- a preference is hidden by a resize, never rewritten ---- */

test("a resize collapse does not lose the pane preference or the ratio", () => {
  const wide = libraryLayout(1440, 900, { pane: "split", splitRatio: 0.65, collectionCount: 6 });
  assert.equal(wide.mode, "split");
  assert.equal(wide.splitRatio, 0.65);

  const narrow = libraryLayout(800, 900, { pane: "split", splitRatio: 0.65, collectionCount: 6 });
  assert.equal(narrow.mode, "single");
  assert.equal(narrow.splitRatio, 0, "the reported ratio is 0 while there is no split");

  // The same preference, the same stored ratio, and the split comes back where it was.
  const again = libraryLayout(1440, 900, { pane: "split", splitRatio: 0.65, collectionCount: 6 });
  assert.equal(again.mode, "split");
  assert.equal(again.splitRatio, 0.65);
  assert.deepEqual(
    [again.gridWidth, again.detailWidth],
    [wide.gridWidth, wide.detailWidth],
    "widening the window moved a pane the reader had placed",
  );
});

test("one pane stays one pane at every width, and a hidden split can never override it", () => {
  for (const width of WIDTHS) {
    for (const height of [400, 900]) {
      const layout = libraryLayout(width, height, { pane: "single", collectionCount: 6 });
      assert.equal(layout.mode, "single", `${width}x${height}: the one-pane preference was overridden`);
      assert.equal(layout.detailWidth, 0);
      assert.equal(layout.thirdWidth, 0);
    }
  }
});

/* ---- three panes ---- */

test("three panes are explicit only, and give way before a column goes under its floor", () => {
  // Automatic never invents a third column.
  for (const width of WIDTHS) {
    const automatic = libraryLayout(width, 900, { pane: "auto", collectionCount: 6 });
    assert.equal(automatic.thirdWidth, 0, `${width}: auto opened a reader`);
  }

  const narrow = libraryLayout(1000, 900, { pane: "three", collectionCount: 6 });
  assert.equal(narrow.thirdWidth, 0, "three panes fit in 1000 px");
  assert.equal(narrow.mode, "split", "the series pane left with the reader");

  const wide = libraryLayout(1440, 900, { pane: "three", collectionCount: 6 });
  assert.ok(wide.thirdWidth >= MIN_READER_WIDTH, `the reader got ${wide.thirdWidth}`);
  assert.ok(wide.gridWidth >= MIN_SHELF_WIDTH && wide.detailWidth >= MIN_DETAIL_WIDTH);
  assert.equal(wide.gridWidth + wide.detailWidth + wide.thirdWidth + wide.sidebarWidth, usable(1440));

  // The seams divide the slack above the three floors, so both handles have somewhere to go.
  const slack = usable(1440) - wide.sidebarWidth - MIN_SHELF_WIDTH - MIN_DETAIL_WIDTH - MIN_READER_WIDTH;
  assert.equal(wide.gridWidth, MIN_SHELF_WIDTH + Math.round(slack * DEFAULT_SHELF_SHARE3));
  assert.equal(
    wide.detailWidth + wide.thirdWidth,
    MIN_DETAIL_WIDTH + MIN_READER_WIDTH + (slack - Math.round(slack * DEFAULT_SHELF_SHARE3)),
  );
});

test("the three-pane floors are the numbers the drags restore", () => {
  const wide = libraryLayout(1440, 900, { pane: "three", collectionCount: 6, detailShare: 0.5 });
  assert.equal(DEFAULT_SPLIT_RATIO, 0.58);
  assert.equal(DEFAULT_SHELF_SHARE3, 0.58);
  assert.equal(DEFAULT_SERIES_SHARE, 0.4);
  assert.ok(wide.detailWidth >= MIN_DETAIL_WIDTH);
});

/* ---- the seam's own numbers ---- */

test("the CSS floors are the resolver's floors plus the seam", () => {
  // The detail's ceiling is written as `calc(100% - 217px)`: the shelf's 200 plus the seam's 9 px
  // and its two 4 px margins. If any of those numbers move, this fails rather than the shelf
  // quietly collapsing by the difference.
  const seam = /^  \.divider \{\n(?:.*\n)*?    width: 9px;\n    margin: 0 var\(--s1\);/m.exec(view)?.[0] ?? "";
  assert.ok(seam.length > 0, "the seam is not 9 px wide with 4 px margins");
  const ceiling = /max-width: calc\(100% - (\d+)px\)/.exec(view);
  assert.ok(ceiling !== null, "the detail has no ceiling");
  assert.equal(Number(ceiling[1]), MIN_SHELF_WIDTH + 9 + 4 + 4);
  const floor = /^  \.view\.split \.column \{\n(?:.*\n)*?    min-width: (\d+)px;/m.exec(view);
  assert.ok(floor !== null, "the shelf has no floor in CSS");
  assert.equal(Number(floor[1]), MIN_SHELF_WIDTH);
});