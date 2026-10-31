import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import {
  WebdavError,
  comicEntries,
  createWebdavProvider,
  decodePath,
  encodePath,
  parseMultistatus,
  relativePath,
} from "../../src/api/webdav.ts";

const FOLDER = "https://cloud.example.com/remote.php/dav/files/me/Comics";

/** A Nextcloud-style answer: `d:` prefixes, absolute hrefs, percent-encoding, a collection. */
const MULTISTATUS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/remote.php/dav/files/me/Comics/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/me/Comics/Saga%20v02.cbz</d:href>
    <d:propstat><d:prop>
      <d:resourcetype/>
      <d:getcontentlength>1048576</d:getcontentlength>
      <d:getlastmodified>Fri, 30 Oct 2026 10:00:00 GMT</d:getlastmodified>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/me/Comics/Saga%20v10.cbz</d:href>
    <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>2048</d:getcontentlength></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/me/Comics/Notes &amp; Extras/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/me/Comics/ComicInfo.xml</d:href>
    <d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat>
  </d:response>
</d:multistatus>`;

test("a multistatus is read into entries, folders and sizes included", () => {
  const entries = parseMultistatus(MULTISTATUS);
  assert.equal(entries.length, 5);
  const saga = entries.find((entry) => entry.href.endsWith("Saga%20v02.cbz"));
  assert.ok(saga);
  assert.equal(saga.isDir, false);
  assert.equal(saga.size, 1048576);
  assert.equal(saga.modified, "Fri, 30 Oct 2026 10:00:00 GMT");
  assert.equal(entries.filter((entry) => entry.isDir).length, 2);
});

test("an escaped ampersand in a name survives", () => {
  const entries = parseMultistatus(MULTISTATUS);
  assert.ok(entries.some((entry) => entry.href.includes("Notes & Extras")));
});

test("an href is resolved against the folder, decoded, and the folder itself is not a file", () => {
  assert.equal(relativePath(FOLDER, "/remote.php/dav/files/me/Comics/Saga%20v02.cbz"), "Saga v02.cbz");
  assert.equal(relativePath(FOLDER, "https://cloud.example.com/remote.php/dav/files/me/Comics/a.pdf"), "a.pdf");
  assert.equal(relativePath(FOLDER, "/remote.php/dav/files/me/Comics/"), null);
  // A server that answers for something outside the folder (a sibling share) is not our library.
  assert.equal(relativePath(FOLDER, "/remote.php/dav/files/me/Other/x.cbz"), null);
});

test("only comics are listed, and they sort naturally", () => {
  const rows = comicEntries(parseMultistatus(MULTISTATUS), FOLDER).map((row) => row.relative);
  assert.deepEqual(rows, ["Saga v02.cbz", "Saga v10.cbz"]);
});

test("an id carries the path and comes back unchanged, unicode included", () => {
  for (const path of ["Saga v01.cbz", "folder/Berserk 001 (2003).pdf", "café/日本.cbz"]) {
    assert.equal(decodePath(encodePath(path)), path);
    // Ids go into a hash route, so they must not contain characters a URL would mangle.
    assert.doesNotMatch(encodePath(path), /[+/=]/);
  }
});

/** A fetch that answers PROPFIND with the fixture and files with zip bytes, counting the calls. */
function fakeFetch(pages = null) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {} });
    if (init.method === "PROPFIND") return new Response(MULTISTATUS, { status: 207 });
    if (pages !== null) return new Response(pages, { status: 200 });
    return new Response("no", { status: 404 });
  };
  return { fetcher, calls };
}

/** Two PNG-ish pages in a zip, so the provider has something real to open. */
function twoPageZip() {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  return zipSync({ "001.png": png, "002.png": png, "ComicInfo.xml": strToU8("<ComicInfo/>") });
}

function fakeStore() {
  const books = new Map();
  return {
    books,
    async getBook(seriesId) {
      return books.get(seriesId);
    },
    async putBook(row) {
      books.set(row.seriesId, row);
    },
  };
}

test("the folder lists as series, filtered by what the user typed", async () => {
  const { fetcher, calls } = fakeFetch();
  const provider = createWebdavProvider({ url: FOLDER, username: "me", password: "pw", store: fakeStore(), fetchImpl: fetcher });

  const all = await provider.search("webdav:src:folder", "", 1);
  assert.deepEqual(all.items.map((row) => row.title), ["Saga v02", "Saga v10"]);
  assert.equal(all.hasNext, false);

  const narrowed = await provider.search("webdav:src:folder", "v10", 1);
  assert.deepEqual(narrowed.items.map((row) => row.title), ["Saga v10"]);

  // One request for the listing, a real PROPFIND carrying the login.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "PROPFIND");
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from("me:pw").toString("base64")}`);
  assert.equal(calls[0].headers.depth, "1");
  assert.ok(calls[0].url.endsWith("/Comics/"));
});

