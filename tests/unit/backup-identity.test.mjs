import { test } from "node:test";
import assert from "node:assert/strict";
import { reattach, sourceOf, summarizeReattach } from "../../src/lib/backup/identity.ts";
import { emptyDocument } from "../../src/lib/sync/document.ts";

const stamp = { at: 1_700_000_000_000, device: "dev-a" };

/** A real dalvik id: `dalvik:<sourceIdLong>:<manga url>`. */
const DALVIK_ID = "dalvik:2499283573021220255:https://mangadex.org/title/4f9c1a2e-1c0b-4f0f-9b2a-2b6a1f7c9d11";
const SOURCE = "2499283573021220255";

function extension(overrides = {}) {
  return {
    extensionId: "sha256:aaa",
    packageId: "eu.kanade.tachiyomi.extension.all.mangadex",
    name: "MangaDex",
    sources: [{ id: SOURCE, name: "MangaDex", lang: "en" }],
    repoUrl: "https://example.invalid/index.json",
    versionName: "1.4.2",
    versionCode: 142,
    enabled: true,
    ...overrides,
  };
}

function series(id, title = "A title") {
  return { id, provider: id.split(":")[0], title, categoryIds: [], ...stamp };
}

function doc(rows, extra = {}) {
  const document = emptyDocument("dev-a", stamp.at);
  document.series = rows;
  return { ...document, ...extra };
}

test("a dalvik series id names its source, with no guessing", () => {
  const source = sourceOf(DALVIK_ID);
  assert.equal(source.provider, "dalvik");
  assert.equal(source.sourceId, SOURCE);
  assert.equal(source.why, undefined);
});

test("a dalvik source or chapter id is not read as a series", () => {
  for (const id of [`dalvik:src:${SOURCE}`, `dalvik:ch:${SOURCE}:https://mangadex.org/chapter/1`, `dalvik:${SOURCE}`]) {
    const source = sourceOf(id);
    assert.equal(source.sourceId, undefined, `${id} must not invent a source`);
    assert.equal(source.why, "not-a-series-id", `${id} is not a series id`);
  }
});

test("a mihon id names a manga on the host, not an extension source", () => {
  const source = sourceOf("mihon:12");
  assert.equal(source.provider, "mihon");
  assert.equal(source.sourceId, undefined);
  assert.equal(source.why, "no-source-in-id");
  // A chapter id is still not a series id.
  assert.equal(sourceOf("mihon:ch:12").why, "not-a-series-id");
});

test("a komga series is a server series too, so it carries no source", () => {
  const source = sourceOf("komga:abc123");
  assert.equal(source.provider, "komga");
  assert.equal(source.why, "no-source-in-id");
});

test("the device's own library needs no extension", () => {
  const source = sourceOf("local:1717000000000");
  assert.equal(source.provider, "local");
  assert.equal(source.sourceId, "local");
});

test("an id shape this app does not write is unknown, not guessed", () => {
  for (const id of ["", "nonsense", "tachiyomi:1", ":1", "dalvik:", "mihon:"]) {
    const source = sourceOf(id);
    assert.equal(source.provider, null, `${JSON.stringify(id)} must not name a provider`);
    assert.equal(source.why, "unrecognised-id");
  }
});

test("a series whose source is installed is attached, and names the extension", () => {
  const [row] = reattach(doc([series(DALVIK_ID)]), [extension()]);
  assert.equal(row.status, "attached");
  assert.equal(row.sourceId, SOURCE);
  assert.equal(row.extensionId, "sha256:aaa");
  assert.equal(row.extensionName, "MangaDex");
  assert.equal(row.from, "id");
  assert.equal(row.reason, undefined);
});

test("a series whose extension is missing is missing — not quietly attached", () => {
  const [row] = reattach(doc([series(DALVIK_ID)]), []);
  assert.equal(row.status, "missing");
  assert.equal(row.reason, "not-installed");
  assert.equal(row.sourceId, SOURCE);
  assert.equal(row.extensionId, undefined);
});

test("a series from a different source is not covered by an unrelated extension", () => {
  const other = extension({
    extensionId: "sha256:bbb",
    packageId: "eu.kanade.tachiyomi.extension.all.mangafire",
    sources: [{ id: "1111111111111111111", name: "MangaFire", lang: "en" }],
  });
  const [row] = reattach(doc([series(DALVIK_ID)]), [other]);
  assert.equal(row.status, "missing");
});

test("an extension that is installed but switched off is missing, with the reason", () => {
  const [row] = reattach(doc([series(DALVIK_ID)]), [extension({ enabled: false })]);
  assert.equal(row.status, "missing");
  assert.equal(row.reason, "disabled");
  assert.equal(row.extensionName, "MangaDex", "the screen can say which one to switch on");
});

test("mihon and unrecognised ids are unknown, and say why", () => {
  const rows = reattach(doc([series("mihon:12"), series("nonsense"), series("local:9")]), [extension()]);
  assert.deepEqual(
    rows.map((row) => [row.seriesId, row.status]),
    [
      ["mihon:12", "unknown"],
      ["nonsense", "unknown"],
      ["local:9", "attached"],
    ],
  );
  assert.equal(rows[0].why, "no-source-in-id");
  assert.equal(rows[1].why, "unrecognised-id");
});

test("a mapping row is evidence and wins over the id shape", () => {
  const document = doc([series("mihon:99")], {
    sourceMappings: [
      { seriesId: "mihon:99", provider: "dalvik", sourceId: SOURCE, packageId: "eu.kanade.tachiyomi.extension.all.mangadex", ...stamp },
    ],
  });
  const [row] = reattach(document, [extension()]);
  assert.equal(row.status, "attached");
  assert.equal(row.from, "mapping");
  assert.equal(row.sourceId, SOURCE);
});

test("a file that declares the owning extension names the package when it is missing", () => {
  const document = doc([series(DALVIK_ID)], {
    extensions: [
      {
        packageId: "eu.kanade.tachiyomi.extension.all.mangadex",
        repoUrl: "https://example.invalid/index.json",
        versionName: "1.4.2",
        versionCode: 142,
        enabled: true,
        sourceIds: [SOURCE],
        preferences: {},
        ...stamp,
      },
    ],
  });
  const summary = summarizeReattach(reattach(document, []));
  assert.deepEqual(summary.missingSources, [
    { sourceId: SOURCE, packageName: "eu.kanade.tachiyomi.extension.all.mangadex", seriesCount: 1 },
  ]);
});

test("missing sources are grouped by source, biggest first, and counted with the rest", () => {
  const second = "1234567890123456789";
  const rows = reattach(
    doc([series(DALVIK_ID), series(DALVIK_ID.replace(SOURCE, second)), series(`${DALVIK_ID}-2`), series("mihon:1")]),
    [],
  );
  const summary = summarizeReattach(rows);
  assert.equal(summary.attached, 0);
  assert.equal(summary.missing, 3);
  assert.equal(summary.unknown, 1);
  assert.deepEqual(
    summary.missingSources.map((row) => [row.sourceId, row.seriesCount]),
    [
      [SOURCE, 2],
      [second, 1],
    ],
  );
  assert.equal(summary.attached + summary.missing + summary.unknown, rows.length, "the three add up to every series");
});
