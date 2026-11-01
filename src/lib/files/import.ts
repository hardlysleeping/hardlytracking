/**
 * Bringing a comic file into the library.
 *
 * The point of this module is the owner's own sentence: *"if they bought drm free comics they can read
 * them here easily by picking the folder"*. So a picked file becomes a normal library row — a series
 * with one chapter — and everything the library already does works on it: continue reading, history,
 * badges, categories, hiding, search. No second kind of library, no "imported files" ghetto.
 *
 * Nothing is copied twice. The bytes are stored once, as the file the user already had, and the pages
 * are produced from them on demand. The one exception is deliberate: page 1 is drawn once at import,
 * as a small cover, because a shelf needs a picture before anyone opens the book.
 *
 * **Every step that can wait is bounded, and says what it is doing.** Reading a real file is the one
 * part of this app that can take arbitrarily long without ever failing — pdf.js walking a scan whose
 * page box is in pixels, a damaged index tried page by page, a webview with no room for one more
 * canvas. Unbounded, that is a button reading "Adding…" for two minutes, a library that gained
 * nothing, and no sentence afterwards to say why. So:
 *
 * 1. Opening a file has a deadline (`RUNTIME_DEADLINE_MS`, the app's own). A file that misses it is
 *    named in `errors`, in seconds, instead of being waited on.
 * 2. Drawing the cover has a shorter one (`COVER_DEADLINE_MS`), and **a cover that fails or runs out
 *    of time never drops the book**: the row lands and the shelf draws the title, which is exactly
 *    what it did before covers existed. A shelf picture is a want; the book is the need.
 * 3. `onProgress` says which file is being worked on and what is happening to it, so the screen can
 *    tell "working" from "hung" without guessing.
 */
import type { Series } from "../../api/source";
import type { LibraryStore } from "../db/store";
import { DeadlineError, RUNTIME_DEADLINE_MS, withDeadline } from "../deadline";
import { kindOf, openComic, titleFromFile } from "./index";
import { coverFromBook, keepCover } from "./cover";
import type { ComicBook } from "./comic";

export interface ImportResult {
  added: number;
  /** Files this app cannot read, by name. */
  skipped: string[];
  /** Files that were readable but failed — a corrupt archive, a password, a full disk. */
  errors: string[];
}

/** Which part of the import one file is at. */
export type ImportStage = "reading" | "cover" | "saving";

/** One step of the import, for a screen that wants to say what is happening. */
export interface ImportProgress {
  /** 1-based: the file being worked on, and how many were picked. */
  index: number;
  total: number;
  name: string;
  stage: ImportStage;
}

/** One sentence for a screen: "Drawing the cover of Saga v01.cbz · 2 of 5". */
export function describeProgress(progress: ImportProgress): string {
  const what =
    progress.stage === "reading"
      ? `Reading ${progress.name}`
      : progress.stage === "cover"
        ? `Drawing the cover of ${progress.name}`
        : `Saving ${progress.name}`;
  return progress.total > 1 ? `${what} · ${progress.index} of ${progress.total}` : what;
}

/**
 * How long page 1 may take to become a picture before the shelf keeps the title instead.
 *
 * Shorter than a file's own deadline because a cover is the optional half of an import: the book can
 * land now, showing the tile it had before covers existed, rather than the whole pick waiting on it.
 */
export const COVER_DEADLINE_MS = 15_000;

export interface ImportOptions {
  /**
   * How page 1 becomes a shelf cover.
   *
   * Injected so a test can watch this happen without a canvas — the drawing itself is `cover.ts`,
   * and no test can assert on a JPEG it never sees.
   */
  cover?: (book: ComicBook) => Promise<Blob | null>;
  /** How a picked file becomes a book. Injected so a test can make one that never opens at all. */
  open?: (file: File, name: string) => Promise<ComicBook>;
  /** Where the RAR decoder's wasm comes from; the app's default is Vite's emitted file. */
  wasm?: () => Promise<ArrayBuffer>;
  /** Called as each file moves through the import, so a screen can say what is happening. */
  onProgress?: (progress: ImportProgress) => void;
  /** How long a file may take to open. The app's `RUNTIME_DEADLINE_MS` by default; tests pass their own. */
  openDeadlineMs?: number;
  /** How long a cover may take. `COVER_DEADLINE_MS` by default; tests pass their own. */
  coverDeadlineMs?: number;
}

