import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute, pathTo } from "../../src/lib/nav.ts";

test("a route carries ids that contain slashes, unchanged", () => {
  // A dalvik series id is `dalvik:<sourceId>:/manga/<uuid>` — the url is part of the id.
  const seriesId = "dalvik:2499283573021220255:/manga/93704d83-322c-4214-99bc-6984cf536795";
  const chapterId = "dalvik:ch:2499283573021220255:/chapter/52717964-ef7e-47a7-9792-e779e91b916f";
  const path = pathTo("read", seriesId, chapterId);
  assert.equal(path.split("/").length, 3, "one segment per id, no matter what the id holds");
  const route = parseRoute(`#/${path}`);
  assert.deepEqual(route, { name: "read", id: seriesId, chapterId, repo: null });
});

test("a plain route and a hand-written hash still parse", () => {
  assert.deepEqual(parseRoute("#/browse"), { name: "browse", id: null, chapterId: null, repo: null });
  assert.deepEqual(parseRoute(""), { name: "library", id: null, chapterId: null, repo: null });
  assert.deepEqual(parseRoute("#/series/mihon:12"), { name: "series", id: "mihon:12", chapterId: null, repo: null });
  // A stray escape must not throw the router away.
  assert.deepEqual(parseRoute("#/series/100%"), { name: "series", id: "100%", chapterId: null, repo: null });
});

test("a package route names the repository first, and keeps the package as the id", () => {
  assert.deepEqual(parseRoute("#/software/eu.kanade.tachiyomi.extension.all.mangafire"), {
    name: "software",
    id: "eu.kanade.tachiyomi.extension.all.mangafire",
    chapterId: null,
    repo: null,
  });
  assert.deepEqual(parseRoute("#/software/https%3A%2F%2Fexample.invalid%2Frepo/eu.kanade.tachiyomi.extension.all.mangafire"), {
    name: "software",
    id: "eu.kanade.tachiyomi.extension.all.mangafire",
    chapterId: null,
    repo: "https://example.invalid/repo",
  });
});
