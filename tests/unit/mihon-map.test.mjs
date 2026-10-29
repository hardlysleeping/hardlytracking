import { test } from "node:test";
import assert from "node:assert/strict";
import {
  browserMihonTransport,
  createMihonProvider,
  mapChapter,
  mapPages,
  mapSeries,
  mapSource,
  stripApiPrefix,
} from "../../src/api/mihon.ts";
import { splitId } from "../../src/api/source.ts";

const asset = (path) => `/api/mihon${stripApiPrefix(path)}`;

test("a source id is namespaced and keeps its native id", () => {
  const source = mapSource({ id: "1802675169972965535", displayName: "Example (EN)", name: "Example", lang: "en", isNsfw: true });
  assert.equal(source.id, "mihon:src:1802675169972965535");
  assert.equal(source.name, "Example (EN)");
  assert.equal(source.nsfw, true);
  assert.deepEqual(splitId(source.id), { provider: "mihon", native: "src:1802675169972965535" });
});

test("a relative thumbnail is joined to the runtime base", () => {
  // Verified shape from the running runtime: "/api/v1/manga/12/thumbnail".
  const series = mapSeries({ id: 12, title: "A Series", thumbnailUrl: "/api/v1/manga/12/thumbnail" }, asset);
  assert.equal(series.id, "mihon:12");
  assert.equal(series.cover, "/api/mihon/v1/manga/12/thumbnail");
  assert.equal(series.provider, "mihon");
});

test("an absolute thumbnail is left alone, and a missing one stays missing", () => {
  assert.equal(stripApiPrefix("https://example.test/a.jpg"), "https://example.test/a.jpg");
  const series = mapSeries({ id: 3, title: "No Cover", thumbnailUrl: null }, asset);
  assert.equal(series.cover, undefined);
});

test("chapter pages are relative paths that must be joined", () => {
  const pages = mapPages(["/api/v1/manga/12/chapter/1/page/0", "/api/v1/manga/12/chapter/1/page/1"], asset);
  assert.deepEqual(pages, [
    { index: 0, url: "/api/mihon/v1/manga/12/chapter/1/page/0" },
    { index: 1, url: "/api/mihon/v1/manga/12/chapter/1/page/1" },
  ]);
});

test("a chapter id round-trips through the provider's own prefix", () => {
  const chapter = mapChapter({ id: 1, name: "Chapter", chapterNumber: -1, pageCount: 4, isRead: false }, "mihon:12");
  assert.equal(chapter.id, "mihon:ch:1");
  assert.equal(chapter.seriesId, "mihon:12");
  assert.equal(chapter.pageCount, 4);
});

/** A transport that records what the provider asked for. */
function fakeTransport(reply) {
  const calls = [];
  return {
    calls,
    asset,
    async gql(query, variables) {
      calls.push({ query, variables });
      return reply(query, variables);
    },
  };
}

test("popular asks the runtime for POPULAR with the bare source id", async () => {
  const t = fakeTransport(() => ({ fetchSourceManga: { mangas: [{ id: 1, title: "One" }], hasNextPage: true } }));
  const provider = createMihonProvider(t);
  const page = await provider.popular("mihon:src:0", 2);
  assert.equal(t.calls[0].variables.source, "0");
  assert.equal(t.calls[0].variables.type, "POPULAR");
  assert.equal(t.calls[0].variables.page, 2);
  assert.equal(page.items[0].id, "mihon:1");
  assert.equal(page.hasNext, true);
});

test("search carries the query and the source", async () => {
  const t = fakeTransport(() => ({ fetchSourceManga: { mangas: [], hasNextPage: false } }));
  const provider = createMihonProvider(t);
  await provider.search("mihon:src:123", "batman", 1);
  assert.equal(t.calls[0].variables.type, "SEARCH");
  assert.equal(t.calls[0].variables.query, "batman");
  assert.equal(t.calls[0].variables.source, "123");
});

test("pages and read state address the runtime by bare numeric id", async () => {
  const t = fakeTransport((query) =>
    query.includes("fetchChapterPages") ? { fetchChapterPages: { pages: ["/api/v1/manga/12/chapter/1/page/0"] } } : { updateChapter: { chapter: { id: 1, isRead: true } } },
  );
  const provider = createMihonProvider(t);
  const pages = await provider.pages("mihon:ch:1");
  assert.equal(pages[0].url, "/api/mihon/v1/manga/12/chapter/1/page/0");
  await provider.setRead("mihon:ch:1", true);
  assert.deepEqual(t.calls[1].variables, { id: 1, read: true });
});

test("a provider rejects on a foreign id instead of guessing", async () => {
  const provider = createMihonProvider(fakeTransport(() => ({})));
  await assert.rejects(() => provider.pages("local:ch:1"), /not a mihon id/);
});

test("a runtime error is surfaced, not swallowed", async () => {
  const provider = createMihonProvider({
    asset,
    async gql() {
      throw new Error("mihon runtime answered 502");
    },
  });
  await assert.rejects(() => provider.sources(), /502/);
});

test("mihon does not own progress", () => {
  assert.equal(createMihonProvider(fakeTransport(() => ({}))).ownsProgress, false);
});

test("the browser transport reports a GraphQL error instead of returning empty data", async () => {
  const transport = async () =>
    new Response(JSON.stringify({ errors: [{ message: "no such source" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  const t = browserMihonTransport("/api/mihon", transport);
  await assert.rejects(() => t.gql("{ sources { nodes { id } } }"), /no such source/);
});

test("the browser transport posts to /api/mihon/graphql", async () => {
  let seen = null;
  const transport = async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const t = browserMihonTransport("/api/mihon", transport);
  assert.deepEqual(await t.gql("query Q { x }", { a: 1 }), { ok: true });
  assert.equal(seen.url, "/api/mihon/graphql");
  assert.deepEqual(seen.body, { query: "query Q { x }", variables: { a: 1 } });
});
