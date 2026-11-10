/**
 * A portable row booted through the real registry: the gate for milestone 1.
 *
 * A fixture package is installed on a store and `createProviders` is asked for the provider set. It
 * has to come back with a live provider that answers `sources` → `popular` → `details` → `chapters`
 * → `pages`, under the kind the package declared, with ids namespaced the way the library expects.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { createProviders, providerFor } from "../../src/api/registry.ts";
import { createWorkerCore } from "../../src/lib/extensions/worker/core.ts";
import { portableRow } from "../../src/lib/extensions/portable-install.ts";

const PACKAGE = "org.hardlytracking.komga";
const SOURCE = `
  export default {
    async sources() { return [{ id: "lib:1", name: "Comics", lang: "en" }]; },
    async popular() { return { items: [{ id: "s1", title: "Saga" }], hasNext: false }; },
    async latest() { return { items: [], hasNext: false }; },
    async details(seriesId) { return { id: seriesId, title: "Saga" }; },
    async chapters(seriesId) { return [{ id: "c1", seriesId, name: "Vol. 1", number: 1, pageCount: 2, read: false }]; },
    async pages() { return [{ index: 0, url: "https://komga.test/page/0.jpg" }]; },
  };
`;

/** The same stand-in the worker tests use: the real core behind a message port. */
function spawn() {
  let handle = () => undefined;
  const core = createWorkerCore({ post: (message) => queueMicrotask(() => handle({ data: message })) });
  return {
    postMessage: (message) => queueMicrotask(() => core.handle(message)),
    addEventListener: (_type, listener) => {
      handle = listener;
    },
    terminate: () => {
      handle = () => undefined;
    },
  };
}

const MANIFEST = {
  id: PACKAGE,
  name: "Komga",
  version: "1.0.0",
  versionCode: 1,
  runtime: "portable-js",
  kind: "komga",
  hostApi: 1,
  entryUrl: "https://example.test/provider.js",
  sources: [{ lang: "en" }],
};

async function boot(rows) {
  const library = new LibraryStore(memoryDatabase());
  for (const row of rows) await library.putExtension(row);
  return createProviders({
    store: library,
    localFirst: true,
    mihonBase: null,
    dalvikBase: null,
    portableSpawn: spawn,
  });
}

test("an installed portable package becomes a live provider on boot", async () => {
  const row = await portableRow({ manifest: MANIFEST, source: SOURCE }, []);
  const set = await boot([row]);
  const provider = providerFor(set.providers, "komga:c1");
  assert.equal(provider?.kind, "komga");
  assert.equal(provider?.ownsProgress, false, "a server keeps its own progress");

  assert.deepEqual(await provider.sources(), [{ id: "komga:lib:1", provider: "komga", name: "Comics", lang: "en" }]);
  const page = await provider.popular("komga:lib:1", 1);
  assert.deepEqual(page.items.map((series) => series.id), ["komga:s1"]);
  const chapters = await provider.chapters("komga:s1");
  assert.deepEqual(chapters.map((chapter) => chapter.id), ["komga:c1"]);
  const pages = await provider.pages("komga:c1");
  assert.equal(pages[0].url, "https://komga.test/page/0.jpg");
});

test("the installed row records the package and where its sources came from", async () => {
  const row = await portableRow(
    { manifest: MANIFEST, source: SOURCE, repoUrl: "https://example.test/index.json" },
    [{ id: "komga:lib:1", provider: "komga", name: "Comics", lang: "en" }],
  );
  assert.equal(row.extensionId, "portable:org.hardlytracking.komga");
  assert.equal(row.packageId, PACKAGE);
  assert.equal(row.versionCode, 1);
  assert.equal(row.portable?.kind, "komga");
  assert.deepEqual(row.sources, [{ id: "lib:1", name: "Comics", lang: "en" }], "ids on the row are bare, like an APK's");
  assert.equal(row.repoUrl, "https://example.test/index.json");
});

test("a disabled package is not started", async () => {
  const row = await portableRow({ manifest: MANIFEST, source: SOURCE, enabled: false }, []);
  const set = await boot([row]);
  assert.equal(set.providers.some((provider) => provider.kind === "komga"), false);
  assert.equal(set.portable.size, 0);
});

test("a package that will not load is a warning, not a boot that fails", async () => {
  // Loading is what the registry checks; a package that loads and then throws belongs to the install
  // path (`startPortable` asks for sources before the row is written), not to the boot.
  const row = await portableRow({ manifest: MANIFEST, source: `export default { popular: async () => ({ items: [], hasNext: false }) };` }, []);
  const set = await boot([row]);
  assert.equal(set.providers.some((provider) => provider.kind === "komga"), false);
  assert.ok(set.warnings.some((warning) => /sources\(\)/.test(warning)), set.warnings.join(" | "));
});
