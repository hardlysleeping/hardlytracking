import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TABS,
  overflowCount,
  setTabPinned,
  tabRow,
  toggleTabPin,
} from "../../src/lib/library/collections.ts";

function category(id, order, over = {}) {
  return { id, name: id, order, hidden: false, pinned: false, tabPinned: false, ...over };
}

/** Eight collections, in the user's order; the first two are tab-pinned. */
function eight() {
  return [
    category("reading", 0, { tabPinned: true }),
    category("favorites", 1, { tabPinned: true }),
    category("manhwa", 2),
    category("completed", 3),
    category("romance", 4),
    category("horror", 5),
    category("shelf", 6, { pinned: true }),
    category("later", 7),
  ];
}

test("pinned collections fill the row first, in the user's order, then unpinned up to MAX_TABS", () => {
  const all = eight();
  const row = tabRow(all, all);
  assert.equal(MAX_TABS, 5);
  assert.deepEqual(row.tabs.map((c) => c.id), ["reading", "favorites", "manhwa", "completed", "romance"]);
  assert.deepEqual(row.overflow.map((c) => c.id), ["horror", "shelf", "later"]);
  assert.equal(row.tabs.length + row.overflow.length, all.length);
});

test("the eye decides membership: a hidden collection is in neither list", () => {
  const all = eight();
  const visible = all.filter((c) => c.id !== "manhwa");
  const row = tabRow(all, visible);
  assert.deepEqual(row.tabs.map((c) => c.id), ["reading", "favorites", "completed", "romance", "horror"]);
  assert.ok(!row.overflow.some((c) => c.id === "manhwa"));
});

test("more pinned collections than slots keeps the first MAX_TABS and overflows the rest", () => {
  const all = [
    category("a", 0, { tabPinned: true }),
    category("b", 1, { tabPinned: true }),
    category("c", 2, { tabPinned: true }),
    category("d", 3, { tabPinned: true }),
    category("e", 4, { tabPinned: true }),
    category("f", 5, { tabPinned: true }),
    category("g", 6),
  ];
  const row = tabRow(all, all);
  assert.deepEqual(row.tabs.map((c) => c.id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(row.overflow.map((c) => c.id), ["f", "g"]);
});

test("pinning a collection already in the row is a no-op, and unpinning one that is not is too", () => {
  const all = eight();
  const pinnedAgain = setTabPinned(all, "reading", true);
  assert.deepEqual(pinnedAgain, all);
  const unpinned = setTabPinned(all, "later", false);
  assert.deepEqual(unpinned, all);
});

test("pinning an overflowed collection lifts it into the row and pushes the last tab out", () => {
  const all = eight();
  const next = setTabPinned(all, "horror", true);
  const row = tabRow(next, next);
  assert.equal(row.tabs.length, MAX_TABS);
  assert.ok(row.tabs.some((c) => c.id === "horror"));
  assert.ok(row.overflow.some((c) => c.id === "romance"));
});

test("the tab pin is not the rail pin: toggling one leaves the other alone", () => {
  const all = eight();
  const next = toggleTabPin(all, "shelf");
  const shelf = next.find((c) => c.id === "shelf");
  assert.equal(shelf.pinned, true);
  assert.equal(shelf.tabPinned, true);
  const back = toggleTabPin(next, "shelf");
  assert.equal(back.find((c) => c.id === "shelf").pinned, true);
  assert.equal(back.find((c) => c.id === "shelf").tabPinned, false);
});

test("the overflow count matches the row", () => {
  const all = eight();
  assert.equal(overflowCount(all, all), 3);
  assert.equal(overflowCount(all.slice(0, 4), all.slice(0, 4)), 0);
});
