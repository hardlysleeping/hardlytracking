/**
 * The library's three panes: floors, containment, and the handles that move them.
 *
 * Three things the layout has to promise, and one place each is checked:
 *
 * - **No pane collapses.** Every column keeps a floor at every window the plan names, and the
 *   columns add up to exactly the room available — a pixel more and the document scrolls sideways,
 *   a pixel less and a gap opens between the shelf and its seam.
 * - **The seam belongs to the window, not the shelf.** A 5 000-title library made the divider as
 *   tall as the document; it has to be bounded like the pane it resizes, or the resize cursor lives
 *   over the whole page.
 * - **Every pane scrolls itself.** The shelf keeps its place while chapters are read beside it.
 *
 * The arithmetic is checked here; the same contract is measured in a real engine by
 * `tests/manual/panes-window.mjs`, because a CSS declaration is not a layout until something lays it
 * out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MIN_DETAIL_WIDTH,
  MIN_GRID_WIDTH,
  MIN_READER_WIDTH,
  MIN_SHELF_WIDTH,
  MIN_SIDEBAR_WIDTH,
  libraryLayout,
} from "../../src/lib/layout-modes.ts";

const view = readFileSync(new URL("../../src/views/Library.svelte", import.meta.url), "utf8");
const series = readFileSync(new URL("../../src/views/Series.svelte", import.meta.url), "utf8");

/** Every width the plan names, plus the two ends of a large monitor. */
const WIDTHS = [1000, 1280, 1440, 1600, 1920, 2560];

/** The room the layout divides, given the same chrome the view has. */
function usable(width) {
  return width - 76 - 32;
}

test("every named width keeps both panes and fills the room exactly", () => {
  for (const width of WIDTHS) {
    for (const pane of ["auto", "split", "three"]) {
      const layout = libraryLayout(width, 900, { pane, collectionCount: 6 });
      const space = layout.gridWidth + layout.detailWidth + layout.thirdWidth;
      assert.equal(space + layout.sidebarWidth, usable(width), `${width}/${pane}: ${space}`);
      if (layout.mode === "single") {
        assert.equal(layout.detailWidth, 0, `${width}/${pane}: a single pane reported a detail width`);
        assert.equal(layout.gridWidth, usable(width) - layout.sidebarWidth);
        continue;
      }
      assert.ok(layout.gridWidth >= MIN_SHELF_WIDTH, `${width}/${pane}: shelf ${layout.gridWidth}`);
      assert.ok(layout.detailWidth >= MIN_DETAIL_WIDTH, `${width}/${pane}: detail ${layout.detailWidth}`);
      if (layout.thirdWidth > 0) {
        assert.ok(layout.thirdWidth >= MIN_READER_WIDTH, `${width}/${pane}: reader ${layout.thirdWidth}`);
      }
    }
  }
});

test("the category sidebar is one width and never eats the shelf's floor", () => {
  for (const width of WIDTHS) {
    const layout = libraryLayout(width, 900, { nav: "sidebar", collectionCount: 6 });
    if (layout.categoryNav.mode !== "sidebar") continue;
    assert.equal(layout.sidebarWidth, MIN_SIDEBAR_WIDTH);
    assert.ok(layout.gridWidth >= MIN_GRID_WIDTH, `${width}: the sidebar left a ${layout.gridWidth} px shelf`);
  }
});

test("one pane never splits, whatever the window", () => {
  for (const width of WIDTHS) {
    const layout = libraryLayout(width, 900, { pane: "single", collectionCount: 6 });
    assert.equal(layout.mode, "single", `${width} split despite "one pane"`);
    assert.equal(layout.detailWidth, 0);
    assert.equal(layout.thirdWidth, 0);
  }
});

test("three panes are dropped before a pane is drawn under its floor", () => {
  for (const width of WIDTHS) {
    const layout = libraryLayout(width, 900, { pane: "three", collectionCount: 6, minGridWidth: 200 });
    if (layout.thirdWidth === 0) continue;
    assert.ok(layout.gridWidth >= 200);
    assert.ok(layout.detailWidth >= MIN_DETAIL_WIDTH);
    assert.ok(layout.thirdWidth >= MIN_READER_WIDTH);
  }
  // The narrow end of the list has to have actually taken the reader away.
  assert.equal(libraryLayout(1000, 900, { pane: "three", minGridWidth: 200 }).thirdWidth, 0);
});

/* ---- the seam, in the stylesheet ---- */

test("the divider is bounded by the window instead of stretched to the shelf", () => {
  const block = /^  \.divider \{[\s\S]*?^  \}/m.exec(view)?.[0] ?? "";
  assert.ok(block.length > 0, "there is no .divider rule");
  // Declarations only: the rule explains the old `align-self: stretch` in prose, and prose is not a
  // declaration.
  const decls = block.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(decls, /position: sticky/, "the seam is not sticky, so it scrolls away with the shelf");
  assert.match(decls, /height: calc\(100dvh - var\(--s4\) \* 2\)/, "the seam is not bounded to the window");
  assert.match(decls, /align-self: flex-start/, "the seam still stretches to the tallest flex item");
  assert.doesNotMatch(decls, /align-self: stretch/, "the seam is still as tall as the shelf");
});

