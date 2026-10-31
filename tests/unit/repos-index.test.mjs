import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { absoluteUrl, contentWarningOf, detectRepoIndex, warningLabel } from "../../src/lib/repos/index.ts";
import { parseAidokuRepo } from "../../src/lib/repos/aidoku.ts";
import { parsePaperbackRepo } from "../../src/lib/repos/paperback.ts";
import { parseMihonRepo } from "../../src/lib/repos/mihon.ts";
import { readRepoIndex, RepoFormatError } from "../../src/lib/repos/parse.ts";

// Fixtures are the live files, not hand-written shapes:
//   aidoku-index.min.json       https://aidoku-community.github.io/sources/index.min.json (144 sources)
//   paperback-versioning.json   https://nicartjay.github.io/PaperbackExt/0.9/stable/versioning.json (383 sources)
const fixture = (name) => fileURLToPath(new URL(`../fixtures/repos/${name}`, import.meta.url));
const aidokuRaw = readFileSync(fixture("aidoku-index.min.json"), "utf8");
const paperbackRaw = readFileSync(fixture("paperback-versioning.json"), "utf8");
const AIDOKU_BASE = "https://aidoku-community.github.io/sources/index.min.json";
const PAPERBACK_BASE = "https://nicartjay.github.io/PaperbackExt/0.9/stable/";

test("detection reads the shape, not the URL", () => {
  // A gzipped protobuf index is the only gzipped index any of the four publishes.
  assert.equal(detectRepoIndex(new Uint8Array([0x1f, 0x8b, 0x08, 0x00])), "mihon");
  assert.equal(detectRepoIndex("[{\"name\":\"MangaDex\",\"pkg\":\"eu.kanade.tachiyomi.extension.all.mangadex\",\"apk\":\"x.apk\"}]"), "mihon");
  assert.equal(detectRepoIndex("{\"name\":\"Keiyoushi\",\"extensionList\":{\"extensions\":[]}}"), "mihon");
  assert.equal(detectRepoIndex(aidokuRaw), "aidoku");
  assert.equal(detectRepoIndex(paperbackRaw), "paperback");
  // Suwatte's list is a RunnerList; detected so the UI can say "not read yet" rather than "not a repo".
  assert.equal(detectRepoIndex("{\"listName\":\"x\",\"runners\":[]}"), "suwatte");
  assert.equal(detectRepoIndex(""), null);
  assert.equal(detectRepoIndex("not json at all"), null);
  assert.equal(detectRepoIndex("{\"hello\":\"world\"}"), null);
  assert.equal(detectRepoIndex(null), null);
});

test("an Aidoku list parses every entry and resolves its relative URLs", () => {
  const index = parseAidokuRepo(JSON.parse(aidokuRaw), AIDOKU_BASE);
  assert.equal(index.kind, "aidoku");
  assert.equal(index.name, "Aidoku Community Sources");
  assert.equal(index.entries.length, 144);

  const first = index.entries.find((e) => e.id === "ar.aasq");
  assert.ok(first, "ar.aasq is in the live list");
  assert.equal(first.name, "3asq");
  assert.equal(first.versionCode, 2);
  assert.equal(first.version, "2");
  assert.equal(first.packageUrl, "https://aidoku-community.github.io/sources/sources/ar.aasq-v2.aix");
  assert.equal(first.iconUrl, "https://aidoku-community.github.io/sources/icons/ar.aasq-v2.png");
  assert.equal(first.minHostVersion, "0.7.1");
  assert.deepEqual(first.langs, ["ar"]);
  assert.equal(first.contentWarning, "SAFE");
  // One package is one source, and its site is the source's home.
  assert.equal(first.sources.length, 1);
  assert.equal(first.sources[0].homeUrl, "https://3asq.online");

  // contentRating 2 is the NSFW tier; the old `nsfw` flag maps the same way.
  const nsfw = index.entries.find((e) => e.contentWarning === "NSFW");
  assert.ok(nsfw, "at least one entry is NSFW-rated");
});

