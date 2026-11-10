import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { browseTabLabel, browseTabsOf } from "../../src/lib/source-tabs.ts";

const answers = { trending: async () => ({ items: [], hasNext: false }) };

test("a source with no declaration keeps the Popular/Latest pair", () => {
  assert.deepEqual(browseTabsOf(null, null), ["popular", "latest"]);
  assert.deepEqual(browseTabsOf({}, {}), ["popular", "latest"]);
});

test("archive declares Trending first and keeps Popular and Latest", () => {
  // The declaration is what puts Trending on screen first; the provider method is what answers it.
  const source = readFileSync(new URL("../../src/api/archive.ts", import.meta.url), "utf8");
  assert.match(source, /browseTabs: \["trending", "popular", "latest"\]/);
});

test("a declared tab the provider cannot answer is dropped, never drawn", () => {
  const source = { browseTabs: ["trending", "popular", "latest"] };
  const latestOnly = { latest: async () => ({ items: [], hasNext: false }) };
  assert.deepEqual(browseTabsOf(source, latestOnly), ["popular", "latest"]);
  assert.deepEqual(browseTabsOf(source, answers), ["trending", "popular", "latest"]);
});

test("declarations collapse duplicates and every tab has one label", () => {
  assert.deepEqual(browseTabsOf({ browseTabs: ["trending", "trending", "popular"] }, answers), ["trending", "popular"]);
  assert.equal(browseTabLabel("trending"), "Trending");
  assert.equal(browseTabLabel("popular"), "Popular");
  assert.equal(browseTabLabel("latest"), "Latest");
});
