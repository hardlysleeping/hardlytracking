import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { applyDocument } from "../../src/lib/sync/apply.ts";
import { documentFromStore } from "../../src/lib/sync/from-store.ts";
import { SYNC_VERSION, parseSync, serializeSync } from "../../src/lib/sync/document.ts";
import { mergeSyncDocuments } from "../../src/lib/sync/merge.ts";
import { reattach, summarizeReattach } from "../../src/lib/backup/identity.ts";

const AT = 1_700_000_000_000;
const DEVICE = "dev-a";
const DALVIK_ID = "dalvik:2499283573021220255:https://mangadex.org/title/4f9c1a2e-1c0b-4f0f-9b2a-2b6a1f7c9d11";
const SOURCE = "2499283573021220255";
const PACKAGE = "eu.kanade.tachiyomi.extension.all.mangadex";

/** A store with one of everything a backup is supposed to carry. */
async function filledStore() {
  const store = new LibraryStore(memoryDatabase());
  await store.putCategory({ id: "c1", name: "Comics", order: 0, hidden: false, pinned: true });
  await store.putCategory({ id: "c2", name: "Manga", order: 1, hidden: true, pinned: false });

  await store.addSeries({
    id: DALVIK_ID,
    provider: "dalvik",
    title: "A Dalvik title",
    author: "Someone",
    description: "A description",
    categoryIds: ["c1"],
  });
  await store.addSeries({ id: "local:1717000000000", provider: "local", title: "A local title", categoryIds: ["c1", "c2"] });
  await store.addSeries({ id: "mihon:12", provider: "mihon", title: "A host title", categoryIds: [] });

  await store.putChapters(DALVIK_ID, [
    { id: `${DALVIK_ID}:ch1`, seriesId: DALVIK_ID, name: "Chapter 1", number: 1, pageCount: 20, read: false, uploadedAt: AT - 86_400_000 },
    { id: `${DALVIK_ID}:ch2`, seriesId: DALVIK_ID, name: "Chapter 2", number: 2, pageCount: 18, read: false },
  ]);
  await store.putChapters("local:1717000000000", [
    { id: "local:1717000000000:ch1", seriesId: "local:1717000000000", name: "One", number: 1, pageCount: 4, read: false },
  ]);

  await store.setProgress(`${DALVIK_ID}:ch1`, 7, 20, AT - 60_000);
  await store.setRead(`${DALVIK_ID}:ch1`, true);
  await store.setPosition(DALVIK_ID, `${DALVIK_ID}:ch2`, 3, AT - 30_000);
  await store.recordHistory(DALVIK_ID, `${DALVIK_ID}:ch2`, AT - 30_000);

  const sessionId = await store.beginSession(
    { seriesId: DALVIK_ID, sourceId: SOURCE, chapterId: `${DALVIK_ID}:ch1`, startPage: 1 },
    AT - 600_000,
  );
  await store.endSession(sessionId, { endPage: 7, completed: false, at: AT - 540_000 });

  await store.putMapping({ seriesId: DALVIK_ID, provider: "dalvik", sourceId: SOURCE, packageId: PACKAGE, at: AT - 900_000 });
  await store.putRepo({ url: "https://example.invalid/repo", indexUrl: "https://example.invalid/repo/index.json", name: "Example", at: AT - 1_000_000 });
  await store.putRepo({ url: "https://example.invalid/other", indexUrl: "https://example.invalid/other/index.min.json", name: "Other", at: AT - 1_000_000 });
  await store.recordTombstone("session", "gone@1", AT - 2_000_000);
  await store.setPref("reader.mode", "paged");

  return store;
}

test("export -> file -> import -> export is the same document, byte for byte", async () => {
  const first = await filledStore();
  const doc1 = await documentFromStore(first, { device: DEVICE, at: AT });
  const text1 = serializeSync(doc1);

  // The file a person actually gets: text on disk, read back through the same parser.
  const parsed = parseSync(text1);

  // A brand-new device, nothing on it.
  const second = new LibraryStore(memoryDatabase());
  assert.equal((await second.listSeries()).length, 0);
  const applied = await applyDocument(second, parsed);

  const doc2 = await documentFromStore(second, { device: DEVICE, at: AT });
  const text2 = serializeSync(doc2);

  assert.equal(text2, text1, "the second export is the same bytes as the first");
  assert.deepEqual(parseSync(text2), parsed, "and the same document, collection by collection");

  // The counts say the restore really wrote what the file carried, not just the series rows.
  assert.equal(applied.series, 3);
  assert.equal(applied.chapters, 3);
  assert.equal(applied.categories, 2);
  assert.equal(applied.positions, 1);
  assert.equal(applied.sessions, 1);
  assert.equal(applied.mappings, 1);
  assert.equal(applied.repos, 2);
  assert.equal(applied.tombstones, 1);

  // Spot-check the things a listed-but-unreadable restore would have lost.
  const chapters = await second.listChapters(DALVIK_ID);
  assert.deepEqual(chapters.map((row) => row.id).sort(), [`${DALVIK_ID}:ch1`, `${DALVIK_ID}:ch2`]);
  assert.equal(chapters.find((row) => row.id.endsWith("ch1"))?.pageCount, 20);
  assert.equal((await second.getPosition(DALVIK_ID))?.chapterId, `${DALVIK_ID}:ch2`);
  assert.equal((await second.getProgress(`${DALVIK_ID}:ch1`))?.at, AT - 60_000, "the position keeps its own time");
  assert.equal(await second.isRead(`${DALVIK_ID}:ch1`), true);
  assert.equal((await second.listHistory(10))[0]?.seriesId, DALVIK_ID);
  assert.equal((await second.listRepos()).length, 2);
});

