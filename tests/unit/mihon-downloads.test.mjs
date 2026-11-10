import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chapterNumberOf,
  countDownloadsPages,
  folderBook,
  importDownloads,
  isPageName,
  orderChapters,
  parseScan,
} from '../../src/lib/files/mihon-downloads.ts';

const at = (name, path = `content://tree/chapter/${name}`, kind = 'folder', ext = '', bytes = 0) => ({ name, path, kind, ext, bytes });

test('a chapter name sorts by the first number in it, and specials go last', () => {
  assert.equal(chapterNumberOf('Vol.2 Ch.14.5 — A title'), 14.5);
  assert.equal(chapterNumberOf('Ch. 7'), 7);
  assert.equal(chapterNumberOf('Chapter 100'), 100);
  assert.equal(chapterNumberOf('Omake'), null);
  const ordered = orderChapters([
    at('Omake'),
    at('Ch.10'),
    at('Ch.2'),
    at('Ch.1.5'),
  ]).map((chapter) => chapter.name);
  assert.deepEqual(ordered, ['Ch.1.5', 'Ch.2', 'Ch.10', 'Omake']);
});

test('a scan keeps readable chapters and drops the rest', () => {
  const scan = parseScan({
    folder: { path: 'content://tree/downloads', name: 'downloads' },
    series: [
      {
        title: 'A Title',
        path: 'content://tree/downloads/A%20Title',
        chapters: [
          { name: 'Ch.2', path: 'p2', kind: 'folder' },
          { name: 'Ch.1', path: 'p1', kind: 'folder' },
          // Not a chapter: an unknown extension, a nameless entry, an empty path.
          { name: 'notes.txt', path: 'p9', kind: 'file', ext: 'txt' },
          { name: '', path: 'p10', kind: 'folder' },
          { name: 'Ch.3', path: '', kind: 'folder' },
        ],
      },
      // A title with nothing readable in it is not a row.
      { title: 'Empty', path: 'content://tree/downloads/Empty', chapters: [{ name: '', path: '' }] },
      { title: '', path: 'content://tree/downloads/nameless', chapters: [{ name: 'Ch.1', path: 'p1' }] },
      { title: 'CBZ Only', path: 'content://tree/downloads/CBZ', chapters: [{ name: 'Vol 1', path: 'c1', kind: 'file', ext: 'CBZ', bytes: 2048 }] },
    ],
  });
  assert.equal(scan.folder?.name, 'downloads');
  assert.deepEqual(scan.series.map((row) => row.title), ['A Title', 'CBZ Only']);
  assert.deepEqual(scan.series[0]?.chapters.map((chapter) => chapter.name), ['Ch.1', 'Ch.2']);
  // The extension is normalised, and its size survives.
  assert.equal(scan.series[1]?.chapters[0]?.ext, 'cbz');
  assert.equal(scan.series[1]?.chapters[0]?.bytes, 2048);
});

test('a scan with no folder and nothing in it is empty, not broken', () => {
  assert.deepEqual(parseScan(null), { folder: null, series: [] });
  assert.deepEqual(parseScan({ series: [] }), { folder: null, series: [] });
  assert.deepEqual(parseScan({ folder: { path: '', name: '' }, series: [] }), { folder: null, series: [] });
});

test('only image names are pages', () => {
  for (const name of ['001.jpg', '002.JPEG', 'page 3.png', 'x.webp', 'y.avif']) assert.equal(isPageName(name), true, name);
  for (const name of ['.nomedia', 'thumb.tmp', 'cover', 'notes.txt', '']) assert.equal(isPageName(name), false, name);
});

test('a folder chapter is a book in natural page order', async () => {
  const pages = [
    { name: '10.jpg', path: 'c/10.jpg' },
    { name: '2.jpg', path: 'c/2.jpg' },
    { name: '1.jpg', path: 'c/1.jpg' },
    { name: '.nomedia', path: 'c/.nomedia' },
  ];
  const book = folderBook(pages, async (path) => new Uint8Array([path === 'c/2.jpg' ? 0x42 : 0x41]));
  assert.equal(book.pageCount, 3, 'the non-image is not a page');
  const first = await book.open(0);
  assert.equal(first.type, 'image/jpeg');
  assert.deepEqual([...(new Uint8Array(await first.arrayBuffer()))], [0x41], 'page 1 is 1.jpg, not 10.jpg');
  const second = await book.open(1);
  assert.deepEqual([...(new Uint8Array(await second.arrayBuffer()))], [0x42], 'page 2 is 2.jpg');
  await assert.rejects(() => book.open(3), /past the end/);
  book.close();
});

test('an empty read is an error naming the page, not a blank page', async () => {
  const book = folderBook([{ name: '1.jpg', path: 'c/1.jpg' }], async () => new Uint8Array());
  await assert.rejects(() => book.open(0), /1\.jpg is empty/);
});

