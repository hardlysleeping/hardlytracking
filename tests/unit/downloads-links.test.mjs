import { test } from "node:test";
import assert from "node:assert/strict";

import {
  archiveItemId,
  bestMatch,
  hostOf,
  queryFromUrl,
  readPastedLines,
  resolveLink,
  resolveLinks,
  sameHost,
  sourceForHost,
} from "../../src/lib/downloads/links.ts";

const sources = [
  { id: "mihon:src:42", name: "BatCave", baseUrl: "https://batcave.biz" },
  { id: "archive:src:texts", name: "Internet Archive", baseUrl: "https://archive.org" },
  { id: "mihon:src:7", name: "No base url" },
];

test("a paste is split however the links were laid out", () => {
  const lines = readPastedLines("https://batcave.biz/comic/solo-leveling/\n\n  https://archive.org/details/invincible  ");
  assert.deepEqual(
    lines.map((line) => line.url),
    ["https://batcave.biz/comic/solo-leveling/", "https://archive.org/details/invincible"],
  );
  // One line, several links: a copied selection, not one long URL.
  assert.equal(readPastedLines("https://a.example/x https://b.example/y").length, 2);
  // A link wrapped in a sentence keeps its brackets out of the URL.
  assert.equal(readPastedLines("(https://batcave.biz/comic/x/)").at(0)?.url, "https://batcave.biz/comic/x/");
});

test("a scheme-less link is still a link, and a bare word is not", () => {
  assert.equal(readPastedLines("batcave.biz/comic/x")[0].url, "https://batcave.biz/comic/x");
  assert.equal(readPastedLines("solo leveling")[0].url, null);
  assert.equal(readPastedLines("not a link at all")[0].host, null);
});

test("hosts compare as sites, not as strings", () => {
  assert.equal(hostOf("https://www.batcave.biz/comic/x"), "batcave.biz");
  assert.ok(sameHost("m.batcave.biz", "batcave.biz"), "a mirror is the same site");
  assert.ok(!sameHost("batcave.biz", "notbatcave.biz"), "a suffix has to be a label boundary");
  assert.equal(sourceForHost(sources, "m.batcave.biz")?.name, "BatCave");
  assert.equal(sourceForHost(sources, "example.com"), null, "no source, no guessing");
  assert.equal(sourceForHost(sources, "batcave.biz")?.id, "mihon:src:42");
});

test("an Internet Archive link is an item id, not a search", () => {
  assert.equal(archiveItemId("https://archive.org/details/invincible-compendiums"), "invincible-compendiums");
  assert.equal(archiveItemId("https://archive.org/download/berzerk_v3/berzerk_v3.cbz"), "berzerk_v3");
  assert.equal(archiveItemId("https://archive.org/details/Berserk/page/n3"), "Berserk");
  assert.equal(archiveItemId("https://archive.org/search?query=berserk"), null, "a search page is not an item");
  assert.equal(archiveItemId("https://batcave.biz/details/x"), null);
});

test("a source link becomes the words to search it for", () => {
  assert.equal(queryFromUrl("https://batcave.biz/comic/solo-leveling/"), "solo leveling");
  assert.equal(queryFromUrl("https://batcave.biz/comic/solo-leveling-123/"), "solo leveling 123");
  assert.equal(queryFromUrl("https://batcave.biz/comic/12345/"), "comic", "an id is not a title");
  assert.equal(queryFromUrl("https://batcave.biz/comic/saga_v2.html"), "saga v2");
  assert.equal(queryFromUrl("https://batcave.biz/"), "");
});

test("resolution answers with a source, an item, or a reason", () => {
  const archive = resolveLink(readPastedLines("https://archive.org/details/berserk")[0], sources);
  assert.deepEqual(archive, { kind: "archive", seriesId: "archive:berserk", url: "https://archive.org/details/berserk" });

  const comic = resolveLink(readPastedLines("https://batcave.biz/comic/solo-leveling/")[0], sources);
  assert.equal(comic.kind, "source");
  assert.equal(comic.kind === "source" ? comic.sourceId : "", "mihon:src:42");
  assert.equal(comic.kind === "source" ? comic.query : "", "solo leveling");

  const unknown = resolveLink(readPastedLines("https://getcomics.org/x/")[0], sources);
  assert.equal(unknown.kind, "error");
  assert.match(unknown.kind === "error" ? unknown.reason : "", /no installed source serves getcomics\.org/);

  const words = resolveLink(readPastedLines("solo leveling")[0], sources);
  assert.equal(words.kind, "error");
  assert.match(words.kind === "error" ? words.reason : "", /not a link/);
});

test("a whole paste resolves in the order it was pasted", () => {
  const out = resolveLinks("https://archive.org/details/a\nhttps://batcave.biz/comic/b\nnonsense", sources);
  assert.deepEqual(
    out.map((entry) => entry.kind),
    ["archive", "source", "error"],
  );
});

test("the best search hit is an exact title, else what the source ranked first", () => {
  const results = [{ title: "Solo Leveling: Ragnarok" }, { title: "Solo Leveling" }, { title: "Solo Max-Level Newbie" }];
  assert.equal(bestMatch(results, "solo leveling")?.title, "Solo Leveling", "exact wins over first");
  assert.equal(bestMatch(results, "solo leveling ragnarok")?.title, "Solo Leveling: Ragnarok");
  assert.equal(bestMatch(results, "nothing like it")?.title, "Solo Leveling: Ragnarok", "the source's own ranking");
  assert.equal(bestMatch([], "x"), null);
});
