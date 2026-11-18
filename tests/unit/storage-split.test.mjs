/**
 * Bytes and descriptions live in different rows.
 *
 * Every store here used to hold one row per picture, page or comic file: the description *and* the
 * image. That is fine until something wants only the description — listing a shelf, counting a
 * chapter's pages at launch, marking a cover "seen just now" — and pays for the bytes anyway, through
 * a base64 encode on the way out and a decode on the way in.
 *
 * Two rules, tested here:
 * 1. A metadata read never touches the bytes store.
 * 2. A metadata write never rewrites the bytes.
 * 3. Rows written before the split still read, and are not rewritten behind the user's back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { ImageCache } from "../../src/lib/cache/images.ts";
import { SqliteDatabase } from "../../src/lib/db/sqlite.ts";

/** The engine, with a record of which store each call touched. */
function spyDatabase() {
  const db = memoryDatabase();
  const touched = [];
  return {
    touched,
    db: {
      get: (store, key) => {
        touched.push(`get ${store}`);
        return db.get(store, key);
      },
      put: (store, value) => {
        touched.push(`put ${store}`);
        return db.put(store, value);
      },
      all: (store) => {
        touched.push(`all ${store}`);
        return db.all(store);
      },
      prefix: (store, prefix) => {
        touched.push(`prefix ${store}`);
        return db.prefix(store, prefix);
      },
      remove: (store, key) => {
        touched.push(`remove ${store}`);
        return db.remove(store, key);
      },
    },
    raw: db,
  };
}

function blob(bytes = 16, type = "image/png") {
  return new Blob([new Uint8Array(bytes)], { type });
}

function bookRow(seriesId, extra = {}) {
  return {
    seriesId,
    chapterId: `${seriesId}#1`,
    name: `${seriesId}.cbz`,
    kind: "cbz",
    pageCount: 12,
    bytes: 4096,
    blob: blob(64),
    addedAt: 1,
    ...extra,
  };
}

test("listing a shelf never reads a comic file", async () => {
  const spy = spyDatabase();
  const store = new LibraryStore(spy.db);
  await store.putBook(bookRow("a"));
  await store.putBook(bookRow("b"));
  spy.touched.length = 0;

  const rows = await store.listBookMetadata();
  assert.deepEqual(rows.map((row) => row.seriesId).sort(), ["a", "b"]);
  assert.equal(rows[0].blob, undefined, "the metadata listing carried the file");
  assert.equal(rows[0].bytes, 4096, "the size a shelf needs is still there");
  assert.deepEqual(spy.touched, ["all books"], `a metadata listing read ${spy.touched.join(", ")}`);
});

test("a book is stored as a description and a file, and comes back whole", async () => {
  const spy = spyDatabase();
  const store = new LibraryStore(spy.db);
  await store.putBook(bookRow("a"));
  assert.deepEqual(spy.touched.filter((call) => call.startsWith("put")), ["put books", "put bookFiles"]);

  spy.touched.length = 0;
  const whole = await store.getBook("a");
  assert.equal(whole.blob.size, 64, "the file did not come back with the row");
  assert.equal(whole.pageCount, 12);
  assert.ok(spy.touched.includes("get bookFiles"), "getBook skipped the bytes");
});

test("a book that points at another app's file stores no bytes of ours", async () => {
  const spy = spyDatabase();
  const store = new LibraryStore(spy.db);
  await store.putBook(bookRow("owned"));
  await store.putBook(bookRow("indexed", { blob: undefined, location: { kind: "mihondl", path: "x", format: "folder", ext: "" } }));
  assert.equal((await spy.raw.all("bookFiles")).length, 1, "an indexed book left a file row behind");
});

test("removing a book removes its file too", async () => {
  const spy = spyDatabase();
  const store = new LibraryStore(spy.db);
  await store.putBook(bookRow("a"));
  await store.removeBook("a");
  assert.equal((await spy.raw.all("books")).length, 0);
  assert.equal((await spy.raw.all("bookFiles")).length, 0, "the file stayed after the book was removed");
});