/** The smallest store the importer touches, so its rows can be inspected. */
function fakeStore() {
  const series = new Map();
  const chapters = new Map();
  const books = new Map();
  return {
    getSeries: async (id) => series.get(id),
    addSeries: async (row) => void series.set(row.id, row),
    putChapters: async (seriesId, rows) => void rows.forEach((row) => chapters.set(row.id, row)),
    putBook: async (row) => void books.set(row.chapterId, row),
    series,
    chapters,
    books,
  };
}

const fakeBridge = (pages = ['1.jpg', '2.jpg']) => ({
  pick: async () => ({ folder: { path: 'content://tree', name: 'downloads' } }),
  saved: async () => ({ folder: { path: 'content://tree', name: 'downloads' } }),
  forget: async () => {},
  scan: async () => ({ folder: { path: 'content://tree', name: 'downloads' }, series: [] }),
  chapter: async ({ path }) => ({
    pages: path.includes('broken') ? [] : pages.map((name) => ({ name, path: `${path}/${name}` })),
  }),
  file: async () => ({ base64: 'QUJD' }),
});

const scanOf = (series) => ({ folder: { path: 'content://tree', name: 'downloads' }, series });

test('an import indexes another app\'s chapters without copying a byte', async () => {
  const store = fakeStore();
  const result = await importDownloads(
    store,
    scanOf([
      {
        title: 'A Title',
        path: 'content://tree/A%20Title',
        chapters: [
          { name: 'Ch.2', path: 'content://tree/A/2', kind: 'folder', ext: '', bytes: 0 },
          { name: 'Ch.1', path: 'content://tree/A/1', kind: 'folder', ext: '', bytes: 0 },
        ],
      },
    ]),
    { load: async () => fakeBridge() },
  );
  assert.deepEqual(result, { series: 1, chapters: 2, skipped: [], errors: [] });
  const [series] = [...store.series.values()];
  assert.equal(series.provider, 'local');
  assert.equal(series.title, 'A Title');
  assert.match(series.id, /^local:mihondl:/);

  const chapters = [...store.chapters.values()].sort((a, b) => a.number - b.number);
  assert.deepEqual(chapters.map((row) => row.name), ['Ch.1', 'Ch.2']);
  assert.deepEqual(chapters.map((row) => row.pageCount), [2, 2]);

  const books = [...store.books.values()];
  assert.equal(books.length, 2);
  for (const book of books) {
    assert.equal(book.blob, undefined, 'nothing is copied into the library');
    assert.deepEqual(book.location, {
      kind: 'mihondl',
      path: book.chapterId.endsWith(':ch:1') ? 'content://tree/A/1' : 'content://tree/A/2',
      format: 'folder',
      ext: '',
    });
  }
});

test('a second run skips what is already here, and never duplicates a row', async () => {
  const store = fakeStore();
  const scan = scanOf([{ title: 'A Title', path: 'content://tree/A', chapters: [at('Ch.1', 'content://tree/A/1')] }]);
  const first = await importDownloads(store, scan, { load: async () => fakeBridge() });
  assert.equal(first.series, 1);
  const again = await importDownloads(store, scan, { load: async () => fakeBridge() });
  assert.deepEqual(again, { series: 0, chapters: 0, skipped: ['A Title'], errors: [] });
  assert.equal(store.series.size, 1);
  assert.equal(store.books.size, 1);
});

test('a title with no readable chapter is an error, and the next title still imports', async () => {
  const store = fakeStore();
  const result = await importDownloads(
    store,
    scanOf([
      { title: 'Broken', path: 'content://tree/broken', chapters: [at('Ch.1', 'content://tree/broken/1')] },
      { title: 'Fine', path: 'content://tree/fine', chapters: [at('Ch.1', 'content://tree/fine/1')] },
    ]),
    { load: async () => fakeBridge() },
  );
  assert.equal(result.series, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^Broken: no readable chapter/);
  assert.deepEqual([...store.series.values()].map((row) => row.title), ['Fine']);
});

test('counting a chapter\'s pages reads names, not pixels', async () => {
  const chapter = at('Ch.1', 'content://tree/A/1');
  assert.equal(await countDownloadsPages(chapter, async () => fakeBridge(['1.jpg', '2.jpg', '3.jpg'])), 3);
  // An unreadable folder is 0 pages rather than an exception the importer would report as a failure.
  assert.equal(await countDownloadsPages(at('Ch.1', 'content://tree/broken/1'), async () => fakeBridge()), 0);
  // A file chapter has no page listing here: its count is the archive's business.
  assert.equal(await countDownloadsPages(at('Vol 1', 'content://tree/A/1.cbz', 'file', 'cbz'), async () => fakeBridge()), 0);
});
