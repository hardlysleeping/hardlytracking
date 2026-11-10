/**
 * Another app's downloads, read in place.
 *
 * Mihon keeps its downloads as `<root>/<manga title>/<chapter>/001.jpg…`, or `<chapter>.cbz` when
 * "save as CBZ" is on. Nothing here copies them: the tree is listed through a persisted URI grant,
 * a chapter's pages are listed when it is opened, and a page's bytes are read when it is drawn. The
 * phone holds one page at a time, exactly as it does for our own library.
 *
 * What this module owns is the interpretation — which entries are chapters, what a chapter is
 * called, what order they read in — so that part can be tested without a device. The shell owns the
 * documents, and answers through the `DownloadsFolder` plugin.
 */
import { mimeOf, naturalCompare, type ComicBook, type PageRequest } from "./comic";
import { keepCover } from "./cover";
import type { LibraryStore } from "../db/store";
import type { Series } from "../../api/source";

/** The shell's `DownloadsFolder` surface. */
export interface DownloadsFolderBridge {
  pick(): Promise<{ folder: MihonFolder | null }>;
  saved(): Promise<{ folder: MihonFolder | null }>;
  forget(): Promise<void>;
  scan(): Promise<MihonScanAnswer>;
  chapter(options: { path: string }): Promise<{ pages: Array<{ name: string; path: string }> }>;
  file(options: { path: string }): Promise<{ base64: string }>;
}

/** The chosen root, as the shell describes it. */
export interface MihonFolder {
  path: string;
  name: string;
}

/** One chapter: a folder of images, or a single archive/PDF file. */
export interface MihonChapter {
  name: string;
  /** The document handle a read goes through. Never a filesystem path — it is a content URI. */
  path: string;
  kind: "folder" | "file";
  /** `cbz`/`cbr`/`zip`/`pdf` for a file chapter. */
  ext: string;
  /** Bytes, for a file chapter the shell measured. A folder chapter is pages, not bytes. */
  bytes: number;
}

/** One title in the other app's library. */
export interface MihonSeries {
  title: string;
  path: string;
  chapters: MihonChapter[];
}

export interface MihonScan {
  folder: MihonFolder | null;
  series: MihonSeries[];
}

interface MihonScanAnswer {
  folder?: { path?: unknown; name?: unknown } | null;
  series?: Array<{
    title?: unknown;
    path?: unknown;
    chapters?: Array<{ name?: unknown; path?: unknown; kind?: unknown; ext?: unknown; bytes?: unknown }>;
  }>;
}

/** The extensions a chapter file can have, as the shell reports them. */
export const CHAPTER_EXTENSIONS = ["cbz", "cbr", "zip", "pdf"] as const;

