import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIndex, parseExtension, planUpdates, updateState } from "../../src/lib/extensions/index.ts";

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


/**
 * `planUpdates` is what "Check for updates" asks once per repository. Its wrong answers all look
 * plausible: updating a built-in that has no APK, "updating" an extension from a repository that did
 * not publish it, or offering a downgrade because a counter went backwards.
 */
function entry(pkg, versionCode, version) {
  return {
    name: pkg,
    pkg,
    version,
    versionCode,
    lib: "1.6",
    apkUrl: `https://example.test/${pkg}.apk`,
    contentWarning: "SAFE",
    sources: [],
  };
}

test("planUpdates offers only a genuinely newer build", () => {
  const installed = [{ packageId: "a", versionCode: 10 }, { packageId: "b", versionCode: 20 }, { packageId: "c", versionCode: 30 }];
  const found = planUpdates(installed, [entry("a", 11, "1.1"), entry("b", 20, "2.0"), entry("c", 29, "2.9")], "https://repo.test/index.json");
  assert.deepEqual(found.map((row) => row.pkg), ["a"]);
  assert.equal(found[0].entry.version, "1.1");
  assert.equal(found[0].repoUrl, "https://repo.test/index.json");
});

test("a built-in is never offered as an update, and an unknown package is not installed", () => {
  const installed = [{ packageId: "builtin:komga", versionCode: 1, builtin: true }];
  assert.deepEqual(planUpdates(installed, [entry("builtin:komga", 9, "9.0"), entry("stranger", 9, "9.0")], "r"), []);
});

test("a row with no version code cannot be compared, so it is left alone", () => {
  assert.deepEqual(planUpdates([{ packageId: "a" }], [entry("a", 99, "9.9")], "r"), []);
});

test("an index that writes its APK beside itself still installs: the URL is joined to the index", () => {
  // Several published indexes write `apk/x.apk` rather than an absolute URL. Handing that string to
  // the repo fetch is refused ("url must be an absolute http(s) URL"), which read as a broken
  // repository rather than a relative link.
  const index = parseIndex(
    {
      name: "relative",
      extensionList: {
        extensions: [
          {
            name: "MangaDex",
            packageName: "eu.kanade.tachiyomi.extension.all.mangadex",
            versionName: "1.6.0",
            versionCode: 106000,
            resources: { apkUrl: "apk/mangadex.apk", iconUrl: "icons/md.png", jarUrl: "x.jar" },
          },
        ],
      },
    },
    "https://repo.test/sub/index.min.json",
  );
  assert.equal(index.extensions[0].apkUrl, "https://repo.test/sub/apk/mangadex.apk");
  assert.equal(index.extensions[0].iconUrl, "https://repo.test/sub/icons/md.png");
  assert.equal(index.extensions[0].jarUrl, "https://repo.test/sub/x.jar");
});

test("an absolute APK URL is left exactly as published, base or no base", () => {
  const raw = [{ pkg: "a.b", apk: "https://cdn.test/a.apk", versionCode: 1 }];
  assert.equal(parseIndex(raw, "https://repo.test/index.json").extensions[0].apkUrl, "https://cdn.test/a.apk");
  assert.equal(parseIndex(raw).extensions[0].apkUrl, "https://cdn.test/a.apk");
});

test("with no index address nothing is invented: a relative APK stays relative", () => {
  // `parseExtension` is also used on rows that never had a URL beside them; guessing a host there
  // would turn "this row is unusable" into "this row points somewhere wrong".
  const index = parseIndex([{ pkg: "a.b", apk: "apk/a.apk", versionCode: 1 }]);
  assert.equal(index.extensions[0].apkUrl, "apk/a.apk");
});
