/**
 * A chapter's page list: numbered by position, and not lost when the source stops answering.
 *
 * Two failures this pins down, both of which showed as "the reader is wrong" rather than "the list
 * is wrong":
 *
 * - A source that numbers from 1 (or skips) shifted every page by one: page one was unreachable,
 *   a failure note landed on the wrong page, and "resume at 4" meant four pages into a list whose
 *   first entry claimed to be 1. The fix is one normalisation at the boundary every provider passes
 *   through, plus the two providers that passed a third party's number straight out.
 * - A source that failed — or answered `[]` — took the stored list with it when it was written back,
 *   so a chapter that had been readable offline became a chapter of no pages on the next open.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { normalizePages, usableStoredPages } from "../../src/lib/page-list.ts";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { DalvikClient, createDalvikProvider } from "../../src/api/dalvik.ts";
import { createPortableProvider } from "../../src/lib/extensions/portable-provider.ts";

const urls = (count) => Array.from({ length: count }, (_, index) => `https://source.example/${index}.jpg`);

test("a page's number is its position, whatever the provider claimed", () => {
  const oneBased = normalizePages(urls(3).map((url, index) => ({ index: index + 1, url })));
  assert.deepEqual(oneBased.map((page) => page.index), [0, 1, 2]);

  const sparse = normalizePages([
    { index: 0, url: "a" },
    { index: 7, url: "b" },
    { index: 7, url: "c" },
    { index: 2, url: "d" },
  ]);
  assert.deepEqual(sparse.map((page) => page.index), [0, 1, 2, 3], "a sparse or repeated index reached the reader");
});

test("normalising keeps the page itself and changes nothing else", () => {
  const headers = { Referer: "https://source.example" };
  const open = async () => new Blob([]);
  const [page] = normalizePages([{ index: 41, url: "https://source.example/1.jpg", headers, open }]);
  assert.equal(page.url, "https://source.example/1.jpg");
  assert.equal(page.headers, headers);
  assert.equal(page.open, open);
});

test("normalising twice is the same as normalising once", () => {
  const once = normalizePages(urls(4).map((url, index) => ({ index: index + 1, url })));
  assert.deepEqual(normalizePages(once), once);
});

test("an empty stored row is no list at all", () => {
  assert.deepEqual(usableStoredPages([]), []);
  assert.deepEqual(usableStoredPages([{ index: 0, url: "" }]), []);
  assert.equal(usableStoredPages([{ index: 0, url: "a" }, { index: 9, url: "b" }]).length, 2);
});

/* ---- the providers that carried a third party's numbering ---- */

