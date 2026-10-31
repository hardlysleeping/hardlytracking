/**
 * The migration rules: what moves, what is refused, and what the confirm panel says.
 *
 * These are the tests that decide whether "nothing is lost" is true: a chapter the reader touched
 * with no counterpart must refuse the whole move, a shorter target must refuse, and an unread
 * chapter that exists only on the old source must be reported rather than silently dropped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { planMigration, alignChapters, describeMigration, furthestProgress, mappingFromId } = await import(
  "../../src/lib/migrate.ts"
);

const chapter = (id, number, extra = {}) => ({
  id,
  seriesId: "old",
  name: `Chapter ${number}`,
  number,
  pageCount: 20,
  read: false,
  ...extra,
});

const oldChapters = [chapter("dalvik:1:a3", 3), chapter("dalvik:1:a2", 2), chapter("dalvik:1:a1", 1)];
const newChapters = [chapter("dalvik:2:b3", 3), chapter("dalvik:2:b2", 2), chapter("dalvik:2:b1", 1)];

const target = { provider: "dalvik", sourceId: "2", seriesId: "dalvik:2:x", title: "Same title", sourceName: "New source" };

const facts = {
  fromSource: "Old source",
  toSource: "New source",
  categories: 2,
  trackers: 1,
  history: 2,
  downloadsKeep: 1,
  downloadsDrop: 0,
};

test("chapters align by number, not by list position", () => {
  const shuffled = [chapter("dalvik:2:b1", 1), chapter("dalvik:2:b3", 3), chapter("dalvik:2:b2", 2)];
  const pairs = alignChapters(oldChapters, shuffled);
  assert.equal(pairs.get("dalvik:1:a2").id, "dalvik:2:b2");
  assert.equal(pairs.get("dalvik:1:a3").id, "dalvik:2:b3");
});

test("a repeated chapter number is consumed in order, never twice to the same row", () => {
  const from = [chapter("a", 5, { name: "Chapter 5 (group A)" }), chapter("b", 5, { name: "Chapter 5 (group B)" })];
  const to = [chapter("x", 5, { name: "Chapter 5" }), chapter("y", 5, { name: "Chapter 5 v2" })];
  const pairs = alignChapters(from, to);
  assert.equal(pairs.get("a").id, "x");
  assert.equal(pairs.get("b").id, "y");
});

test("an unnumbered list aligns by order when the counts are equal", () => {
  const from = [chapter("v1", 0), chapter("v2", 0)];
  const to = [chapter("w1", 0), chapter("w2", 0)];
  const pairs = alignChapters(from, to);
  assert.equal(pairs.get("v1").id, "w1");
  assert.equal(pairs.get("v2").id, "w2");
});

test("a matching title moves every chapter, mark and position", () => {
  const result = planMigration({
    seriesId: "dalvik:1:x",
    target,
    from: oldChapters,
    to: newChapters,
    read: new Set(["dalvik:1:a1", "dalvik:1:a2"]),
    pages: new Map([["dalvik:1:a3", 7]]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.pairs.length, 3);
  assert.deepEqual(result.plan.read.sort(), ["dalvik:1:a1", "dalvik:1:a2"]);
  assert.equal(result.plan.progressed.length, 1);
  assert.equal(result.plan.progressed[0].to.id, "dalvik:2:b3");
  assert.deepEqual(result.plan.stranded, []);
  assert.equal(result.plan.chapters.length, 3);
});

test("a shorter target refuses and says both counts", () => {
  const result = planMigration({
    seriesId: "dalvik:1:x",
    target,
    from: oldChapters,
    to: [chapter("dalvik:2:b1", 1), chapter("dalvik:2:b2", 2)],
    read: new Set(),
    pages: new Map(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "target-shorter");
  assert.match(result.message, /2 chapters and this title has 3/);
});

test("an empty target refuses rather than emptying the entry", () => {
  const result = planMigration({ seriesId: "dalvik:1:x", target, from: oldChapters, to: [], read: new Set(), pages: new Map() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty-target");
});

test("a title with no chapters on the old source refuses", () => {
  const result = planMigration({ seriesId: "dalvik:1:x", target, from: [], to: newChapters, read: new Set(), pages: new Map() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-chapters");
});

test("the same series on the same source is refused by name", () => {
  const result = planMigration({
    seriesId: "dalvik:2:x",
    target,
    from: oldChapters,
    to: newChapters,
    read: new Set(),
    pages: new Map(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "same-series");
});

test("a read chapter the target does not have refuses the whole move", () => {
  const result = planMigration({
    seriesId: "dalvik:1:x",
    target,
    // The target has 3 chapters but not chapter 2 — a gap the old source filled.
    from: oldChapters,
    to: [chapter("dalvik:2:b1", 1), chapter("dalvik:2:b3", 3), chapter("dalvik:2:b4", 4)],
    read: new Set(["dalvik:1:a2"]),
    pages: new Map(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unmatched-progress");
  assert.match(result.message, /Chapter 2 is read here/);
});

test("a page position with no counterpart refuses too, not only a read mark", () => {
  const result = planMigration({
    seriesId: "dalvik:1:x",
    target,
    from: oldChapters,
    to: [chapter("dalvik:2:b1", 1), chapter("dalvik:2:b3", 3), chapter("dalvik:2:b4", 4)],
    read: new Set(),
    pages: new Map([["dalvik:1:a2", 4]]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unmatched-progress");
});

test("an unread chapter that exists only on the old source is reported, not refused", () => {
  const result = planMigration({
    seriesId: "dalvik:1:x",
    target,
    from: oldChapters,
    to: [chapter("dalvik:2:b1", 1), chapter("dalvik:2:b3", 3), chapter("dalvik:2:b4", 4)],
    read: new Set(["dalvik:1:a1"]),
    pages: new Map(),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.stranded.map((row) => row.id), ["dalvik:1:a2"]);
  const rows = describeMigration(result.plan, facts, new Map());
  const stranded = rows.find((row) => row.label === "Only on the old source");
  assert.equal(stranded.value, "1 chapter");
});

test("extra chapters on the target are kept as unread additions", () => {
  const result = planMigration({
    seriesId: "dalvik:1:x",
    target,
    from: oldChapters,
    to: [...newChapters, chapter("dalvik:2:b4", 4)],
    read: new Set(["dalvik:1:a1"]),
    pages: new Map(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.chapters.length, 4);
  assert.equal(result.plan.pairs.length, 3);
});

test("the panel says what moves and what stays", () => {
  const result = planMigration({
    seriesId: "dalvik:1:x",
    target,
    from: oldChapters,
    to: newChapters,
    read: new Set(["dalvik:1:a1", "dalvik:1:a2"]),
    pages: new Map([["dalvik:1:a3", 7]]),
  });
  const rows = describeMigration(result.plan, facts, new Map([["dalvik:1:a3", 7]]));
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]));
  assert.equal(byLabel.Chapters, "3 → 3");
  assert.equal(byLabel["Read marks"], "2 move");
  assert.equal(byLabel["Furthest read"], "Chapter 3, page 8");
  assert.equal(byLabel["Reading history"], "2 entries");
  assert.equal(byLabel.Categories, "2 kept");
  assert.equal(byLabel["Tracker links"], "1 kept");
  assert.equal(byLabel.Downloads, "1 kept on this device");
  assert.equal(byLabel["Old source"], "kept as an alternate");
});

test("a dropped download is named as removed, not hidden", () => {
  const result = planMigration({
    seriesId: "dalvik:1:x",
    target,
    from: oldChapters,
    to: newChapters,
    read: new Set(),
    pages: new Map(),
  });
  const rows = describeMigration(result.plan, { ...facts, downloadsKeep: 0, downloadsDrop: 2 }, new Map());
  assert.equal(rows.find((row) => row.label === "Downloads").value, "2 removed (page count differs)");
});

test("furthest progress is the highest chapter, then the furthest page", () => {
  const result = planMigration({
    seriesId: "dalvik:1:x",
    target,
    from: oldChapters,
    to: newChapters,
    read: new Set(),
    pages: new Map([
      ["dalvik:1:a1", 19],
      ["dalvik:1:a2", 3],
    ]),
  });
  const furthest = furthestProgress(result.plan, new Map([
    ["dalvik:1:a1", 19],
    ["dalvik:1:a2", 3],
  ]));
  assert.equal(furthest.chapter.to.id, "dalvik:2:b2");
  assert.equal(furthest.page, 3);
});

test("a mapping is derived from the id, and never invented for mihon", () => {
  assert.deepEqual(mappingFromId("dalvik:123:https://site/manga/x"), {
    provider: "dalvik",
    sourceId: "123",
    remoteSeriesId: "dalvik:123:https://site/manga/x",
  });
  assert.equal(mappingFromId("mihon:12"), null);
  assert.deepEqual(mappingFromId("komga:book-1"), {
    provider: "komga",
    sourceId: "book-1",
    remoteSeriesId: "komga:book-1",
  });
});
