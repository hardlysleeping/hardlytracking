import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTIONS,
  SYNC_FORMAT,
  SYNC_VERSION,
  emptyDocument,
  parseSync,
  serializeSync,
  validateSyncDocument,
} from "../../src/lib/sync/document.ts";
import { identityOf, mergeMany, mergeSyncDocuments } from "../../src/lib/sync/merge.ts";

const AT = 1_700_000_000_000;

/** A document with the rows a test cares about; everything else stays an empty list. */
function doc(device, rows = {}) {
  const document = emptyDocument(device, AT);
  for (const [name, list] of Object.entries(rows)) document[name] = list;
  return document;
}

const stamp = (at, device) => ({ at, device });

/** Two documents that disagree about something in every collection that can disagree. */
function pair() {
  const a = doc("dev-a", {
    series: [
      { id: "mihon:1", provider: "mihon", title: "One", categoryIds: ["c1"], ...stamp(AT, "dev-a") },
      { id: "mihon:2", provider: "mihon", title: "Two", categoryIds: [], ...stamp(AT + 5, "dev-a") },
    ],
    categories: [{ id: "c1", name: "Comics", order: 0, hidden: false, pinned: true, ...stamp(AT, "dev-a") }],
    progress: [{ chapterId: "mihon:1:ch:1", seriesId: "mihon:1", page: 3, total: 20, ...stamp(AT, "dev-a") }],
    readState: [{ chapterId: "mihon:1:ch:1", read: true, ...stamp(AT + 10, "dev-a") }],
    history: [{ seriesId: "mihon:1", chapterId: "mihon:1:ch:1", ...stamp(AT, "dev-a") }],
    bookmarks: [{ seriesId: "mihon:2", chapterId: "mihon:2:ch:7", ...stamp(AT, "dev-a") }],
    sourceMappings: [
      {
        seriesId: "mihon:1",
        provider: "mihon",
        sourceId: "1234567890123456789",
        packageId: "eu.kanade.tachiyomi.extension.all.test",
        ...stamp(AT, "dev-a"),
      },
    ],
    extensions: [
      {
        packageId: "eu.kanade.tachiyomi.extension.all.test",
        repoUrl: "https://example.invalid/index.json",
        versionName: "1.4.2",
        versionCode: 142,
        enabled: true,
        sourceIds: ["1234567890123456789"],
        preferences: { quality: "high" },
        ...stamp(AT, "dev-a"),
      },
    ],
    preferences: [{ key: "reader.mode", value: "paged", ...stamp(AT, "dev-a") }],
    trackers: [{ seriesId: "mihon:1", service: "mal", remoteId: "42", ...stamp(AT, "dev-a") }],
  });

  const b = doc("dev-b", {
    series: [
      { id: "mihon:2", provider: "mihon", title: "Two, corrected", categoryIds: [], ...stamp(AT + 8, "dev-b") },
      { id: "mihon:3", provider: "mihon", title: "Three", categoryIds: [], ...stamp(AT + 2, "dev-b") },
    ],
    categories: [{ id: "c2", name: "Manga", order: 1, hidden: true, pinned: false, ...stamp(AT + 1, "dev-b") }],
    progress: [{ chapterId: "mihon:3:ch:4", seriesId: "mihon:3", page: 12, total: 30, ...stamp(AT + 20, "dev-b") }],
    readState: [{ chapterId: "mihon:3:ch:2", read: true, ...stamp(AT + 3, "dev-b") }],
    bookmarks: [{ seriesId: "mihon:3", chapterId: "mihon:3:ch:4", ...stamp(AT + 2, "dev-b") }],
    preferences: [{ key: "reader.mode", value: "vertical", ...stamp(AT + 30, "dev-b") }],
    tombstones: [{ kind: "series", id: "mihon:1", ...stamp(AT + 40, "dev-b") }],
  });

  return { a, b };
}

const options = { device: "dev-a", now: AT + 1000 };

test("merge is commutative: the same two documents give the same result in either order", () => {
  const { a, b } = pair();
  const forward = mergeSyncDocuments(a, b, options);
  const backward = mergeSyncDocuments(b, a, options);
  assert.deepEqual(backward, forward);
  for (const name of COLLECTIONS) assert.deepEqual(backward[name], forward[name], `${name} differs by order`);
});

