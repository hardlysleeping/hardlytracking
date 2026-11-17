import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { openLibraryProfile } from "../../src/api/profile.ts";
import { createProviders, providerFor } from "../../src/api/registry.ts";

/**
 * A stand-in M-Extension-Server: `/capabilities`, and one `/dalvik` surface that answers
 * `sourcesManga` (which is also the install) plus a listing, so the wiring can be walked
 * end to end without the real runtime.
 */
async function stubHost({ bridge = true } = {}) {
  const seen = [];
  const sources = [
    { id: "2499283573021220255", name: "MangaDex", lang: "en", baseUrl: "https://mangadex.org" },
    { id: "4638673959522768501", name: "MangaDex (af)", lang: "af", baseUrl: "https://mangadex.org" },
  ];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/capabilities") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(bridge ? { mangayomiMihonBridge: 1, imageProxy: true } : { hello: "world" }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ url: req.url, body });
      if (body.method === "getChapterList") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ url: "/chapter/abc", name: "Ch.1", chapter_number: 1 }]));
        return;
      }
      if (body.method !== "sourcesManga") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown method: ${body.method}`, code: 500 }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "x-mangayomi-extension-id": "12fde776sha256" });
      res.end(JSON.stringify(sources));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const apk = new Uint8Array([1, 2, 3, 4]);

test("a host that answers /capabilities gets a provider; a silent one is a warning, not a throw", async () => {
  const host = await stubHost();
  try {
    const store = new LibraryStore(memoryDatabase());
    const registered = await createProviders({ store, mihonBase: null, dalvikBase: host.baseUrl });
    assert.deepEqual(registered.providers.map((p) => p.kind), ["local", "archive", "dalvik"]);
    assert.equal(registered.warnings.length, 0);
    assert.equal(registered.dalvik?.baseUrl, host.baseUrl);
    assert.equal(providerFor(registered.providers, "dalvik:src:1").kind, "dalvik");
    // A dalvik id must never be answered by the Suwayomi provider — that is why the kinds differ.
    assert.throws(() => providerFor(registered.providers, "mihon:12"), /no mihon provider/);
  } finally {
    await host.close();
  }

  const silent = await stubHost({ bridge: false });
  try {
    const store = new LibraryStore(memoryDatabase());
    const refused = await createProviders({ store, mihonBase: null, dalvikBase: silent.baseUrl });
    assert.deepEqual(refused.providers.map((p) => p.kind), ["local", "archive"], "no provider for a host that does not advertise the bridge");
    assert.equal(refused.dalvik, null);
    assert.match(refused.warnings[0], /does not advertise the \/dalvik bridge/);
  } finally {
    await silent.close();
  }
});

test("an APK installed through the profile is kept in our database and its sources appear", async () => {
  const host = await stubHost();
  try {
    const database = memoryDatabase();
    const profile = await openLibraryProfile({ database, mihonBase: null, dalvikBase: host.baseUrl });
    assert.equal(profile.dalvik?.extensions.length, 0, "nothing installed yet");
    assert.equal((await providerFor(profile.providers, "dalvik:src:1").sources()).length, 0);

    const installed = await profile.installApk(apk, "eu.kanade.tachiyomi.extension.all.mangadex");
    assert.equal(installed.extensionId, "12fde776sha256");
    assert.equal(installed.packageId, "eu.kanade.tachiyomi.extension.all.mangadex");
    assert.equal(installed.sources.length, 2);

    // The bytes were the install: base64 on the same call surface.
    assert.equal(host.seen.at(-1).body.data, Buffer.from(apk).toString("base64"));

    // Kept, with the three fields the card asks for. The built-in row is not an APK, so it is
    // skipped here rather than making this assertion about two different kinds of extension.
    const [row] = (await profile.store.listExtensions()).filter((extension) => extension.builtin !== true);
    // `enabled` is part of the row now: an installed extension can be switched off without
    // losing its APK or its sources, so the flag has to be stored with it.
    // `apk` is the fourth: the runtime keeps APKs only in memory, so the bytes live here and can be
    // handed back when the runtime forgets a handle.
    assert.deepEqual(Object.keys(row).sort(), ["apk", "enabled", "extensionId", "packageId", "sources"]);
    assert.equal(row.enabled, true);
    assert.equal(row.extensionId, "12fde776sha256");
    assert.equal(new Uint8Array(row.apk).length, apk.length, "the bytes are stored with the row");

    // …and the sources are live without a reload of the provider.
    const sources = await providerFor(profile.providers, "dalvik:src:1").sources();
    assert.deepEqual(sources.map((s) => s.id), ["dalvik:src:2499283573021220255", "dalvik:src:4638673959522768501"]);

    // Reinstalling the same APK replaces its row instead of duplicating 61 sources.
    await profile.installApk(apk, "eu.kanade.tachiyomi.extension.all.mangadex");
    assert.equal((await profile.store.listExtensions()).filter((row) => row.builtin !== true).length, 1);
    assert.equal((await providerFor(profile.providers, "dalvik:src:1").sources()).length, 2);
  } finally {
    await host.close();
  }
});

test("a reopened app has the sources of the APK it installed last time", async () => {
  const host = await stubHost();
  try {
    const database = memoryDatabase();
    const first = await openLibraryProfile({ database, mihonBase: null, dalvikBase: host.baseUrl });
    await first.installApk(apk, "mangadex");

    const second = await openLibraryProfile({ database, mihonBase: null, dalvikBase: host.baseUrl });
    assert.equal(second.dalvik?.extensions.length, 1);
    const sources = await providerFor(second.providers, "dalvik:src:1").sources();
    assert.equal(sources.length, 2, "no APK resend needed: the row carries the source list");
  } finally {
    await host.close();
  }
});

test("with no host at all, installing refuses by name instead of failing obscurely", async () => {
  const profile = await openLibraryProfile({ database: memoryDatabase(), mihonBase: null, dalvikBase: "http://127.0.0.1:9" });
  assert.equal(profile.dalvik, null);
  assert.match(profile.warnings[0], /no extension host at/);
  await assert.rejects(profile.installApk(apk, "mangadex"), /nothing to install onto/);
});

test("a row without its key is refused, never stored under 'undefined'", async () => {
  // The browser's IndexedDB throws `DataError` here; the in-memory double has to agree, or a
  // test passes on rows the real database rejects.
  const db = memoryDatabase();
  await assert.rejects(db.put("extensions", { packageId: "mangadex", sources: [] }), /extensions row has no extensionId/);
  await db.put("extensions", { extensionId: "abc", packageId: "mangadex", sources: [] });
  assert.equal((await db.all("extensions")).length, 1);
});

test("a read mark goes to our database, and the chapter list draws it back", async () => {
  // The runtime has no read-state API, so `ownsProgress: true` has to mean the store writes.
  // A provider built without a store still refuses by name (dalvik.test.mjs); this is the
  // wired case: mark through the provider, read it back through the same provider's list.
  const host = await stubHost();
  try {
    const database = memoryDatabase();
    const profile = await openLibraryProfile({ database, mihonBase: null, dalvikBase: host.baseUrl });
    await profile.installApk(apk, "mangadex");
    const provider = providerFor(profile.providers, "dalvik:src:2499283573021220255");
    assert.equal(provider.ownsProgress, true, "the host cannot own a mark it cannot store");
    const callsAfterInstall = host.seen.length;

    const chapterId = "dalvik:ch:2499283573021220255:/chapter/abc";
    await provider.setRead(chapterId, true);
    assert.equal(await profile.store.isRead(chapterId), true);

    // Nothing was sent to the host to write a mark: a read mark is never a /dalvik call.
    assert.equal(host.seen.length, callsAfterInstall, "no call was made to write a mark");

    // …and the same provider draws it back on the list, which the runtime cannot answer.
    const chapters = await provider.chapters("dalvik:2499283573021220255:/manga/x");
    assert.deepEqual(chapters.map((c) => [c.id, c.read]), [[chapterId, true]]);

    await provider.setRead(chapterId, false);
    assert.equal(await profile.store.isRead(chapterId), false);
    assert.deepEqual((await provider.chapters("dalvik:2499283573021220255:/manga/x")).map((c) => c.read), [false]);
  } finally {
    await host.close();
  }
});

test("a capability check cancelled by a busy first paint is asked again, not called a missing host", async (t) => {
  // The shape of the desktop bug: the app's own runtime is up (its log says so), but the first
  // probe loses its 4 s clock to the main thread that is still opening the library, and the shell's
  // HTTP bridge rejects with the bare string "Request cancelled". That used to end as a warning —
  // "no extension host at …: Request cancelled", or worse, ": undefined" — for a host that answers
  // perfectly well a second later.
  const host = await stubHost();
  try {
    const database = memoryDatabase();
    let attempts = 0;
    const real = globalThis.fetch;
    const fetchImpl = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/capabilities")) {
        attempts += 1;
        if (attempts < 3) return Promise.reject("Request cancelled");
      }
      return real(input, init);
    };
    // Opened with no host at all, exactly like a shell that attaches its own runtime afterwards.
    const profile = await openLibraryProfile({ database, mihonBase: null, dalvikBase: null, fetchImpl });

    // The waits between attempts are real time; the test does not spend seven seconds on them.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
    const pending = profile.attachDalvik(host.baseUrl);
    await flush();
    t.mock.timers.tick(2_000);
    await flush();
    t.mock.timers.tick(5_000);
    await flush();
    const warning = await pending;

    assert.equal(warning, null, "the second answer attached the host");
    assert.equal(attempts, 3, "each cancelled probe was asked again");
    assert.equal(profile.dalvik?.baseUrl, host.baseUrl);
    assert.deepEqual(profile.warnings, [], "a host that answered is not reported as missing");
    assert.equal(providerFor(profile.providers, "dalvik:src:1").kind, "dalvik");
  } finally {
    t.mock.timers.reset();
    await host.close();
  }
});
