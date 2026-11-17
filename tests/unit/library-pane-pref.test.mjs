import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { libraryLayout } from "../../src/lib/layout-modes.ts";

const librarySource = readFileSync(new URL("../../src/views/Library.svelte", import.meta.url), "utf8");

test("Library passes its saved pane preference to the layout resolver", () => {
  assert.match(librarySource, /pane:\s*settings\.libraryPane/);
});

test("single stays one pane even when the window can split", () => {
  const layout = libraryLayout(1440, 900, { collectionCount: 6, pane: "single" });
  assert.equal(layout.mode, "single");
  assert.equal(layout.detailWidth, 0);
  assert.equal(layout.thirdWidth, 0);
});

test("split collapses only while narrow, then returns without changing the preference", () => {
  const options = { collectionCount: 6, pane: "split" };
  assert.equal(libraryLayout(1440, 900, options).mode, "split");
  assert.equal(libraryLayout(800, 900, options).mode, "single");
  assert.equal(options.pane, "split");
  assert.equal(libraryLayout(1440, 900, options).mode, "split");
});

test("only explicit pane-choice controls write the saved pane preference", () => {
  const writes = [...librarySource.matchAll(/settings\.set\(\s*[\"']libraryPane[\"']/g)];
  assert.equal(writes.length, 3);
});
