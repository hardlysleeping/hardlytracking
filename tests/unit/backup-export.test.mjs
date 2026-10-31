import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EXPORT_FORMATS,
  chapterUrlOf,
  documentToAidoku,
  documentToMihon,
  exportDocument,
  splitSeriesId,
} from "../../src/lib/backup/export.ts";
import { readTachibk, toDocument } from "../../src/lib/backup/mihon.ts";
import { emptyDocument } from "../../src/lib/sync/document.ts";

const SOURCE = "2499283573021220255";
const AT = 1700000000000;

/** A library with one dalvik series, two chapters, a read mark, a resume point, a shelf and a tracker. */
function library() {
  const doc = emptyDocument("device-a", AT);
  doc.categories.push({ id: "c:1", name: "Reading", order: 0, hidden: false, pinned: false, at: AT, device: "device-a" });
  doc.series.push({
    id: `dalvik:${SOURCE}:/manga/aaa`,
    provider: "dalvik",
    title: "Berserk",
    cover: "https://example.test/cover.jpg",
    author: "Kentaro Miura",
    categoryIds: ["c:1"],
    at: 1699999999000,
    device: "device-a",
  });
  doc.chapters.push(
    { id: `dalvik:ch:${SOURCE}:/chapter/1`, seriesId: `dalvik:${SOURCE}:/manga/aaa`, name: "Chapter 1", number: 1, pageCount: 20, at: 1699999999000, device: "device-a" },
    { id: `dalvik:ch:${SOURCE}:/chapter/2`, seriesId: `dalvik:${SOURCE}:/manga/aaa`, name: "Chapter 2", number: 2, pageCount: 18, at: 1699999999500, device: "device-a" },
  );
  doc.readState.push({ chapterId: `dalvik:ch:${SOURCE}:/chapter/1`, read: true, at: AT, device: "device-a" });
  doc.progress.push({ chapterId: `dalvik:ch:${SOURCE}:/chapter/2`, seriesId: `dalvik:${SOURCE}:/manga/aaa`, page: 6, total: 18, at: AT, device: "device-a" });
  doc.positions.push({ seriesId: `dalvik:${SOURCE}:/manga/aaa`, chapterId: `dalvik:ch:${SOURCE}:/chapter/2`, page: 6, at: AT, device: "device-a" });
  doc.history.push({ seriesId: `dalvik:${SOURCE}:/manga/aaa`, chapterId: `dalvik:ch:${SOURCE}:/chapter/2`, at: AT, device: "device-a" });
  doc.sourceMappings.push({ seriesId: `dalvik:${SOURCE}:/manga/aaa`, provider: "dalvik", sourceId: SOURCE, at: AT, device: "device-a" });
  doc.trackers.push({ seriesId: `dalvik:${SOURCE}:/manga/aaa`, service: "anilist", remoteId: "30002", at: AT, device: "device-a" });
  doc.repos.push({ url: "https://example.test/repo", indexUrl: "https://example.test/repo/index.json", name: "Some repo", at: AT, device: "device-a" });
  return doc;
}

test("ids split back into a source and an address, and never lose a colon", () => {
  assert.deepEqual(splitSeriesId(`dalvik:${SOURCE}:/manga/aaa`), { provider: "dalvik", sourceId: SOURCE, url: "/manga/aaa" });
  // A url with a colon in it survives: everything after the source id is the address.
  assert.equal(splitSeriesId(`dalvik:${SOURCE}:https://site.test/m/1`).url, "https://site.test/m/1");
  // A title from another provider keeps its id as the address and its provider as the source.
  assert.deepEqual(splitSeriesId("local:one"), { provider: "local", sourceId: "local", url: "local:one" });
  assert.equal(chapterUrlOf(`dalvik:ch:${SOURCE}:/chapter/1`), "/chapter/1");
  assert.equal(chapterUrlOf("local:ch:1"), "local:ch:1");
});

