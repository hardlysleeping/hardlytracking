import assert from "node:assert/strict";
import test from "node:test";

import {
  createKomgaProvider,
  komgaAuthHeaders,
  mapKomgaBook,
  mapKomgaLibrary,
  mapKomgaReadState,
  mapKomgaSeries,
  trimBase,
} from "../../src/api/komga.ts";
import { probeKomga } from "../../src/lib/komga.ts";

const BASE = "http://komga.test:25600";
const AUTH = komgaAuthHeaders("reader", "hunter2");

/** A fetch that records every request and answers from a table of path → body. */
function fakeKomga(table, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname + parsed.search, init });
    // Longest prefix wins: `/api/v1/books/b-1/pages` must not be answered by `/api/v1/books`.
    const key = Object.keys(table)
      .filter((pattern) => parsed.pathname.startsWith(pattern))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const value = table[key];
    const body = typeof value === "function" ? value(parsed) : value;
    const code = typeof body === "object" && body !== null && "status" in body ? body.status : status;
    if (code === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  };
  return { calls, impl };
}

const LIBRARIES = [{ id: "lib-1", name: "Comics" }];
const SERIES = [
  {
    id: "s-1",
    name: "Saga",
    libraryId: "lib-1",
    metadata: { title: "Saga", summary: "Space opera.", status: "ONGOING" },
    booksMetadata: { authors: [{ name: "Brian K. Vaughan", role: "writer" }, { name: "Fiona Staples", role: "penciller" }] },
  },
];
const BOOKS = [
  {
    id: "b-1",
    name: "Saga 001",
    number: 1,
    metadata: { title: "Chapter One", numberSort: 1, releaseDate: "2020-03-01" },
    media: { pagesCount: 24 },
    readProgress: { page: 12, completed: true, readDate: "2026-10-29T10:00:00Z" },
  },
  {
    id: "b-2",
    name: "Saga 002",
    number: 2,
    metadata: { title: "Chapter Two", numberSort: 2 },
    media: { pagesCount: 22 },
    readProgress: { page: 3, completed: false, readDate: "2026-10-28T09:00:00Z" },
  },
];

test("the login is HTTP basic over UTF-8, which is what Komga clients use", () => {
  assert.equal(AUTH.authorization, `Basic ${Buffer.from("reader:hunter2").toString("base64")}`);
  const unicode = komgaAuthHeaders("lecteur", "möt de passe");
  assert.equal(Buffer.from(unicode.authorization.replace("Basic ", ""), "base64").toString("utf8"), "lecteur:möt de passe");
});

test("a trailing slash on the address is trimmed, not doubled into every path", () => {
  assert.equal(trimBase("http://komga.test:25600///"), "http://komga.test:25600");
});

test("a library becomes a namespaced source", () => {
  const source = mapKomgaLibrary(LIBRARIES[0]);
  assert.equal(source.id, "komga:lib:lib-1");
  assert.equal(source.provider, "komga");
  assert.equal(source.name, "Comics");
});

test("a series carries its cover url and the header that cover needs", () => {
  const series = mapKomgaSeries(SERIES[0], BASE, AUTH);
  assert.equal(series.id, "komga:s-1");
  assert.equal(series.title, "Saga");
  assert.equal(series.cover, `${BASE}/api/v1/series/s-1/thumbnail`);
  assert.deepEqual(series.coverHeaders, AUTH, "an <img> cannot send the login, so the app must");
  assert.equal(series.author, "Brian K. Vaughan, Fiona Staples");
  assert.equal(series.description, "Space opera.");
  assert.equal(series.url, `${BASE}/series/s-1`, "the series page in Komga's own UI");
  assert.equal(series.status, "ONGOING");
});

test("a book is a chapter, read from readProgress.completed", () => {
  const chapter = mapKomgaBook(BOOKS[0], "komga:s-1");
  assert.equal(chapter.id, "komga:ch:b-1");
  assert.equal(chapter.seriesId, "komga:s-1");
  assert.equal(chapter.name, "Chapter One");
  assert.equal(chapter.number, 1);
  assert.equal(chapter.pageCount, 24);
  assert.equal(chapter.read, true);
  assert.equal(chapter.uploadedAt, Date.parse("2020-03-01T00:00:00Z"));

  assert.equal(mapKomgaBook(BOOKS[1], "komga:s-1").read, false);
});

test("read state carries the page and the server's own timestamp", () => {
  const remote = mapKomgaReadState(BOOKS);
  assert.deepEqual(remote[0], {
    chapterId: "komga:ch:b-1",
    read: true,
    page: 12,
    at: Date.parse("2026-10-29T10:00:00Z"),
  });
  assert.equal(remote[1].read, false);
  assert.equal(remote[1].page, 3);
});

