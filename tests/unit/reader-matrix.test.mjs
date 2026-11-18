/**
 * The reader's page matrix: every place a chapter can come from, through the same seam.
 *
 * `page-list.test.mjs` asks about one failure at a time; `reader.test.mjs` about the queue. This
 * file is the table the plan names (`#28`): Local CBZ, Local PDF, a downloaded chapter, a partial
 * download, Dalvik, Suwayomi, Mihon, a page that needs headers, a source that is offline while its
 * page list is cached, and page 1 failing while page 2 succeeds — every one asserted for
 * **positions** (the reader counts from 0 whatever the source says), **fallback order** (device,
 * then source, then the stored list) and **state** (loading, failed-with-a-retry, missing, stored).
 *
 * Fixtures only: a zip written in this file, a fake pdf.js document, a generated page list, the
 * Dalvik fixture server, a fake Suwayomi transport and the in-memory database. No real library,
 * no owner runtime, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";

import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { createLocalProvider } from "../../src/api/local.ts";
import { createMihonProvider } from "../../src/api/mihon.ts";
import { createSuwayomiProvider } from "../../src/api/suwayomi.ts";
import { DalvikClient, createDalvikProvider } from "../../src/api/dalvik.ts";
import { fileChapterId, fileSeriesId } from "../../src/lib/files/import.ts";
import { normalizePages, usableStoredPages } from "../../src/lib/page-list.ts";
import { forgetLocalPages, imageSrc, isPrivate, pageSrc } from "../../src/lib/pages.ts";
import { DownloadEngine } from "../../src/lib/downloads/engine.ts";
import { ReaderQueue, readerOrder } from "../../src/lib/reader.ts";
import { EXTENSION_NAME, PACKAGE_NAME, SOURCE_IDS, startDalvikMock } from "../fixtures/dalvik-mock.mjs";

const reader = readFileSync(new URL("../../src/views/Reader.svelte", import.meta.url), "utf8");

/** The smallest thing that is still a picture file name — the bytes only have to round-trip. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

/** A CBZ whose entry names are deliberately out of order: the page order is the natural one. */
function cbz(names) {
  return new Blob([zipSync(Object.fromEntries(names.map((name) => [name, PNG])))], { type: "application/zip" });
}

/** A book on the shelf, exactly as the importer writes one: bytes in `bookFiles`, ids derived. */
async function putFile(store, name, kind, pageCount, blob) {
  const seriesId = fileSeriesId(name, blob.size);
  const chapterId = fileChapterId(seriesId);
  await store.putBook({ seriesId, chapterId, name, kind, pageCount, bytes: blob.size, addedAt: 1_700_000_000_000, blob });
  return { seriesId, chapterId };
}

const positions = (count) => Array.from({ length: count }, (_, index) => index);

/** Positions, never a provider's own numbers: the rule every source is checked against. */
function assertPages(list, count, label) {
  assert.equal(list.length, count, `${label}: expected ${count} pages, got ${list.length}`);
  assert.deepEqual(list.map((page) => page.index), positions(count), `${label}: pages are not numbered by position`);
}

/* ---- the local file providers ------------------------------------------------------------- */

async function cbzPages() {
  const store = new LibraryStore(memoryDatabase());
  const { seriesId, chapterId } = await putFile(store, "Probe v01.cbz", "cbz", 3, cbz(["003.png", "001.png", "002.png"]));
  const pages = await createLocalProvider(store).pages(chapterId);
  return { store, seriesId, chapterId, pages };
}

async function pdfPages(t) {
  // pdf.js is the one dependency that needs a browser (worker + canvas), so the *document* is the
  // fixture here: what this proves is the app's contract — a PDF is a chapter of `numPages` pages,
  // none of them decoded until the reader asks for that page.
  let opened = 0;
  const document = {
    numPages: 4,
    async getPage() {
      opened += 1;
      return { getViewport: () => ({ width: 300, height: 400 }) };
    },
    async destroy() {},
  };
  t.mock.module("pdfjs-dist", {
    namedExports: { GlobalWorkerOptions: {}, OPS: {}, getDocument: () => ({ promise: Promise.resolve(document) }) },
    defaultExport: {},
  });
  const store = new LibraryStore(memoryDatabase());
  const { seriesId, chapterId } = await putFile(store, "Probe v02.pdf", "pdf", 4, new Blob([new Uint8Array([1, 2, 3])]));
  const pages = await createLocalProvider(store).pages(chapterId);
  return { store, seriesId, chapterId, pages, opened: () => opened };
}

/* ---- downloads ---------------------------------------------------------------------------- */

