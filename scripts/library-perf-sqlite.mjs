/**
 * The desktop storage path, with a library in it (TEST-03, `#29`).
 *
 *   npm run perf:sqlite                 # 3 000 titles, covers, downloads, books
 *   PERF_SERIES=10000 npm run perf:sqlite
 *
 * The browser bench (`perf/bench.html`) measures frames; `npm run perf` measures the in-memory
 * pipeline. Neither touches the engine the Linux Tauri build actually opens, so a cold start on a
 * real library had never been timed. This script does:
 *
 *   1. writes a populated library into a real SQLite file through `src/lib/db/sqlite.ts` — the same
 *      SQL, JSON documents and base64 blobs the desktop build runs, with `node:sqlite` standing in
 *      for `@tauri-apps/plugin-sql` as the transport only (the plugin's IPC hop is not measured
 *      here, and the JSON says so);
 *   2. times the five interactions the card names, composed from the calls the app makes:
 *        cold open      open + the boot reads (titles, categories, downloads, prefs, chapter mirror)
 *        pane selection pick a title in a pane: the series row and its chapter list
 *        scroll p95     the per-frame data half: the window arithmetic plus the tile rows
 *        series select  open a series page: details, chapters with read state, progress
 *        reader page 1  the device's copy of a chapter, page one first
 *   3. prints a table and writes `perf/sqlite-baseline.json`, so a later run is comparable without
 *      remembering what the numbers were.
 *
 * Deterministic (`PERF_SEED`) and self-cleaning: the database lives in a fresh temp directory, is
 * never the app's own file, and is deleted unless `PERF_KEEP=1`. Nothing here reads a real library.
 */
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SqliteDatabase } from "../src/lib/db/sqlite.ts";
import { LibraryStore } from "../src/lib/db/store.ts";
import { createLocalProvider } from "../src/api/local.ts";
import { itemWindow } from "../src/lib/window.ts";
import { ImageCache } from "../src/lib/cache/images.ts";

const COUNTS = {
  series: Number(process.env.PERF_SERIES ?? 3_000),
  chapters: Number(process.env.PERF_CHAPTERS ?? 16),
  /** Chapters with a finished download; page count inside each. */
  downloads: Number(process.env.PERF_DOWNLOADS ?? 40),
  pages: Number(process.env.PERF_PAGES ?? 20),
  /** Comic files on the shelf, at `PERF_BOOK_KB` each. */
  books: Number(process.env.PERF_BOOKS ?? 40),
  bookKb: Number(process.env.PERF_BOOK_KB ?? 200),
  /** Covers kept in the image cache, at `PERF_COVER_KB` each. */
  covers: Number(process.env.PERF_COVERS ?? 1_000),
  coverKb: Number(process.env.PERF_COVER_KB ?? 4),
  /** The page's own blob store row: 20 KB, the size of a scanned page thumbnail. */
  pageKb: Number(process.env.PERF_PAGE_KB ?? 20),
  seed: Number(process.env.PERF_SEED ?? 0x2f6e2b1),
  runs: Number(process.env.PERF_RUNS ?? 15),
};

const OUT = process.env.PERF_OUT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "perf", "sqlite-baseline.json");

/**
 * `$1, $2, …` (the plugin's sqlx) translated to `node:sqlite`'s positional `?`.
 *
 * The arguments are re-ordered by where each `$n` appears, so a statement that names the same
 * argument twice binds it twice instead of shifting every later argument. This is the only thing
 * that changes between the desktop engine and this one.
 */
function connector(directory) {
  return async (name) => {
    const db = new DatabaseSync(join(directory, name));
    db.exec("PRAGMA journal_mode = WAL");
    const order = (query) => [...query.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]) - 1);
    const bind = (query, values = []) => db.prepare(query.replace(/\$\d+/g, "?")).all(...order(query).map((at) => values[at]));
    const run = (query, values = []) => db.prepare(query.replace(/\$\d+/g, "?")).run(...order(query).map((at) => values[at]));
    return {
      async execute(query, values = []) {
        run(query, values);
      },
      async select(query, values = []) {
        return bind(query, values);
      },
      async close() {
        db.close();
        return true;
      },
    };
  };
}

