/**
 * A seen thumbnail stays seen.
 *
 * The four ways the image cache used to lose a picture it already had: an owned book's cover was
 * evicted like a downloaded copy, a login-protected cover could never be drawn with caching off,
 * the first failed draw stuck a tile on its title for the rest of the session, and the cache pruned
 * against defaults before reading the limit the reader chose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ImageCache, STORED_IMAGE_SCHEME } from "../../src/lib/cache/images.ts";
import { planEviction, CACHE_POLICY_DEFAULT } from "../../src/lib/cache/policy.ts";
import { memoryDatabase } from "../../src/lib/db/open.ts";

/** The app's own in-memory engine, so a test sees exactly which rows were written, per store. */
function memoryDb() {
  // The real engine, not a single map: a picture is a row in `imageCache` and its bytes in
  // `imageCacheData`, and a double that keys both by `key` alone silently overwrites one with the
  // other (which is exactly the bug this shape exists to avoid).
  return memoryDatabase();
}

function fakeBlob(bytes, type = "image/png") {
  const blob = new Blob([new Uint8Array(1)], { type });
  Object.defineProperty(blob, "size", { value: bytes });
  return blob;
}

/** A fetch that draws a PNG of a known size and counts its calls. */
function stubFetch(bytes = 2048) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {} });
    return {
      ok: true,
      headers: { get: () => "image/png" },
      async blob() {
        return fakeBlob(bytes);
      },
    };
  };
  return { calls, fetchImpl };
}

const MB = 1024 * 1024;

async function withGlobals(run) {
  const originalFetch = globalThis.fetch;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let counter = 0;
  URL.createObjectURL = () => `blob:test/${(counter += 1)}`;
  URL.revokeObjectURL = () => {};
  const { calls, fetchImpl } = stubFetch();
  globalThis.fetch = fetchImpl;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
}

test("a picture the app drew itself is never evicted like a downloaded copy", async () => {
  const db = memoryDb();
  const cache = new ImageCache();
  cache.attach(db, { limitBytes: 10 * MB, cacheImages: true });
  await cache.remember(`${STORED_IMAGE_SCHEME}book-1#cover`, fakeBlob(8 * MB));
  await cache.remember("https://source.example/a.jpg", fakeBlob(8 * MB));

  const entries = await cache.entries();
  const book = entries.find((row) => row.key.startsWith(STORED_IMAGE_SCHEME));
  assert.equal(book.pinned, true, "an owned book's cover must be pinned");
  assert.equal(entries.find((row) => row.key.startsWith("https://")).pinned, false);

  // 16 MB against a 10 MB ceiling: only the downloaded copy may go, and it is enough.
  assert.deepEqual(planEviction(entries, { ...CACHE_POLICY_DEFAULT, limitBytes: 10 * MB }), [
    "https://source.example/a.jpg",
  ]);
  await cache.prune();
  assert.deepEqual((await db.all("imageCache")).map((row) => row.key), [`${STORED_IMAGE_SCHEME}book-1#cover`]);
});

test("a login-protected cover is still drawn with caching switched off, and nothing is stored", async () => {
  await withGlobals(async (calls) => {
    const db = memoryDb();
    const cache = new ImageCache();
    cache.attach(db, { cacheImages: false, limitBytes: 256 * MB });

    const url = await cache.resolve("https://komga.example/api/v1/books/1/thumbnail", {
      headers: { Authorization: "Basic abc" },
    });
    assert.match(url, /^blob:test\//, "the tile must get a drawable URL");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.Authorization, "Basic abc", "the login must travel with the fetch");
    assert.equal((await db.all("imageCache")).length, 0, "caching off means no copy on disk");

    // Same session, same picture: the second tile must not fetch again.
    const again = await cache.resolve("https://komga.example/api/v1/books/1/thumbnail", {
      headers: { Authorization: "Basic abc" },
    });
    assert.equal(again, url);
    assert.equal(calls.length, 1);
  });
});

test("caching off leaves an ordinary URL alone", async () => {
  await withGlobals(async (calls) => {
    const cache = new ImageCache();
    cache.attach(memoryDb(), { cacheImages: false });
    const plain = "https://source.example/cover.jpg";
    assert.equal(await cache.resolve(plain), plain);
    assert.equal(calls.length, 0, "no fetch when there is nothing to keep");
  });
});

test("with caching on, a seen cover comes back from disk without asking the network", async () => {
  await withGlobals(async (calls) => {
    const db = memoryDb();
    const cache = new ImageCache();
    cache.attach(db, { cacheImages: true, limitBytes: 256 * MB });
    const url = "https://source.example/cover.jpg";
    const first = await cache.resolve(url);
    assert.match(first, /^blob:test\//);
    assert.equal(calls.length, 1);
    assert.equal((await db.all("imageCache")).length, 1, "the copy is kept");

    // A fresh cache object is a fresh process: the bytes must still be there.
    const reopened = new ImageCache();
    reopened.attach(db, { cacheImages: true, limitBytes: 256 * MB });
    const second = await reopened.resolve(url);
    assert.match(second, /^blob:test\//);
    assert.equal(calls.length, 1, "a stored cover must not be downloaded again");
  });
});

test("the saved ceiling is what prunes, not the default", async () => {
  const db = memoryDb();
  const cache = new ImageCache();
  // A reader who chose 1 GB must not lose copies to a 256 MB default during the first prune.
  cache.attach(db, { limitBytes: 1024 * MB, cacheImages: true });
  await withGlobals(async () => {
    for (let i = 0; i < 12; i += 1) await cache.resolve(`https://source.example/${i}.jpg`);
  });
  await cache.prune();
  assert.equal((await db.all("imageCache")).length, 12);
});
