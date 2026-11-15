/**
 * archive.org through the seam.
 *
 * The stub answers the three endpoints the provider actually calls, with the shapes archive.org
 * really returns: `title`/`creator`/`description` as either a string or an array, a bundle item
 * whose chapters are its CBZ files, and a scanned item with no book file whose length only the
 * page index can answer.
 */
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import test from "node:test";

import {
  ARCHIVE_MAX_PAGES,
  buildQuery,
  chapterNameOf,
  createArchiveProvider,
  firstOf,
  metadataToItem,
  pageIndexCount,
  pageUrl,
  parseChapterId,
  plainText,
  naturalBookOrder,
  bookUrl,
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
        const bytes = body instanceof Uint8Array ? body : undefined;
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => (isText ? body : JSON.stringify(body)),
          // A route can answer bytes — that is how a volume download is served here.
          ...(bytes === undefined ? {} : { blob: async () => new Blob([bytes]) }),
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
  assert.equal(first.url, "https://archive.org/details/berserk-bundle", "the item's own page");
  assert.equal(second, null);
});

test("a description that only repeats the title is not a blurb", () => {
  assert.equal(usefulDescription("Berserk, Volume 1", "Berserk, Volume 1"), "");
  assert.equal(usefulDescription("A different sentence.", "Berserk, Volume 1"), "A different sentence.");
  assert.equal(plainText("a &amp; b<br/>c"), "a & b c");
  assert.equal(firstOf(["", ["deep"]]), "deep");
  assert.equal(firstOf(undefined), "");
});

