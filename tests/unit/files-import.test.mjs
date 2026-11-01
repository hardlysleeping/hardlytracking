/**
 * Importing an owned comic: one row, one chapter, one cover.
 *
 * The file here is a real RAR 5 archive written by `rar a -m3` (the same fixture the CBR test uses),
 * imported through the app's own importer into the app's own store. What is stubbed is only the
 * drawing of the cover — a canvas is not something a test can assert on.
 *
 * The last four tests are about the part a passing import hides: a file that never opens, a cover that
 * never finishes, and the progress line in between. Those are the "Adding…" forever cases, and they
 * are deterministic here because the deadlines are injected in milliseconds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { imageCache } from "../../src/lib/cache/images.ts";
import { COVER_DEADLINE_MS, describeProgress, importComicFiles, fileSeriesId, fileChapterId } from "../../src/lib/files/import.ts";
import { COVER_WIDTH, coverFromBook, coverKey } from "../../src/lib/files/cover.ts";
import { openComic } from "../../src/lib/files/index.ts";
import { RUNTIME_DEADLINE_MS } from "../../src/lib/deadline.ts";
import { RAR5_CBR as RAR5_CBR_BASE64 } from "./cbr-fixtures.mjs";

/** `rar a -m3` over three 1×1 PNGs: pages/001..003.png. */
const RAR5_CBR = Buffer.from(RAR5_CBR_BASE64, "base64");

const wasm = readFileSync("node_modules/node-unrar-js/dist/js/unrar.wasm");
const wasmBinary = async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength);

/** A stand-in for a drawn cover: three bytes, enough to prove it travelled. */
const picture = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });

function freshStore() {
  const store = new LibraryStore(memoryDatabase());
  imageCache.attach(store.database);
  return store;
}

const file = (name, bytes) => new File([bytes], name, { type: "application/octet-stream" });

test("a .cbr becomes a title, a chapter and a cover, and says it is a RAR", async () => {
  const store = freshStore();
  const result = await importComicFiles(store, [file("Saga v01.cbr", RAR5_CBR)], {
    wasm: wasmBinary,
    cover: async () => picture(),
  });
  assert.deepEqual(result, { added: 1, skipped: [], errors: [] });

  const seriesId = fileSeriesId("Saga v01.cbr", RAR5_CBR.length);
  const series = await store.getSeries(seriesId);
  assert.equal(series?.title, "Saga v01");
  // The shelf row points at the cache, not at a file path and not at the network.
  assert.equal(series?.cover, coverKey(seriesId));

  const chapters = await store.listChapters(seriesId);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].id, fileChapterId(seriesId));
  assert.equal(chapters[0].pageCount, 3);

  const book = await store.getBook(seriesId);
  assert.equal(book?.kind, "cbr");
  assert.equal(book?.pageCount, 3);
});

test("the cover is a picture the shelf can actually load", async () => {
  const store = freshStore();
  await importComicFiles(store, [file("Saga v01.cbr", RAR5_CBR)], { wasm: wasmBinary, cover: async () => picture() });
  const seriesId = fileSeriesId("Saga v01.cbr", RAR5_CBR.length);
  // `resolve` is what `Cover.svelte` asks; a book cover must come back as a blob, not as a URL to
  // fetch — there is nothing to fetch.
  const src = await imageCache.resolve(coverKey(seriesId));
  assert.match(src, /^blob:/);
  // And it is served whether or not the network-cover cache is switched on.
  imageCache.setPolicy({ cacheImages: false });
  try {
    assert.match(await imageCache.resolve(coverKey(seriesId)), /^blob:/);
  } finally {
    imageCache.setPolicy({ cacheImages: true });
  }
});

test("a cover that cannot be drawn does not fail the import", async () => {
  const store = freshStore();
  const result = await importComicFiles(store, [file("Berserk v01.cbr", RAR5_CBR)], {
    wasm: wasmBinary,
    cover: async () => null,
  });
  assert.deepEqual(result, { added: 1, skipped: [], errors: [] });
  const seriesId = fileSeriesId("Berserk v01.cbr", RAR5_CBR.length);
  // No cover key at all: the tile draws the title, which is what it did before covers existed.
  assert.equal((await store.getSeries(seriesId))?.cover, undefined);
});

test("a cover that throws does not fail the import either", async () => {
  const store = freshStore();
  const result = await importComicFiles(store, [file("Akira v01.cbr", RAR5_CBR)], {
    wasm: wasmBinary,
    cover: async () => {
      throw new Error("no canvas here");
    },
  });
  assert.equal(result.added, 1);
  assert.deepEqual(result.errors, []);
});