test("Mihon export round-trips through our own reader with every fact intact", async () => {
  const doc = library();
  const file = await exportDocument(doc, "mihon", { device: "device-a", at: AT });
  assert.equal(file.filename, "hardlytracking-2023-11-14.tachibk");
  assert.equal(file.mime, "application/octet-stream");
  assert.equal(file.bytes[0], 0x1f, "gzipped, as Mihon writes it");
  assert.equal(file.bytes[1], 0x8b);

  const backup = await readTachibk(file.bytes);
  const manga = backup.mangas[0];
  assert.equal(manga.source, SOURCE, "the 19-digit source id survives the trip out too");
  assert.equal(manga.url, "/manga/aaa");
  assert.equal(manga.title, "Berserk");
  assert.equal(manga.author, "Kentaro Miura");
  assert.deepEqual(manga.categories, ["1"]);
  assert.equal(manga.chapters.length, 2);
  assert.equal(manga.chapters[0].read, true, "the read mark lands on the chapter");
  assert.equal(manga.chapters[1].lastPageRead, 6, "the page position lands on the chapter");
  assert.equal(manga.history.length, 1);
  assert.equal(manga.tracking[0].syncId, 2, "anilist is Mihon tracker id 2");
  assert.equal(manga.tracking[0].remoteId, "30002");
  assert.equal(backup.categories[0].name, "Reading");
  assert.equal(backup.stores[0].indexUrl, "https://example.test/repo/index.json");

  // And back into a document: same ids, same marks. That is the whole promise of the pair.
  const again = toDocument(backup, { device: "device-b", at: AT });
  assert.deepEqual(again.series.map((s) => s.id), doc.series.map((s) => s.id));
  assert.deepEqual(again.chapters.map((c) => c.id), doc.chapters.map((c) => c.id));
  assert.deepEqual(again.categories.map((c) => c.name), doc.categories.map((c) => c.name));
  assert.equal(again.readState[0].read, true);
  assert.equal(again.progress[0].page, 6);
});

test("Aidoku export writes the shapes Aidoku decodes, with dates in seconds", () => {
  const doc = library();
  const backup = documentToAidoku(doc, AT);

  assert.equal(backup.version, "1");
  assert.equal(backup.automatic, false);
  // Aidoku decodes with `.secondsSince1970`: milliseconds here would put every date in the year 55000.
  assert.equal(backup.date, 1700000000);

  assert.equal(backup.library.length, 1);
  const entry = backup.library[0];
  assert.equal(entry.mangaId, "/manga/aaa");
  assert.equal(entry.sourceId, SOURCE);
  assert.equal(entry.dateAdded, 1699999999);
  assert.deepEqual(entry.categories, ["Reading"], "Aidoku files a title under category names, not ids");
  assert.equal(entry.lastRead, 1700000000);

  assert.equal(backup.manga.length, 1);
  assert.equal(backup.manga[0].title, "Berserk");
  assert.equal(backup.manga[0].cover, "https://example.test/cover.jpg");
  assert.equal(backup.manga[0].status, 0, "an unknown status is 0, never a guess");

  assert.equal(backup.chapters.length, 2);
  assert.equal(backup.chapters[1].id, "/chapter/2");
  assert.equal(backup.chapters[1].chapter, 2);

  // History carries read chapters and resume points; a chapter nobody opened is not history.
  assert.equal(backup.history.length, 2);
  const read = backup.history.find((h) => h.chapterId === "/chapter/1");
  assert.equal(read.completed, true);
  const partial = backup.history.find((h) => h.chapterId === "/chapter/2");
  assert.equal(partial.completed, false);
  assert.equal(partial.progress, 6);
  assert.equal(partial.total, 18);

  assert.deepEqual(backup.categories, ["Reading"]);
  assert.deepEqual(backup.sources, [SOURCE]);
  assert.deepEqual(backup.sourceLists, ["https://example.test/repo"]);
});

test("the three formats the app writes are offered, and the two it does not say why", () => {
  const ready = EXPORT_FORMATS.filter((f) => f.ready).map((f) => f.kind);
  assert.deepEqual(ready, ["hardlytracking", "mihon", "aidoku"]);
  for (const format of EXPORT_FORMATS.filter((f) => !f.ready)) {
    assert.equal(typeof format.why, "string");
    assert.ok((format.why ?? "").length > 40, `${format.kind} must explain what is missing`);
  }
});

test("a format that is not written refuses instead of producing a file", async () => {
  const doc = library();
  for (const kind of ["suwatte", "paperback"]) {
    await assert.rejects(() => exportDocument(doc, kind, { device: "device-a", at: AT }), /not written yet/);
  }
});

test("the app's own export is the same document the import reads", async () => {
  const doc = library();
  const file = await exportDocument(doc, "hardlytracking", { device: "device-a", at: AT });
  assert.equal(file.filename, "hardlytracking-2023-11-14.json");
  const parsed = JSON.parse(new TextDecoder().decode(file.bytes));
  assert.equal(parsed.meta.format, doc.meta.format);
  assert.equal(parsed.series.length, 1);
  assert.equal(parsed.series[0].id, doc.series[0].id);
});
