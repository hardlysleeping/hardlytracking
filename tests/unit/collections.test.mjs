import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTINUE_ID,
  SYSTEM_COLLECTIONS,
  categoryIdFromCollection,
  collectionIdFromCategory,
  continueEntries,
  homeSections,
  matchesFilter,
  orderedCollections,
  ruleOf,
  titlesIn,
  visibleSeries,
} from "../../src/lib/collections.ts";

/** A title with sane defaults; each test overrides only what it is about. */
function facts(over = {}) {
  return {
    seriesId: "s1",
    provider: "dalvik",
    categoryIds: [],
    chapters: 10,
    unread: 4,
    downloaded: 0,
    started: true,
    updatedAt: Date.now() - 86_400_000,
    ...over,
  };
}

function collection(over = {}) {
  return { id: "c1", name: "Reading", kind: "manual", order: 0, hidden: false, pinned: false, ...over };
}

test("a manual collection is membership, nothing else", () => {
  const reading = collection({ id: "c1" });
  const favourites = collection({ id: "c2", name: "Favorites", order: 1 });
  const rows = [facts({ seriesId: "a", categoryIds: ["c1"] }), facts({ seriesId: "b", categoryIds: ["c2"] }), facts({ seriesId: "c" })];
  assert.deepEqual(titlesIn(reading, rows).map((r) => r.seriesId), ["a"]);
  assert.deepEqual(titlesIn(favourites, rows).map((r) => r.seriesId), ["b"]);
});

test("a title can be in several collections at once", () => {
  const rows = [facts({ seriesId: "a", categoryIds: ["c1", "c2", "c3"] })];
  for (const id of ["c1", "c2", "c3"]) {
    assert.equal(titlesIn(collection({ id }), rows).length, 1);
  }
});

test("unread is a smart rule, and an all-read title fails it", () => {
  const unread = SYSTEM_COLLECTIONS.find((c) => c.system === "unread");
  const rows = [facts({ seriesId: "a", unread: 3 }), facts({ seriesId: "b", unread: 0 })];
  assert.deepEqual(titlesIn(unread, rows).map((r) => r.seriesId), ["a"]);
});

test("completed needs chapters, so a title with none is not complete", () => {
  const completed = SYSTEM_COLLECTIONS.find((c) => c.system === "completed");
  const rows = [
    facts({ seriesId: "a", chapters: 10, unread: 0 }),
    facts({ seriesId: "b", chapters: 10, unread: 1 }),
    facts({ seriesId: "c", chapters: 0, unread: 0 }),
  ];
  assert.deepEqual(titlesIn(completed, rows).map((r) => r.seriesId), ["a"]);
});

test("downloaded only matches titles with a chapter on this device", () => {
  const downloaded = SYSTEM_COLLECTIONS.find((c) => c.system === "downloaded");
  const rows = [facts({ seriesId: "a", downloaded: 2 }), facts({ seriesId: "b", downloaded: 0 })];
  assert.deepEqual(titlesIn(downloaded, rows).map((r) => r.seriesId), ["a"]);
});

test("recently updated is a window, and a title with no dates never matches", () => {
  const recent = SYSTEM_COLLECTIONS.find((c) => c.system === "recent");
  const now = Date.now();
  const rows = [
    facts({ seriesId: "new", updatedAt: now - 86_400_000 }),
    facts({ seriesId: "old", updatedAt: now - 40 * 86_400_000 }),
    facts({ seriesId: "undated", updatedAt: 0 }),
  ];
  assert.deepEqual(titlesIn(recent, rows, now).map((r) => r.seriesId), ["new"]);
});

test("filters combine with AND, not OR", () => {
  const filter = { unread: true, downloaded: true };
  assert.equal(matchesFilter(filter, facts({ unread: 1, downloaded: 1 })), true);
  assert.equal(matchesFilter(filter, facts({ unread: 1, downloaded: 0 })), false);
  assert.equal(matchesFilter(filter, facts({ unread: 0, downloaded: 1 })), false);
});

test("a source filter needs a mapping, and does not match a title without one", () => {
  const filter = { sourceId: "6084907896154116083" };
  assert.equal(matchesFilter(filter, facts({ sourceId: "6084907896154116083" })), true);
  assert.equal(matchesFilter(filter, facts({ sourceId: "999" })), false);
  assert.equal(matchesFilter(filter, facts()), false);
});

