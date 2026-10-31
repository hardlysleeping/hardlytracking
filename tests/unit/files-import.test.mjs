/**
 * Importing an owned comic: one row, one chapter, one cover.
 *
 * The file here is a real RAR 5 archive written by `rar a -m3` (the same fixture the CBR test uses),
 * imported through the app's own importer into the app's own store. What is stubbed is only the
 * drawing of the cover — a canvas is not something a test can assert on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { imageCache } from "../../src/lib/cache/images.ts";
import { importComicFiles, fileSeriesId, fileChapterId } from "../../src/lib/files/import.ts";
import { coverKey } from "../../src/lib/files/cover.ts";
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