/** A store, an engine and the two things the engine cannot own: a page list and page bytes. */
function downloadRig() {
  const store = new LibraryStore(memoryDatabase());
  const host = { rows: [], queue: [], active: null, error: null };
  const fetched = [];
  let failOn = null;
  let made = 0;
  const engine = new DownloadEngine(host, {
    store,
    pages: async () => Array.from({ length: 5 }, (_, index) => ({ index, url: `https://fixture.example/${index}.jpg` })),
    fetchBlob: async (page) => {
      fetched.push(page.index);
      if (page.index === failOn) throw new Error(`page ${page.index + 1}: HTTP 404`);
      return new Blob([new Uint8Array([page.index, 1, 2])]);
    },
    now: () => 1_000,
    createUrl: () => `blob:fixture/${(made += 1)}`,
    revokeUrl: () => {},
  });
  const chapter = { id: "ch1", seriesId: "s1", name: "Chapter 1", number: 1, pageCount: 5, read: false };
  return { store, host, engine, fetched, chapter, failAt: (index) => (failOn = index) };
}

async function completeDownload() {
  const rig = downloadRig();
  rig.engine.enqueue("s1", rig.chapter);
  await rig.engine.whenIdle();
  return { ...rig, local: await rig.engine.local("ch1") };
}

async function partialDownload() {
  const rig = downloadRig();
  rig.failAt(2);
  rig.engine.enqueue("s1", rig.chapter);
  await rig.engine.whenIdle();
  return { ...rig, local: await rig.engine.local("ch1") };
}

/* ---- the three remote transports --------------------------------------------------------- */

async function dalvikPages() {
  const mock = await startDalvikMock({});
  try {
    const client = new DalvikClient({ baseUrl: mock.baseUrl });
    const extensions = [{ extensionId: mock.extensionId, packageId: PACKAGE_NAME, name: EXTENSION_NAME, sources: mock.sources() }];
    const provider = createDalvikProvider({ client, extensions });
    const series = (await provider.popular(`dalvik:src:${SOURCE_IDS.html}`, 1)).items[0];
    const chapters = await provider.chapters(series.id);
    return await provider.pages(chapters[0].id);
  } finally {
    await mock.close();
  }
}

/** Suwayomi's GraphQL, answered from memory; the asset host is a LAN address on purpose. */
function suwayomiProvider() {
  const fetchImpl = async (_url, init) => {
    const { query } = JSON.parse(init.body);
    if (String(query).includes("Pages")) {
      return Response.json({ data: { fetchChapterPages: { pages: ["/api/v1/page/0", "/api/v1/page/1", "/api/v1/page/2"] } } });
    }
    return Response.json({ data: {} });
  };
  return createSuwayomiProvider({
    baseUrl: "http://192.168.10.20:4567",
    username: "reader",
    password: "secret",
    fetchImpl,
    proxied: false,
  });
}

function mihonProvider() {
  return createMihonProvider({
    asset: (path) => `https://mihon.example${path}`,
    async gql(query) {
      if (String(query).includes("Pages")) return { fetchChapterPages: { pages: ["/1.jpg", "/2.jpg", "/3.jpg"] } };
      throw new Error(`unexpected query in the fixture: ${String(query).slice(0, 40)}`);
    },
  });
}

/* ---- the matrix ---------------------------------------------------------------------------- */

test("every place a chapter can come from numbers its pages by position", async (t) => {
  const cbzList = await cbzPages();
  const pdfList = await pdfPages(t);
  const complete = await completeDownload();
  const partial = await partialDownload();
  const remote = {
    Dalvik: await dalvikPages(),
    Suwayomi: await suwayomiProvider().pages("mihon:ch:42"),
    Mihon: await mihonProvider().pages("mihon:ch:7"),
  };

  assertPages(cbzList.pages, 3, "local CBZ");
  assertPages(pdfList.pages, 4, "local PDF");
  assertPages(remote.Dalvik, 3, "Dalvik");
  assertPages(remote.Suwayomi, 3, "Suwayomi");
  assertPages(remote.Mihon, 3, "Mihon");

  // A downloaded chapter is the device's copy: one slot per page, in order, and every slot full
  // when the download finished.
  assert.equal(complete.local.total, 5, "a complete download does not name its length");
  assert.equal(complete.local.urls.length, 5);
  assert.ok(complete.local.urls.every((url) => url !== null), "a complete download left a page empty");

  // A partial one is the same list with holes, never a shorter list: the hole is what tells the
  // reader which page to ask the source for.
  assert.equal(partial.local.urls.length, 5, "a partial download changed the chapter's length");
  assert.deepEqual(
    partial.local.urls.map((url) => (url === null ? null : "stored")),
    ["stored", "stored", null, null, null],
  );

  // Every source's own numbering is normalised at the boundary; a 1-based or sparse list becomes
  // positions, which is what `data-page`, notes, progress and the scroll observer all key on.
  const messy = normalizePages([
    { index: 1, url: "a" },
    { index: 9, url: "b" },
    { index: 9, url: "c" },
  ]);
  assert.deepEqual(messy.map((page) => page.index), [0, 1, 2]);
  for (const [label, list] of Object.entries(remote)) {
    assert.deepEqual(usableStoredPages(list).length, 3, `${label}: a usable list lost a page`);
  }
});

