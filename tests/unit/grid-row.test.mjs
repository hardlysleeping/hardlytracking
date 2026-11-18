import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { columnCount, rowStart } from "../../src/lib/grid-row.ts";

const grid = readFileSync(new URL("../../src/components/SeriesGrid.svelte", import.meta.url), "utf8");

test("a tile's row head is the first tile of its row, for every column count", () => {
  const cases = [
    { columns: 1, index: 7, head: 7 },
    { columns: 2, index: 7, head: 6 },
    { columns: 3, index: 7, head: 6 },
    { columns: 4, index: 7, head: 4 },
    { columns: 6, index: 11, head: 6 },
    { columns: 6, index: 12, head: 12 },
    { columns: 8, index: 0, head: 0 },
  ];
  for (const row of cases) {
    assert.equal(rowStart(row.index, row.columns), row.head, `${row.index} in ${row.columns} columns`);
  }
});

test("the row head never leaves the shelf, however odd the numbers", () => {
  for (const index of [0, 1, 4999]) {
    for (const columns of [0, -3, 1, 2, 5]) {
      const head = rowStart(index, columns);
      assert.ok(head >= 0 && head <= index, `rowStart(${index}, ${columns}) = ${head}`);
    }
  }
  assert.equal(rowStart(Number.NaN, 4), 0);
  assert.equal(rowStart(2.7, 2), 2, "a fractional index is floored, not rounded into the next row");
});

test("a resolved grid says how many columns it has, and a list says one", () => {
  assert.equal(columnCount("204px 204px 204px"), 3);
  assert.equal(columnCount("  180.5px   120px "), 2);
  assert.equal(columnCount("none"), 1);
  assert.equal(columnCount(""), 1);
  assert.equal(columnCount(null), 1);
  assert.equal(columnCount(undefined), 1);
});

test("the tile is not a button wrapping another button", () => {
  assert.doesNotMatch(grid, /<button[^>]*class="tile"/, "the tile is still a <button>");
  assert.match(grid, /<div\s+class="tile"/, "the tile is not a plain container");
  assert.match(grid, /class="open"[\s\S]{0,2000}?<\/button>/, "the card has no open control");
  assert.match(grid, /{#if resume\.has\(item\.id\)}\s*<!--[\s\S]*?<button\s+class="resume"/, "Resume is not a button of its own");
});

test("selecting a tile does not measure its neighbours", () => {
  const pick = /function pick\(item: Series[\s\S]*?\n  \}/.exec(grid)?.[0] ?? "";
  assert.ok(pick.length > 0, "pick() is gone");
  assert.doesNotMatch(pick, /querySelectorAll/, "pick() still scans every sibling");
  assert.doesNotMatch(pick, /getBoundingClientRect/, "pick() still forces a layout per tile");
  assert.match(pick, /rowStart\(index, columns\)/, "pick() does not use the row-head arithmetic");
  assert.match(grid, /getComputedStyle\(host\)\.gridTemplateColumns/, "the column count is not read from the grid");
});