/** The image extensions a chapter folder holds. Junk in the folder is skipped, never drawn. */
export const PAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "bmp"] as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function count(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function isPageName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return (PAGE_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * A chapter name → the number it should sort by, or `null`.
 *
 * A chapter marker wins over a volume number: "Vol.2 Ch.14.5" is chapter 14.5, and taking the first
 * number in the string would file it next to chapter 2. Only when no chapter marker exists does the
 * first number in the name count. A chapter with no number sorts last rather than first: specials
 * after the run.
 */
export function chapterNumberOf(name: string): number | null {
  const marked = name.match(/ch(?:apter)?\.?\s*(\d+(?:\.\d+)?)/i)?.[1];
  const bare = name.match(/\d+(?:\.\d+)?/)?.[0];
  const found = marked ?? bare;
  if (found === undefined) return null;
  const value = Number(found);
  return Number.isFinite(value) ? value : null;
}

/** Chapters in reading order: numbered ones by number and name, then the unnumbered by name. */
export function orderChapters(chapters: readonly MihonChapter[]): MihonChapter[] {
  return [...chapters].sort((one, two) => {
    const left = chapterNumberOf(one.name);
    const right = chapterNumberOf(two.name);
    if (left !== null && right !== null && left !== right) return left - right;
    if (left === null && right !== null) return 1;
    if (left !== null && right === null) return -1;
    return naturalCompare(one.name, two.name);
  });
}

/**
 * The scan, normalised: readable series only, chapters ordered, nothing invented.
 *
 * A series with no usable chapter is dropped — a row that opens onto nothing is worse than no row.
 * A chapter path or name that is empty is dropped for the same reason.
 */
export function parseScan(answer: MihonScanAnswer | null | undefined): MihonScan {
  const folder = answer?.folder;
  const root: MihonFolder | null =
    folder === null || folder === undefined
      ? null
      : { path: text(folder.path), name: text(folder.name) };
  const series: MihonSeries[] = [];
  for (const row of answer?.series ?? []) {
    const title = text(row.title);
    const path = text(row.path);
    if (title === "" || path === "") continue;
    const chapters: MihonChapter[] = [];
    for (const entry of row.chapters ?? []) {
      const name = text(entry.name);
      const chapterPath = text(entry.path);
      if (name === "" || chapterPath === "") continue;
      const kind = entry.kind === "file" ? "file" : "folder";
      const ext = text(entry.ext).toLowerCase();
      if (kind === "file" && !(CHAPTER_EXTENSIONS as readonly string[]).includes(ext)) continue;
      chapters.push({ name, path: chapterPath, kind, ext, bytes: count(entry.bytes) });
    }
    if (chapters.length === 0) continue;
    series.push({ title, path, chapters: orderChapters(chapters) });
  }
  series.sort((one, two) => naturalCompare(one.title, two.title));
  return { folder: root?.path === "" ? null : root, series };
}

/**
 * A chapter folder as a book: its pages are listed once, then read one at a time.
 *
 * `read` is the only thing that touches the device, which is what makes this testable and what keeps
 * a 200-page chapter from costing 200 reads before the first page appears.
 */
export function folderBook(pages: ReadonlyArray<{ name: string; path: string }>, read: (path: string) => Promise<Uint8Array>): ComicBook {
  const ordered = [...pages].filter((page) => isPageName(page.name)).sort((one, two) => naturalCompare(one.name, two.name));
  return {
    kind: "cbz",
    pageCount: ordered.length,
    async open(index: number, request?: PageRequest): Promise<Blob> {
      const page = ordered[index];
      if (page === undefined) throw new Error(`page ${index + 1} is past the end of this chapter`);
      const bytes = await read(page.path);
      if (bytes.length === 0) throw new Error(`${page.name} is empty`);
      void request;
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      return new Blob([copy.buffer], { type: mimeOf(page.name) });
    },
    close(): void {
      // Nothing is held between pages: the shell reads on demand and the reader drops each blob.
    },
  };
}

/**
 * Base64 → bytes, without `atob`: the packaged apps and the unit tests do not all have it, and a
 * silent empty result here reads as a corrupt page rather than as a bug in this file.
 */
export function decodeBase64(text: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Map<string, number>();
  for (let index = 0; index < alphabet.length; index += 1) lookup.set(alphabet[index] as string, index);
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let at = 0;
  let bits = 0;
  let store = 0;
  for (const character of clean) {
    const value = lookup.get(character);
    if (value === undefined) continue;
    store = (store << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at] = (store >> bits) & 0xff;
      at += 1;
    }
  }
  return out.subarray(0, at);
}

const PLUGIN = "DownloadsFolder";

async function loadBridge(): Promise<DownloadsFolderBridge | null> {
  try {
    const { Capacitor, registerPlugin } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform()) return null;
    if (String(Capacitor.getPlatform?.() ?? "") !== "android") return null;
    return registerPlugin<DownloadsFolderBridge>(PLUGIN);
  } catch {
    return null;
  }
}

/** Can this build read another app's folder at all? The UI hides the entry point when it cannot. */
export async function canReadDownloadsFolder(
  load: () => Promise<DownloadsFolderBridge | null> = loadBridge,
): Promise<boolean> {
  return (await load()) !== null;
}