/* ---- the local file providers, in detail --------------------------------------------------- */

test("a CBZ produces one page per entry, on demand, and the reader holds one URL per page", async () => {
  forgetLocalPages();
  const { pages, seriesId } = await cbzPages();
  assert.deepEqual(
    pages.map((page) => page.url),
    positions(3).map((index) => `book:${seriesId}#${index}`),
    "a local page has no stable pseudo-URL for the reader's cache to key on",
  );

  // The bytes are the entry's, read when the page is asked for.
  const first = new Uint8Array(await (await pages[0].open()).arrayBuffer());
  assert.deepEqual(first, PNG, "page 1 did not read back as the archive's entry");

  let opened = 0;
  const page = { ...pages[1], open: async () => ((opened += 1), pages[1].open()) };
  const src = await pageSrc(page);
  assert.match(src, /^(blob:|data:)/, `a produced page became ${src}`);
  assert.equal(await pageSrc(page), src, "the same page was produced twice");
  assert.equal(opened, 1, "the reader produced a page it already had");
  forgetLocalPages();
});

test("a PDF is a chapter of its own length, and nothing is decoded before the reader asks", async (t) => {
  const { pages, opened } = await pdfPages(t);
  assert.equal(pages.length, 4);
  assert.equal(opened(), 0, "a PDF page was drawn for a chapter that was only opened");
  assert.ok(pages.every((page) => typeof page.open === "function"), "a PDF page cannot be asked for");
});

/* ---- downloads, in detail ------------------------------------------------------------------ */

test("a complete download opens the chapter with no source at all", async () => {
  const { local, host } = await completeDownload();
  assert.equal(local.complete, true);
  assert.equal(local.state, "done");
  assert.equal(local.stored, 5);
  assert.equal(host.error, null, "a clean download left an error behind");
});

test("a partial download keeps what arrived, and a retry fetches only the gaps", async () => {
  const rig = await partialDownload();
  assert.equal(rig.local.complete, false, "a broken download claimed to be complete");
  assert.equal(rig.local.state, "partial");
  assert.equal(rig.local.stored, 2);
  assert.equal(rig.local.total, 5, "the chapter's length was taken from the pages that arrived");
  assert.match(rig.host.error, /Chapter 1: .*HTTP 404/, "the failure was not reported");
  assert.deepEqual(rig.fetched, [0, 1, 2], "the pages that arrived were fetched again");

  // The retry path from the downloads screen: the pages already on disk are skipped.
  rig.failAt(-1);
  rig.engine.retry("ch1");
  await rig.engine.whenIdle();
  const after = await rig.engine.local("ch1");
  assert.equal(after.complete, true, "a retried download did not finish");
  assert.equal(after.stored, 5);
  assert.deepEqual(rig.fetched, [0, 1, 2, 2, 3, 4], "the retry re-downloaded pages it already had");
});

/* ---- fallback order, through the real library state ---------------------------------------- */