test("a wrong login names the user rather than showing an empty folder", async () => {
  const provider = createWebdavProvider({
    url: FOLDER,
    username: "me",
    password: "wrong",
    store: fakeStore(),
    fetchImpl: async () => new Response("", { status: 401 }),
  });
  await assert.rejects(provider.search("webdav:src:folder", "", 1), (error) => {
    assert.ok(error instanceof WebdavError);
    assert.equal(error.status, 401);
    assert.match(error.message, /refused the login for "me"/);
    return true;
  });
});

test("a chapter's pages come from one download, and the second read never touches the network", async () => {
  const store = fakeStore();
  const { fetcher, calls } = fakeFetch(twoPageZip());
  const provider = createWebdavProvider({ url: FOLDER, username: "me", password: "pw", store, fetchImpl: fetcher });

  const series = (await provider.search("webdav:src:folder", "v02", 1)).items[0];
  const chapters = await provider.chapters(series.id);
  assert.equal(chapters.length, 1);
  // Nothing is downloaded just to list a title.
  assert.equal(chapters[0].pageCount, 0);
  assert.equal(store.books.size, 0);

  const pages = await provider.pages(chapters[0].id);
  assert.equal(pages.length, 2);
  assert.equal(store.books.size, 1);
  const stored = store.books.get(series.id);
  assert.equal(stored.pageCount, 2);
  assert.equal(stored.name, "Saga v02.cbz");

  const first = await pages[0].open();
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()).slice(0, 4), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

  // The download happened once. Reading again reuses the stored book — no second GET.
  const before = calls.filter((call) => call.method === "GET").length;
  const again = await provider.pages(chapters[0].id);
  assert.equal(await (await again[1].open()).arrayBuffer().then((b) => b.byteLength > 0), true);
  assert.equal(calls.filter((call) => call.method === "GET").length, before);
  assert.equal(store.books.size, 1);
});

test("two callers asking at once share one download", async () => {
  // Measured live: the reader and the quick sheet both asked before the first download finished and
  // the server got two GETs for one book. The second call now waits on the first.
  const store = fakeStore();
  const { fetcher, calls } = fakeFetch(twoPageZip());
  const provider = createWebdavProvider({ url: FOLDER, username: "me", password: "pw", store, fetchImpl: fetcher });
  const series = (await provider.search("webdav:src:folder", "v02", 1)).items[0];
  const chapterId = `webdav:ch:${encodePath("Saga v02.cbz")}`;

  const [a, b] = await Promise.all([provider.pages(chapterId), provider.pages(chapterId)]);
  assert.equal(a.length, 2);
  assert.equal(b.length, 2);
  assert.equal(calls.filter((call) => call.method === "GET").length, 1);
  assert.equal(store.books.size, 1);
  assert.equal(store.books.get(series.id).pageCount, 2);
});

test("the source is one folder and says so", async () => {
  const provider = createWebdavProvider({ url: FOLDER, username: "me", password: "pw", store: fakeStore(), fetchImpl: fakeFetch().fetcher });
  const sources = await provider.sources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].provider, "webdav");
  assert.equal(provider.kind, "webdav");
  // A folder has nowhere to keep a read mark, so progress is ours — same as an imported file.
  assert.equal(provider.ownsProgress, true);
  await assert.rejects(provider.setRead("webdav:ch:x", true), /keeps no read state/);
});
