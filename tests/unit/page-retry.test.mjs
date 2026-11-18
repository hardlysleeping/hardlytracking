/**
 * One page, asked for a second time — by the path that can actually succeed.
 *
 * A failed page used to be a sentence painted by a CSS pseudo-element: nothing to focus, nothing to
 * press, and the only retry restarted the whole chapter. Re-pointing the same `<img>` at the same
 * URL is not a retry either: it repeats the request that just failed (no `Referer` the host wants, a
 * webview origin the host refuses, an at-home token that has expired). The retry therefore asks for
 * the bytes through the native transport and hands back a blob URL, and it is offered exactly once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { forgetRetriedPages, retryPageSrc } from "../../src/lib/pages.ts";

const reader = readFileSync(new URL("../../src/views/Reader.svelte", import.meta.url), "utf8");

async function withFetch(impl, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return impl(String(input), init);
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
    forgetRetriedPages();
  }
}

function png(size = 8) {
  return new Blob([new Uint8Array(size)], { type: "image/png" });
}

test("a retried page comes back as a blob URL, with the headers the source asked for", async () => {
  await withFetch(
    async () => new Response(png(32), { status: 200, headers: { "content-type": "image/png" } }),
    async (calls) => {
      const url = await retryPageSrc({ index: 4, url: "https://source.example/5.jpg", headers: { Referer: "https://source.example" } });
      assert.match(url, /^blob:/, "the retry did not hand back a drawable URL");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://source.example/5.jpg");
      assert.deepEqual(calls[0].init.headers, { Referer: "https://source.example" }, "the retry dropped the source's headers");
    },
  );
});

test("a page the host refuses says so, instead of handing back the URL that failed", async () => {
  await withFetch(
    async () => new Response("no", { status: 403 }),
    async () => {
      await assert.rejects(
        retryPageSrc({ index: 1, url: "https://source.example/2.jpg" }),
        /page 2 could not be fetched \(403\)/,
      );
    },
  );
});

test("an empty body is a failure, not a blank page", async () => {
  await withFetch(
    async () => new Response(png(0), { status: 200 }),
    async () => {
      await assert.rejects(retryPageSrc({ index: 0, url: "https://source.example/1.jpg" }), /came back empty/);
    },
  );
});

test("a page this device produces itself is retried by producing it again", async () => {
  let produced = 0;
  const page = {
    index: 2,
    url: "book:series#2",
    open: async () => {
      produced += 1;
      return png(16);
    },
  };
  const url = await retryPageSrc(page);
  assert.match(url, /^blob:/);
  assert.equal(produced, 1);
  forgetRetriedPages();
});

test("a cancelled retry does not fetch anything", async () => {
  await withFetch(
    async () => new Response(png(8), { status: 200 }),
    async (calls) => {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(retryPageSrc({ index: 0, url: "https://source.example/1.jpg" }, controller.signal));
      assert.equal(calls.length, 0);
    },
  );
});

test("the failed page is a card with a focusable retry control, offered once", () => {
  assert.match(reader, /class="pageerror"/, "the failure is still painted by CSS rather than rendered");
  assert.match(reader, /class="pageerror"[^>]*role="alert"/, "the failure card is not announced");
  assert.match(reader, /<button class="btn" onclick=\{\(\) => retryPage\(page\)\}>Retry page \{page\.index \+ 1\}<\/button>/, "there is no Retry page button");
  assert.match(reader, /\(attempts\[page\.index\] \?\? 0\) < 1/, "the retry is not limited to one attempt");
  assert.match(reader, /did not load on a second attempt/, "a second failure does not say so");
  assert.doesNotMatch(reader, /\.page\[data-note\]::after/, "the CSS pseudo-element note is still there");
});

test("a page box says it is loading, and stops saying it", () => {
  assert.match(reader, /data-loading=\{loading\[page\.index\] === true/, "the box has no loading state");
  assert.match(reader, /Loading page \{page\.index \+ 1\}…/, "there is no per-page loading text");
  assert.match(reader, /delete loading\[page\.index\]/, "the loading state is never cleared");
  assert.match(reader, /retryPageSrc\(page, signal\)/, "a retry does not use the native-transport path");
});