/** A provider for `local:` ids that answers however the case needs, and counts its calls. */
function providerWith(pages) {
  const calls = [];
  return {
    calls,
    provider: {
      kind: "local",
      ownsProgress: true,
      id: "local",
      label: "Fixture",
      async pages(chapterId) {
        calls.push(chapterId);
        const answer = typeof pages === "function" ? pages(chapterId) : pages;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

async function withLibrary(run) {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    configFile: new URL("../../vite.config.ts", import.meta.url).pathname,
  });
  try {
    const { library } = await vite.ssrLoadModule("/src/state/library.svelte.ts");
    const store = new LibraryStore(memoryDatabase());
    await run({ library, store });
  } finally {
    await vite.close();
  }
}

test("an offline source is answered by the cached list, and a fresh answer still wins", async () => {
  await withLibrary(async ({ library, store }) => {
    await store.putPages("local:c1", positions(3).map((index) => ({ index, url: `https://fixture.example/${index}.jpg` })));

    // 1. The source is down and the device has the list: the chapter still reads, and says which
    //    list it is reading.
    const down = providerWith(new Error("no connection"));
    library.profile = { store, providers: [down.provider] };
    const stored = await library.pageList("local:c1");
    assert.equal(stored.source, "stored", "an offline source was reported instead of the stored list");
    assert.deepEqual(stored.pages.map((page) => page.index), [0, 1, 2]);

    // 2. An empty answer is not a replacement: `[]` is a rate-limited source, not an empty chapter.
    const empty = providerWith([]);
    library.profile = { store, providers: [empty.provider] };
    const kept = await library.pageList("local:c1");
    assert.equal(kept.source, "stored");
    assert.equal((await store.getPages("local:c1")).length, 3, "an empty answer destroyed a readable list");

    // 3. A source that answers is the newest truth, and it is written down — normalised.
    const fresh = providerWith(positions(2).map((index) => ({ index: index + 1, url: `https://fixture.example/new-${index}.jpg` })));
    library.profile = { store, providers: [fresh.provider] };
    const answered = await library.pageList("local:c1");
    assert.equal(answered.source, "source");
    assert.deepEqual(answered.pages.map((page) => page.index), [0, 1], "a 1-based answer reached the reader as-is");
    assert.deepEqual(
      (await store.getPages("local:c1")).map((page) => page.index),
      [0, 1],
      "a 1-based answer was written to the database",
    );

    // 4. With nothing stored there is nothing to fall back to: the failure is the answer.
    const lost = providerWith(new Error("no connection"));
    library.profile = { store, providers: [lost.provider] };
    await assert.rejects(library.pageList("local:c9"), /no connection/);
  });
});

/* ---- headers, retry, and the state the reader shows ----------------------------------------- */

test("a page that needs headers is fetched, never pointed at directly", () => {
  const headers = { referer: "https://fixture.example/", "user-agent": "HardlyTracking/fixture" };
  const guarded = { index: 1, url: "https://fixture.example/1.jpg", headers };
  const plain = { index: 0, url: "https://fixture.example/0.jpg" };

  const src = imageSrc(guarded);
  assert.notEqual(src, guarded.url, "a header-bearing page was pointed at directly");
  assert.match(src, /\/api\/img\?url=.*&h=/);
  assert.equal(imageSrc(plain), plain.url, "a plain page was routed through the proxy");

  // A source on the private network is fetched here, not through `/api/img` — that route refuses
  // private addresses by design, and a Komga nearly always is one.
  assert.equal(isPrivate("http://192.168.10.20:4567/api/v1/page/0"), true);
  assert.equal(isPrivate("http://10.0.0.5/page.jpg"), true);
  assert.equal(isPrivate("https://fixture.example/page.jpg"), false);

  // The two buttons the failed-page card offers, and the state each page box carries.
  assert.match(reader, /import \{ pageSrc, retryPageSrc \} from "\.\.\/lib\/pages"/);
  assert.match(reader, /attempt > 0\s*\n?\s*\? await withDeadline\(retryPageSrc\(page, signal\)/);
  assert.match(reader, /data-page=\{page\.index\}/);
  assert.match(reader, /data-loading=\{loading\[page\.index\] === true \? "true" : undefined\}/);
  assert.match(reader, /class="pageerror" role="alert" data-page-error=\{page\.index\}/);
  assert.match(reader, /Retry page \{page\.index \+ 1\}/);
  assert.match(reader, /This page did not load on a second attempt\./);
  assert.match(reader, /Page \{page\.index \+ 1\} is not on this device/);
});

test("page one failing is one card; page two still paints", async () => {
  assert.deepEqual(readerOrder(0, 3, 2, 0), [0, 1, 2], "the queue did not read forwards from the current page");

  const started = [];
  const finished = [];
  const jobs = positions(3).map((index) => ({
    async run() {
      started.push(index);
      if (index === 0) throw new Error("Page 1 could not load");
      finished.push(index);
    },
  }));

  // No grace: one lane, strict reading order. That is the normal case, and the one where a
  // failure must not become a stall.
  const queue = new ReaderQueue(60_000);
  queue.set(jobs);
  await waitFor(() => finished.length === 2);
  assert.deepEqual(started, [0, 1, 2], "one page at a time, in reading order");
  assert.deepEqual(finished, [1, 2], "page 2 waited on page 1");

  // Re-setting the same window does not re-run a page that already failed on its own: the card's
  // button is the only retry, and it says so after the second attempt.
  queue.set(jobs);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(started, [0, 1, 2], "a page that already failed was retried without being asked");
  queue.cancel();
});

test("the reader asks the device first, then the source, and says when the list is stored", () => {
  const downloaded = reader.indexOf("downloads.local(id)");
  const source = reader.indexOf("library.pageList(id)");
  assert.ok(downloaded > 0, "the reader never checks the device's copy");
  assert.ok(source > downloaded, "the source was asked before the downloaded chapter was checked");
  assert.match(reader, /storedNotice = nextPages\?\.source === "stored"/);
  assert.match(reader, /data-pages="stored"/);
  assert.match(reader, /Using the page list saved on this device\. The source did not answer\./);
  assert.match(reader, /pages are not on this device\. Missing pages will be fetched when reached/);
  assert.match(reader, /This chapter has no pages\./, "an empty chapter would be a blank screen");
});

/** Resolve once `predicate` holds, or throw after a generous number of turns. */
async function waitFor(predicate, turns = 200) {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the queue never settled");
}