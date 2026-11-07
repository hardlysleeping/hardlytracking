/**
 * A thumbnail does not vanish from a screen that is already showing it.
 *
 * The cache holds at most a fixed number of object URLs in memory and trims the oldest when a new
 * one arrives. It used to revoke the URL as it left the map, which broke any tile elsewhere — a
 * search grid, History, the shelf — that was still drawing that exact blob URL: the picture went
 * blank and the tile stayed on its title. The bytes were on disk the whole time.
 *
 * Two rules, tested here:
 * 1. A URL leaving the map survives one whole trim cycle before it is revoked.
 * 2. A picture that has to be resolved again after being released comes back as a fresh URL from
 *    the stored copy, without another network fetch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ImageCache } from "../../src/lib/cache/images.ts";

function memoryDb() {
  const rows = new Map();
  return {
    rows,
    async all() {
      return [...rows.values()];
    },
    async get(_store, key) {
      return rows.get(key);
    },
    async put(_store, value) {
      rows.set(value.key, value);
    },
    async remove(_store, key) {
      rows.delete(key);
      return true;
    },
  };
}

function fakeBlob(bytes = 2048, type = "image/png") {
  const blob = new Blob([new Uint8Array(1)], { type });
  Object.defineProperty(blob, "size", { value: bytes });
  return blob;
}

/** A fetch that answers a PNG and counts its calls, so "no re-download" is observable. */
function stubFetch(bytes = 2048) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
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

async function withGlobals(run) {
  const originalFetch = globalThis.fetch;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let counter = 0;
  const revoked = [];
  URL.createObjectURL = () => `blob:test/${(counter += 1)}`;
  URL.revokeObjectURL = (url) => revoked.push(url);
  const { calls, fetchImpl } = stubFetch();
  globalThis.fetch = fetchImpl;
  try {
    await run({ calls, revoked });
  } finally {
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
}

/** Resolve `count` distinct URLs, so the in-memory ceiling (160) is crossed twice. */
async function fill(cache, count) {
  const urls = [];
  for (let index = 0; index < count; index += 1) {
    const url = `https://source.example/${index}.jpg`;
    urls.push({ url, objectUrl: await cache.resolve(url) });
  }
  return urls;
}

test("a trimmed URL is revoked one generation later, never while a screen still draws it", async () => {
  await withGlobals(async ({ revoked }) => {
    const cache = new ImageCache();
    cache.attach(memoryDb(), { cacheImages: true, limitBytes: 256 * 1024 * 1024 });
    const urls = await fill(cache, 161);

    // The map had to give up its oldest entry, and that URL is still drawable right now.
    assert.equal(revoked.length, 0, "nothing is revoked in the cycle that drops it");
    assert.deepEqual(revoked, []);

    // One more resolution trims again, and only then does the first generation's bytes go.
    await cache.resolve("https://source.example/extra.jpg");
    assert.ok(revoked.length > 0, "the previous generation is released on the next trim");
    assert.equal(revoked.includes(urls[urls.length - 1].objectUrl), false, "the newest URL is untouched");
  });
});

test("a released picture comes back from the stored copy without another fetch", async () => {
  await withGlobals(async ({ calls }) => {
    const cache = new ImageCache();
    cache.attach(memoryDb(), { cacheImages: true, limitBytes: 256 * 1024 * 1024 });
    const urls = await fill(cache, 162);
    const first = urls[0];
    const before = calls.length;

    const again = await cache.reacquire(first.url);
    assert.notEqual(again, first.objectUrl, "a fresh object URL, because the old one may be revoked");
    assert.match(again, /^blob:test\//);
    assert.equal(calls.length, before, "the stored copy is a re-read, not a re-download");
  });
});

test("a URL with nothing stored is reacquired from the network once, then left alone", async () => {
  await withGlobals(async ({ calls }) => {
    const cache = new ImageCache();
    cache.attach(memoryDb(), { cacheImages: false });
    const url = "https://source.example/nothing-stored.jpg";
    const resolved = await cache.resolve(url, { headers: { Authorization: "Basic abc" } });
    assert.match(resolved, /^blob:test\//);
    const again = await cache.reacquire(url, { Authorization: "Basic abc" });
    assert.match(again, /^blob:test\//);
    assert.equal(calls.length, 2, "one fetch each time, never a loop");
  });
});

test("clearing the cache releases both the live and the retiring URLs", async () => {
  await withGlobals(async ({ revoked }) => {
    const db = memoryDb();
    const cache = new ImageCache();
    cache.attach(db, { cacheImages: true, limitBytes: 256 * 1024 * 1024 });
    await fill(cache, 165);
    await cache.clear();
    assert.equal(db.rows.size, 0);
    assert.ok(revoked.length >= 163, "every URL this session minted is revoked");
  });
});
