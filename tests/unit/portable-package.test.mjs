import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PORTABLE_HOST_API,
  PORTABLE_RUNTIME,
  PortablePackageError,
  parsePortableManifest,
  parsePortableRepo,
} from "../../src/lib/extensions/portable.ts";
import { detectRepoIndex } from "../../src/lib/repos/index.ts";
import { readRepoIndex } from "../../src/lib/repos/parse.ts";

const BASE = "https://raw.githubusercontent.com/hardlysleeping/hardlytracking-extensions/repo/index.json";

/** The shape the official repository publishes. One entry per portable package. */
const INDEX = {
  name: "HardlyTracking Official Extensions",
  badgeLabel: "HT",
  signingKey: "0".repeat(64),
  extensionList: {
    extensions: [
      {
        name: "Komga",
        packageName: "org.hardlytracking.komga",
        versionName: "1.0.0",
        versionCode: 1,
        runtime: "portable-js",
        kind: "komga",
        hostApi: 1,
        resources: {
          providerUrl: "extensions/komga/provider.js",
          iconUrl: "extensions/komga/icon.png",
        },
        sources: [{ name: "Komga", lang: "en" }],
      },
      {
        name: "Suwayomi",
        packageName: "org.hardlytracking.suwayomi",
        versionName: "1.0.0",
        versionCode: 1,
        runtime: "portable-js",
        kind: "mihon",
        hostApi: 1,
        resources: { providerUrl: "extensions/suwayomi/provider.js" },
      },
      {
        name: "MangaDex",
        packageName: "eu.kanade.tachiyomi.extension.all.mangadex",
        versionName: "1.4.0",
        versionCode: 14,
        runtime: "dalvik",
        resources: { apkUrl: "apk/mangadex.apk" },
      },
    ],
  },
};

test("a portable index parses, and only the portable rows come through", () => {
  const repo = parsePortableRepo(INDEX, BASE);
  assert.equal(repo.kind, "portable");
  assert.equal(repo.name, "HardlyTracking Official Extensions");
  assert.deepEqual(repo.entries.map((e) => e.id), ["org.hardlytracking.komga", "org.hardlytracking.suwayomi"]);
  const komga = repo.entries[0];
  assert.equal(komga.name, "Komga");
  assert.equal(komga.version, "1.0.0");
  assert.equal(komga.versionCode, 1);
  assert.equal(komga.runtime, PORTABLE_RUNTIME);
  assert.equal(komga.providerKind, "komga");
  assert.equal(komga.hostApi, 1);
  // Relative paths are resolved against the index, or the install cannot fetch them at all.
  assert.equal(
    komga.packageUrl,
    "https://raw.githubusercontent.com/hardlysleeping/hardlytracking-extensions/repo/extensions/komga/provider.js",
  );
  assert.equal(
    komga.iconUrl,
    "https://raw.githubusercontent.com/hardlysleeping/hardlytracking-extensions/repo/extensions/komga/icon.png",
  );
});

test("detection reads the runtime, not the repository's address", () => {
  assert.equal(detectRepoIndex(JSON.stringify(INDEX)), "portable");
  // A Mihon v2 index is still a Mihon index, even with the same extensionList wrapper.
  assert.equal(detectRepoIndex('{"name":"Keiyoushi","extensionList":{"extensions":[{"packageName":"x","resources":{"apkUrl":"x.apk"}}]}}'), "mihon");
  // The one door parses it too, so a pasted official repo is not a parse error.
  assert.equal(readRepoIndex(JSON.stringify(INDEX), BASE).kind, "portable");
});

test("a package built for a newer host API is refused by name, not half-installed", () => {
  const newer = structuredClone(INDEX);
  newer.extensionList.extensions[0].hostApi = PORTABLE_HOST_API + 1;
  const repo = parsePortableRepo(newer, BASE);
  assert.deepEqual(repo.entries.map((e) => e.id), ["org.hardlytracking.suwayomi"]);

  assert.throws(
    () => parsePortableManifest(newer.extensionList.extensions[0], BASE),
    (error) => {
      assert.ok(error instanceof PortablePackageError);
      assert.match(error.message, new RegExp(`host API ${PORTABLE_HOST_API + 1}`));
      assert.match(error.message, new RegExp(`speaks ${PORTABLE_HOST_API}`));
      return true;
    },
  );
});

test("an entry is refused when it cannot be trusted or fetched", () => {
  const plainHttp = { ...INDEX.extensionList.extensions[0], resources: { providerUrl: "http://example.test/p.js" } };
  assert.throws(() => parsePortableManifest(plainHttp, BASE), /https/);

  const noEntry = { ...INDEX.extensionList.extensions[0], resources: {} };
  assert.throws(() => parsePortableManifest(noEntry, BASE), /provider\.js/);

  const wrongRuntime = { ...INDEX.extensionList.extensions[0], runtime: "quickjs" };
  assert.throws(() => parsePortableManifest(wrongRuntime, BASE), /quickjs/);

  const unknownKind = { ...INDEX.extensionList.extensions[0], kind: "cmanga" };
  assert.throws(() => parsePortableManifest(unknownKind, BASE), /kind "cmanga"/);
});

test("one unreadable row does not empty the repository", () => {
  const mixed = structuredClone(INDEX);
  mixed.extensionList.extensions.unshift({ name: "Broken", runtime: "portable-js", hostApi: 1 });
  const repo = parsePortableRepo(mixed, BASE);
  assert.equal(repo.entries.length, 2);
});

test("a bare array is read as the same list", () => {
  const repo = parsePortableRepo([INDEX.extensionList.extensions[0]], BASE);
  assert.equal(repo.entries.length, 1);
  assert.equal(repo.entries[0].id, "org.hardlytracking.komga");
});

test("a relative entry resolves against the manifest's own URL", () => {
  const manifest = parsePortableManifest(
    {
      packageName: "org.hardlytracking.komga",
      name: "Komga",
      versionName: "1.2.0",
      versionCode: 120,
      runtime: "portable-js",
      kind: "komga",
      resources: { providerUrl: "provider.js" },
    },
    "https://example.test/ext/komga/manifest.json",
  );
  assert.equal(manifest.entryUrl, "https://example.test/ext/komga/provider.js");
  assert.equal(manifest.versionCode, 120);
  assert.equal(manifest.hostApi, PORTABLE_HOST_API);
});
