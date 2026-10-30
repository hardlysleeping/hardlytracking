import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTIONS,
  SYNC_FORMAT,
  SYNC_VERSION,
  SyncFormatError,
  canonicalJson,
  emptyDocument,
  isNewer,
  looksLikeSyncDocument,
  parseSync,
  serializeSync,
  validateSyncDocument,
} from "../../src/lib/sync/document.ts";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { applyDocument } from "../../src/lib/sync/apply.ts";
import { documentFromStore } from "../../src/lib/sync/from-store.ts";

const stamp = { at: 1_700_000_000_000, device: "dev-a" };

function sample() {
  const doc = emptyDocument("dev-a", 1_700_000_000_000);
  doc.series = [
    { id: "mihon:2", provider: "mihon", title: "Second", categoryIds: ["c2", "c1"], ...stamp },
    { id: "mihon:1", provider: "mihon", title: "First", author: "A", categoryIds: [], ...stamp },
  ];
  doc.categories = [
    { id: "c2", name: "Manga", order: 1, hidden: true, pinned: false, ...stamp },
    { id: "c1", name: "Comics", order: 0, hidden: false, pinned: true, ...stamp },
  ];
  doc.progress = [{ chapterId: "mihon:ch:1", seriesId: "mihon:1", page: 3, total: 20, ...stamp }];
  doc.readState = [{ chapterId: "mihon:ch:1", read: true, ...stamp }];
  doc.sourceMappings = [
    { seriesId: "mihon:1", provider: "mihon", sourceId: "1234567890123456789", packageId: "eu.kanade.tachiyomi.extension.all.test", ...stamp },
  ];
  doc.extensions = [
    {
      packageId: "eu.kanade.tachiyomi.extension.all.test",
      repoUrl: "https://example.invalid/index.json",
      versionName: "1.4.2",
      versionCode: 142,
      enabled: true,
      sourceIds: ["1234567890123456789"],
      preferences: { quality: "high" },
      ...stamp,
    },
  ];
  doc.preferences = [{ key: "reader.mode", value: "paged", ...stamp }];
  return doc;
}

test("an empty document round-trips to identical bytes", () => {
  const doc = emptyDocument("dev-a", 1_700_000_000_000);
  const text = serializeSync(doc);
  assert.equal(serializeSync(parseSync(text)), text);
});

test("a full document round-trips to identical bytes, and collections come out sorted", () => {
  const text = serializeSync(sample());
  const back = parseSync(text);
  assert.equal(serializeSync(back), text, "serialize(parse(x)) === x");
  assert.deepEqual(back.series.map((s) => s.id), ["mihon:1", "mihon:2"]);
  assert.deepEqual(back.categories.map((c) => c.id), ["c1", "c2"]);
});

test("key order in the input does not change the bytes", () => {
  const shuffled = {
    tombstones: [],
    series: [{ categoryIds: [], title: "First", provider: "mihon", id: "mihon:1", device: "dev-a", at: 1_700_000_000_000 }],
    meta: { revision: 1, updatedAt: new Date(1_700_000_000_000).toISOString(), device: "dev-a", version: SYNC_VERSION, format: SYNC_FORMAT },
    chapters: [],
    positions: [],
    repos: [],
    categories: [],
    progress: [],
    readState: [],
    history: [],
    sessions: [],
    bookmarks: [],
    sourceMappings: [],
    extensions: [],
    preferences: [],
    trackers: [],
  };
  const tidy = emptyDocument("dev-a", 1_700_000_000_000);
  tidy.series = [{ id: "mihon:1", provider: "mihon", title: "First", categoryIds: [], ...stamp }];
  assert.equal(serializeSync(validateSyncDocument(shuffled)), serializeSync(tidy));
});

test("a reading session survives serialise, validate and parse with every field", () => {
  const doc = emptyDocument("dev-a", 1_700_000_000_000);
  doc.sessions = [
    {
      id: "ch:1@1700000000000",
      seriesId: "mihon:1",
      sourceId: "2499283573021220255",
      chapterId: "ch:1",
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_540_000,
      startPage: 3,
      endPage: 21,
      pagesRead: 19,
      durationSeconds: 540,
      completedChapter: true,
      at: 1_700_000_540_000,
      device: "dev-a",
    },
  ];
  const back = parseSync(serializeSync(doc));
  assert.deepEqual(back.sessions, doc.sessions);
  // An open session travels too: it is unfinished, not invalid.
  const open = { ...doc.sessions[0], id: "ch:2@1", chapterId: "ch:2", endedAt: undefined, durationSeconds: undefined, completedChapter: false };
  const doc2 = emptyDocument("dev-a", 1_700_000_000_000);
  doc2.sessions = [open];
  const back2 = parseSync(serializeSync(doc2));
  assert.equal(back2.sessions[0].endedAt, undefined);
  assert.equal(back2.sessions[0].durationSeconds, undefined);
});