test("merge is idempotent: merging a document with itself is that document, normalised", () => {
  const { a } = pair();
  const merged = mergeSyncDocuments(a, a, { device: "dev-a", now: AT });
  const normalised = validateSyncDocument(JSON.parse(JSON.stringify(a)));
  for (const name of COLLECTIONS) assert.deepEqual(merged[name], normalised[name], `${name} changed`);
  assert.equal(merged.meta.revision, a.meta.revision + 1);
  assert.equal(merged.meta.device, "dev-a");
  assert.equal(merged.meta.updatedAt, new Date(AT).toISOString());

  const again = mergeSyncDocuments(merged, merged, { device: "dev-a", now: AT });
  for (const name of COLLECTIONS) assert.deepEqual(again[name], merged[name], `${name} is not stable`);
});

test("merge is associative for three documents, and mergeMany is that fold", () => {
  const { a, b } = pair();
  const c = doc("dev-c", {
    series: [{ id: "mihon:4", provider: "mihon", title: "Four", categoryIds: [], ...stamp(AT + 12, "dev-c") }],
    progress: [{ chapterId: "mihon:4:ch:1", seriesId: "mihon:4", page: 2, total: 18, ...stamp(AT + 12, "dev-c") }],
    tombstones: [{ kind: "category", id: "c2", ...stamp(AT + 50, "dev-c") }],
  });
  const opts = { device: "dev-a", now: AT + 2000 };
  const left = mergeSyncDocuments(mergeSyncDocuments(a, b, opts), c, opts);
  const right = mergeSyncDocuments(a, mergeSyncDocuments(b, c, opts), opts);
  assert.deepEqual(right, left);
  assert.deepEqual(mergeMany([a, b, c], opts), left);
  assert.equal(left.meta.revision, 3, "three documents at revision 1 are one new revision");
});

test("the newest stamp wins per row, whichever document it arrived in", () => {
  const older = doc("dev-a", { preferences: [{ key: "reader.mode", value: "paged", ...stamp(AT, "dev-a") }] });
  const newer = doc("dev-b", { preferences: [{ key: "reader.mode", value: "vertical", ...stamp(AT + 1, "dev-b") }] });
  assert.equal(mergeSyncDocuments(older, newer, options).preferences[0].value, "vertical");
  assert.equal(mergeSyncDocuments(newer, older, options).preferences[0].value, "vertical");
});

test("an equal stamp is broken by device id, so both devices agree", () => {
  const a = doc("dev-a", { preferences: [{ key: "theme", value: "dark", ...stamp(AT, "dev-a") }] });
  const b = doc("dev-b", { preferences: [{ key: "theme", value: "sepia", ...stamp(AT, "dev-b") }] });
  const forward = mergeSyncDocuments(a, b, options);
  const backward = mergeSyncDocuments(b, a, options);
  assert.equal(forward.preferences[0].value, "sepia");
  assert.deepEqual(backward.preferences, forward.preferences);
});

test("a tombstone removes an older row and stays in the document as a fact", () => {
  const { a, b } = pair();
  const merged = mergeSyncDocuments(a, b, options);
  assert.deepEqual(merged.series.map((row) => row.id), ["mihon:2", "mihon:3"], "mihon:1 is deleted");
  assert.deepEqual(merged.tombstones.map((row) => `${row.kind}:${row.id}`), ["series:mihon:1"]);
  assert.deepEqual(mergeSyncDocuments(b, a, options).tombstones, merged.tombstones);
});

test("a row with the same stamp as its tombstone is not newer, so it is suppressed", () => {
  const a = doc("dev-a", { categories: [{ id: "c1", name: "Comics", order: 0, hidden: false, pinned: false, ...stamp(AT, "dev-a") }] });
  const b = doc("dev-b", { tombstones: [{ kind: "category", id: "c1", ...stamp(AT, "dev-a") }] });
  const merged = mergeSyncDocuments(a, b, options);
  assert.deepEqual(merged.categories, []);
  assert.equal(merged.tombstones.length, 1);
});

test("a re-add after a delete wins, and the tombstone is kept", () => {
  const deleted = doc("dev-b", { tombstones: [{ kind: "series", id: "mihon:9", ...stamp(AT + 5, "dev-b") }] });
  const readded = doc("dev-a", { series: [{ id: "mihon:9", provider: "mihon", title: "Back again", categoryIds: [], ...stamp(AT + 20, "dev-a") }] });
  for (const merged of [mergeSyncDocuments(deleted, readded, options), mergeSyncDocuments(readded, deleted, options)]) {
    assert.deepEqual(merged.series.map((row) => row.title), ["Back again"]);
    assert.deepEqual(merged.tombstones.map((row) => row.id), ["mihon:9"], "the delete is still a fact");
  }
});