/** A stable id from the file name, so re-importing the same book is a skip rather than a duplicate. */
export function fileSeriesId(name: string, bytes: number): string {
  const slug = name
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  // The size keeps two different scans of the same title apart, and keeps a re-pick of the same file
  // identical so the second import is recognised.
  return `local:file:${slug || "book"}-${bytes.toString(36)}`;
}

export function fileChapterId(seriesId: string): string {
  return `${seriesId.replace("local:file:", "local:ch:")}:1`;
}

/**
 * What to tell someone about a file that would not open.
 *
 * A deadline says nothing about the file — only that waiting had stopped being useful. So it is not
 * reported in `DeadlineError`'s own words ("did not answer"), which are written for a server.
 */
function whyUnreadable(error: unknown): string {
  if (error instanceof DeadlineError) {
    return `still not read after ${Math.round(error.ms / 1000)} s — the file may be damaged, or too large for this device`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The `openComic` the app uses, with the test decoder wired in when the caller brought one. */
function openerFor(options: ImportOptions): (file: File, name: string) => Promise<ComicBook> {
  if (options.open !== undefined) return options.open;
  return (file, name) => openComic(file, name, options.wasm === undefined ? {} : { wasm: options.wasm });
}

/**
 * Import the files the user picked.
 *
 * One file is one title with one chapter, which is what a bought comic *is* — a book, not a
 * serialisation. Grouping a folder of volumes into one series is a later, separate decision: guessing
 * it here would file "Saga v01" and "Saga v02" under one title for some users and split "Batman 001" /
 * "Batman 002" for others.
 *
 * One file failing never stops the rest of the pick: its name lands in `errors` and the loop moves on.
 */
export async function importComicFiles(
  store: LibraryStore,
  files: ReadonlyArray<File>,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const result: ImportResult = { added: 0, skipped: [], errors: [] };
  const coverFor = options.cover ?? coverFromBook;
  const openFor = openerFor(options);
  const openDeadlineMs = options.openDeadlineMs ?? RUNTIME_DEADLINE_MS;
  const coverDeadlineMs = options.coverDeadlineMs ?? COVER_DEADLINE_MS;

  for (const [at, file] of files.entries()) {
    const name = file.name;
    const progress = (stage: ImportStage) => options.onProgress?.({ index: at + 1, total: files.length, name, stage });
    const kind = kindOf(name);
    if (kind === null) {
      result.skipped.push(name);
      continue;
    }
    const seriesId = fileSeriesId(name, file.size);
    if ((await store.getBook(seriesId)) !== undefined) {
      result.skipped.push(name);
      continue;
    }
    try {
      progress("reading");
      // The deadline counts in `activity` under the file's own name, so the shell's chip says
      // "Waiting on Saga v01.pdf · 12s" while this runs — and the same call ends the wait at 30 s
      // rather than leaving the button spinning.
      const book = await withDeadline(openFor(file, name), openDeadlineMs, name);
      const pageCount = book.pageCount;
      // One page, once. A cover that cannot be drawn — or that will not finish within
      // `COVER_DEADLINE_MS` — is not a failed import: the book still opens, and the shelf falls back
      // to the title exactly as it did before covers existed.
      let cover = "";
      try {
        progress("cover");
        cover = await keepCover(seriesId, await withDeadline(coverFor(book), coverDeadlineMs, `the cover of ${name}`));
      } catch {
        cover = "";
      }
      book.close();

      progress("saving");
      const series: Series = {
        id: seriesId,
        provider: "local",
        title: titleFromFile(name),
        ...(cover === "" ? {} : { cover }),
      };
      const chapterId = fileChapterId(seriesId);
      await store.addSeries(series);
      await store.putChapters(seriesId, [
        { id: chapterId, seriesId, name: titleFromFile(name), number: 1, pageCount, read: false },
      ]);
      await store.putBook({
        seriesId,
        chapterId,
        name,
        kind,
        pageCount,
        bytes: file.size,
        blob: file,
        addedAt: Date.now(),
      });
      result.added += 1;
    } catch (error) {
      result.errors.push(`${name}: ${whyUnreadable(error)}`);
    }
  }

  return result;
}

/** A file that has been imported, or nothing. Used by the reader to know it must produce pages. */
export async function bookFor(store: LibraryStore, seriesId: string) {
  return store.getBook(seriesId);
}
