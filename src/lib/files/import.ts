/**
 * Bringing a comic file into the library.
 *
 * The point of this module is the owner's own sentence: *"if they bought drm free comics they can read
 * them here easily by picking the folder"*. So a picked file becomes a normal library row — a series
 * with one chapter — and everything the library already does works on it: continue reading, history,
 * badges, categories, hiding, search. No second kind of library, no "imported files" ghetto.
 *
 * Nothing is copied twice. The bytes are stored once, as the file the user already had, and the pages
 * are produced from them on demand.
 */
import type { Series } from "../../api/source";
import type { LibraryStore } from "../db/store";
import { kindOf, openComic, titleFromFile } from "./index";

export interface ImportResult {
  added: number;
  /** Files this app cannot read, by name. */
  skipped: string[];
  /** Files that were readable but failed — a corrupt archive, a password, a full disk. */
  errors: string[];
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
export async function importComicFiles(store: LibraryStore, files: ReadonlyArray<File>): Promise<ImportResult> {
  const result: ImportResult = { added: 0, skipped: [], errors: [] };

  for (const file of files) {
    const name = file.name;
    if (kindOf(name) === null) {
      result.skipped.push(name);
      continue;
    }
    const seriesId = fileSeriesId(name, file.size);
    if ((await store.getBook(seriesId)) !== undefined) {
      result.skipped.push(name);
      continue;
    }
    try {
      const book = await openComic(file, name);
      const pageCount = book.pageCount;
      book.close();

      const series: Series = {
        id: seriesId,
        provider: "local",
        title: titleFromFile(name),
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
        kind: kindOf(name) === "pdf" ? "pdf" : "cbz",
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
