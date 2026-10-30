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

test("the built-in list is archive.org and the Mihon runtime", () => {
  assert.equal(BUILTIN_EXTENSIONS.length, 2);
  assert.deepEqual(
    BUILTIN_EXTENSIONS.map((entry) => entry.extensionId),
    ["builtin:internet-archive", "builtin:mihon-runtime"],
  );
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
  assert.equal(first.length, 2, "archive.org and the runtime");
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
