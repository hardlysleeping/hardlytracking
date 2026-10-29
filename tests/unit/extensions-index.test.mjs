import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIndex, parseExtension, updateState } from "../../src/lib/extensions/index.ts";

/** Shape taken from keiyoushi's live `index.json` (v2), trimmed to the fields we read. */
const V2 = {
  name: "Keiyoushi",
  badgeLabel: "KEI",
  signingKey: "9add…",
  contact: { website: "https://keiyoushi.github.io" },
  extensionList: {
    extensions: [
      {
        name: "MangaDex",
        packageName: "eu.kanade.tachiyomi.extension.all.mangadex",
        resources: {
          apkUrl: "https://example.test/tachiyomi-all.mangadex-v1.6.0.apk",
          iconUrl: "https://example.test/icon.png",
          jarUrl: "https://example.test/x.jar",
        },
        extensionLib: "1.6",
        versionCode: "106000",
        versionName: "1.6.0",
        contentWarning: "CONTENT_WARNING_MIXED",
        sources: [
          { id: "4638673959522768501", name: "MangaDex", language: "af", homeUrl: "https://mangadex.org" },
          { id: "987803387023224960", name: "MangaDex", language: "sq" },
        ],
      },
    ],
  },
};

/** Shape taken from the legacy `index.min.json` (bare array). */
const LEGACY = [
  {
    name: "Outdated App",
    pkg: "eu.kanade.tachiyomi.extension.all.keiyoushi",
    apk: "tachiyomi-all.keiyoushi-v1.4.1.apk",
    lang: "all",
    code: 1,
    version: "1.4.1",
    nsfw: 0,
    sources: [{ name: "Outdated App", lang: "all", id: "1", baseUrl: "https://keiyoushi.github.io" }],
  },
];

test("the v2 index shape parses, and keeps the real source ids", () => {
  const index = parseIndex(V2);
  assert.equal(index.name, "Keiyoushi");
  assert.equal(index.extensions.length, 1);
  const [ext] = index.extensions;
  assert.equal(ext.pkg, "eu.kanade.tachiyomi.extension.all.mangadex");
  assert.equal(ext.version, "1.6.0");
  assert.equal(ext.versionCode, 106000);
  assert.equal(ext.lib, "1.6");
  assert.equal(ext.apkUrl, "https://example.test/tachiyomi-all.mangadex-v1.6.0.apk");
  assert.equal(ext.contentWarning, "MIXED");
  assert.equal(ext.sources.length, 2);
  // A 19-digit id must survive as a string: Number() would round it.
  assert.equal(ext.sources[0].id, "4638673959522768501");
  assert.equal(ext.sources[0].homeUrl, "https://mangadex.org");
  assert.equal(ext.sources[1].lang, "sq");
});

test("the legacy array shape parses into the same entry", () => {
  const [ext] = parseIndex(LEGACY).extensions;
  assert.equal(ext.name, "Outdated App");
  assert.equal(ext.version, "1.4.1");
  assert.equal(ext.versionCode, 1);
  assert.equal(ext.contentWarning, "SAFE", "nsfw:0 normalises to SAFE");
  assert.equal(ext.sources[0].id, "1");
  assert.equal(ext.apkUrl, "tachiyomi-all.keiyoushi-v1.4.1.apk");
});

test("an entry with no APK URL is dropped, not half-parsed", () => {
  assert.equal(parseExtension({ name: "Broken", packageName: "x.y" }), null);
  const index = parseIndex({ extensionList: { extensions: [{ name: "Broken", packageName: "x.y" }] } });
  assert.deepEqual(index.extensions, []);
});

test("a nonsense index is an error, not an empty store", () => {
  assert.throws(() => parseIndex("nope"), /not an extension index/);
});

test("update state is decided by versionCode, and never downgrades", () => {
  const entry = parseIndex(V2).extensions[0];
  assert.equal(updateState(undefined, entry), "new");
  assert.equal(updateState({ versionCode: 106000 }, entry), "up-to-date");
  assert.equal(updateState({ versionCode: 105999 }, entry), "update");
  assert.equal(updateState({ versionCode: 106001 }, entry), "downgrade");
});