test("a tombstone only removes its own kind, never another collection's row", () => {
  const a = doc("dev-a", {
    series: [{ id: "c1", provider: "mihon", title: "A series that shares an id", categoryIds: [], ...stamp(AT, "dev-a") }],
    categories: [{ id: "c1", name: "Comics", order: 0, hidden: false, pinned: false, ...stamp(AT, "dev-a") }],
  });
  const b = doc("dev-b", { tombstones: [{ kind: "category", id: "c1", ...stamp(AT + 5, "dev-b") }] });
  const merged = mergeSyncDocuments(a, b, options);
  assert.deepEqual(merged.categories, []);
  assert.deepEqual(merged.series.map((row) => row.id), ["c1"]);
});

test("position and read mark are separate rows for one chapter and never overwrite each other", () => {
  const a = doc("dev-a", {
    progress: [{ chapterId: "mihon:1:ch:1", seriesId: "mihon:1", page: 3, total: 20, ...stamp(AT + 50, "dev-a") }],
    readState: [{ chapterId: "mihon:1:ch:1", read: true, ...stamp(AT, "dev-a") }],
  });
  const b = doc("dev-b", {
    progress: [{ chapterId: "mihon:1:ch:1", seriesId: "mihon:1", page: 7, total: 20, ...stamp(AT + 5, "dev-b") }],
    readState: [{ chapterId: "mihon:1:ch:1", read: false, ...stamp(AT + 9, "dev-b") }],
  });
  const merged = mergeSyncDocuments(a, b, options);
  assert.equal(merged.progress.length, 1);
  assert.equal(merged.readState.length, 1);
  assert.equal(merged.progress[0].page, 3, "the later position wins on its own stamp");
  assert.equal(merged.readState[0].read, false, "the later mark wins on its own stamp");
  assert.equal(merged.progress[0].device, "dev-a");
  assert.equal(merged.readState[0].device, "dev-b");
});

test("a category present on one side survives, because absence is not a deletion", () => {
  const a = doc("dev-a", { categories: [{ id: "c1", name: "Comics", order: 0, hidden: false, pinned: false, ...stamp(AT, "dev-a") }] });
  const b = doc("dev-b", {});
  assert.deepEqual(mergeSyncDocuments(a, b, options).categories.map((row) => row.id), ["c1"]);
  assert.deepEqual(mergeSyncDocuments(b, a, options).categories.map((row) => row.id), ["c1"]);
});

test("history and bookmarks are identified by the series and chapter pair", () => {
  const a = doc("dev-a", {
    history: [{ seriesId: "mihon:1", chapterId: "mihon:1:ch:1", ...stamp(AT, "dev-a") }],
    bookmarks: [{ seriesId: "mihon:2", chapterId: "mihon:2:ch:7", ...stamp(AT, "dev-a") }],
  });
  const b = doc("dev-b", {
    history: [
      { seriesId: "mihon:1", chapterId: "mihon:1:ch:1", ...stamp(AT + 4, "dev-b") },
      { seriesId: "mihon:2", chapterId: "mihon:2:ch:1", ...stamp(AT + 4, "dev-b") },
    ],
    tombstones: [{ kind: "bookmark", id: "mihon:2:ch:7", ...stamp(AT + 10, "dev-b") }],
  });
  const merged = mergeSyncDocuments(a, b, options);
  assert.deepEqual(merged.history.map(identityOf.bind(null, "history")), ["mihon:1\u0000mihon:1:ch:1", "mihon:2\u0000mihon:2:ch:1"]);
  assert.equal(merged.history[0].at, AT + 4, "the same pair is one row, newest wins");
  assert.deepEqual(merged.bookmarks, [], "the bookmark was deleted by its chapter id");
});