test("a smart collection nested inside a manual one keeps the manual membership", () => {
  const filter = { inCollection: "c1", unread: true };
  const rows = [facts({ seriesId: "a", categoryIds: ["c1"], unread: 2 }), facts({ seriesId: "b", categoryIds: ["c2"], unread: 2 })];
  const nested = collection({ id: "s:custom", kind: "smart", filter });
  assert.deepEqual(titlesIn(nested, rows).map((r) => r.seriesId), ["a"]);
});

test("a system collection's rule comes from its preset when it carries no filter of its own", () => {
  const bare = { id: "s:unread", name: "Unread", kind: "smart", order: 0, hidden: false, pinned: false };
  assert.deepEqual(ruleOf(bare), { unread: true });
});

test("hiding a collection removes its titles, but an uncategorised title is never hidden", () => {
  const hidden = collection({ id: "c1", hidden: true });
  const rows = [facts({ seriesId: "in-hidden", categoryIds: ["c1"] }), facts({ seriesId: "loose", categoryIds: [] })];
  assert.deepEqual(visibleSeries([hidden], rows).map((r) => r.seriesId), ["loose"]);
});

test("with no collections at all, every title is visible", () => {
  const rows = [facts({ seriesId: "a" }), facts({ seriesId: "b" })];
  assert.equal(visibleSeries([], rows).length, 2);
});

test("pinned collections sort first and keep their own order inside that", () => {
  const rows = [
    collection({ id: "c1", order: 0 }),
    collection({ id: "c2", order: 1, pinned: true }),
    collection({ id: "c3", order: 2 }),
    collection({ id: "c4", order: 3, pinned: true }),
  ];
  assert.deepEqual(orderedCollections(rows).map((r) => r.id), ["c2", "c4", "c1", "c3"]);
});

test("home sections are pinned, visible, and never Continue Reading twice", () => {
  const rows = [
    collection({ id: "c1", pinned: true }),
    collection({ id: "c2", pinned: true, hidden: true }),
    collection({ id: "c3" }),
    { id: CONTINUE_ID, name: "Continue reading", kind: "smart", order: 0, hidden: false, pinned: true, system: undefined },
  ];
  assert.deepEqual(homeSections(rows).map((r) => r.id), ["c1"]);
});

test("continue reading resumes an unfinished chapter at its page", () => {
  const entries = continueEntries([
    { seriesId: "a", chapterId: "ch1", page: 12, total: 21, at: 100, finished: false },
  ]);
  assert.deepEqual(entries, [{ seriesId: "a", chapterId: "ch1", page: 12, total: 21, at: 100, next: false }]);
});

test("a finished chapter offers the next unread one, or nothing, by setting", () => {
  const input = [
    { seriesId: "a", chapterId: "ch1", page: 20, total: 21, at: 100, finished: true, next: { chapterId: "ch2", total: 18 } },
  ];
  assert.deepEqual(continueEntries(input, { afterFinish: "next" }), [
    { seriesId: "a", chapterId: "ch2", page: 0, total: 18, at: 100, next: true },
  ]);
  assert.deepEqual(continueEntries(input, { afterFinish: "remove" }), []);
});

test("continue reading keeps one entry per title, newest first, and honours the cap", () => {
  const inputs = [
    { seriesId: "a", chapterId: "a1", page: 1, total: 10, at: 10, finished: false },
    { seriesId: "a", chapterId: "a2", page: 2, total: 10, at: 50, finished: false },
    { seriesId: "b", chapterId: "b1", page: 3, total: 10, at: 30, finished: false },
    { seriesId: "c", chapterId: "c1", page: 4, total: 10, at: 20, finished: false },
  ];
  const entries = continueEntries(inputs, { afterFinish: "next", limit: 2 });
  assert.deepEqual(entries.map((e) => [e.seriesId, e.chapterId]), [["a", "a2"], ["b", "b1"]]);
});

test("a Mihon category id round-trips to a collection id and back", () => {
  assert.equal(collectionIdFromCategory("7"), "c:7");
  assert.equal(collectionIdFromCategory("c:7"), "c:7");
  assert.equal(categoryIdFromCollection("c:7"), "7");
  assert.equal(categoryIdFromCollection("7"), "7");
});
