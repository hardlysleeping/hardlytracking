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
    categories: [],
    progress: [],
    readState: [],
    history: [],
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