test("one chapter's pages cost one chapter, not the whole download folder", async () => {
  const spy = spyDatabase();
  const store = new LibraryStore(spy.db);
  for (const chapter of ["c1", "c2", "c3"]) {
    for (let index = 0; index < 3; index += 1) {
      await store.putDownloadPage({ id: `${chapter}#${index}`, chapterId: chapter, index, blob: blob(8) });
    }
  }
  spy.touched.length = 0;

  const meta = await store.downloadPageMeta("c2");
  assert.deepEqual(meta.map((row) => row.index).sort(), [0, 1, 2]);
  assert.equal(meta[0].bytes, 8, "the page's size is recorded, so a reconcile needs no blob");
  assert.equal(meta[0].blob, undefined);
  assert.deepEqual(spy.touched, ["prefix downloadPages"], `reading one chapter used ${spy.touched.join(", ")}`);
});

test("a chapter id that looks like a LIKE pattern does not collect another chapter", async () => {
  const spy = spyDatabase();
  const store = new LibraryStore(spy.db);
  await store.putDownloadPage({ id: "c_x#0", chapterId: "c_x", index: 0, blob: blob(4) });
  await store.putDownloadPage({ id: "cax#0", chapterId: "cax", index: 0, blob: blob(4) });
  const rows = await store.downloadPageMeta("c_x");
  assert.deepEqual(rows.map((row) => row.chapterId), ["c_x"], "the underscore matched a wildcard");
});

test("the launch reconcile reads page sizes, never page images", async () => {
  const spy = spyDatabase();
  const store = new LibraryStore(spy.db);
  await store.putDownloadPage({ id: "c1#0", chapterId: "c1", index: 0, blob: blob(32) });
  spy.touched.length = 0;

  const meta = await store.allDownloadPageMeta();
  assert.equal(meta.length, 1);
  assert.equal(meta[0].bytes, 32);
  assert.deepEqual(spy.touched, ["all downloadPages"], `the reconcile read ${spy.touched.join(", ")}`);
});

test("the reader still gets the pages themselves, by chapter", async () => {
  const spy = spyDatabase();
  const store = new LibraryStore(spy.db);
  await store.putDownloadPage({ id: "c1#0", chapterId: "c1", index: 0, blob: blob(8) });
  await store.putDownloadPage({ id: "c1#1", chapterId: "c1", index: 1, blob: blob(8) });
  await store.putDownloadPage({ id: "c2#0", chapterId: "c2", index: 0, blob: blob(8) });

  const pages = await store.listDownloadPages("c1");
  assert.deepEqual(pages.map((page) => page.index), [0, 1]);
  assert.equal(pages[0].blob.size, 8);
});

test("removing a download removes both halves of every page", async () => {
  const spy = spyDatabase();
  const store = new LibraryStore(spy.db);
  await store.putDownload({ chapterId: "c1", seriesId: "s", chapterName: "1", pages: 2, bytes: 16, at: 1 });
  for (const index of [0, 1]) {
    await store.putDownloadPage({ id: `c1#${index}`, chapterId: "c1", index, blob: blob(8) });
  }
  await store.removeDownload("c1");
  assert.equal((await spy.raw.all("downloadPages")).length, 0);
  assert.equal((await spy.raw.all("downloadPageData")).length, 0, "the page images outlived the download");
});

test("moving a chapter's pages moves its bytes and leaves the neighbours alone", async () => {
  const spy = spyDatabase();
  const store = new LibraryStore(spy.db);
  await store.putDownload({ chapterId: "old", seriesId: "s", chapterName: "1", pages: 1, bytes: 8, at: 1 });
  await store.putDownloadPage({ id: "old#0", chapterId: "old", index: 0, blob: blob(8) });
  await store.putDownloadPage({ id: "other#0", chapterId: "other", index: 0, blob: blob(8) });
  await store.rekeyDownload("old", "new");

  const moved = await store.listDownloadPages("new");
  assert.deepEqual(moved.map((page) => page.index), [0]);
  assert.equal((await spy.raw.all("downloadPages")).filter((row) => row.chapterId === "old").length, 0);
  assert.equal((await spy.raw.all("downloadPages")).filter((row) => row.chapterId === "other").length, 1);
  assert.equal((await spy.raw.all("downloadPageData")).filter((row) => row.id === "old#0").length, 0, "the old bytes stayed");
});

