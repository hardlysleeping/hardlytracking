/**
 * A shelf of thousands, without thousands of tiles.
 *
 * `content-visibility: auto` skips a tile's rendering, not its creation: a 5 000-title library still
 * built 5 000 covers on the first frame and carried them through every scroll. The window below
 * answers "which rows exist" from three numbers — where the scroller is, how tall a row is, how many
 * columns fit — and two spacers hold the height of the rows it leaves out, so nothing about the
 * scrollbar or the scroll offset changes.
 *
 * The numbers are the contract, so they are tested as numbers: a 5 000-row shelf, a scroll into the
 * middle, the end of the list, and the guarantee that the reserved height always adds up to the shelf
 * that would have been drawn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { itemWindow, scrollRoot, OVERSCAN_ROWS } from "../../src/lib/window.ts";

const grid = readFileSync(new URL("../../src/components/SeriesGrid.svelte", import.meta.url), "utf8");

/** The same shelf the bug report uses: 5 000 titles, five to a row, a 100 px row. */
const SHELF = { count: 5000, columns: 5, rowHeight: 100, viewportHeight: 800 };

test("the top of a long shelf draws a window, never the whole shelf", () => {
  const win = itemWindow({ ...SHELF, scrollTop: 0 });
  const drawn = win.end - win.start;
  assert.equal(win.start, 0, "the window does not start at the top");
  assert.equal(win.padTop, 0, "there is nothing above the first row to reserve");
  assert.ok(drawn > 0, "the window is empty");
  assert.ok(drawn < SHELF.count, "the whole shelf was mounted");
  // One screen (8 rows) plus the overscan either side.
  assert.equal(win.end, (8 + OVERSCAN_ROWS) * SHELF.columns);
  assert.equal(win.padBottom, (1000 - (8 + OVERSCAN_ROWS)) * SHELF.rowHeight);
});

test("scrolled into the middle, the window holds the rows on screen and the height still adds up", () => {
  const win = itemWindow({ ...SHELF, scrollTop: 50_000 });
  const totalRows = Math.ceil(SHELF.count / SHELF.columns);
  const firstRow = win.padTop / SHELF.rowHeight;
  const lastRow = totalRows - win.padBottom / SHELF.rowHeight;
  // The row under the viewport's top edge is in the window.
  const visibleRow = Math.floor(50_000 / SHELF.rowHeight);
  assert.ok(win.start <= visibleRow * SHELF.columns, "the window starts below the row being read");
  assert.ok(visibleRow * SHELF.columns < win.end, "the window ends above the row being read");
  assert.ok(lastRow * SHELF.columns >= win.end);
  assert.equal(win.padTop + (lastRow - firstRow) * SHELF.rowHeight + win.padBottom, totalRows * SHELF.rowHeight);
  assert.ok(win.padTop > 0 && win.padBottom > 0, "a middle window needs a spacer on both sides");
});

test("at the end of the shelf there is nothing left to reserve below", () => {
  const win = itemWindow({ ...SHELF, scrollTop: 99_200 });
  assert.equal(win.end, SHELF.count, "the last titles are unreachable");
  assert.equal(win.padBottom, 0);
  assert.ok(win.padTop > 0);
  assert.ok(SHELF.count - win.start < 100, "the window did not follow the scroll to the end");
});

test("the overscan is what keeps a flick from outrunning the render", () => {
  const tight = itemWindow({ ...SHELF, scrollTop: 20_000, overscanRows: 0 });
  const roomy = itemWindow({ ...SHELF, scrollTop: 20_000 });
  assert.ok(roomy.start < tight.start, "the roomy window did not start earlier");
  assert.ok(roomy.end > tight.end, "the roomy window did not end later");
  assert.ok(roomy.end - roomy.start < SHELF.count, "overscan mounted the shelf");
});

test("a window is a slice in reading order, aligned to whole rows", () => {
  const win = itemWindow({ ...SHELF, scrollTop: 7_777 });
  assert.equal(win.start % SHELF.columns, 0, "the window starts mid-row");
  assert.equal(win.end % SHELF.columns, 0, "the window ends mid-row");
  assert.ok(win.end <= SHELF.count);
});

test("an empty or tiny shelf is the whole answer, not an empty window", () => {
  assert.deepEqual(itemWindow({ ...SHELF, count: 0, scrollTop: 0 }), { start: 0, end: 0, padTop: 0, padBottom: 0 });
  const three = itemWindow({ ...SHELF, count: 3, scrollTop: 0 });
  assert.deepEqual([three.start, three.end, three.padTop, three.padBottom], [0, 3, 0, 0]);
});

test("a row height that has not been measured yet cannot make the window jump", () => {
  const win = itemWindow({ ...SHELF, scrollTop: 1_000, rowHeight: 0 });
  assert.ok(Number.isFinite(win.padTop) && Number.isFinite(win.padBottom));
  assert.ok(win.end > win.start);
});

test("the scroller is the first ancestor that can actually scroll", () => {
  const outer = { parentElement: null };
  const inner = { parentElement: outer };
  const shelf = { parentElement: inner };
  const styles = new Map([
    [inner, "auto"],
    [outer, "hidden"],
  ]);
  const original = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (node) => ({ overflowY: styles.get(node) ?? "visible" });
  try {
    assert.equal(scrollRoot(shelf), inner, "walked past the scroller that holds the shelf");
    assert.equal(scrollRoot(outer), null, "answered a container that cannot scroll");
  } finally {
    globalThis.getComputedStyle = original;
  }
});

test("the grid mounts a window and holds the rest with spacers", () => {
  assert.match(grid, /bind:this=\{host\}/, "the grid is not bound to the element that gets measured");
  assert.match(grid, /class="pad" style:height=\{`\$\{win\.padTop\}px`\}/, "there is no spacer above the window");
  assert.match(grid, /class="pad" style:height=\{`\$\{win\.padBottom\}px`\}/, "there is no spacer below the window");
  assert.match(grid, /const drawn = \$derived\(windowed \? series\.slice\(win\.start, win\.end\)/, "the grid still draws the whole shelf");
  assert.match(grid, /mode !== "card"/, "a card grid (which has no uniform row) is windowed");
});

test("a windowed tile still knows its place in the whole shelf", () => {
  assert.match(grid, /onclick=\{\(event\) => pick\(item, win\.start \+ index, event\)\}/, "the tile reports a slice-relative position");
  assert.match(grid, /expansionAnchor = series\[rowStart\(index, columns\)\]/, "the expansion panel anchors inside the slice");
});