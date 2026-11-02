/**
 * The source picker on the search screen.
 *
 * Three plain decisions, kept out of the view because they are the ones that went wrong: what order
 * the chips are in, what a first search ticks, and what happens to a tick whose source is gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { orderForPicker, pruneSelection, seedSelection } = await import("../../src/lib/pinned.ts");

const source = (id, name) => ({ id, provider: "dalvik", name, supportsLatest: false });

const sources = [
  source("dalvik:src:1", "MangaDex"),
  source("dalvik:src:2", "Batoto"),
  source("dalvik:src:3", "Comick"),
  source("dalvik:src:4", "WeebCentral"),
];

test("the picker shows the pinned sources first, in the order they were pinned", () => {
  const ordered = orderForPicker(sources, ["dalvik:src:4", "dalvik:src:2"]);
  assert.deepEqual(
    ordered.map((row) => row.id),
    ["dalvik:src:4", "dalvik:src:2", "dalvik:src:3", "dalvik:src:1"],
    "pins in their own order (4, then 2), then the rest by name (Comick, MangaDex)",
  );
});

test("a pin for a source that is not installed is not a chip", () => {
  const ordered = orderForPicker(sources, ["dalvik:src:9"]);
  assert.deepEqual(ordered.map((row) => row.id), ["dalvik:src:2", "dalvik:src:3", "dalvik:src:1", "dalvik:src:4"]);
});

test("a first search ticks the pins when there are pins, and a dozen otherwise", () => {
  assert.deepEqual(seedSelection(sources, ["dalvik:src:3"], true), ["dalvik:src:3"]);
  assert.deepEqual(seedSelection(sources, [], true), ["dalvik:src:1", "dalvik:src:2", "dalvik:src:3", "dalvik:src:4"]);
  assert.deepEqual(seedSelection(sources, ["dalvik:src:3"], false).length, 4, "the preference off means the usual dozen");
  const many = Array.from({ length: 30 }, (_, at) => source(`dalvik:src:${at + 1}`, `S${at + 1}`));
  assert.equal(seedSelection(many, [], false).length, 12, "sixty sources at once is a hammer, not a search");
});

test("a tick whose source is gone is dropped, the rest kept", () => {
  const chosen = new Set(["dalvik:src:1", "dalvik:src:2"]);
  const kept = pruneSelection(chosen, sources.slice(0, 1));
  assert.deepEqual([...kept], ["dalvik:src:1"]);
  assert.equal(chosen.size, 2, "the caller's set is not mutated");
});