test("queries are scoped to readable formats and cannot smuggle clauses", () => {
  const params = buildQuery({ query: 'berserk" OR mediatype:movies' });
  const q = params.get("q");
  assert.match(q, /mediatype:texts/);
  assert.match(q, /collection:comicbooks/);
  // The format clause is the one place a quote belongs here. The term's own quote is stripped, so
  // the smuggled `mediatype:movies` stays inside the parentheses it was wrapped in instead of
  // ending the clause and widening the search.
  assert.match(q, /format:\(/);
  assert.match(q, /"Comic Book ZIP"/);
  assert.match(q, /"Image Container PDF"/);
  assert.doesNotMatch(q, /berserk"/, "the term cannot close its own clause");
  assert.doesNotMatch(q.replace(/format:\([^)]*\)/, ""), /"/, "no quote survives outside the format clause");
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

test("page urls and chapter ids round-trip, including names with colons and spaces", () => {
  assert.equal(pageUrl("scanned-book", 0), "https://archive.org/download/scanned-book/page/n0_w1200.jpg");
  assert.equal(pageUrl("scanned-book", 7, 800), "https://archive.org/download/scanned-book/page/n7_w800.jpg");
  const parsed = parseChapterId("ch:berserk-bundle:Berserk%20v01%20(2003).cbz");
  assert.deepEqual(parsed, { identifier: "berserk-bundle", book: "Berserk v01 (2003).cbz" });
  assert.deepEqual(parseChapterId("ch:scanned-book:"), { identifier: "scanned-book", book: "" });
  assert.equal(parseChapterId("nope"), null);
  assert.equal(parseChapterId("ch::x"), null);
});

test("a bundle's volumes are downloaded once and opened like a file on this device", async () => {
  // archive.org serves no per-file directory today (`/download/<id>/<book>/` is a 404), so a volume
  // cannot be walked page by page: it is fetched whole and opened locally, which is also the only
  // thing that works for a PDF. The fixture is a real CBZ so the zip reader proves it.
  const cbz = zipSync({ "page001.jpg": strToU8("one"), "page002.jpg": strToU8("two") }, { level: 0 });
  const { impl, calls } = stubFetch([
    ["advancedsearch.php", SEARCH_BODY],
    ["/metadata/berserk-bundle", BUNDLE_BODY],
    ["/download/berserk-bundle/Berserk%20v01%20(2003).cbz", cbz],
  ]);
  const provider = createArchiveProvider({ fetchImpl: impl });

  const chapters = await provider.chapters("archive:berserk-bundle");
  assert.equal(chapters.length, 2, "one chapter per volume, not one for the item");
  assert.equal(chapters[0].name, "Berserk v01 (2003)");
  assert.equal(chapters[0].pageCount, 0, "the count is not guessed at list time");
  assert.equal(chapters[1].number, 2);

  const pages = await provider.pages(chapters[0].id);
  assert.equal(pages.length, 2, "the volume's own page count, read from the file");
  assert.equal(pages[1].index, 1);
  assert.equal(pages[0].url, "book:berserk-bundle/Berserk v01 (2003).cbz#0");
  assert.ok(pages[0].open !== undefined, "a page this device produces has no URL to point at");
  const first = await pages[0].open();
  assert.equal(first.size, 3);

  // The bytes are kept for the session: opening the same volume twice costs one download.
  const again = await provider.pages(chapters[0].id);
  await again[0].open();
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

test("trending asks for the week's downloads, popular for all time", async () => {
  // This is the whole difference between the two listings: `week` moves, `downloads` does not. If
  // trending ever shipped on `-downloads` the first tab would just be the old static row.
  const { impl, calls } = stubFetch([["advancedsearch.php", SEARCH_BODY]]);
  const provider = createArchiveProvider({ fetchImpl: impl });

  await provider.trending("archive:src:texts", 1);
  const trendingUrl = new URL(calls.at(-1));
  assert.equal(trendingUrl.searchParams.get("sort[]"), "-week");
  // The scope query is unchanged: trending is the same corpus, ordered differently.
  assert.match(trendingUrl.searchParams.get("q"), /mediatype:texts AND \(collection:comicbooks/);

  await provider.popular("archive:src:texts", 1);
  assert.equal(new URL(calls.at(-1)).searchParams.get("sort[]"), "-downloads");
});

test("a foreign id is refused, and read state is never faked", async () => {
  const provider = createArchiveProvider({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(() => provider.details("mihon:12"), /not a archive id/);
  await assert.rejects(() => provider.pages("archive:ch:bad"), /not an archive chapter id/);
  await assert.rejects(() => provider.setRead("archive:ch:x:", true), /local store owns/);
});

test("a chapter is named from the file, not quoted as one", () => {
  // The archive's own separators become spaces, and the extension goes: a chapter list is the last
  // place that should look like a file path.
  assert.equal(chapterNameOf("Quality__Blackhawk_009.cbz"), "Quality Blackhawk 009");
  assert.equal(chapterNameOf("Plastic_Man_v1_001__paper_Flatterman_text.pdf"), "Plastic Man v1 001 paper Flatterman text");
  assert.equal(chapterNameOf("Berserk v01 (2003).cbr"), "Berserk v01 (2003)");
  // A name that is only separators is the whole item, and says so.
  assert.equal(chapterNameOf("__.cbz"), "Complete book");
  // Two files of one volume (a zip of scans and its text-layer PDF) clean to the same words; the
  // second gets its number rather than a duplicate row.
  const taken = new Set();
  const first = chapterNameOf("Volume_01.cbz", taken);
  taken.add(first);
  const second = chapterNameOf("Volume__01.pdf", taken);
  assert.equal(first, "Volume 01");
  assert.equal(second, "Volume 01 (2)");
});

test("a bundle names its chapters in words, and keeps their ids keyed on the file", async () => {
  const { impl } = stubFetch([
    ["/metadata/berserk-bundle", BUNDLE_BODY],
    ["/download/berserk-bundle/", LISTING_HTML],
  ]);
  const provider = createArchiveProvider({ fetchImpl: impl });
  const chapters = await provider.chapters("archive:berserk-bundle");
  assert.equal(chapters[0].name, "Berserk v01 (2003)");
  // The id still carries the file's own name: renaming a row must not change what it opens.
  assert.match(chapters[0].id, /Berserk%20v01%20\(2003\)\.cbz$/);
});


test("a collection's files are numbered in reading order, not in lexicographic order", () => {
  const books = ["TITANS N°1.cbz", "TITANS N°10.cbz", "TITANS N°2.cbz", "TITANS N°100.cbz", "TITANS N°9.cbz"].map(
    (name) => ({ name, format: "Comic Book ZIP", extension: "cbz", size: 1 }),
  );
  assert.deepEqual(
    naturalBookOrder(books).map((book) => book.name),
    ["TITANS N°1.cbz", "TITANS N°2.cbz", "TITANS N°9.cbz", "TITANS N°10.cbz", "TITANS N°100.cbz"],
    "numbering chapters 1..n from a lexicographic listing makes issue 10 the second issue",
  );
  assert.equal(books[0].name, "TITANS N°1.cbz", "the input is not reordered in place");
});

test("a file name keeps the space archive.org stores it with, because the download URL needs it", () => {
  const item = metadataToItem("titans-n-1", {
    files: [{ name: " TITANS N°2 .cbz", format: "Comic Book ZIP", size: "29210861" }],
  });
  assert.equal(item.books[0].name, " TITANS N°2 .cbz", "trimming it turns /download/<id>/<name> into a 404");
  const url = bookUrl("https://archive.org", "titans-n-1", item.books[0].name, false);
  assert.equal(url, "https://archive.org/download/titans-n-1/%20TITANS%20N%C2%B02%20.cbz");
  // What the reader shows is still the trimmed label.
  assert.equal(chapterNameOf(item.books[0].name), "TITANS N°2");
});

test("one volume shipped with and without padding is still one volume", () => {
  const item = metadataToItem("mixed", {
    files: [
      { name: " TITANS N°1 .cbz", format: "Comic Book ZIP", size: "1" },
      { name: "TITANS N°1.pdf", format: "Text PDF", size: "2" },
      { name: " TITANS N°2 .cbz", format: "Comic Book ZIP", size: "3" },
    ],
  });
  assert.deepEqual(
    item.books.map((book) => book.name.trim()),
    ["TITANS N°1 .cbz", "TITANS N°2 .cbz"],
    "the padded and unpadded copies of volume 1 are one volume, and the zip is the one kept",
  );
});
