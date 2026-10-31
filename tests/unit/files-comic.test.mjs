import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { naturalCompare, pageEntries, kindOf, titleFromFile, extensionOf, mimeOf } from "../../src/lib/files/comic.ts";
import { openZip } from "../../src/lib/files/zip.ts";

test("pages sort naturally, so page 2 comes before page 10", () => {
  const names = ["p10.jpg", "p2.jpg", "p1.jpg", "cover.jpg"];
  assert.deepEqual(pageEntries(names), ["cover.jpg", "p1.jpg", "p2.jpg", "p10.jpg"]);
});

test("non-images and directory entries are not pages", () => {
  const names = ["ComicInfo.xml", "folder/", "folder/001.jpg", "notes.txt", "002.PNG"];
  // Natural order over the whole name: "002.PNG" sorts before "folder/001.jpg", and both are pages.
  assert.deepEqual(pageEntries(names), ["002.PNG", "folder/001.jpg"]);
});

test("a name is a title: no extension, no underscores", () => {
  assert.equal(titleFromFile("Saga_Vol_01.cbz"), "Saga Vol 01");
  assert.equal(titleFromFile("C:/comics/Berserk v01 (2003).pdf"), "Berserk v01 (2003)");
  assert.equal(titleFromFile("no-extension"), "no-extension");
});

test("kind is decided by extension, and anything else is refused", () => {
  assert.equal(kindOf("a.CBZ"), "cbz");
  assert.equal(kindOf("a.zip"), "cbz");
  assert.equal(kindOf("a.pdf"), "pdf");
  assert.equal(kindOf("a.cbr"), null);
  assert.equal(kindOf("a.jpg"), null);
  assert.equal(extensionOf("a.CBR"), ".cbr");
  assert.equal(mimeOf("a.png"), "image/png");
  assert.equal(mimeOf("a.jpg"), "image/jpeg");
});

test("naturalCompare is a total order that agrees with itself", () => {
  const sorted = ["v10", "v2", "v1"].sort(naturalCompare);
  assert.deepEqual(sorted, ["v1", "v2", "v10"]);
  assert.equal(naturalCompare("same", "same"), 0);
});

/** A real archive, built the way a comic is: images stored, one per page. */
function makeCbz(entries) {
  const files = {};
  for (const [name, text] of Object.entries(entries)) files[name] = strToU8(text);
  return zipSync(files);
}

test("one page can be read out of a zip without unpacking the rest", () => {
  const bytes = makeCbz({ "001.jpg": "first page", "002.jpg": "second page", "ComicInfo.xml": "<xml/>" });
  const zip = openZip(bytes);
  assert.deepEqual(pageEntries(zip.names), ["001.jpg", "002.jpg"]);
  assert.equal(new TextDecoder().decode(zip.read("002.jpg")), "second page");
  assert.throws(() => zip.read("missing.jpg"), /no such entry/);
});

test("a file that is not a zip is refused by name, not misread", () => {
  const notAZip = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.throws(() => openZip(notAZip), /not a zip archive/);
});

test("stored entries are returned as-is and deflated ones are inflated", () => {
  const stored = zipSync({ "a.jpg": strToU8("plain") }, { level: 0 });
  const deflated = zipSync({ "a.jpg": strToU8("compressed text that is long enough to matter") });
  assert.equal(new TextDecoder().decode(openZip(stored).read("a.jpg")), "plain");
  assert.equal(
    new TextDecoder().decode(openZip(deflated).read("a.jpg")),
    "compressed text that is long enough to matter",
  );
});
