/**
 * Export a chapter *back out* — into the download folder Mihon reads.
 *
 * The import half (`mihon-downloads.ts`) indexes another app's tree; this half writes one chapter of
 * ours into it as a `.cbz`, under the exact names Mihon looks for. Two facts from Mihon's source make
 * that worth doing rather than guessing:
 *
 * - Its layout is `<downloads>/<source>/<manga>/<chapter>.cbz` (`DownloadProvider.createMangaDir`).
 * - Its "is this chapter downloaded?" check renews a cache of the *directory listing* and matches
 *   chapter names against it (`DownloadCache.getDownloadedChapterIds`). A file with a matching name
 *   therefore reads as downloaded on the next refresh — no import step in Mihon, no database write
 *   from us.
 *
 * What that means in practice: this works for a chapter Mihon already knows — one that came from a
 * Mihon backup, or that exists in Mihon's own library — because the match is by name. Writing a
 * chapter Mihon has never heard of puts a file on disk that nothing there can claim.
 */
import { mihonChapterDirName, mihonMangaDirName, mihonSourceDirName } from "./mihon-names";
import { writeZip, type ZipEntry } from "./zip-write";
import type { LibraryStore } from "../db/store";

/** The write half of the shell bridge this module needs. */
export interface MihonWriter {
  write(options: { segments: string[]; base64: string }): Promise<{ path: string; bytes: number }>;
}

export interface ExportChapterInput {
  seriesTitle: string;
  /** Mihon's name for the source, e.g. "MangaDex (EN)" — the folder above the manga. */
  sourceName: string;
  chapterName: string;
  scanlator?: string | null;
  /** The chapter's URL, only consulted when `hash` is on. */
  url?: string | null;
  disallowNonAscii?: boolean;
  hash?: boolean;
}

/** The path below the chosen folder, as Mihon would have written it. */
export function chapterSegments(input: ExportChapterInput, withCbz = true): string[] {
  const chapter = mihonChapterDirName({
    name: input.chapterName,
    scanlator: input.scanlator,
    url: input.url,
    disallowNonAscii: input.disallowNonAscii === true,
    hash: input.hash === true,
  });
  return [
    mihonSourceDirName(input.sourceName, input.disallowNonAscii === true),
    mihonMangaDirName(input.seriesTitle, input.disallowNonAscii === true),
    withCbz ? `${chapter}.cbz` : chapter,
  ];
}

/** The page name inside the archive: 001.jpg, 002.jpg … so a name-sorting reader agrees with us. */
export function pageName(index: number, extension: string): string {
  return `${String(index + 1).padStart(3, "0")}.${extension}`;
}

function extensionOf(blob: Blob, fallback = "jpg"): string {
  const type = blob.type.toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  if (type.includes("avif")) return "avif";
  if (type.includes("bmp")) return "bmp";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  return fallback;
}

/** Pages, in order, as a CBZ. */
export async function pagesToCbz(pages: ReadonlyArray<Blob>): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error("this chapter has no downloaded pages to export");
  const entries: ZipEntry[] = [];
  for (const [index, page] of pages.entries()) {
    entries.push({ name: pageName(index, extensionOf(page)), bytes: new Uint8Array(await page.arrayBuffer()) });
  }
  return writeZip(entries);
}

export interface ExportResult {
  written: string[];
  skipped: string[];
}

/**
 * Write one chapter's downloaded pages into Mihon's tree.
 *
 * Addressed by chapter id, so the caller does not have to know how our pages are stored: the download
 * pages are the source, and a chapter with none is skipped with its name rather than written empty.
 */
export async function exportChapter(
  store: LibraryStore,
  chapterId: string,
  input: ExportChapterInput,
  writer: MihonWriter,
): Promise<Blob | null> {
  const rows = await store.listDownloadPages(chapterId);
  if (rows.length === 0) return null;
  const ordered = [...rows].sort((one, two) => one.index - two.index).map((row) => row.blob);
  const cbz = await pagesToCbz(ordered);
  const segments = chapterSegments(input);
  await writer.write({ segments, base64: toBase64(cbz) });
  return new Blob([cbz.buffer as ArrayBuffer], { type: "application/zip" });
}

/** Bytes → base64, chunked so a large archive does not blow the argument limit of a spread. */
export function toBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let at = 0;
  for (; at + 2 < bytes.length; at += 3) {
    const chunk = ((bytes[at] as number) << 16) | ((bytes[at + 1] as number) << 8) | (bytes[at + 2] as number);
    out += alphabet[(chunk >> 18) & 63];
    out += alphabet[(chunk >> 12) & 63];
    out += alphabet[(chunk >> 6) & 63];
    out += alphabet[chunk & 63];
  }
  const left = bytes.length - at;
  if (left === 1) {
    const chunk = (bytes[at] as number) << 16;
    out += `${alphabet[(chunk >> 18) & 63]}${alphabet[(chunk >> 12) & 63]}==`;
  } else if (left === 2) {
    const chunk = ((bytes[at] as number) << 16) | ((bytes[at + 1] as number) << 8);
    out += `${alphabet[(chunk >> 18) & 63]}${alphabet[(chunk >> 12) & 63]}${alphabet[(chunk >> 6) & 63]}=`;
  }
  return out;
}
