import { test } from "node:test";
import assert from "node:assert/strict";

import { createPortableProvider } from "../../src/lib/extensions/portable-provider.ts";

/** A runtime that records the calls and answers from a table — the Worker without the Worker. */
function fakeRuntime(answers, supported) {
  const calls = [];
  return {
    calls,
    supports: (method) => supported.includes(method),
    async call(method, args) {
      calls.push([method, args]);
      const answer = answers[method];
      if (answer === undefined) throw new Error(`no answer for ${method}`);
      return typeof answer === "function" ? answer(...args) : answer;
    },
  };
}

const SERIES = { id: "server1:series1", title: "Saga", cover: "https://k/api/v1/series/1/thumbnail" };
const CHAPTER = { id: "book1", name: "Vol. 1", number: 1, pageCount: 3, read: false };

function provider(answers, supported = ["sources", "popular", "latest", "search", "details", "chapters", "pages", "setRead"]) {
  return createPortableProvider({
    kind: "komga",
    packageId: "org.hardlytracking.komga",
    ownsProgress: false,
    runtime: fakeRuntime(answers, supported),
  });
}

test("a source id is namespaced on the way out", async () => {
  const p = provider({
    sources: () => [{ id: "lib:1", name: "Comics", lang: "en" }],
  });
  const sources = await p.sources();
  assert.deepEqual(sources, [{ id: "komga:lib:1", provider: "komga", name: "Comics", lang: "en" }]);
});

test("a namespaced id is stripped before it reaches the package", async () => {
  const runtime = fakeRuntime(
    {
      popular: () => ({ items: [SERIES], hasNext: true }),
      details: () => SERIES,
      chapters: () => [CHAPTER],
      pages: () => [{ index: 0, url: "https://k/page/0.jpg", headers: { "X-Api-Key": "k" } }],
    },
    ["sources", "popular", "latest", "search", "details", "chapters", "pages", "setRead"],
  );
  const p = createPortableProvider({ kind: "komga", packageId: "org.hardlytracking.komga", ownsProgress: false, runtime });

  await p.popular("komga:lib:1", 2);
  await p.details("komga:server1:series1");
  await p.chapters("komga:server1:series1");
  const pages = await p.pages("komga:book1");

  assert.deepEqual(runtime.calls.map(([m]) => m), ["popular", "details", "chapters", "pages"]);
  assert.deepEqual(runtime.calls[0][1], ["lib:1", 2], "the package sees its own id, not ours");
  assert.deepEqual(runtime.calls[1][1], ["server1:series1"]);
  // Pages keep the headers the server requires; an <img> cannot send them, the cache can.
  assert.deepEqual(pages, [{ index: 0, url: "https://k/page/0.jpg", headers: { "X-Api-Key": "k" } }]);
});

test("what comes back is namespaced and carries the kind", async () => {
  const p = provider({
    popular: () => ({ items: [SERIES], hasNext: false }),
    details: () => SERIES,
    chapters: () => [CHAPTER],
  });
  const page = await p.popular("komga:lib:1", 1);
  assert.deepEqual(page.items[0], {
    ...SERIES,
    id: "komga:server1:series1",
    provider: "komga",
  });
  assert.equal(page.hasNext, false);

  const details = await p.details("komga:server1:series1");
  assert.equal(details.id, "komga:server1:series1");

  const chapters = await p.chapters("komga:server1:series1");
  assert.equal(chapters[0].id, "komga:book1");
  assert.equal(chapters[0].seriesId, "komga:server1:series1");
  assert.equal(chapters[0].read, false);
});

test("progress ownership is declared, and setRead carries the page", async () => {
  const runtime = fakeRuntime({ setRead: () => undefined }, ["setRead"]);
  const p = createPortableProvider({ kind: "komga", packageId: "org.hardlytracking.komga", ownsProgress: false, runtime });
  assert.equal(p.ownsProgress, false);
  await p.setRead("komga:book1", true, 7);
  assert.deepEqual(runtime.calls[0], ["setRead", ["book1", true, 7]]);
});

test("a method the package does not have is absent, not a silent empty answer", async () => {
  const p = provider({ sources: () => [] }, ["sources"]);
  assert.equal(p.filters, undefined, "no Filters button rather than an empty sheet");
  assert.equal(p.readState, undefined, "nothing to reconcile");
  await assert.rejects(() => p.setRead("komga:book1", true), /setRead/);
});

test("a package that declares filters and read state gets both", async () => {
  const p = provider(
    {
      filters: () => [{ kind: "header", name: "Sort" }],
      readState: () => [{ chapterId: "book1", read: true, page: 4 }],
    },
    ["sources", "filters", "readState"],
  );
  assert.deepEqual(await p.filters("komga:lib:1"), [{ kind: "header", name: "Sort" }]);
  assert.deepEqual(await p.readState("komga:server1:series1"), [{ chapterId: "book1", read: true, page: 4 }]);
});

test("a malformed payload fails by name instead of rendering a broken row", async () => {
  const p = provider({
    popular: () => ({ items: [{ title: "no id here" }], hasNext: false }),
    chapters: () => [{ name: "no id", seriesId: "", number: 1, pageCount: 1, read: false }],
  });
  await assert.rejects(() => p.popular("komga:lib:1", 1), /series without an id/);
  await assert.rejects(() => p.chapters("komga:server1:series1"), /chapter without an id/);
});

test("an id from another provider is refused by name", async () => {
  const p = provider({ details: () => SERIES });
  await assert.rejects(() => p.details("mihon:12"), /not a komga id/);
});