test("two devices: three chapters read on one, a position on the other, nothing is lost", () => {
  const phone = doc("dev-a", {
    readState: [1, 2, 3].map((chapter) => ({ chapterId: `mihon:1:ch:${chapter}`, read: true, ...stamp(AT + chapter, "dev-a") })),
    progress: [{ chapterId: "mihon:1:ch:3", seriesId: "mihon:1", page: 19, total: 20, ...stamp(AT + 3, "dev-a") }],
  });
  const tablet = doc("dev-b", {
    progress: [{ chapterId: "mihon:1:ch:4", seriesId: "mihon:1", page: 12, total: 30, ...stamp(AT + 20, "dev-b") }],
  });

  for (const merged of [mergeSyncDocuments(phone, tablet, options), mergeSyncDocuments(tablet, phone, options)]) {
    assert.deepEqual(merged.readState.map((row) => row.chapterId), ["mihon:1:ch:1", "mihon:1:ch:2", "mihon:1:ch:3"]);
    assert.ok(merged.readState.every((row) => row.read === true), "every read mark survives");
    assert.deepEqual(merged.progress.map((row) => `${row.chapterId}@${row.page}`), ["mihon:1:ch:3@19", "mihon:1:ch:4@12"]);
    const roundTripped = parseSync(serializeSync(merged));
    assert.deepEqual(roundTripped, merged, "the merged document is a valid document");
  }
});

test("the merged document is canonical and carries the current format and version", () => {
  const { a, b } = pair();
  b.meta.version = 0;
  const merged = mergeSyncDocuments(a, b, options);
  assert.equal(merged.meta.format, SYNC_FORMAT);
  assert.equal(merged.meta.version, SYNC_VERSION, "an old input is written out at the version this build knows");
  const text = serializeSync(merged);
  assert.equal(serializeSync(parseSync(text)), text, "serialize(parse(x)) === x");
  assert.equal(parseSync(text).meta.revision, merged.meta.revision);
});

test("every collection unions, so a row only one side knows is kept", () => {
  const { a, b } = pair();
  const merged = mergeSyncDocuments(a, b, options);
  assert.deepEqual(merged.sourceMappings.map((row) => row.seriesId), ["mihon:1"]);
  assert.deepEqual(merged.extensions.map((row) => row.packageId), ["eu.kanade.tachiyomi.extension.all.test"]);
  assert.deepEqual(merged.trackers.map((row) => row.service), ["mal"]);
  assert.deepEqual(merged.bookmarks.map((row) => row.chapterId), ["mihon:2:ch:7", "mihon:3:ch:4"]);
  assert.deepEqual(merged.progress.map((row) => row.chapterId), ["mihon:1:ch:1", "mihon:3:ch:4"]);
});

test("merging does not mutate its inputs, and the result owns its rows", () => {
  const { a, b } = pair();
  const before = JSON.stringify([a, b]);
  const merged = mergeSyncDocuments(a, b, options);
  assert.equal(JSON.stringify([a, b]), before, "inputs are untouched");
  merged.series[0].categoryIds.push("c9");
  merged.tombstones.push({ kind: "series", id: "made-up", at: AT, device: "dev-a" });
  assert.equal(JSON.stringify([a, b]), before, "editing the result does not reach back into the inputs");
});

test("a document that still carries a row its own tombstone killed comes out consistent", () => {
  const stale = doc("dev-a", {
    series: [{ id: "mihon:5", provider: "mihon", title: "Gone", categoryIds: [], ...stamp(AT, "dev-a") }],
    tombstones: [{ kind: "series", id: "mihon:5", ...stamp(AT + 5, "dev-a") }],
  });
  const merged = mergeSyncDocuments(stale, stale, options);
  assert.deepEqual(merged.series, []);
  assert.equal(merged.tombstones.length, 1);
});

test("mergeMany of one document is that document, and of none is an empty one", () => {
  const { a } = pair();
  const single = mergeMany([a], { device: "dev-a", now: AT });
  for (const name of COLLECTIONS) assert.deepEqual(single[name], a[name], `${name} changed`);
  assert.equal(single.meta.revision, a.meta.revision, "no merge happened, so no revision was invented");

  const none = mergeMany([], { device: "dev-a", now: AT });
  for (const name of COLLECTIONS) assert.deepEqual(none[name], []);
  assert.equal(none.meta.device, "dev-a");
  assert.equal(none.meta.revision, 1);
});

test("mergeMany does not depend on the order the documents are handed over", () => {
  const { a, b } = pair();
  const c = doc("dev-c", {
    readState: [{ chapterId: "mihon:9:ch:1", read: true, ...stamp(AT + 7, "dev-c") }],
  });
  const opts = { device: "dev-a", now: AT + 3000 };
  assert.deepEqual(mergeMany([c, b, a], opts), mergeMany([a, b, c], opts));
});
