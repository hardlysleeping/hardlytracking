import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SORT, SORT_OPTIONS, sortKeyOf, sortSeries } from "../../src/lib/library/sort.ts";
import { emptyFacts } from "../../src/lib/library/query.ts";

function series(id, over = {}) {
  return { id, provider: "mihon", title: id, categoryIds: [], ...over };
}

function facts() {
  const base = emptyFacts();
  base.unread.set("a", 3);
  base.unread.set("b", 1);
  base.total.set("a", 5);
  base.total.set("b", 9);
  base.downloaded.set("a", 2);
  base.lastRead.set("a", 10);
  base.lastRead.set("b", 20);
  base.lastUpdated = new Map([["a", 100], ["b", 300]]);
  base.added = new Map([["a", 900], ["b", 100]]);
  base.latestChapter = new Map([["a", 40], ["b", 7]]);
  return base;
}

const ids = (rows) => rows.map((row) => row.id);

test("ten sort keys, in the spec's order", () => {
  assert.deepEqual(SORT_OPTIONS.map((option) => option.key), [
    "title", "lastRead", "lastUpdated", "added", "unread", "totalChapters", "latestChapter", "downloaded", "source", "manual",
  ]);
  assert.deepEqual(DEFAULT_SORT, { key: "title", dir: "asc" });
});

test("title sorts case-insensitively and keeps ties in the incoming order", () => {
  const rows = [series("b"), series("A"), series("a")];
  assert.deepEqual(ids(sortSeries(rows, { key: "title", dir: "asc" }, facts())), ["A", "a", "b"]);
  assert.deepEqual(ids(sortSeries(rows, { key: "title", dir: "desc" }, facts())), ["b", "A", "a"]);
});

test("every numeric key reads its own fact, in both directions", () => {
  const rows = [series("a"), series("b")];
  const keys = ["lastRead", "lastUpdated", "added", "unread", "totalChapters", "latestChapter", "downloaded"];
  for (const key of keys) {
    const asc = ids(sortSeries(rows, { key, dir: "asc" }, facts()));
    const desc = ids(sortSeries(rows, { key, dir: "desc" }, facts()));
    assert.equal(asc.length, 2, key);
    assert.deepEqual(desc, [...asc].reverse(), `${key} should reverse`);
  }
});

test("a missing fact sorts last, never first, in either direction", () => {
  const rows = [series("a"), series("never-read")];
  const factsWithMissing = facts();
  assert.deepEqual(ids(sortSeries(rows, { key: "lastRead", dir: "desc" }, factsWithMissing)), ["a", "never-read"]);
  assert.deepEqual(ids(sortSeries(rows, { key: "lastRead", dir: "asc" }, factsWithMissing)), ["a", "never-read"]);
  assert.deepEqual(ids(sortSeries(rows, { key: "lastUpdated", dir: "asc" }, factsWithMissing)), ["a", "never-read"]);
});

test("a sort over rows with no facts at all never throws and keeps the order", () => {
  const rows = [series("a"), series("b"), series("c")];
  assert.deepEqual(ids(sortSeries(rows, { key: "lastUpdated", dir: "desc" }, emptyFacts())), ["a", "b", "c"]);
});

test("manual order puts listed rows in list order and unlisted rows last, in title order", () => {
  const rows = [series("c"), series("a"), series("b")];
  assert.deepEqual(ids(sortSeries(rows, { key: "manual", dir: "asc" }, facts(), ["b", "c"])), ["b", "c", "a"]);
});

test("manual order ignores ids that are no longer in the shelf", () => {
  const rows = [series("a")];
  assert.deepEqual(ids(sortSeries(rows, { key: "manual", dir: "asc" }, facts(), ["gone", "a"])), ["a"]);
});

test("each collection keeps its own spec; an unknown collection falls back to the library's", () => {
  const prefs = { all: { key: "title", dir: "asc" }, "cat:reading": { key: "lastRead", dir: "desc" } };
  assert.deepEqual(sortKeyOf(prefs, "cat:reading"), { key: "lastRead", dir: "desc" });
  assert.deepEqual(sortKeyOf(prefs, "cat:unknown"), { key: "title", dir: "asc" });
  assert.deepEqual(sortKeyOf({}, null), DEFAULT_SORT);
});
