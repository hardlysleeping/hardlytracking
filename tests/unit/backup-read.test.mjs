import { test } from "node:test";
import assert from "node:assert/strict";

import { readBackupFile } from "../../src/lib/backup/read.ts";
import { writeTachibk } from "../../src/lib/backup/mihon.ts";
import { emptyDocument, serializeSync } from "../../src/lib/sync/document.ts";
import { concat, fieldMessage, fieldString } from "../../src/lib/backup/proto.ts";

const SOURCE = "2499283573021220255";

function mihonBackup() {
  return {
    gzipped: true,
    preferenceKeys: ["theme", "library_layout", "reader_mode"],
    sources: [{ sourceId: SOURCE, name: "MangaDex" }],
    stores: [{ indexUrl: "https://example.test/index.json", name: "Some repo" }],
    categories: [{ id: "1", name: "Reading", order: 0 }],
    mangas: [
      {
        source: SOURCE,
        url: "/manga/abc",
        title: "Berserk",
        genre: ["Action"],
        status: 2,
        dateAdded: 1699999999000,
        favorite: true,
        categories: ["1"],
        chapters: [
          { url: "/chapter/1", name: "Chapter 1", read: true, bookmark: false, lastPageRead: 5, dateFetch: 1699999999000, dateUpload: 0, chapterNumber: 1, sourceOrder: 0 },
        ],
        history: [{ url: "/chapter/1", lastRead: 1700000000000, readDuration: 60 }],
        tracking: [],
      },
    ],
  };
}

test("the app's own document is recognised and parsed by the sync rules", async () => {
  const doc = emptyDocument("device-a", 1700000000000);
  doc.series.push({
    id: "local:one",
    provider: "local",
    title: "A local book",
    categoryIds: [],
    at: 1700000000000,
    device: "device-a",
  });
  const bytes = new TextEncoder().encode(serializeSync(doc));

  const read = await readBackupFile(bytes, { device: "device-b" });
  assert.equal(read.kind, "hardlytracking");
  assert.equal(read.label, "HardlyTracking backup");
  assert.equal(read.doc.series.length, 1);
  assert.equal(read.doc.series[0].id, "local:one");
  assert.deepEqual(read.warnings, []);
});

test("a gzipped .tachibk is read into the same document, and says what it ignored", async () => {
  const bytes = await writeTachibk(mihonBackup());
  const read = await readBackupFile(bytes, { device: "device-b" });

  assert.equal(read.kind, "mihon");
  assert.match(read.label, /tachibk, gzipped/);
  assert.equal(read.doc.series.length, 1);
  // The id shape is the one the dalvik provider writes, so the extension can adopt the row.
  assert.equal(read.doc.series[0].id, `dalvik:${SOURCE}:/manga/abc`);
  assert.equal(read.doc.series[0].provider, "dalvik");
  assert.equal(read.doc.chapters[0].id, `dalvik:ch:${SOURCE}:/chapter/1`);
  assert.equal(read.doc.readState.length, 1);
  assert.equal(read.doc.progress[0].page, 5);
  assert.equal(read.doc.categories[0].id, "c:1");
  // The repository the series needs travels, so the confirm step can offer to add it.
  assert.equal(read.doc.repos.length, 1);

  // A written file carries no preferences (the writer drops them on purpose), so there is nothing
  // to warn about here; the warning path is covered by its own test below.
  assert.deepEqual(read.warnings, []);
});

test("settings in a real Mihon file are counted and named, never applied", async () => {
  // A minimal protobuf carrying three global preferences (field 104, `{1: key}`) and nothing else —
  // the shape a real Mihon backup has, which `writeTachibk` deliberately will not produce.
  const bytes = concat([
    fieldMessage(104, fieldString(1, "theme")),
    fieldMessage(104, fieldString(1, "library_layout")),
    fieldMessage(104, fieldString(1, "reader_mode")),
  ]);
  const read = await readBackupFile(bytes, { device: "device-b" });
  assert.equal(read.kind, "mihon");
  assert.equal(read.doc.preferences.length, 0, "another app's settings are not imported");
  assert.equal(read.warnings.length, 1);
  assert.match(read.warnings[0], /3 Mihon settings in the file were ignored/);
});

test("a bare protobuf .tachibk is accepted and labelled without the gzip note", async () => {
  const bytes = await writeTachibk(mihonBackup(), { gzip: false });
  const read = await readBackupFile(bytes, { device: "device-b" });
  assert.equal(read.kind, "mihon");
  assert.equal(read.label, "Mihon backup (.tachibk)");
  assert.equal(read.doc.series[0].title, "Berserk");
});

test("an Aidoku backup is refused by name, not called an unknown file", async () => {
  const aidoku = new TextEncoder().encode(
    JSON.stringify({ library: [], manga: [], chapters: [], history: [], date: 1700000000, version: "0.8" }),
  );
  await assert.rejects(() => readBackupFile(aidoku, { device: "device-b" }), (error) => {
    assert.match(error.message, /Aidoku backup/);
    assert.match(error.message, /not read yet/);
    return true;
  });
});

test("other JSON and an empty file are refused with a plain sentence", async () => {
  const notABackup = new TextEncoder().encode('{"hello":"world"}');
  await assert.rejects(() => readBackupFile(notABackup, { device: "device-b" }), /not a backup this app made/);

  await assert.rejects(() => readBackupFile(new Uint8Array([]), { device: "device-b" }), /empty/);

  const truncatedJson = new TextEncoder().encode('{"meta":');
  await assert.rejects(() => readBackupFile(truncatedJson, { device: "device-b" }), /truncated/);
});

test("a corrupt protobuf is named as an unreadable Mihon backup", async () => {
  const bytes = await writeTachibk(mihonBackup(), { gzip: false });
  const cut = bytes.slice(0, Math.floor(bytes.length / 2));
  await assert.rejects(() => readBackupFile(cut, { device: "device-b" }), /not a readable Mihon backup/);
});