async function stubRuntime(handlers) {
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ mangayomiMihonBridge: 1, imageProxy: true }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const handler = handlers[body.method];
      if (handler === undefined) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown method: ${body.method}`, code: 500 }));
        return;
      }
      const { status = 200, json } = handler(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

const source = { id: "2499283573021220255", name: "MangaDex", lang: "en", baseUrl: "https://mangadex.org" };

test("a Dalvik extension that counts pages from 1 still reaches page one", async () => {
  const runtime = await stubRuntime({
    getPageList: () => ({
      json: [
        { index: 1, url: "one", imageUrl: "/image/1" },
        { index: 2, url: "two", imageUrl: "/image/2" },
        { index: 7, url: "three", imageUrl: "/image/3" },
      ],
    }),
  });
  try {
    const provider = createDalvikProvider({
      client: new DalvikClient({ baseUrl: runtime.baseUrl }),
      extensions: [{ extensionId: "12fde776apk", packageId: "pkg", sources: [source] }],
    });
    const pages = await provider.pages(`dalvik:ch:${source.id}:/chapter/x`);
    assert.deepEqual(pages.map((page) => page.index), [0, 1, 2], "the extension's own numbering leaked out");
    assert.deepEqual(pages.map((page) => page.url), [`${runtime.baseUrl}/image/1`, `${runtime.baseUrl}/image/2`, `${runtime.baseUrl}/image/3`]);
  } finally {
    await runtime.close();
  }
});

test("a portable package is numbered by its answer, not by its own field", async () => {
  const provider = createPortableProvider({
    kind: "archive",
    packageId: "example.pkg",
    ownsProgress: true,
    runtime: {
      call: async (method) => {
        assert.equal(method, "pages");
        return [{ index: 1, url: "a" }, { index: 1, url: "b" }, { index: 5, url: "c" }];
      },
      supports: () => false,
    },
  });
  const pages = await provider.pages("archive:item:1");
  assert.deepEqual(pages.map((page) => page.index), [0, 1, 2]);
  assert.deepEqual(pages.map((page) => page.url), ["a", "b", "c"]);
});

/* ---- the stored-list fallback, through the real library state ---- */

/** A provider that answers for `local:` ids and reports how often it was asked. */
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
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
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

test("a source that fails does not empty a chapter the device already has", async () => {
  await withLibrary(async ({ library, store }) => {
    await store.putPages("local:c1", urls(3).map((url, index) => ({ index, url })));
    const { provider } = providerWith(new Error("the source is not answering"));
    library.profile = { store, providers: [provider] };

    const answer = await library.pageList("local:c1");
    assert.equal(answer.source, "stored", "a failure was reported instead of the stored list");
    assert.equal(answer.pages.length, 3);
    assert.deepEqual(answer.pages.map((page) => page.index), [0, 1, 2]);
  });
});

test("an empty answer never replaces a list the device already has", async () => {
  await withLibrary(async ({ library, store }) => {
    await store.putPages("local:c1", urls(4).map((url, index) => ({ index, url })));
    const { provider } = providerWith([]);
    library.profile = { store, providers: [provider] };

    const answer = await library.pageList("local:c1");
    assert.equal(answer.pages.length, 4, "an empty answer overwrote a good page list");
    assert.equal(answer.source, "stored");
    assert.equal((await store.getPages("local:c1")).length, 4, "the good list was written over");
  });
});

test("a fresh answer is normalised, written down, and reported as the source's", async () => {
  await withLibrary(async ({ library, store }) => {
    const { provider, calls } = providerWith(urls(5).map((url, index) => ({ index: index + 1, url })));
    library.profile = { store, providers: [provider] };

    const answer = await library.pageList("local:c1");
    assert.deepEqual(answer.pages.map((page) => page.index), [0, 1, 2, 3, 4], "the boundary passed 1-based numbers through");
    assert.equal(answer.source, "source");
    assert.deepEqual(calls, ["local:c1"]);
    const stored = await store.getPages("local:c1");
    assert.deepEqual(stored.map((page) => page.index), [0, 1, 2, 3, 4], "a 1-based list was written to the database");
  });
});

test("with nothing stored, a failing source is still an error the reader can show", async () => {
  await withLibrary(async ({ library, store }) => {
    const { provider } = providerWith(new Error("no connection"));
    library.profile = { store, providers: [provider] };
    await assert.rejects(library.pageList("local:c1"), /no connection/);
  });
});

test("with nothing stored, an empty answer is an empty chapter, not an error", async () => {
  await withLibrary(async ({ library, store }) => {
    const { provider } = providerWith([]);
    library.profile = { store, providers: [provider] };
    const answer = await library.pageList("local:c1");
    assert.deepEqual(answer.pages, []);
    assert.equal(answer.source, "source");
  });
});

test("pages() still answers a plain list for the callers that only want one", async () => {
  await withLibrary(async ({ library, store }) => {
    await store.putPages("local:c1", urls(2).map((url, index) => ({ index, url })));
    library.profile = { store, providers: [providerWith(new Error("down")).provider] };
    const pages = await library.pages("local:c1");
    assert.equal(pages.length, 2);
  });
});

test("the reader says when it is showing a stored page list", () => {
  const reader = readFileSync(new URL("../../src/views/Reader.svelte", import.meta.url), "utf8");
  assert.match(reader, /library\.pageList\(/, "the reader does not ask where its page list came from");
  assert.match(reader, /source === "stored"/, "the reader never checks for a stored list");
  assert.match(reader, /data-pages="stored"/, "there is no state for a stored page list");
});