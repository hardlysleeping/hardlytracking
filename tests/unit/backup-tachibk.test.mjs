import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chapterIdOf,
  gzip,
  isGzipped,
  readTachibk,
  seriesIdOf,
  toDocument,
  trackerName,
  writeTachibk,
} from "../../src/lib/backup/mihon.ts";
import { ProtoError, readFields, varintToString } from "../../src/lib/backup/proto.ts";

// A source id that is past Number.MAX_SAFE_INTEGER (9007199254740991). It must survive every read
// as this exact string; rounding it is how an imported library loses its source.
const BIG_SOURCE = "2499283573021220255";

function sample() {
  return {
    gzipped: true,
    preferenceKeys: ["theme", "library_layout"],
    sources: [{ sourceId: BIG_SOURCE, name: "MangaDex" }],
    stores: [{ indexUrl: "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json", name: "Keiyoushi" }],
    categories: [
      { id: "1", name: "Reading", order: 0 },
      { id: "2", name: "On hold", order: 1 },
    ],
    mangas: [
      {
        source: BIG_SOURCE,
        url: "/manga/1c1f8e5b-a1b2",
        title: "Berserk",
        author: "Kentaro Miura",
        genre: ["Action", "Horror"],
        status: 2,
        thumbnailUrl: "https://uploads.mangadex.org/covers/x.jpg",
        dateAdded: 1699999999000,
        favorite: true,
        categories: ["1", "2"],
        chapters: [
          {
            url: "/chapter/a1",
            name: "Chapter 1",
            read: true,
            bookmark: false,
            lastPageRead: 12,
            dateFetch: 1699999999000,
            dateUpload: 1690000000000,
            chapterNumber: 1,
            sourceOrder: 0,
          },
          {
            url: "/chapter/a2",
            name: "Chapter 2",
            read: false,
            bookmark: true,
            lastPageRead: 0,
            dateFetch: 1700000000000,
            dateUpload: 0,
            chapterNumber: 2,
            sourceOrder: 1,
          },
        ],
        history: [
          { url: "/chapter/a1", lastRead: 1700000000000, readDuration: 120 },
          { url: "/chapter/a2", lastRead: 1700000900000, readDuration: 30 },
        ],
        tracking: [
          { syncId: 2, remoteId: "30002", title: "Berserk", lastChapterRead: 1, score: 9, status: 1 },
        ],
      },
    ],
  };
}

test("a written backup reads back with its ids exact", async () => {
  const backup = sample();
  const bytes = await writeTachibk(backup);
  assert.ok(isGzipped(bytes), "gzipped by default, like Mihon");

  const read = await readTachibk(bytes);
  assert.equal(read.gzipped, true);
  assert.equal(read.mangas.length, 1);
  const manga = read.mangas[0];
  // The whole point: 19 digits, exact.
  assert.equal(manga.source, BIG_SOURCE);
  assert.equal(manga.source, "2499283573021220255");
  assert.equal(manga.title, "Berserk");
  assert.equal(manga.author, "Kentaro Miura");
  assert.deepEqual(manga.genre, ["Action", "Horror"]);
  assert.equal(manga.status, 2);
  assert.equal(manga.dateAdded, 1699999999000);
  assert.deepEqual(manga.categories, ["1", "2"]);
  assert.equal(manga.chapters.length, 2);
  assert.equal(manga.chapters[0].name, "Chapter 1");
  assert.equal(manga.chapters[0].read, true);
  assert.equal(manga.chapters[0].lastPageRead, 12);
  assert.equal(manga.chapters[1].bookmark, true);
  assert.equal(manga.chapters[1].chapterNumber, 2);
  assert.equal(manga.history.length, 2);
  assert.equal(manga.history[1].readDuration, 30);
  assert.equal(manga.tracking[0].remoteId, "30002");
  assert.equal(manga.tracking[0].score, 9);
  assert.equal(read.categories.length, 2);
  assert.equal(read.sources[0].sourceId, BIG_SOURCE);
  assert.equal(read.stores[0].name, "Keiyoushi");
  // Global preferences are counted for the report, never applied and never written back: another
  // app's settings are not ours, so a round-trip drops them deliberately.
  assert.deepEqual(read.preferenceKeys, []);
});

test("the bare protobuf form round-trips too, and keeps its container", async () => {
  const bytes = await writeTachibk(sample(), { gzip: false });
  assert.equal(isGzipped(bytes), false);
  const read = await readTachibk(bytes);
  assert.equal(read.gzipped, false);
  assert.equal(read.mangas[0].source, BIG_SOURCE);
  // Re-exporting without an explicit choice writes the container it was given.
  const again = await writeTachibk(read);
  assert.equal(isGzipped(again), false);
});

