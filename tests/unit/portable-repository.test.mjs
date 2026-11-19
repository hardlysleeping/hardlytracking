/**
 * The portable repository, end to end from an index to an install row.
 *
 * The parser, the manifest validator and the install path all existed and were tested — and no
 * screen could reach any of them. `loadRepository` parsed only the Mihon shape, so an index written
 * by this app's own publisher arrived as a list of rows with no `apkUrl`, and `parseExtension`
 * dropped every one. The repository listed nothing, and the Install button it never drew could not
 * have worked: the portable branch of the install had no caller.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadRepository } from "../../src/lib/extensions/repository.ts";
import { proposalOf, repositoryEcosystem } from "../../src/lib/extensions/proposal.ts";
import { detectRepoIndex } from "../../src/lib/repos/index.ts";

const BASE = "https://example.test/repo/index.json";

const MANIFEST = {
  name: "Komga",
  packageName: "org.hardlytracking.komga",
  versionName: "1.0.0",
  versionCode: 1,
  runtime: "portable-js",
  kind: "komga",
  hostApi: 1,
  resources: { providerUrl: "extensions/komga/provider.js", iconUrl: "extensions/komga/icon.png" },
  sources: [{ name: "Comics", lang: "en" }],
};

const portableIndex = { name: "HardlyTracking Extensions", extensionList: { extensions: [MANIFEST] } };

test("a portable index is detected by its wrapper", () => {
  assert.equal(detectRepoIndex(portableIndex), "portable");
});

test("a bare array of portable packages is portable, not legacy Mihon", () => {
  // `detectRepoIndex` answered "mihon" for every bare array, so the publisher's own format — an
  // array — was parsed by the APK parser and emptied.
  assert.equal(detectRepoIndex([MANIFEST]), "portable");
  assert.equal(detectRepoIndex([{ name: "MangaFire", pkg: "x.y", apk: "apk/x.apk", version: "1", code: 1 }]), "mihon");
});

test("the repository loader lists a portable package with its manifest attached", async () => {
  const loaded = await loadRepository(BASE, {
    fetchImpl: async () =>
      new Response(JSON.stringify(portableIndex), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(loaded.name, "HardlyTracking Extensions");
  assert.equal(loaded.extensions.length, 1, "the portable row was dropped");
  const [entry] = loaded.extensions;
  assert.equal(entry.pkg, "org.hardlytracking.komga");
  assert.equal(entry.version, "1.0.0");
  // The row's package URL is the provider module, resolved against the index that named it.
  assert.equal(entry.apkUrl, "https://example.test/repo/extensions/komga/provider.js");
  assert.equal(entry.portable?.kind, "komga");
  assert.equal(entry.portable?.hostApi, 1);
  assert.equal(entry.portable?.id, "org.hardlytracking.komga");
});

test("a Mihon index still travels down the APK path", async () => {
  const mihon = {
    name: "Keiyoushi",
    extensionList: {
      extensions: [
        {
          name: "MangaFire",
          packageName: "eu.kanade.tachiyomi.extension.en.mangafire",
          versionName: "1.4.2",
          versionCode: 14,
          resources: { apkUrl: "apk/mangafire.apk" },
          sources: [{ id: "1", name: "MangaFire", language: "en" }],
        },
      ],
    },
  };
  const loaded = await loadRepository(BASE, {
    fetchImpl: async () => new Response(JSON.stringify(mihon), { status: 200 }),
  });
  assert.equal(loaded.extensions.length, 1);
  assert.equal(loaded.extensions[0].portable, undefined);
  assert.equal(loaded.extensions[0].apkUrl, "https://example.test/repo/apk/mangafire.apk");
});

test("the install path routes a portable row to the portable installer", () => {
  // Not importable here (the store needs runes and IndexedDB), so the branch is pinned in source:
  // sending a provider module down the APK path asks the runtime to install a `.js`.
  const library = readFileSync(new URL("../../src/state/library.svelte.ts", import.meta.url), "utf8");
  assert.match(library, /if \(entry\.portable !== undefined\) return this\.installPortableEntry\(entry\.portable, repoUrl\)/);
  const beforeApk = library.indexOf("entry.portable !== undefined");
  const apk = library.indexOf("await downloadApk(entry)", beforeApk);
  assert.ok(beforeApk > 0 && apk > beforeApk, "the portable branch must come before the APK download");
});
test("a portable listing is named portable, not 'APK extensions'", async () => {
  // The filename test cannot tell: the publisher's index is `index.json`, which every name rule
  // calls Mihon. The rows know, so the panel — and a package page — must ask them.
  const loaded = await loadRepository(BASE, {
    fetchImpl: async () => new Response(JSON.stringify(portableIndex), { status: 200 }),
  });
  assert.equal(repositoryEcosystem(loaded), "portable");
  assert.match(proposalOf(loaded).ecosystemLabel, /portable/i);
  assert.doesNotMatch(proposalOf(loaded).ecosystemLabel, /APK/);
});
