/**
 * Built-in extensions: preinstalled, visible, switchable, never re-enabled behind the user's back.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_ARCHIVE_ID, BUILTIN_EXTENSIONS, builtinEnabled, ensureBuiltinExtensions, isBuiltin } from "../../src/api/builtin.ts";
import { createArchiveProvider } from "../../src/api/archive.ts";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { createProviders, providerFor } from "../../src/api/registry.ts";
import { extensionSourceIds } from "../../src/lib/extensions/installed.ts";

function store() {
  return new LibraryStore(memoryDatabase());
}

test("the built-ins are archive.org and the HT-Server, and nothing else", () => {
  assert.equal(BUILTIN_EXTENSIONS.length, 2);
  assert.deepEqual(
    BUILTIN_EXTENSIONS.map((entry) => entry.extensionId),
    ["builtin:internet-archive", "builtin:ht-server"],
  );
  // The Mihon runtime is a service the app talks to, not an extension anyone can uninstall.
  assert.equal(BUILTIN_EXTENSIONS.some((entry) => /mihon|runtime/i.test(entry.name)), false);
  const row = BUILTIN_EXTENSIONS[0];
  assert.equal(row.extensionId, BUILTIN_ARCHIVE_ID);
  assert.equal(row.builtin, true);
  assert.equal(row.enabled, true);
  assert.equal(row.name, "Internet Archive");
  assert.deepEqual(row.sources.map((source) => source.id), ["archive:src:texts"]);
  assert.equal(isBuiltin(BUILTIN_ARCHIVE_ID), true);
  assert.equal(isBuiltin("12fde776sha256"), false);
});

test("a fresh install gets the row, and seeding twice does not duplicate it", async () => {
  const library = store();
  const first = await ensureBuiltinExtensions(library);
  assert.equal(first.length, 2, "archive.org and the read server");
  assert.equal(first[0].extensionId, BUILTIN_ARCHIVE_ID);

  const second = await ensureBuiltinExtensions(library);
  assert.equal(second.length, 2, "one row each, not four");
  assert.equal(second[0].enabled, true);
});

test("re-seeding never re-enables what the user turned off", async () => {
  const library = store();
  await ensureBuiltinExtensions(library);
  const row = await library.getExtension(BUILTIN_ARCHIVE_ID);
  await library.putExtension({ ...row, enabled: false });

  const after = await ensureBuiltinExtensions(library);
  assert.equal(after[0].enabled, false, "the switch is the user's, not the boot code's");
  assert.equal(await builtinEnabled(library, BUILTIN_ARCHIVE_ID), false);
});

test("a row without the flag is repaired in place, keeping its own name", async () => {
  const library = store();
  await library.putExtension({
    extensionId: BUILTIN_ARCHIVE_ID,
    packageId: "ing.hardlysleep.hardlytracking.builtin.archive",
    name: "Archive",
    sources: [],
    enabled: false,
  });
  const [row] = await ensureBuiltinExtensions(library);
  assert.equal(row.builtin, true);
  assert.equal(row.name, "Archive", "a name already there is not overwritten");
  assert.equal(row.sources.length, 1, "an empty source list is filled in");
  assert.equal(row.enabled, false, "repair does not touch the switch");
});

test("a disabled built-in offers no sources, and the registry honours the live switch", async () => {
  const library = store();
  await ensureBuiltinExtensions(library);
  let on = true;
  const providers = await createProviders({
    store: library,
    mihonBase: null,
    dalvikBase: null,
    archiveEnabled: () => on,
  });
  const archive = providerFor(providers.providers, "archive:src:texts");
  assert.equal((await archive.sources()).length, 1);

  on = false;
  assert.equal((await archive.sources()).length, 0, "a disabled extension is not offered");
});

test("a disabled built-in can still be read, so a saved book does not vanish", async () => {
  const provider = createArchiveProvider({
    enabled: () => false,
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({
        metadata: { identifier: "scanned", title: "Scanned", imagecount: "3" },
        files: [],
      }),
      text: async () => "",
    }),
  });
  assert.equal((await provider.sources()).length, 0);
  const chapters = await provider.chapters("archive:scanned");
  assert.equal(chapters.length, 1);
  assert.equal((await provider.pages(chapters[0].id)).length, 3);
});

test("the built-in's source id is already namespaced, so it is not prefixed twice", () => {
  assert.deepEqual(extensionSourceIds(BUILTIN_EXTENSIONS[0]), ["archive:src:texts"]);
  assert.deepEqual(extensionSourceIds({ sources: [{ id: "2499283573021220255", name: "MangaDex" }] }), [
    "dalvik:src:2499283573021220255",
  ]);
});

test("a packaged app asks the repository directly, because it has no /api/repo of its own", async () => {
  const { repoFetchUrl } = await import("../../src/lib/extensions/repository.ts");
  const { proxiedImage } = await import("../../src/lib/pages.ts");
  // In node there is no `location`, which is the same answer as a packaged app: no server here.
  assert.equal(repoFetchUrl("https://example.test/repo/index.pb"), "https://example.test/repo/index.pb");
  assert.equal(proxiedImage("https://example.test/icon.png"), "https://example.test/icon.png");
});

test("the HT-Server switch adds and removes a source, and never re-points the app", async () => {
  const { htServerEnabled, setHtServerEnabled, remoteHost, apiUrl, htServerBase } = await import(
    "../../src/lib/host.ts"
  );
  const memory = new Map();
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
  };
  // `setRemoteHost` compares against location.origin, and node has no location, so the pairing is
  // written the way a browser writes it.
  memory.set("hardlytracking.host", "http://desktop.test:8460");
  assert.equal(htServerBase(), "http://desktop.test:8460/api/dalvik");

  // The whole point of the fix: a paired host changes exactly one base, never the app's own paths.
  for (const path of ["/api/dalvik", "/api/mihon", "/api/repo", "/api/img", "/api/host-info"]) {
    assert.equal(apiUrl(path), path, `${path} means this device, paired or not`);
  }

  setHtServerEnabled(false);
  assert.equal(htServerEnabled(), false);
  assert.equal(htServerBase(), "", "off means no host source at all");
  assert.equal(remoteHost(), "http://desktop.test:8460", "the address is kept, not deleted");

  setHtServerEnabled(true);
  assert.equal(htServerBase(), "http://desktop.test:8460/api/dalvik", "on again offers the host");
  delete globalThis.localStorage;
});

test("the switch carries over from the name it used to have", async () => {
  const { htServerEnabled } = await import("../../src/lib/host.ts");
  const memory = new Map([["hardlytracking.readServer", "off"]]);
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
  };
  // A host the user had switched off must not come back on by being renamed.
  assert.equal(htServerEnabled(), false);
  assert.equal(memory.has("hardlytracking.readServer"), false, "the old key is dropped after it is read");
  assert.equal(memory.get("hardlytracking.htServer"), "off");
  delete globalThis.localStorage;
});
