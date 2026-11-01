/**
 * archive.org through the seam.
 *
 * The stub answers the three endpoints the provider actually calls, with the shapes archive.org
 * really returns: `title`/`creator`/`description` as either a string or an array, a bundle item
 * whose chapters are its CBZ files, and a scanned item with no book file whose length only the
 * page index can answer.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHIVE_MAX_PAGES,
  buildQuery,
  createArchiveProvider,
  firstOf,
  memberUrl,
  membersFromListing,
  metadataToItem,
  pageIndexCount,
  pageUrl,
  parseChapterId,
  plainText,
  rowToSeries,
  usefulDescription,
} from "../../src/api/archive.ts";

const SEARCH_BODY = {
  response: {
    numFound: 2,
    start: 0,
    docs: [
      {
        identifier: "berserk-bundle",
        title: ["Berserk, Volumes 1-41"],
        creator: ["Miura, Kentaro"],
        year: "1989",
        description: "<p>The <b>Black Swordsman</b> arc.</p>",
        downloads: 1200,
      },
      // No identifier: nothing to open, so it must not become a card.
      { title: "orphan row" },
    ],
  },
};

/** A bundle: no `imagecount` at all, and its volumes are files inside it. */
const BUNDLE_BODY = {
  metadata: { identifier: "berserk-bundle", title: "Berserk, Volumes 1-41", creator: "Miura, Kentaro" },
  files: [
    { name: "Berserk v01 (2003).cbz", format: "Comic Book ZIP", size: "10485760" },
    { name: "Berserk v02 (2004).cbz", format: "Comic Book ZIP", size: "11000000" },
    { name: "Berserk v01 (2003)_abbyy.gz", format: "Abbyy GZ", size: "4096" },
    { name: "berserk-bundle_jp2.zip", format: "JPEG 2000 ZIP", size: "900000000" },
  ],
};

/** A scanned book: leaves, a stated count, and no volume files. */
const SCANNED_BODY = {
  metadata: { identifier: "scanned-book", title: "A Scanned Book", imagecount: "42" },
  files: [{ name: "scanned-book_jp2.zip", format: "JPEG 2000 ZIP", size: "9000" }],
};

const LISTING_HTML = `<!DOCTYPE html><html><body>
  <a href="https://archive.org/details/berserk-bundle">back</a>
  <a href="//archive.org/download/berserk-bundle/Berserk%20v01%20(2003).cbz/Berserk%20-%20p000.jpg">p000</a>
  <a href="//archive.org/download/berserk-bundle/Berserk%20v01%20(2003).cbz/Berserk%20-%20p001.jpg">p001</a>
  <a href="//archive.org/download/berserk-bundle/Berserk%20v01%20(2003).cbz/Berserk%20-%20p002.png">p002</a>
  <a href="//archive.org/download/berserk-bundle/Berserk%20v01%20(2003).cbz/notes.txt">notes</a>
  <a href="//archive.org/download/berserk-bundle/Berserk%20v02%20(2004).cbz/other-p000.jpg">other volume</a>
</body></html>`;

function stubFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    for (const [match, body] of routes) {
      if (String(url).includes(match)) {
        const isText = typeof body === "string";
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => (isText ? body : JSON.stringify(body)),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  return { impl, calls };
}

test("a search row keeps the string-or-array fields and drops the unusable one", () => {
  const [first, second] = SEARCH_BODY.response.docs.map(rowToSeries);
  assert.equal(first.id, "archive:berserk-bundle");
  assert.equal(first.provider, "archive");
  assert.equal(first.title, "Berserk, Volumes 1-41");
  assert.equal(first.author, "Miura, Kentaro");
  assert.equal(first.description, "The Black Swordsman arc.");
  assert.equal(first.status, "Published 1989");
  assert.equal(first.cover, "https://archive.org/services/img/berserk-bundle");
  assert.equal(second, null);
});

test("a description that only repeats the title is not a blurb", () => {
  assert.equal(usefulDescription("Berserk, Volume 1", "Berserk, Volume 1"), "");
  assert.equal(usefulDescription("A different sentence.", "Berserk, Volume 1"), "A different sentence.");
  assert.equal(plainText("a &amp; b<br/>c"), "a & b c");
  assert.equal(firstOf(["", ["deep"]]), "deep");
  assert.equal(firstOf(undefined), "");
});

test("queries are scoped to readable texts and cannot smuggle clauses", () => {
  const params = buildQuery({ query: 'berserk" OR mediatype:movies' });
  const q = params.get("q");
  assert.match(q, /mediatype:texts/);
  assert.match(q, /collection:comicbooks/);
  assert.doesNotMatch(q, /"/);
  assert.equal(params.get("rows"), "30");
  assert.equal(params.get("output"), "json");
  assert.deepEqual(params.getAll("fl[]"), ["identifier", "title", "creator", "year", "description", "downloads", "mediatype"]);
});

test("a bundle's books are its volumes; the scan zip and the OCR sidecar are not books", () => {
  const item = metadataToItem("berserk-bundle", BUNDLE_BODY);
  assert.deepEqual(item.books.map((book) => book.name), ["Berserk v01 (2003).cbz", "Berserk v02 (2004).cbz"]);
  // Each volume usually ships as a cbz and a pdf of the same scan: one row, the streamable one.
  const both = metadataToItem("both", {
    metadata: { identifier: "both" },
    files: [
      { name: "Vol 1.pdf", format: "Text PDF" },
      { name: "Vol 1.cbz", format: "Comic Book ZIP" },
      { name: "Vol 2.pdf", format: "Text PDF" },
    ],
  });
  assert.deepEqual(both.books.map((book) => book.name), ["Vol 1.cbz", "Vol 2.pdf"]);
  assert.equal(item.books[0].extension, "cbz");
  assert.equal(item.books[0].size, 10485760);
  // No imagecount: archive.org states no length, and the provider must not invent one.
  assert.equal(item.leafCount, null);
});

test("a scanned book's stated length is read; silence stays null", () => {
  assert.equal(metadataToItem("scanned-book", SCANNED_BODY).leafCount, 42);
  assert.equal(metadataToItem("x", {}).leafCount, null);
});

test("the page index is the fallback length, and a failed fetch is null", async () => {
  const ok = stubFetch([["silent_page_numbers.json", [[0, 1], [1, 1], [2, 1]]]]);
  assert.equal(await pageIndexCount(ok.impl, "https://archive.org", "silent", ["silent_page_numbers.json"]), 3);
  const missing = stubFetch([]);
  assert.equal(await pageIndexCount(missing.impl, "https://archive.org", "silent", ["silent_page_numbers.json"]), null);
  assert.equal(await pageIndexCount(missing.impl, "https://archive.org", "silent", []), null);
});

test("zip members become pages in listing order, and only images count", () => {
  const pages = membersFromListing(LISTING_HTML, "berserk-bundle", "Berserk v01 (2003).cbz");
  assert.equal(pages.length, 3);
  assert.deepEqual(
    pages.map((url) => url.split("/").pop()),
    ["Berserk%20-%20p000.jpg", "Berserk%20-%20p001.jpg", "Berserk%20-%20p002.png"],
  );
  assert.ok(decodeURIComponent(pages[0]).startsWith("https://archive.org/download/berserk-bundle/Berserk v01 (2003).cbz/"));
  assert.equal(memberUrl("id", "book.cbz", "p1.jpg"), "https://archive.org/download/id/book.cbz/p1.jpg");
});

test("a volume that keeps its pages in a folder is a volume, not 'no pages'", () => {
  // archive.org writes the folder as %2F in the href, and the page URL that reads it back the same
  // way is the one that answers 200 — so the parsed member keeps the folder in its path.
  const html = `<!DOCTYPE html><html><body>
    <a href="//archive.org/download/si/Sports%20Illustrated.cbz/Sports%20Illustrated%2Fpage001.jpg">p1</a>
    <a href="//archive.org/download/si/Sports%20Illustrated.cbz/Sports%20Illustrated%2Fpage002.jpg">p2</a>
    <a href="//archive.org/download/si/Sports%20Illustrated.cbz/Sports%20Illustrated%2Fpage003.png">p3</a>
    <a href="//archive.org/download/si/Sports%20Illustrated.cbz/Sports%20Illustrated%2F">the folder</a>
    <a href="//archive.org/download/si/Sports%20Illustrated.cbz/__MACOSX%2FSports%20Illustrated%2F._page001.jpg">stub</a>
    <a href="//archive.org/download/si/Sports%20Illustrated.cbz/.DS_Store">junk</a>
    <a href="//archive.org/download/si/Sports%20Illustrated.cbz/notes.txt">notes</a>
  </body></html>`;
  const pages = membersFromListing(html, "si", "Sports Illustrated.cbz");
  assert.deepEqual(pages, [
    "https://archive.org/download/si/Sports%20Illustrated.cbz/Sports%20Illustrated%2Fpage001.jpg",
    "https://archive.org/download/si/Sports%20Illustrated.cbz/Sports%20Illustrated%2Fpage002.jpg",
    "https://archive.org/download/si/Sports%20Illustrated.cbz/Sports%20Illustrated%2Fpage003.png",
  ]);
  assert.equal(memberUrl("si", "Sports Illustrated.cbz", "Sports Illustrated/page001.jpg"), pages[0]);
});

test("a listing the browser cannot read says so, instead of 'Failed to fetch'", async () => {
  const refused = async () => {
    // Exactly what Chromium throws: no status, no host, nothing to show a reader.
    throw new TypeError("Failed to fetch");
  };
  const provider = createArchiveProvider({ fetchImpl: refused });
  await assert.rejects(
    () => provider.pages("archive:ch:restricted:Vol.cbz"),
    /archive\.org did not list the pages of Vol\.cbz/,
  );

  // A deadline keeps its own sentence: it is already the honest one.
  const { DeadlineError } = await import("../../src/lib/deadline.ts");
  const slow = async () => {
    throw new DeadlineError("the Internet Archive", 30_000);
  };
  const timed = createArchiveProvider({ fetchImpl: slow });
  await assert.rejects(() => timed.pages("archive:ch:slow:Vol.cbz"), /did not answer within 30 s/);
});

test("page urls and chapter ids round-trip, including names with colons and spaces", () => {
  assert.equal(pageUrl("scanned-book", 0), "https://archive.org/download/scanned-book/page/n0_w1200.jpg");
  assert.equal(pageUrl("scanned-book", 7, 800), "https://archive.org/download/scanned-book/page/n7_w800.jpg");
  const parsed = parseChapterId("ch:berserk-bundle:Berserk%20v01%20(2003).cbz");
  assert.deepEqual(parsed, { identifier: "berserk-bundle", book: "Berserk v01 (2003).cbz" });
  assert.deepEqual(parseChapterId("ch:scanned-book:"), { identifier: "scanned-book", book: "" });
  assert.equal(parseChapterId("nope"), null);
  assert.equal(parseChapterId("ch::x"), null);
});

test("a bundle lists one chapter per volume and reads the opened volume's members", async () => {
  const { impl, calls } = stubFetch([
    ["advancedsearch.php", SEARCH_BODY],
    ["/metadata/berserk-bundle", BUNDLE_BODY],
    ["/download/berserk-bundle/", LISTING_HTML],
  ]);
  const provider = createArchiveProvider({ fetchImpl: impl });

  const sources = await provider.sources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, "archive:src:texts");

  const popular = await provider.popular(sources[0].id, 1);
  assert.equal(popular.items.length, 1);
  assert.equal(popular.hasNext, false);

  const chapters = await provider.chapters("archive:berserk-bundle");
  assert.equal(chapters.length, 2, "one chapter per volume, not one for the item");
  assert.equal(chapters[0].name, "Berserk v01 (2003)");
  assert.equal(chapters[0].pageCount, 0, "the count is not guessed at list time");
  assert.equal(chapters[1].number, 2);

  const pages = await provider.pages(chapters[0].id);
  assert.equal(pages.length, 3);
  assert.equal(pages[1].index, 1);
  assert.match(pages[1].url, /Berserk%20-%20p001\.jpg$/);

  // The listing is cached: opening the same volume twice costs one request.
  await provider.pages(chapters[0].id);
  assert.equal(calls.filter((url) => url.includes("/download/berserk-bundle/")).length, 1);
});

test("a scanned book reads its leaves, and refuses when archive.org states no length", async () => {
  const { impl } = stubFetch([
    ["/metadata/scanned-book", SCANNED_BODY],
    ["/metadata/no-count", { metadata: { identifier: "no-count", title: "No Count" }, files: [] }],
  ]);
  const provider = createArchiveProvider({ fetchImpl: impl });

  const chapters = await provider.chapters("archive:scanned-book");
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].pageCount, 42);
  const pages = await provider.pages(chapters[0].id);
  assert.equal(pages.length, 42);
  assert.equal(pages[41].url, "https://archive.org/download/scanned-book/page/n41_w1200.jpg");

  await assert.rejects(() => provider.chapters("archive:no-count"), /does not state a page count/);
});

test("hasNext follows numFound, not the page size", async () => {
  const { impl } = stubFetch([["advancedsearch.php", { response: { numFound: 90, start: 30, docs: SEARCH_BODY.response.docs } }]]);
  const provider = createArchiveProvider({ fetchImpl: impl });
  const page = await provider.popular("archive:src:texts", 2);
  assert.equal(page.hasNext, true);
});

test("a foreign id is refused, and read state is never faked", async () => {
  const provider = createArchiveProvider({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(() => provider.details("mihon:12"), /not a archive id/);
  await assert.rejects(() => provider.pages("archive:ch:bad"), /not an archive chapter id/);
  await assert.rejects(() => provider.setRead("archive:ch:x:", true), /local store owns/);
});

test("the page ceiling holds for a huge volume", () => {
  const many = Array.from({ length: ARCHIVE_MAX_PAGES + 50 }, (_, i) => `<a href="/download/b/Big.cbz/p${i}.jpg">x</a>`).join("");
  assert.equal(membersFromListing(many, "b", "Big.cbz").length, ARCHIVE_MAX_PAGES + 50);
});
