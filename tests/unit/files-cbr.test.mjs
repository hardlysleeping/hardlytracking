/**
 * CBR: a RAR of images, read one page at a time.
 *
 * The two fixtures are real archives, not something this repo's reader wrote:
 * - `RAR4_CBR` was assembled byte by byte to the RAR 1.5 header layout and then accepted by
 *   RARLAB's own `unrar` (`unrar t`: "All OK", four entries, every CRC checked). It is stored, not
 *   compressed, and one of its names carries a backslash — what a Windows-made CBR looks like, so the
 *   reader must normalise it rather than lose the page.
 * - `RAR5_CBR` came out of `rar a -m3`, so its pages really are compressed.
 *
 * Both are decoded by the same wasm binary the app ships, read off disk rather than fetched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32, inflateSync } from "node:zlib";

import { openRar } from "../../src/lib/files/rar.ts";
import { RAR4_CBR as RAR4_CBR_BASE64, RAR5_CBR as RAR5_CBR_BASE64 } from "./cbr-fixtures.mjs";
import { pageEntries } from "../../src/lib/files/comic.ts";

const RAR4_CBR = Buffer.from(RAR4_CBR_BASE64, "base64");
const RAR5_CBR = Buffer.from(RAR5_CBR_BASE64, "base64");

/** The decoder the app ships, taken from the package rather than fetched through Vite. */
const wasm = readFileSync("node_modules/node-unrar-js/dist/js/unrar.wasm");
const loadWasm = async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength);

const bytesOf = (buffer) => new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

/**
 * Whether these bytes are a whole, valid PNG — every chunk's CRC checked, the image data inflated.
 *
 * A RAR decoder that hands back the right number of bytes from the wrong place passes a length check
 * and fails here, which is the point: the reader draws this, so it has to decode.
 */
function isWholePng(bytes) {
  const text = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));
  // 89 50 4E 47 0D 0A 1A 0A: the eight-byte signature every PNG starts with.
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return false;
  let at = 8;
  let sawData = false;
  while (at + 8 <= bytes.length) {
    const length = Buffer.from(bytes.subarray(at, at + 4)).readUInt32BE(0);
    const tag = text(at + 4);
    const payload = bytes.subarray(at + 8, at + 8 + length);
    const expected = Buffer.from(bytes.subarray(at + 8 + length, at + 12 + length)).readUInt32BE(0);
    if (crc32 && crc32(Buffer.concat([Buffer.from(tag), Buffer.from(payload)])) !== expected) return false;
    if (tag === "IDAT") {
      sawData = true;
      if (inflateSync(Buffer.from(payload)).length === 0) return false;
    }
    if (tag === "IEND") return sawData;
    at += 12 + length;
  }
  return false;
}

test("a RAR 1.5 .cbr lists its entries, with a Windows backslash name normalised", async () => {
  const rar = await openRar(bytesOf(RAR4_CBR), { wasm: loadWasm });
  assert.deepEqual(rar.names, ["pages/003.png", "pages/001.png", "pages/002.png", "ComicInfo.xml"]);
  // Reading order comes from the names, not from the order the archive stores them in.
  assert.deepEqual(pageEntries(rar.names), ["pages/001.png", "pages/002.png", "pages/003.png"]);
});

test("a page is the entry's own bytes, decoded", async () => {
  const rar = await openRar(bytesOf(RAR4_CBR), { wasm: loadWasm });
  const first = await rar.read("pages/001.png");
  const third = await rar.read("pages/003.png");
  assert.equal(isWholePng(first), true);
  assert.equal(isWholePng(third), true);
  assert.equal(first.length, 69);
  assert.notDeepEqual(first, third);
  assert.equal(new TextDecoder().decode(await rar.read("ComicInfo.xml")), "<ComicInfo><Title>Fixture</Title></ComicInfo>");
});

test("a RAR 5 .cbr is decompressed page by page", async () => {
  const rar = await openRar(bytesOf(RAR5_CBR), { wasm: loadWasm });
  const pages = pageEntries(rar.names);
  assert.deepEqual(pages, ["pages/001.png", "pages/002.png", "pages/003.png"]);
  const read = [];
  for (const name of pages) read.push(await rar.read(name));
  for (const page of read) {
    assert.equal(isWholePng(page), true);
    assert.equal(page.length, 69);
  }
  assert.equal(new Set(read.map((page) => Buffer.from(page).toString("base64"))).size, 3);
});

test("an entry that is not there is refused by name", async () => {
  const rar = await openRar(bytesOf(RAR4_CBR), { wasm: loadWasm });
  await assert.rejects(() => rar.read("pages/999.png"), /no such entry/);
});

test("a file that is not a RAR is refused, not misread", async () => {
  const notARar = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  await assert.rejects(() => openRar(notARar, { wasm: loadWasm }), /not a RAR archive/);
});

test("two books can be open at once without reading each other's pages", async () => {
  // The wasm has one decoder and its callbacks read whichever extractor was created last, so this is
  // the failure `oneAtATime` exists to prevent: interleaved reads from two different archives.
  const [one, two] = await Promise.all([
    openRar(bytesOf(RAR4_CBR), { wasm: loadWasm }),
    openRar(bytesOf(RAR5_CBR), { wasm: loadWasm }),
  ]);
  const [a, b, c] = await Promise.all([one.read("pages/003.png"), two.read("pages/002.png"), one.read("pages/001.png")]);
  assert.equal(isWholePng(a), true);
  assert.equal(isWholePng(b), true);
  assert.equal(isWholePng(c), true);
  assert.notDeepEqual(a, c);
  // Page 2 is the same picture in both archives, so a crossed read would show up here.
  assert.deepEqual(b, await one.read("pages/002.png"));
});