test("a JSON file is refused with the same sentence Mihon uses", async () => {
  const json = new TextEncoder().encode('{"backupManga":[]}');
  await assert.rejects(() => readTachibk(json), (error) => {
    assert.ok(error instanceof ProtoError);
    assert.match(error.message, /JSON backup/);
    return true;
  });
});

test("a truncated file throws instead of inventing rows", async () => {
  const bytes = await writeTachibk(sample(), { gzip: false });
  const cut = bytes.slice(0, Math.floor(bytes.length / 2));
  await assert.rejects(() => readTachibk(cut), ProtoError);
});

test("varints are exact past the float limit", () => {
  const body = new Uint8Array([0x08]); // field 1, varint
  const value = 2499283573021220255n;
  const encoded = new Uint8Array([...body, ...encodeVarintForTest(value)]);
  const fields = readFields(encoded);
  assert.equal(varintToString(fields[0].value), "2499283573021220255");
  // The lossy conversion is visibly wrong — that is why nothing calls it for an id.
  assert.notEqual(String(Number(fields[0].value)), "2499283573021220255");
});

// Local copy of the varint encoder so the test does not depend on the writer's field helpers.
function encodeVarintForTest(value) {
  const out = [];
  let v = value;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return new Uint8Array(out);
}

test("a backup becomes the app's own document", async () => {
  const backup = await readTachibk(await writeTachibk(sample()));
  const doc = toDocument(backup, { device: "test-device", at: 1700000000000 });

  const manga = backup.mangas[0];
  const seriesId = seriesIdOf(manga);
  assert.equal(seriesId, `dalvik:${BIG_SOURCE}:/manga/1c1f8e5b-a1b2`);

  assert.equal(doc.series.length, 1);
  assert.equal(doc.series[0].id, seriesId);
  assert.equal(doc.series[0].provider, "dalvik");
  assert.equal(doc.series[0].title, "Berserk");
  assert.deepEqual(doc.series[0].categoryIds, ["c:1", "c:2"]);
  // The series keeps the date it was added, not the import time.
  assert.equal(doc.series[0].at, 1699999999000);

  assert.equal(doc.categories.length, 2);
  assert.equal(doc.categories[0].id, "c:1");
  assert.equal(doc.categories[1].name, "On hold");

  assert.equal(doc.chapters.length, 2);
  assert.equal(doc.chapters[0].id, chapterIdOf(manga, "/chapter/a1"));
  assert.equal(doc.chapters[0].number, 1);
  // Mihon stores no page count; 0 is "unknown", never "empty".
  assert.equal(doc.chapters[0].pageCount, 0);

  // Read state is its own row, and only for chapters that were read.
  assert.equal(doc.readState.length, 1);
  assert.equal(doc.readState[0].chapterId, chapterIdOf(manga, "/chapter/a1"));
  assert.equal(doc.readState[0].read, true);

  // Resume point from lastPageRead, and only where there is one. Continue Reading reads
  // `positions`, so the import must produce one — a progress row alone leaves the strip empty.
  assert.equal(doc.progress.length, 1);
  assert.equal(doc.progress[0].page, 12);
  assert.equal(doc.progress[0].total, 0);
  assert.equal(doc.positions.length, 1);
  assert.equal(doc.positions[0].seriesId, seriesId);
  assert.equal(doc.positions[0].chapterId, chapterIdOf(manga, "/chapter/a1"));
  assert.equal(doc.positions[0].page, 12);

  // History is newest first, as the app's own list is.
  assert.equal(doc.history.length, 2);
  assert.equal(doc.history[0].at, 1700000900000);
  assert.equal(doc.history[1].at, 1700000000000);

  // The source a reinstall needs.
  assert.equal(doc.sourceMappings[0].sourceId, BIG_SOURCE);
  assert.equal(doc.sourceMappings[0].provider, "dalvik");

  // Trackers land as names, not raw sync ids.
  assert.equal(doc.trackers[0].service, "anilist");
  assert.equal(doc.trackers[0].remoteId, "30002");

  // The repository the series needs travels, so the import can offer to add it.
  assert.equal(doc.repos.length, 1);
  assert.equal(doc.repos[0].url, "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json");

  // Nothing from another app's settings, and no APK, ever.
  assert.equal(doc.preferences.length, 0);
  assert.equal(doc.extensions.length, 0);
});

test("tracker ids without a name become an honest label", () => {
  assert.equal(trackerName(2), "anilist");
  assert.equal(trackerName(1), "myanimelist");
  assert.equal(trackerName(99), "tracker:99");
});