test("an imported series reattaches to the extension that owns it, and says so when it cannot", async () => {
  const store = await filledStore();
  const doc = parseSync(serializeSync(await documentFromStore(store, { device: DEVICE, at: AT })));

  // Nothing installed: the dalvik series is missing, the local one opens, the host one is unknown.
  const nothing = summarizeReattach(reattach(doc, []));
  assert.deepEqual([nothing.attached, nothing.missing, nothing.unknown], [1, 1, 1]);
  assert.equal(nothing.missingSources[0].sourceId, SOURCE);
  assert.equal(nothing.missingSources[0].packageName, PACKAGE, "the mapping names the APK that is missing");

  // The same file after installing the extension: the series reattaches with no re-import.
  const installed = [
    {
      extensionId: "sha256:aaa",
      packageId: PACKAGE,
      name: "MangaDex",
      sources: [{ id: SOURCE, name: "MangaDex", lang: "en" }],
      enabled: true,
    },
  ];
  const after = summarizeReattach(reattach(doc, installed));
  assert.deepEqual([after.attached, after.missing, after.unknown], [2, 0, 1]);
});

test("an import into a store that already has newer data deletes nothing", async () => {
  const source = await filledStore();
  const doc = parseSync(serializeSync(await documentFromStore(source, { device: DEVICE, at: AT })));

  // This device already has a series the file has never heard of, its own newer progress and a
  // session of its own — the three things an import must not touch.
  const local = new LibraryStore(memoryDatabase());
  await local.addSeries({ id: "local:keep-me", provider: "local", title: "Keep me", categoryIds: [] });
  await local.putChapters("local:keep-me", [
    { id: "local:keep-me:ch1", seriesId: "local:keep-me", name: "One", number: 1, pageCount: 9, read: false },
  ]);
  await local.setProgress("local:keep-me:ch1", 8, 9, AT + 5_000);
  const ownSession = await local.beginSession(
    { seriesId: "local:keep-me", chapterId: "local:keep-me:ch1", startPage: 1 },
    AT + 6_000,
  );
  await local.endSession(ownSession, { endPage: 8, at: AT + 9_000 });

  const before = {
    series: (await local.listSeries()).length,
    chapters: (await local.listAllChapters()).length,
    sessions: (await local.listSessions(Number.POSITIVE_INFINITY)).length,
  };

  // The file also carries a tombstone for the local row, as a deletion from another device.
  const withTombstone = {
    ...doc,
    tombstones: [...doc.tombstones, { kind: "series", id: "local:keep-me", at: AT - 1, device: "dev-b" }],
  };
  await applyDocument(local, withTombstone);

  const after = {
    series: (await local.listSeries()).length,
    chapters: (await local.listAllChapters()).length,
    sessions: (await local.listSessions(Number.POSITIVE_INFINITY)).length,
  };

  assert.equal(await local.getSeries("local:keep-me") !== undefined, true, "an import never deletes a row");
  assert.ok(after.series > before.series, "it only adds");
  assert.ok(after.chapters > before.chapters);
  assert.equal(after.sessions, before.sessions + 1, "its own session survives, the file's is added");

  // The tombstone is recorded as a fact, so a later sync cannot resurrect the row — and because the
  // local row is newer than the tombstone, the merge keeps it. That is "tombstones only suppress".
  const merged = mergeSyncDocuments(await documentFromStore(local, { device: DEVICE, at: AT + 10_000 }), doc, {
    device: DEVICE,
    now: AT + 10_000,
  });
  assert.ok(merged.series.some((row) => row.id === "local:keep-me"), "a row newer than the tombstone survives");
});

test("a v2 file is read, not refused: the lists it never had arrive empty", async () => {
  const store = await filledStore();
  const doc = await documentFromStore(store, { device: DEVICE, at: AT });
  const text = serializeSync(doc);
  const old = JSON.parse(text);
  old.meta.version = 2;
  delete old.chapters;
  delete old.positions;
  delete old.repos;

  const parsed = parseSync(JSON.stringify(old));
  assert.equal(parsed.meta.version, 2);
  assert.deepEqual(parsed.chapters, []);
  assert.deepEqual(parsed.positions, []);
  assert.deepEqual(parsed.repos, []);
  assert.equal(parsed.series.length, 3, "the rows v2 did carry are all still there");

  // And a list that every version has is still refused when it is absent.
  const truncated = JSON.parse(text);
  delete truncated.series;
  assert.throws(() => parseSync(JSON.stringify(truncated)), /missing the "series" list/);

  // The build writes its own version on the way out.
  assert.equal(JSON.parse(serializeSync(parsed)).meta.version, SYNC_VERSION);
});