/** Deterministic, so two runs are the same library and their numbers are comparable. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 10_000) / 10_000;
  };
}

const WORDS = ["Hollow", "Star", "Blue", "Iron", "Night", "Paper", "Salt", "Glass", "Ash", "Wild"];
const NOUNS = ["Garden", "Engine", "Lantern", "Orchard", "Signal", "Harbour", "Cipher", "Meadow"];

function seriesRow(index) {
  return {
    id: `local:perf:${index}`,
    provider: "local",
    sourceId: "local:src:library",
    title: `${WORDS[index % WORDS.length]} ${NOUNS[(index * 7) % NOUNS.length]} ${index}`,
    author: `Author ${index % 97}`,
    description: "A synthetic row: the measurement is the storage path, not the network.",
    status: ["ongoing", "completed", "hiatus"][index % 3],
    categoryIds: index % 4 === 0 ? [] : [`local:cat:${index % 5}`],
    cover: `https://fixture.example/cover/${index}.png`,
  };
}

function chapterRow(seriesId, index, number) {
  return {
    id: `${seriesId}:ch:${index}`,
    seriesId,
    name: `Chapter ${number}`,
    number,
    pageCount: 20,
    read: false,
    uploadedAt: 1_700_000_000_000 - number * 86_400_000,
  };
}

/** The pages of a downloaded chapter: 20 tiny blobs, one row each plus the bytes row. */
async function putDownload(store, chapter, pages, byteLength) {
  await store.putDownload({
    chapterId: chapter.id,
    seriesId: chapter.seriesId,
    chapterName: chapter.name,
    pages,
    bytes: pages * byteLength,
    at: 1_700_000_000_000,
    total: pages,
    number: chapter.number,
    state: "done",
  });
  for (let index = 0; index < pages; index += 1) {
    await store.putDownloadPage({
      id: `${chapter.id}#${index}`,
      chapterId: chapter.id,
      index,
      blob: new Blob([new Uint8Array(byteLength)], { type: "image/jpeg" }),
    });
  }
}

/** Everything the five interactions read, written once. Returns the ids the measurements use. */
async function populate(store, db) {
  const rand = random(COUNTS.seed);
  const categories = [0, 1, 2, 3, 4].map((n) => ({
    id: `local:cat:${n}`,
    name: `Collection ${n}`,
    order: n,
    hidden: false,
    pinned: n === 0,
  }));
  for (const category of categories) await store.putCategory(category);

  const seriesIds = [];
  const chapterIds = [];
  for (let i = 0; i < COUNTS.series; i += 1) {
    const row = seriesRow(i);
    await store.addSeries(row);
    seriesIds.push(row.id);
    const chapters = Array.from({ length: COUNTS.chapters }, (_, c) => chapterRow(row.id, c, c + 1));
    await store.putChapters(row.id, chapters);
    for (const chapter of chapters) {
      chapterIds.push(chapter.id);
      // A third read in, so the shelf's unread counts and continue strip are not all-zero.
      if (rand() < 0.33) await store.setProgress(chapter.id, 3, chapter.pageCount, 1_700_000_000_000 - i * 1_000);
    }
    // The page list every chapter keeps after its first open: the reader's fallback when offline.
    const pages = Array.from({ length: 20 }, (_, index) => ({ index, url: `https://fixture.example/${row.id}/${index}.jpg` }));
    await store.putPages(chapters[0].id, pages);
  }

  // Cached covers, through the cache's own write path.
  const cache = new ImageCache();
  cache.attach(db);
  for (let i = 0; i < Math.min(COUNTS.covers, COUNTS.series); i += 1) {
    const bytes = new Uint8Array(COUNTS.coverKb * 1024);
    bytes.fill(i % 251);
    await cache.remember(`https://fixture.example/cover/${i}.png`, new Blob([bytes], { type: "image/png" }));
  }

  // Downloaded chapters, spread over the library so a reader open is not always the same row.
  for (let i = 0; i < COUNTS.downloads; i += 1) {
    const chapter = chapterRow(seriesIds[i % seriesIds.length], 0, 1);
    await putDownload(store, chapter, COUNTS.pages, COUNTS.pageKb * 1024);
  }

  // Owned comic files: whole files, read a page at a time — never decoded here.
  for (let i = 0; i < COUNTS.books; i += 1) {
    const seriesId = `local:file:perf-${i}-${i.toString(36)}`;
    const bytes = new Uint8Array(COUNTS.bookKb * 1024);
    bytes.fill(i % 251);
    await store.putBook({
      seriesId,
      chapterId: `${seriesId.replace("local:file:", "local:ch:")}:1`,
      name: `Perf Book ${i}.cbz`,
      kind: "cbz",
      pageCount: 20,
      bytes: bytes.byteLength,
      addedAt: 1_700_000_000_000 - i,
      blob: new Blob([bytes], { type: "application/zip" }),
    });
  }

  return {
    seriesIds,
    chapterIds,
    // The chapters that actually have a download, for the reader measurement.
    downloaded: seriesIds
      .slice(0, Math.min(COUNTS.downloads, seriesIds.length))
      .map((seriesId) => chapterRow(seriesId, 0, 1).id),
    cache,
  };
}