test("a backup carries the reading log and an import writes it back", async () => {
  const store = new LibraryStore(memoryDatabase());
  const id = await store.beginSession(
    { seriesId: "local:1", sourceId: "src:7", chapterId: "local:1:ch1", startPage: 2 },
    1_700_000_000_000,
  );
  await store.endSession(id, { endPage: 12, completed: true, at: 1_700_000_000_000 + 300_000 });

  const doc = await documentFromStore(store, { device: "dev-a", at: 1_700_000_100_000 });
  assert.equal(doc.sessions.length, 1);
  const session = doc.sessions[0];
  assert.equal(session.sourceId, "src:7");
  assert.equal(session.pagesRead, 11);
  assert.equal(session.durationSeconds, 300);
  assert.equal(session.completedChapter, true);

  // Serialise, parse and apply into a fresh device: the log arrives intact.
  const parsed = parseSync(serializeSync(doc));
  const other = new LibraryStore(memoryDatabase());
  const summary = await applyDocument(other, parsed);
  assert.equal(summary.sessions, 1);
  const [landed] = await other.listSessions();
  assert.equal(landed.id, session.id);
  assert.equal(landed.startedAt, 1_700_000_000_000);
  assert.equal(landed.endedAt, 1_700_000_300_000);
  assert.equal(landed.durationSeconds, 300);
  assert.equal(landed.completedChapter, true);
});

test("duplicate rows collapse to the newest stamp, deterministically", () => {
  const doc = sample();
  doc.preferences = [
    { key: "reader.mode", value: "paged", at: 200, device: "dev-a" },
    { key: "reader.mode", value: "vertical", at: 300, device: "dev-b" },
    { key: "reader.mode", value: "strip", at: 300, device: "dev-c" },
  ];
  const back = parseSync(serializeSync(doc));
  assert.equal(back.preferences.length, 1);
  assert.equal(back.preferences[0].value, "strip", "same stamp, higher device id wins");
});

test("a newer document version is refused, naming both versions", () => {
  const doc = JSON.parse(serializeSync(emptyDocument("dev-a")));
  doc.meta.version = SYNC_VERSION + 1;
  assert.throws(
    () => validateSyncDocument(doc),
    (error) =>
      error instanceof SyncFormatError &&
      error.reason === "newer-version" &&
      error.message.includes(String(SYNC_VERSION + 1)) &&
      error.message.includes(String(SYNC_VERSION)),
  );
});

test("a missing collection is an error, not an empty list", () => {
  const doc = JSON.parse(serializeSync(emptyDocument("dev-a")));
  delete doc.categories;
  assert.throws(() => validateSyncDocument(doc), (error) => {
    return error instanceof SyncFormatError && error.reason === "missing-collection" && error.message.includes("categories");
  });
});

test("a foreign file and a broken file are both refused with a reason", () => {
  assert.throws(() => parseSync("{"), (error) => error instanceof SyncFormatError && error.reason === "not-json");
  assert.throws(() => parseSync("[]"), (error) => error instanceof SyncFormatError && error.reason === "not-an-object");
  assert.throws(() => validateSyncDocument({ meta: { format: "other.app", version: 1 } }), (error) => {
    return error instanceof SyncFormatError && error.reason === "wrong-format";
  });
  assert.throws(() => validateSyncDocument({ meta: { format: SYNC_FORMAT, version: "1" } }), (error) => {
    return error instanceof SyncFormatError && error.reason === "wrong-format";
  });
});

test("a row without its identity is refused, and the message says which row", () => {
  const doc = JSON.parse(serializeSync(emptyDocument("dev-a")));
  doc.series = [{ provider: "mihon", title: "No id", ...stamp }];
  assert.throws(() => validateSyncDocument(doc), (error) => {
    return error instanceof SyncFormatError && error.reason === "bad-entry" && error.message.includes("series[0]") && error.message.includes("id");
  });
});

test("a tombstone with an unknown kind is refused", () => {
  const doc = JSON.parse(serializeSync(emptyDocument("dev-a")));
  doc.tombstones = [{ kind: "manga", id: "mihon:1", ...stamp }];
  assert.throws(() => validateSyncDocument(doc), (error) => error instanceof SyncFormatError && error.reason === "bad-entry");
});

test("stamps compare by time, then by device, so two devices agree on a winner", () => {
  assert.equal(isNewer({ at: 2, device: "a" }, { at: 1, device: "z" }), true);
  assert.equal(isNewer({ at: 1, device: "b" }, { at: 1, device: "a" }), true);
  assert.equal(isNewer({ at: 1, device: "a" }, { at: 1, device: "b" }), false);
});

test("every collection is present in a new document", () => {
  const doc = emptyDocument("dev-a");
  for (const name of COLLECTIONS) assert.ok(Array.isArray(doc[name]), `${name} missing`);
});

test("canonicalJson sorts keys at every depth", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }, 0), '{"a":{"c":3,"d":2},"b":1}');
});

test("looksLikeSyncDocument is a cheap check, not a validator that throws", () => {
  assert.equal(looksLikeSyncDocument(serializeSync(emptyDocument("dev-a"))), true);
  assert.equal(looksLikeSyncDocument("nope"), false);
});