test("picking the same file twice is a skip, not a second row", async () => {
  const store = freshStore();
  const first = await importComicFiles(store, [file("Saga v01.cbr", RAR5_CBR)], { wasm: wasmBinary, cover: async () => picture() });
  const second = await importComicFiles(store, [file("Saga v01.cbr", RAR5_CBR)], { wasm: wasmBinary, cover: async () => picture() });
  assert.equal(first.added, 1);
  assert.deepEqual(second, { added: 0, skipped: ["Saga v01.cbr"], errors: [] });
  assert.equal((await store.listSeries()).length, 1);
});

test("a .cbr that is not a RAR lands in errors, by name", async () => {
  const store = freshStore();
  const result = await importComicFiles(store, [file("not really.cbr", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))], {
    wasm: wasmBinary,
  });
  assert.equal(result.added, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^not really\.cbr: this file is not a RAR archive$/);
  assert.equal((await store.listSeries()).length, 0);
});

test("a file that never opens is named in errors after its deadline, and the next one still imports", async () => {
  const store = freshStore();
  const started = Date.now();
  const result = await importComicFiles(store, [file("stuck.pdf", new Uint8Array([1, 2, 3])), file("Saga v01.cbr", RAR5_CBR)], {
    cover: async () => picture(),
    openDeadlineMs: 500,
    // The stuck one never opens at all — the shape of a pdf.js parse that does not come back.
    open: (target, name) =>
      name === "stuck.pdf" ? new Promise(() => {}) : openComic(target, name, { wasm: wasmBinary }),
  });
  assert.ok(Date.now() - started < 3000, "the deadline did not end the wait");
  assert.equal(result.added, 1, "one dead file took the rest of the pick with it");
  assert.deepEqual(result.skipped, []);
  assert.equal(result.errors.length, 1);
  // Named, in seconds, and not in a server's words: this is a file, not a host.
  assert.match(result.errors[0], /^stuck\.pdf: still not read after \d+ s — the file may be damaged/);
  assert.equal((await store.listSeries()).length, 1);
  assert.equal(await store.getBook(fileSeriesId("stuck.pdf", 3)), undefined, "a file that never opened left a row behind");
});

test("a cover that never finishes becomes the title tile — it never drops the book", async () => {
  assert.ok(COVER_DEADLINE_MS < RUNTIME_DEADLINE_MS, "a cover may not outlast the file it belongs to");
  const store = freshStore();
  const started = Date.now();
  const result = await importComicFiles(store, [file("Blame v01.cbr", RAR5_CBR)], {
    wasm: wasmBinary,
    cover: () => new Promise(() => {}),
    coverDeadlineMs: 40,
  });
  assert.ok(Date.now() - started < 2000, "the cover deadline did not end the wait");
  assert.deepEqual(result, { added: 1, skipped: [], errors: [] });
  // The book is here with no cover: the shelf draws the title, which is the pre-cover behaviour.
  const seriesId = fileSeriesId("Blame v01.cbr", RAR5_CBR.length);
  assert.equal((await store.getSeries(seriesId))?.cover, undefined);
  assert.match((await store.getBook(seriesId))?.name ?? "", /Blame/);
});

test("progress names the file and the step, from reading to saving", async () => {
  const store = freshStore();
  const seen = [];
  const result = await importComicFiles(store, [file("Saga v01.cbr", RAR5_CBR), file("Akira v01.cbr", RAR5_CBR)], {
    wasm: wasmBinary,
    cover: async () => picture(),
    onProgress: (step) => seen.push(step),
  });
  assert.equal(result.added, 2);
  assert.deepEqual(
    seen.map((step) => `${step.index}/${step.total} ${step.name} ${step.stage}`),
    [
      "1/2 Saga v01.cbr reading",
      "1/2 Saga v01.cbr cover",
      "1/2 Saga v01.cbr saving",
      "2/2 Akira v01.cbr reading",
      "2/2 Akira v01.cbr cover",
      "2/2 Akira v01.cbr saving",
    ],
  );
  assert.equal(describeProgress(seen[1]), "Drawing the cover of Saga v01.cbr · 1 of 2");
  // One file needs no count: the line is about what is happening, not bookkeeping.
  assert.equal(describeProgress({ index: 1, total: 1, name: "one.cbz", stage: "reading" }), "Reading one.cbz");
});

test("a cover asks for a page at cover size, not at the reader's", async () => {
  let asked;
  const book = {
    kind: "pdf",
    pageCount: 133,
    open: async (index, request) => {
      asked = { index, request };
      return new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    },
    close: () => {},
  };
  // Nothing is drawn here — the runner has no canvas. What matters is the size that was asked for:
  // twice a 400 px tile is sharp, and a 2550 pt page box would otherwise be drawn 5100 px wide.
  await coverFromBook(book);
  assert.equal(asked.index, 0);
  assert.equal(asked.request?.maxWidth, COVER_WIDTH * 2);
});
