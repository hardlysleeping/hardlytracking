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
 */
import type { Series } from "../../api/source";
import type { LibraryStore } from "../db/store";
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

export interface ImportOptions {
  /**
   * How page 1 becomes a shelf cover.
   *
   * Injected so a test can watch this happen without a canvas — the drawing itself is `cover.ts`,
   * and no test can assert on a JPEG it never sees.
   */
  cover?: (book: ComicBook) => Promise<Blob | null>;
  /** Where the RAR decoder's wasm comes from; the app's default is Vite's emitted file. */
  wasm?: () => Promise<ArrayBuffer>;
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
 * Import the files the user picked.
 *
 * One file is one title with one chapter, which is what a bought comic *is* — a book, not a
 * serialisation. Grouping a folder of volumes into one series is a later, separate decision: guessing
 * it here would file "Saga v01" and "Saga v02" under one title for some users and split "Batman 001" /
 * "Batman 002" for others.
 */
export async function importComicFiles(
  store: LibraryStore,
  files: ReadonlyArray<File>,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const result: ImportResult = { added: 0, skipped: [], errors: [] };
  const coverFor = options.cover ?? coverFromBook;

  for (const file of files) {
    const name = file.name;
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
      const book = await openComic(file, name, options.wasm === undefined ? {} : { wasm: options.wasm });
      const pageCount = book.pageCount;
      // One page, once. A cover that cannot be drawn is not a failed import: the book still opens,
      // and the shelf falls back to the title exactly as it did before covers existed.
      let cover = "";
      try {
        cover = await keepCover(seriesId, await coverFor(book));
      } catch {
        cover = "";
      }
      book.close();

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
      result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}

/** A file that has been imported, or nothing. Used by the reader to know it must produce pages. */
export async function bookFor(store: LibraryStore, seriesId: string) {
  return store.getBook(seriesId);
}