/* ---- timing --------------------------------------------------------------------------------- */

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

/** One warm-up, then the median/p95/max of `runs`. The first call pays for the JIT. */
async function timed(fn, runs = COUNTS.runs) {
  await fn();
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    p50: +percentile(times, 0.5).toFixed(3),
    p95: +percentile(times, 0.95).toFixed(3),
    max: +times[times.length - 1].toFixed(3),
    min: +times[0].toFixed(3),
    runs,
  };
}

const show = (label, value, unit = "ms") => console.log(`${label.padEnd(34)} ${value.toFixed(2).padStart(9)} ${unit}`);

/* ---- the run -------------------------------------------------------------------------------- */

const directory = mkdtempSync(join(tmpdir(), "ht-perf-sqlite-"));

try {
  const database = await SqliteDatabase.open("perf-library.db", connector(directory));
  const store = new LibraryStore(database);

  console.log(
    `populating ${COUNTS.series} titles × ${COUNTS.chapters} chapters, ${COUNTS.covers} covers, ` +
      `${COUNTS.downloads} downloads, ${COUNTS.books} books…`,
  );
  const buildStart = performance.now();
  const built = await populate(store, database);
  const buildMs = performance.now() - buildStart;
  const file = join(directory, "perf-library.db");
  const fileBytes = statSync(file).size;

  // The five interactions, each composed from the calls the app makes.

  // 1. A cold start: open the file, then the reads the boot gate waits on.
  const coldOpen = await timed(async () => {
    const opened = await SqliteDatabase.open("perf-library.db", connector(directory));
    const cold = new LibraryStore(opened);
    await cold.listSeries();
    await cold.listCategories();
    await cold.listDownloads();
    await cold.listPrefs();
    await cold.listAllChapters();
    await cold.listProgress();
    await opened.close?.();
  });

  // 2. Picking a title in a pane: the series row and the chapter list beside it.
  let pick = 0;
  const paneSelection = await timed(async () => {
    const id = built.seriesIds[pick++ % built.seriesIds.length];
    const series = await store.getSeries(id);
    if (series === undefined) throw new Error(`pane fixture lost ${id}`);
    await store.listChapters(id);
  });
  // The two halves, because they are not the same order of cost and the fix is not the same call.
  let row = 0;
  const paneRowOnly = await timed(async () => {
    const id = built.seriesIds[row++ % built.seriesIds.length];
    await store.getSeries(id);
  });
  let list = 0;
  const paneChaptersOnly = await timed(async () => {
    const id = built.seriesIds[list++ % built.seriesIds.length];
    await store.listChapters(id);
  });

  // 3. A scroll frame's data half: the window arithmetic and the rows it keeps.
  //    The DOM half (tiles, paint) is the browser bench's number, on purpose.
  const shelf = await store.listSeries();
  const facts = {
    unread: new Map(built.seriesIds.map((id, i) => [id, i % 3])),
    downloaded: new Map(built.seriesIds.map((id, i) => [id, i % 7])),
    lastRead: new Map(built.seriesIds.map((id, i) => [id, 1_700_000_000_000 - i * 1_000])),
  };
  const scrollFrames = [];
  for (let frame = 0; frame < 120; frame += 1) {
    const scrollTop = frame * 240;
    const t0 = performance.now();
    const win = itemWindow({ count: shelf.length, columns: 5, rowHeight: 260, scrollTop, viewportHeight: 900 });
    const visible = shelf.slice(win.start, win.end);
    // What a tile reads: its row, its unread count, whether it is downloaded, when it last read.
    for (const row of visible) {
      facts.unread.get(row.id);
      facts.downloaded.get(row.id);
      facts.lastRead.get(row.id);
    }
    scrollFrames.push(performance.now() - t0);
  }
  scrollFrames.sort((a, b) => a - b);
  const scrollP95 = {
    p50: +percentile(scrollFrames, 0.5).toFixed(3),
    p95: +percentile(scrollFrames, 0.95).toFixed(3),
    max: +scrollFrames[scrollFrames.length - 1].toFixed(3),
    frames: scrollFrames.length,
    rendered: itemWindow({ count: shelf.length, columns: 5, rowHeight: 260, scrollTop: 0, viewportHeight: 900 }).end,
  };

  // 4. Opening a series page: the provider's details, the chapter list with read state, and where
  //    the reader left off. This is the whole cold path a tap on a tile walks.
  const provider = createLocalProvider(store);
  let open = 0;
  const seriesSelection = await timed(async () => {
    const id = built.seriesIds[open++ % built.seriesIds.length];
    await provider.details(id);
    const chapters = await provider.chapters(id);
    const first = chapters[0];
    if (first !== undefined) await store.getProgress(first.id);
  });

  // 5. The reader's first page from the device's own copy: the pages of the chapter, page one
  //    decoded from its blob. This is `downloads.local()` without the object-URL layer.
  let reader = 0;
  const readerPage1 = await timed(async () => {
    const chapterId = built.downloaded[reader++ % built.downloaded.length];
    const pages = await store.listDownloadPages(chapterId);
    const first = pages.find((page) => page.index === 0);
    if (first === undefined) throw new Error("the downloaded fixture lost its first page");
    await first.blob.arrayBuffer();
  });

  // A cover, cold: the row plus its bytes, which is what a tile asks the cache for on first paint.
  // A fresh cache per run, because the instance keeps its object URLs in memory.
  const coverKey = "https://fixture.example/cover/0.png";
  const coverCold = await timed(async () => {
    const cache = new ImageCache();
    cache.attach(database);
    const url = await cache.resolve(coverKey);
    if (!url.startsWith("blob:") && !url.startsWith("data:")) throw new Error("the cover fixture is not cached");
  }, 10);

  console.log(`\nbuilt in ${(buildMs / 1000).toFixed(1)} s — ${COUNTS.series} titles, ${built.chapterIds.length} chapters, ${(fileBytes / 1048576).toFixed(1)} MiB file\n`);
  show("cold open (open + boot reads)", coldOpen.p50);
  show("pane selection (row + chapters)", paneSelection.p50);
  show("  ↳ the series row alone", paneRowOnly.p50);
  show("  ↳ the chapter list alone", paneChaptersOnly.p50);
  show("scroll frame, p50 (data half)", scrollP95.p50);
  show("scroll frame, p95 (data half)", scrollP95.p95);
  show("series selection (details + list)", seriesSelection.p50);
  show("reader page 1 (device copy)", readerPage1.p50);
  show("cover, cold (row + bytes)", coverCold.p50);

  const report = {
    card: "TEST-03 (#29)",
    measuredAt: new Date().toISOString(),
    engine: "src/lib/db/sqlite.ts over node:sqlite",
    note:
      "The SQL, the JSON documents and the base64 blobs are the desktop engine's own. node:sqlite stands in for " +
      "@tauri-apps/plugin-sql as the transport, so the plugin's IPC hop is not part of these numbers.",
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpus: cpus().map((cpu) => cpu.model).slice(0, 2),
      cpuCount: cpus().length,
    },
    counts: { ...COUNTS, chaptersTotal: built.chapterIds.length },
    database: { bytes: fileBytes, files: ["perf-library.db", "perf-library.db-wal", "perf-library.db-shm"] },
    buildMs: +buildMs.toFixed(0),
    measurements: {
      coldOpen,
      paneSelection,
      seriesSelection,
      scrollP95,
      readerPage1,
      coverCold,
      breakdown: { paneRowOnly, paneChaptersOnly },
    },
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${OUT}`);
} finally {
  if (process.env.PERF_KEEP === "1") console.log(`kept ${directory} (PERF_KEEP=1)`);
  else rmSync(directory, { recursive: true, force: true });
}