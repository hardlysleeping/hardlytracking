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

test("tab pins fill the row first, then a pinned shelf, then the user's order up to MAX_TABS", () => {
  const all = eight();
  const row = tabRow(all, all);
  assert.equal(MAX_TABS, 5);
  // `shelf` is pinned, so it comes to the front with the two tab pins and pushes `romance` out of
  // the row: pinning a shelf is how it gets to the front, in the row as well as in the rail.
  assert.deepEqual(row.tabs.map((c) => c.id), ["reading", "favorites", "shelf", "manhwa", "completed"]);
  assert.deepEqual(row.overflow.map((c) => c.id), ["romance", "horror", "later"]);
  assert.equal(row.tabs.length + row.overflow.length, all.length);
});

test("the eye decides membership: a hidden collection is in neither list", () => {
  const all = eight();
  const visible = all.filter((c) => c.id !== "manhwa");
  const row = tabRow(all, visible);
  assert.deepEqual(row.tabs.map((c) => c.id), ["reading", "favorites", "shelf", "completed", "romance"]);
  assert.ok(!row.overflow.some((c) => c.id === "manhwa"));
});

test("the chip row puts a pinned collection first, tab pins still leading", () => {
  const cats = [
    category("a", 0),
    category("b", 1, { pinned: true }),
    category("c", 2, { tabPinned: true }),
  ];
  const { tabs } = tabRow(cats, cats, 5);
  assert.deepEqual(tabs.map((x) => x.id), ["c", "b", "a"], "tab pin, then the category pin, then order");
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