test("the provider asks for libraries with the login", async () => {
  const komga = fakeKomga({ "/api/v1/libraries": LIBRARIES });
  const provider = createKomgaProvider({ baseUrl: BASE, username: "reader", password: "hunter2", fetchImpl: komga.impl });
  const sources = await provider.sources();
  assert.equal(sources[0].id, "komga:lib:lib-1");
  assert.equal(komga.calls[0].init.headers.authorization, AUTH.authorization);
});

test("browse asks for a page Komga understands, with the right sort per tab", async () => {
  const komga = fakeKomga({ "/api/v1/series": { content: SERIES, last: false } });
  const provider = createKomgaProvider({ baseUrl: BASE, username: "r", password: "p", fetchImpl: komga.impl, pageSize: 40 });

  await provider.latest("komga:lib:lib-1", 1);
  assert.match(komga.calls[0].path, /library_id=lib-1/);
  assert.match(komga.calls[0].path, /page=0/, "Komga pages are 0-based; ours are 1-based");
  assert.match(komga.calls[0].path, /sort=lastModified/);

  await provider.popular("komga:lib:lib-1", 2);
  assert.match(komga.calls[1].path, /page=1/);
  assert.match(komga.calls[1].path, /sort=created/);

  const page = await provider.search("komga:lib:lib-1", "saga", 1);
  assert.match(komga.calls[2].path, /search=saga/);
  assert.equal(page.items[0].id, "komga:s-1");
  assert.equal(page.hasNext, true);
});

test("chapters and then read state is one request, and pages carry the login", async () => {
  const komga = fakeKomga({
    "/api/v1/books": { content: BOOKS, last: true },
    "/api/v1/books/b-1/pages": [{ number: 0 }, { number: 1 }],
  });
  const provider = createKomgaProvider({ baseUrl: BASE, username: "r", password: "p", fetchImpl: komga.impl });

  const chapters = await provider.chapters("komga:s-1");
  const remote = await provider.readState("komga:s-1");
  assert.equal(komga.calls.length, 1, "the read state came from the list chapters() already had");
  assert.equal(chapters.length, 2);
  assert.equal(remote[0].read, true);

  const pages = await provider.pages("komga:ch:b-1");
  assert.equal(pages.length, 2);
  assert.equal(pages[1].url, `${BASE}/api/v1/books/b-1/pages/1`);
  assert.equal(pages[0].headers.authorization, komgaAuthHeaders("r", "p").authorization);
});

test("marking read writes completed, a page writes the page, unread deletes", async () => {
  const komga = fakeKomga({ "/api/v1/books/b-1/read-progress": { status: 204 } }, { status: 204 });
  const provider = createKomgaProvider({ baseUrl: BASE, username: "r", password: "p", fetchImpl: komga.impl });

  await provider.setRead("komga:ch:b-1", true);
  assert.equal(komga.calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(komga.calls[0].init.body), { completed: true });

  await provider.setRead("komga:ch:b-1", true, 7);
  assert.deepEqual(JSON.parse(komga.calls[1].init.body), { page: 7 });

  await provider.setRead("komga:ch:b-1", false);
  assert.equal(komga.calls[2].init.method, "DELETE");
});

test("a refused login says so, by name, instead of an empty shelf", async () => {
  const komga = fakeKomga({ "/api/v1/libraries": { status: 401 } }, { status: 401 });
  const provider = createKomgaProvider({ baseUrl: BASE, username: "reader", password: "wrong", fetchImpl: komga.impl });
  await assert.rejects(() => provider.sources(), /refused the login for "reader"/);
});

test("a server that is not there is a named failure, not a crash", async () => {
  const provider = createKomgaProvider({
    baseUrl: BASE,
    username: "r",
    password: "p",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(() => provider.sources(), /Komga is not answering at http:\/\/komga.test:25600/);
});

test("the card's test says which libraries the login can see", async () => {
  const ok = fakeKomga({ "/api/v1/users/me": { email: "reader@example.test" }, "/api/v1/libraries": LIBRARIES });
  const probe = await probeKomga({ baseUrl: BASE, username: "reader", password: "hunter2" }, ok.impl);
  assert.deepEqual(probe, { ok: true, libraries: ["Comics"] });

  const refused = fakeKomga({ "/api/v1/users/me": { status: 401 } }, { status: 401 });
  const bad = await probeKomga({ baseUrl: BASE, username: "reader", password: "nope" }, refused.impl);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /refused that login \(401\)/);
});