/** The folder already chosen, or `null` — on a build with no shell, always `null`. */
export async function savedDownloadsFolder(
  load: () => Promise<DownloadsFolderBridge | null> = loadBridge,
): Promise<MihonFolder | null> {
  const bridge = await load();
  if (bridge === null) return null;
  try {
    const answer = await bridge.saved();
    return parseScan({ folder: answer?.folder ?? null, series: [] }).folder;
  } catch {
    return null;
  }
}

/** Ask the system for a tree, and remember it. `null` means the pick was cancelled. */
export async function pickDownloadsFolder(
  load: () => Promise<DownloadsFolderBridge | null> = loadBridge,
): Promise<MihonFolder | null> {
  const bridge = await load();
  if (bridge === null) throw new Error("this build cannot read another app's downloads");
  const answer = await bridge.pick();
  return parseScan({ folder: answer?.folder ?? null, series: [] }).folder;
}

/** Forget the chosen folder. The files are untouched: they belong to the other app. */
export async function forgetDownloadsFolder(
  load: () => Promise<DownloadsFolderBridge | null> = loadBridge,
): Promise<void> {
  const bridge = await load();
  if (bridge === null) return;
  await bridge.forget();
}

/** List the chosen tree as series and chapters. Nothing is read but names. */
export async function scanDownloadsFolder(
  load: () => Promise<DownloadsFolderBridge | null> = loadBridge,
): Promise<MihonScan> {
  const bridge = await load();
  if (bridge === null) return { folder: null, series: [] };
  try {
    return parseScan(await bridge.scan());
  } catch {
    return { folder: null, series: [] };
  }
}

/** A chapter folder's pages, as a book the reader can draw one page at a time. */
export async function listDownloadsPages(
  chapter: MihonChapter,
  load: () => Promise<DownloadsFolderBridge | null> = loadBridge,
): Promise<Array<{ name: string; path: string }>> {
  const bridge = await load();
  if (bridge === null) throw new Error("this build cannot read another app's downloads");
  if (chapter.kind !== "folder") throw new Error(`${chapter.name} is a file, not a folder of pages`);
  const listing = await bridge.chapter({ path: chapter.path });
  const pages = Array.isArray(listing?.pages) ? listing.pages : [];
  return pages.filter((page) => isPageName(page.name)).sort((one, two) => naturalCompare(one.name, two.name));
}

/** How many pages a folder chapter holds, without reading one: the listing is the count. */
export async function countDownloadsPages(
  chapter: MihonChapter,
  load: () => Promise<DownloadsFolderBridge | null> = loadBridge,
): Promise<number> {
  try {
    return (await listDownloadsPages(chapter, load)).length;
  } catch {
    return 0;
  }
}

export async function openDownloadsChapter(
  chapter: MihonChapter,
  load: () => Promise<DownloadsFolderBridge | null> = loadBridge,
): Promise<ComicBook> {
  const bridge = await load();
  if (bridge === null) throw new Error("this build cannot read another app's downloads");
  const pages = await listDownloadsPages(chapter, load);
  if (pages.length === 0) throw new Error(`${chapter.name} has no page images in it`);
  return folderBook(pages, async (path) => {
    const answer = await bridge.file({ path });
    const bytes = decodeBase64(answer?.base64 ?? "");
    if (bytes.length === 0) throw new Error(`could not read a page of ${chapter.name}`);
    return bytes;
  });
}

/** A stable id from the folder's document handle: re-scanning the same title is a skip, not a copy. */
export function downloadsSeriesId(seriesPath: string): string {
  let hash = 0;
  for (let index = 0; index < seriesPath.length; index += 1) {
    hash = (hash * 31 + seriesPath.charCodeAt(index)) | 0;
  }
  return `local:mihondl:${(hash >>> 0).toString(36)}`;
}

export interface DownloadsImportResult {
  /** Titles added to the library. */
  series: number;
  /** Chapters indexed, all of them pointing at the other app's files. */
  chapters: number;
  /** Titles already in the library, by title, so the sentence can name them. */
  skipped: string[];
  /** Titles that could not be indexed, with the reason. */
  errors: string[];
}

