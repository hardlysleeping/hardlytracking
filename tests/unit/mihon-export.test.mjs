import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildValidFilename,
  md5Hex,
  mihonChapterDirName,
  mihonChapterDirNames,
  mihonMangaDirName,
  truncateToBytes,
} from '../../src/lib/files/mihon-names.ts';
import { crc32, writeZip } from '../../src/lib/files/zip-write.ts';
import { chapterSegments, pageName, pagesToCbz, toBase64 } from '../../src/lib/files/mihon-export.ts';
import { decodeBase64 } from '../../src/lib/files/mihon-downloads.ts';
import { openZip } from '../../src/lib/files/zip.ts';

test('md5 matches the published vectors, which is all the hash suffix needs', () => {
  assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5Hex('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
});

test('a name is trimmed, sanitised and never empty — Mihon\'s buildValidFilename', () => {
  // The FAT-forbidden set becomes underscores; colons are how "Ch.1: A title" would otherwise break.
  assert.equal(buildValidFilename('Ch.1: A title'), 'Ch.1_ A title');
  assert.equal(buildValidFilename('a/b\\c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i');
  assert.equal(buildValidFilename('  ...dots and spaces...  '), 'dots and spaces');
  assert.equal(buildValidFilename('   '), '(invalid)');
  // Control characters too.
  assert.equal(buildValidFilename('a\u0000b'), 'a_b');
});

test('non-ASCII becomes hex only when Mihon is set to disallow it', () => {
  assert.equal(buildValidFilename('日本語', 240, false), '日本語');
  assert.equal(buildValidFilename('日本語', 240, true), 'e697a5e69cace8aa9e');
});

test('truncation counts bytes and never splits a character', () => {
  assert.equal(truncateToBytes('abc', 10), 'abc');
  assert.equal(truncateToBytes('abcd', 2), 'ab');
  const cut = truncateToBytes('日本', 4);
  assert.equal([...cut].length, 1, 'one whole character fits in four bytes');
  assert.equal(new TextEncoder().encode(cut).length <= 4, true);
});

test('a chapter folder name is the scanlator and name sanitised together, inside Mihon\'s budget', () => {
  assert.equal(mihonChapterDirName({ name: 'Ch.1' }), 'Ch.1');
  assert.equal(mihonChapterDirName({ name: 'Ch.1', scanlator: 'Team' }), 'Team_Ch.1');
  assert.equal(mihonChapterDirName({ name: '   ' }), 'Chapter');
  // The hash suffix is Mihon's optional setting, and it is off unless asked for.
  assert.equal(mihonChapterDirName({ name: 'Ch.1', url: 'https://x/y' }), 'Ch.1');
  const hashed = mihonChapterDirName({ name: 'Ch.1', url: 'https://x/y', hash: true });
  assert.match(hashed, /^Ch\.1_[0-9a-f]{6}$/);
  // 229 bytes is the budget: 240 minus `_` + 6 for the hash and `.cbz`.
  assert.equal(new TextEncoder().encode(mihonChapterDirName({ name: 'a'.repeat(400) })).length, 229);
  assert.deepEqual(mihonChapterDirNames({ name: 'Ch.1' }), ['Ch.1', 'Ch.1.cbz']);
});

test('manga and source folders use the whole 240 bytes', () => {
  assert.equal(mihonMangaDirName('Solo Leveling: Ragnarok'), 'Solo Leveling_ Ragnarok');
  assert.equal(new TextEncoder().encode(mihonMangaDirName('b'.repeat(400))).length, 240);
});

test('a written CBZ is a ZIP our own reader can open, with the pages in order', async () => {
  const pages = [new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), new Blob([new Uint8Array([4, 5])], { type: 'image/png' })];
  const cbz = await pagesToCbz(pages);
  // Local header magic, then the end-of-central-directory record at the tail.
  assert.deepEqual([...cbz.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const end = cbz.subarray(cbz.length - 22);
  assert.equal(new DataView(end.buffer, end.byteOffset).getUint32(0, true), 0x06054b50);
  assert.equal(new DataView(end.buffer, end.byteOffset).getUint16(10, true), 2, 'two entries');

  const zip = await openZip(cbz);
  assert.deepEqual(zip.names, ['001.jpg', '002.png'], 'page order, extension from the blob type');
  assert.deepEqual([...(await zip.read('001.jpg'))], [1, 2, 3]);
  assert.deepEqual([...(await zip.read('002.png'))], [4, 5]);
});

test('CRC-32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test('an empty chapter is refused rather than written as an empty archive', async () => {
  await assert.rejects(() => pagesToCbz([]), /no downloaded pages/);
});

test('the path written is the one Mihon looks for', () => {
  assert.deepEqual(
    chapterSegments({ seriesTitle: 'A Title: Subtitle', sourceName: 'MangaDex (EN)', chapterName: 'Vol.2 Ch.14.5' }),
    ['MangaDex (EN)', 'A Title_ Subtitle', 'Vol.2 Ch.14.5.cbz'],
  );
});

test('page names are zero-padded so a name-sorting reader agrees with us', () => {
  assert.equal(pageName(0, 'jpg'), '001.jpg');
  assert.equal(pageName(9, 'png'), '010.png');
  assert.equal(pageName(99, 'webp'), '100.webp');
});

test('base64 survives a round trip, including the two padding cases', () => {
  for (const bytes of [[], [0x41], [0x41, 0x42], [0x41, 0x42, 0x43], [0xff, 0x00, 0x7f, 0x10, 0x01]]) {
    const encoded = toBase64(new Uint8Array(bytes));
    assert.deepEqual([...decodeBase64(encoded)], bytes, `round trip for ${bytes.length} bytes`);
  }
  assert.equal(toBase64(new Uint8Array([0x41, 0x42, 0x43])), 'QUJD');
});

test('a zip of one entry is still a zip', () => {
  const bytes = writeZip([{ name: '001.jpg', bytes: new Uint8Array([9, 9]) }]);
  assert.deepEqual([...bytes.subarray(0, 2)], [0x50, 0x4b]);
  const end = bytes.subarray(bytes.length - 22);
  const view = new DataView(end.buffer, end.byteOffset);
  assert.equal(view.getUint16(8, true), 1);
  assert.equal(view.getUint32(12, true), 46 + '001.jpg'.length, 'central directory size');
});
