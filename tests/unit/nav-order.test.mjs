import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BOTTOM_NAV,
  DEFAULT_LIBRARY_TABS,
  DESTINATION_IDS,
  LIBRARY_SECTION_IDS,
  normaliseOrder,
  toggleItem,
  moveItem,
} from "../../src/lib/nav-order.ts";

test("the shipped defaults name every destination, once", () => {
  assert.deepEqual(DEFAULT_BOTTOM_NAV, ["library", "browse", "search", "history", "more"]);
  assert.deepEqual([...DEFAULT_BOTTOM_NAV].sort(), [...DESTINATION_IDS].sort());
  assert.deepEqual(DEFAULT_LIBRARY_TABS, ["titles", "updates"]);
  assert.deepEqual([...DEFAULT_LIBRARY_TABS].sort(), [...LIBRARY_SECTION_IDS].sort());
});

test("an empty list is the default, not a blank bar", () => {
  assert.deepEqual(normaliseOrder([], DESTINATION_IDS, DEFAULT_BOTTOM_NAV), DEFAULT_BOTTOM_NAV);
  assert.deepEqual(normaliseOrder([], LIBRARY_SECTION_IDS, DEFAULT_LIBRARY_TABS), DEFAULT_LIBRARY_TABS);
});

test("a missing or garbage value is the default", () => {
  for (const value of [undefined, null, 42, "library", {}, { 0: "library" }, [null], [{}], [""]]) {
    assert.deepEqual(normaliseOrder(value, DESTINATION_IDS, DEFAULT_BOTTOM_NAV), DEFAULT_BOTTOM_NAV);
  }
});

test("unknown ids are dropped, and the stored order of the rest is kept", () => {
  assert.deepEqual(
    normaliseOrder(["history", "nope", "library", 7], DESTINATION_IDS, DEFAULT_BOTTOM_NAV),
    ["history", "library"],
  );
});

test("duplicates are dropped at their first position", () => {
  assert.deepEqual(
    normaliseOrder(["more", "browse", "more", "browse", "search"], DESTINATION_IDS, DEFAULT_BOTTOM_NAV),
    ["more", "browse", "search"],
  );
});

test("a short list is the reader's choice, not corruption", () => {
  // Hiding three destinations is a legitimate bar: it must not be padded back to five.
  assert.deepEqual(normaliseOrder(["library", "search"], DESTINATION_IDS, DEFAULT_BOTTOM_NAV), ["library", "search"]);
});

test("a single item survives normalisation", () => {
  assert.deepEqual(normaliseOrder(["history"], DESTINATION_IDS, DEFAULT_BOTTOM_NAV), ["history"]);
});

test("toggle adds to the end and removes in place", () => {
  assert.deepEqual(toggleItem(["library", "browse"], "history", DEFAULT_BOTTOM_NAV), ["library", "browse", "history"]);
  assert.deepEqual(toggleItem(["library", "browse", "history"], "browse", DEFAULT_BOTTOM_NAV), ["library", "history"]);
});

test("toggle refuses to empty the list", () => {
  assert.deepEqual(toggleItem(["library"], "library", DEFAULT_BOTTOM_NAV), ["library"]);
});

test("toggle cleans the list it is given before editing it", () => {
  assert.deepEqual(toggleItem(["browse", "browse", "nope"], "history", DEFAULT_BOTTOM_NAV), ["browse", "history"]);
});

test("an unknown id is not added: the list is a closed set", () => {
  assert.deepEqual(toggleItem(["library", "browse"], "nope", DEFAULT_BOTTOM_NAV), ["library", "browse"]);
});

test("move swaps neighbours and copies the list", () => {
  const list = ["library", "browse", "search"];
  assert.deepEqual(moveItem(list, 0, 1), ["browse", "library", "search"]);
  assert.deepEqual(moveItem(list, 2, -1), ["library", "search", "browse"]);
  assert.deepEqual(list, ["library", "browse", "search"], "the input is not mutated");
});

test("a move past either end is refused", () => {
  const list = ["library", "browse", "search"];
  assert.deepEqual(moveItem(list, 0, -1), list);
  assert.deepEqual(moveItem(list, 2, 1), list);
  assert.deepEqual(moveItem(list, 1, 5), list);
});

test("a single item cannot move at all", () => {
  assert.deepEqual(moveItem(["library"], 0, -1), ["library"]);
  assert.deepEqual(moveItem(["library"], 0, 1), ["library"]);
});

test("an out-of-range index or a zero delta leaves the order alone", () => {
  const list = ["library", "browse"];
  assert.deepEqual(moveItem(list, -1, 1), list);
  assert.deepEqual(moveItem(list, 9, -1), list);
  assert.deepEqual(moveItem(list, 0, 0), list);
  assert.deepEqual(moveItem([], 0, 1), []);
});