/**
 * Put another app's downloads in this library, without moving a byte.
 *
 * One title in the scan becomes one series; each chapter folder becomes a chapter whose pages are
 * read from where Mihon put them (`BookLocation`). A title already in the library is skipped rather
 * than re-added — the id is derived from its folder handle, so a second scan is a no-op for it.
 *
 * Nothing here deletes or writes in the other app's tree: it is a read grant, and the rows are ours.
 */
export async function importDownloads(
  store: LibraryStore,
  scan: MihonScan,
  options: {
    onProgress?: (state: { title: string; done: number; total: number }) => void;
    /** The shell, for a test that hands in a fake one. */
    load?: () => Promise<DownloadsFolderBridge | null>;
  } = {},
): Promise<DownloadsImportResult> {
  const result: DownloadsImportResult = { series: 0, chapters: 0, skipped: [], errors: [] };
  let done = 0;
  for (const row of scan.series) {
    options.onProgress?.({ title: row.title, done, total: scan.series.length });
    done += 1;
    const seriesId = downloadsSeriesId(row.path);
    try {
      if ((await store.getSeries(seriesId)) !== undefined) {
        result.skipped.push(row.title);
        continue;
      }
      // Ordered here rather than trusting the caller: the id is derived from the position in
      // reading order, so a second scan of the same folder produces the same ids.
      const ordered = orderChapters(row.chapters);
      const chapters: Array<{ chapter: MihonChapter; id: string; number: number; pageCount: number }> = [];
      for (const [index, chapter] of ordered.entries()) {
        const pageCount = chapter.kind === "folder" ? await countDownloadsPages(chapter, options.load) : 0;
        if (chapter.kind === "folder" && pageCount === 0) continue;
        chapters.push({
          chapter,
          id: `${seriesId}:ch:${index + 1}`,
          number: chapterNumberOf(chapter.name) ?? index + 1,
          pageCount,
        });
      }
      if (chapters.length === 0) {
        result.errors.push(`${row.title}: no readable chapter in it`);
        continue;
      }
      // A cover costs one page of the first chapter and makes the shelf look like the library it is.
      let cover = "";
      const first = chapters[0];
      if (first !== undefined && first.chapter.kind === "folder") {
        try {
          const book = await openDownloadsChapter(first.chapter, options.load);
          cover = await keepCover(seriesId, await book.open(0));
          book.close();
        } catch {
          cover = "";
        }
      }
      const series: Series = {
        id: seriesId,
        provider: "local",
        title: row.title,
        ...(cover === "" ? {} : { cover }),
      };
      await store.addSeries(series);
      await store.putChapters(
        seriesId,
        chapters.map((entry) => ({
          id: entry.id,
          seriesId,
          name: entry.chapter.name,
          number: entry.number,
          pageCount: entry.pageCount,
          read: false,
        })),
      );
      for (const entry of chapters) {
        await store.putBook({
          seriesId,
          chapterId: entry.id,
          name: entry.chapter.name,
          kind: entry.chapter.kind === "file" && entry.chapter.ext === "pdf" ? "pdf" : "cbz",
          pageCount: entry.pageCount,
          bytes: entry.chapter.bytes,
          location: {
            kind: "mihondl",
            path: entry.chapter.path,
            format: entry.chapter.kind,
            ext: entry.chapter.ext,
          },
          addedAt: Date.now(),
        });
      }
      result.series += 1;
      result.chapters += chapters.length;
    } catch (error) {
      result.errors.push(`${row.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  options.onProgress?.({ title: "", done, total: scan.series.length });
  return result;
}

/** A file chapter's bytes (a CBZ), for the archive reader. */
export async function readDownloadsFile(
  chapter: MihonChapter,
  load: () => Promise<DownloadsFolderBridge | null> = loadBridge,
): Promise<Blob> {
  const bridge = await load();
  if (bridge === null) throw new Error("this build cannot read another app's downloads");
  const answer = await bridge.file({ path: chapter.path });
  const bytes = decodeBase64(answer?.base64 ?? "");
  if (bytes.length === 0) throw new Error(`could not read ${chapter.name}`);
  return new Blob([bytes.buffer as ArrayBuffer], { type: mimeOf(`${chapter.name}.${chapter.ext}`) });
}