test("a Paperback repository parses from versioning.json and finds index.js", () => {
  const index = parsePaperbackRepo(JSON.parse(paperbackRaw), PAPERBACK_BASE);
  assert.equal(index.kind, "paperback");
  assert.equal(index.name, "paperbackext");
  assert.equal(index.entries.length, 383);

  const ap = index.entries.find((e) => e.id === "APComics");
  assert.ok(ap, "APComics is in the live repository");
  assert.equal(ap.name, "AP Comics");
  assert.equal(ap.version, "1.4.55.1");
  // Paperback publishes no numeric code; 0 means "cannot be ordered", not "oldest".
  assert.equal(ap.versionCode, 0);
  assert.equal(ap.packageUrl, `${PAPERBACK_BASE}APComics/index.js`);
  assert.equal(ap.iconUrl, `${PAPERBACK_BASE}APComics/static/icon.png`);
  assert.equal(ap.contentWarning, "NSFW", "MATURE maps to NSFW");
  assert.deepEqual(ap.langs, ["en"]);
});

test("a Mihon index projects into the same shape without touching its parser", () => {
  const v2 = {
    name: "Keiyoushi",
    extensionList: {
      extensions: [
        {
          name: "Komga",
          packageName: "eu.kanade.tachiyomi.extension.all.komga",
          resources: { apkUrl: "apk/tachiyomi-all.komga-v1.6.74.apk", iconUrl: "icon/komga.png", jarUrl: "apk/tachiyomi-all.komga-v1.6.74.jar" },
          extensionLib: "1.6",
          versionCode: 106074,
          versionName: "1.6.74",
          contentWarning: "CONTENT_WARNING_SAFE",
          sources: [{ id: "2499283573021220255", name: "Komga", language: "all", homeUrl: "https://komga.org" }],
        },
      ],
    },
  };
  const index = parseMihonRepo(v2, "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json");
  assert.equal(index.kind, "mihon");
  const entry = index.entries[0];
  assert.equal(entry.id, "eu.kanade.tachiyomi.extension.all.komga");
  assert.equal(entry.packageUrl, "https://raw.githubusercontent.com/keiyoushi/extensions/repo/apk/tachiyomi-all.komga-v1.6.74.apk");
  assert.equal(entry.auxUrl, "https://raw.githubusercontent.com/keiyoushi/extensions/repo/apk/tachiyomi-all.komga-v1.6.74.jar");
  assert.equal(entry.lib, "1.6");
  assert.equal(entry.versionCode, 106074);
  assert.equal(entry.contentWarning, "SAFE");
  // The 19-digit source id survives verbatim: a backup's source mapping is keyed by it.
  assert.equal(entry.sources[0].id, "2499283573021220255");
});

test("one door: detect then parse, and a refusal names what it saw", () => {
  const aidoku = readRepoIndex(aidokuRaw, AIDOKU_BASE);
  assert.equal(aidoku.kind, "aidoku");
  assert.equal(readRepoIndex(paperbackRaw, PAPERBACK_BASE).kind, "paperback");

  assert.throws(() => readRepoIndex("<html>nope</html>", AIDOKU_BASE), RepoFormatError);
  try {
    readRepoIndex("{\"listName\":\"x\",\"runners\":[]}", "https://example.test/list.json");
    assert.fail("a Suwatte list must not parse as something else");
  } catch (error) {
    assert.ok(error instanceof RepoFormatError);
    assert.equal(error.kind, "suwatte");
  }
});

test("helpers stay honest about unknown values", () => {
  assert.equal(contentWarningOf(0), "SAFE");
  assert.equal(contentWarningOf(1), "MIXED");
  assert.equal(contentWarningOf(2), "NSFW");
  assert.equal(contentWarningOf("MATURE"), "NSFW");
  assert.equal(contentWarningOf("CONTENT_WARNING_MIXED"), "MIXED");
  assert.equal(contentWarningOf("whatever"), "UNKNOWN");
  assert.equal(warningLabel("UNKNOWN"), "unrated");
  // A relative URL resolves against the list; a broken base does not invent one.
  assert.equal(absoluteUrl("sources/a.aix", "https://x.test/dir/index.min.json"), "https://x.test/dir/sources/a.aix");
  assert.equal(absoluteUrl("https://cdn.test/a.aix", "https://x.test/"), "https://cdn.test/a.aix");
  assert.equal(absoluteUrl(undefined, "https://x.test/"), "");
});