test("every pane scrolls itself", () => {
  const detail = /^  \.detail \{[\s\S]*?^  \}/m.exec(view)?.[0] ?? "";
  assert.match(detail, /max-height: calc\(100dvh/, "the detail pane is not height-bounded");
  assert.match(detail, /overflow-y: auto/, "the detail pane does not scroll on its own");
  const collections = /^  \.collections \{[\s\S]*?^  \}/m.exec(view)?.[0] ?? "";
  assert.match(collections, /max-height: calc\(100dvh/, "the collection column is not height-bounded");
  assert.match(collections, /overflow-y: auto/, "the collection column does not scroll on its own");
});

test("the split uses its room, and the box itself keeps the floors", () => {
  // Measured in Chromium through `tests/manual/panes-window.mjs`: with the 1200 px reading cap left
  // on, `libraryLayout` promised a 657 px shelf and the view drew 464 — and a drag pinned against
  // the panes it could see took it to 44. The cap stays for a single column; a split is two columns
  // of a master/detail screen and grows with the window.
  assert.match(view, /class:split=\{layout\.mode === "split"\}/, "the view does not know when it is split");
  const split = /^  \.view\.split \{[\s\S]*?^  \}/m.exec(view)?.[0] ?? "";
  assert.ok(split.length > 0, "there is no .view.split rule");
  assert.match(split, /max-width: none/, "the split is still capped at the reading measure");
  const single = /^  \.view \{[\s\S]*?^  \}/m.exec(view)?.[0] ?? "";
  assert.match(single, /max-width: 1200px/, "the single-column reading measure was dropped too");

  // The floors are enforced by the box, not only by arithmetic the seam and gap then take 29 px out
  // of: whatever a drag asks for, neither pane is drawn under its minimum.
  const column = /^  \.view\.split \.column \{[\s\S]*?^  \}/m.exec(view)?.[0] ?? "";
  assert.ok(column.length > 0, "there is no split column floor");
  assert.match(column, /min-width: 200px/, "the shelf can still collapse under its floor");
  const detail = /^  \.view\.split \.detail \{[\s\S]*?^  \}/m.exec(view)?.[0] ?? "";
  assert.ok(detail.length > 0, "there is no split detail ceiling");
  assert.match(detail, /max-width: calc\(100% - 217px\)/, "the detail can still push the shelf under its floor");
});

/* ---- the handles, in the handlers ---- */

test("a drag measures the panes, clamps to the floors and commits once", () => {
  assert.match(view, /function startDrag\(event: PointerEvent\): void \{[\s\S]*setPointerCapture/, "the drag does not capture the pointer");
  assert.match(view, /splitRatioAt\(moveEvent\.clientX/, "the two-pane drag does not use the shared clamp");
  assert.match(view, /shelfShareAt\(moveEvent\.clientX/, "the three-pane drag does not divide the slack");
  assert.match(view, /seriesShareAt\(moveEvent\.clientX/, "the series seam does not use the shared clamp");
  // One write, on release: a `settings.set` inside `move` would be a database write per pointer move.
  const move = /const move = \(moveEvent: PointerEvent\) => \{[\s\S]*?\n    \};/.exec(view)?.[0] ?? "";
  assert.ok(move.length > 0, "the move handler is gone");
  assert.doesNotMatch(move, /settings\.set\(/, "the drag writes to settings on every pointer move");
  assert.match(view, /const done = \(\) => \{[\s\S]*settings\.set\("splitRatio"/, "the drag never commits its ratio");
});

test("double-clicking a seam puts it back to the shipped default", () => {
  assert.match(view, /ondblclick=\{resetDrag\}/, "the shelf's seam has no reset");
  assert.match(view, /ondblclick=\{resetShare\}/, "the series' seam has no reset");
  const reset = /function resetDrag\(\): void \{[\s\S]*?\n  \}/.exec(view)?.[0] ?? "";
  assert.match(reset, /DEFAULT_SPLIT_RATIO/, "the reset does not use the shipped default");
  assert.match(reset, /DEFAULT_SHELF_SHARE3/, "the three-pane reset does not use the shipped default");
});

/* ---- the embedded selection ---- */

test("the pane paints what it has before it asks the source", () => {
  const load = /async function load\(id: string\): Promise<void> \{[\s\S]*?\n  \}/.exec(series)?.[0] ?? "";
  assert.ok(load.length > 0, "Series.load is gone");
  const storedAt = load.indexOf("profile.store.getSeries(id)");
  const remoteAt = load.indexOf("library.details(id)");
  assert.ok(storedAt > 0 && remoteAt > storedAt, "the source is asked before the database is read");
  assert.match(load, /settleSelection\(embedded \? SELECTION_SETTLE_MS : 0, current\)/, "a pane does not wait for the selection to settle");
  assert.match(load, /if \(!current\(\)\) return;/, "an obsolete selection is never discarded");
});

test("a torn-down pane stops its own work", () => {
  assert.match(series, /\$effect\(\(\) => \{\s*void load\(seriesId\);[\s\S]*?return \(\) => \{\s*loadGeneration \+= 1;\s*\};/, "nothing invalidates an in-flight load when the pane goes away");
});