test("a row written before the split is still read, and is not rewritten", async () => {
  const spy = spyDatabase();
  const store = new LibraryStore(spy.db);
  // The old shape: the blob inside the row, nothing in the bytes store.
  await spy.raw.put("books", { ...bookRow("legacy"), blob: blob(40) });
  await spy.raw.put("downloadPages", { id: "c1#0", chapterId: "c1", index: 0, blob: blob(24) });

  const rows = await store.listBookMetadata();
  assert.equal(rows[0].blob, undefined, "the listing carried the file");
  const whole = await store.getBook("legacy");
  assert.equal(whole.blob.size, 40, "an old book lost its file");
  const pages = await store.listDownloadPages("c1");
  assert.equal(pages[0].blob.size, 24, "an old page lost its bytes");

  // Reading did not write: an old row stays where it is until something writes it again.
  assert.equal((await spy.raw.all("bookFiles")).length, 0);
  assert.equal((await spy.raw.all("downloadPageData")).length, 0);
});

test("marking a cover seen does not rewrite its bytes", async () => {
  const spy = spyDatabase();
  const cache = new ImageCache();
  cache.attach(spy.db, { cacheImages: true, limitBytes: 256 * 1024 * 1024 });
  const url = "https://source.example/cover.jpg";
  await spy.raw.put("imageCache", { key: url, bytes: 2400, at: 1, usedAt: 1 });
  await spy.raw.put("imageCacheData", { key: url, blob: blob(2400) });
  const before = await spy.raw.get("imageCacheData", url);

  spy.touched.length = 0;
  // A hit is a resolve that finds the row: that is what marks it seen.
  const drawn = await cache.resolve(url);
  assert.match(drawn, /^blob:/, "the stored cover did not resolve");
  await new Promise((resolve) => setTimeout(resolve, 0)); // `touch` is fire-and-forget
  assert.deepEqual(spy.touched, ["get imageCache", "get imageCacheData", "get imageCache", "put imageCache"], `a touch wrote ${spy.touched.join(", ")}`);
  assert.equal(spy.touched.includes("put imageCacheData"), false, "marking a cover seen rewrote its bytes");
  const row = await spy.raw.get("imageCache", url);
  assert.ok(row.usedAt > 1, "the row was not marked as seen");
  assert.equal(row.bytes, 2400, "the touch lost the size");
  const after = await spy.raw.get("imageCacheData", url);
  assert.equal(after, before, "the bytes row was rewritten by a touch");
});

test("the SQLite engine answers a prefix read with the rows in it, and no others", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ht-prefix-"));
  const file = join(dir, "prefix.db");
  const sql = new DatabaseSync(file);
  // `$1, $2, …` (the plugin's sqlx) to node:sqlite's positional `?`.
  const bind = (query, values = []) =>
    sql.prepare(query.replace(/\$\d+/g, "?")).all(...[...query.matchAll(/\$(\d+)/g)].map((m) => values[Number(m[1]) - 1]));
  const run = (query, values = []) =>
    sql.prepare(query.replace(/\$\d+/g, "?")).run(...[...query.matchAll(/\$(\d+)/g)].map((m) => values[Number(m[1]) - 1]));
  const connect = async () => ({
    execute: async (query, values) => {
      run(query, values);
    },
    select: async (query, values) => bind(query, values),
  });
  try {
    const db = await SqliteDatabase.open("prefix", connect);
    await db.put("downloadPages", { id: "c1#0", chapterId: "c1", index: 0, bytes: 8 });
    await db.put("downloadPages", { id: "c1#1", chapterId: "c1", index: 1, bytes: 8 });
    await db.put("downloadPages", { id: "c10#0", chapterId: "c10", index: 0, bytes: 8 });
    await db.put("downloadPages", { id: "c_1#0", chapterId: "c_1", index: 0, bytes: 8 });

    const rows = await db.prefix("downloadPages", "c1#");
    assert.deepEqual(rows.map((row) => row.id).sort(), ["c1#0", "c1#1"]);
    const underscored = await db.prefix("downloadPages", "c_1#");
    assert.deepEqual(underscored.map((row) => row.id), ["c_1#0"], "the underscore acted as a wildcard");
    assert.equal((await db.prefix("downloadPages", "nothing#")).length, 0);
  } finally {
    sql.close();
    rmSync(dir, { recursive: true, force: true });
  }
});