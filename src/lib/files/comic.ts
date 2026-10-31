/**
 * A comic file on this device: a CBZ/ZIP or CBR of images, or a PDF.
 *
 * The rule that shapes this module: **a book is opened, never unpacked.** A 400-page CBZ is a few
 * hundred megabytes of scans, and turning that into four hundred blobs up front is how a reader
 * fills a phone with decoded pages before anyone scrolls. So a `ComicBook` knows its page count and
 * hands out one page at a time, and the caller releases each one when the reader has moved past it.
 *
 * Page order comes from the file names, sorted naturally (`p2` before `p10`), not from the order the
 * zip happens to store them in — uploaders append pages as they scan, so archive order is not
 * reading order.
 */

/** The image types a comic archive realistically holds. */
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"];

export interface ComicBook {
  /** `cbz` for a zip of images, `cbr` for a RAR of them, `pdf` for a PDF. */
  kind: "cbz" | "cbr" | "pdf";

  pageCount: number;
  /** One page as an image blob, in reading order. */
  open(index: number): Promise<Blob>;
  /** Release anything the book is holding; safe to call twice. */
  close(): void;
}

/** A title from a file name: no extension, no `_`/`%20` noise, trimmed. */
export function titleFromFile(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const noExtension = base.replace(/\.[^.]+$/, "");
  return noExtension.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim() || base;
}

/** The extension of a file name, lowercased, with its dot (`".cbz"`), or `""`. */
export function extensionOf(name: string): string {
  const match = /\.[^.\\/]+$/.exec(name);
  return match === null ? "" : match[0].toLowerCase();
}

/** What a file is, by its name — `null` when it is not a comic this app can read. */
export function kindOf(name: string): "cbz" | "cbr" | "pdf" | null {
  const extension = extensionOf(name);
  if (extension === ".cbz" || extension === ".zip") return "cbz";
  // `.cbr` is a RAR with a comic's name on it. The extension is the only signal a file picker gives,
  // and a `.cbr` is never anything but a RAR, so the name is enough to choose the decoder.
  if (extension === ".cbr") return "cbr";
  if (extension === ".pdf") return "pdf";
  return null;
}

/**
 * Natural sort: `page 2` before `page 10`.
 *
 * A plain `localeCompare` puts "10" before "2", which silently reorders a whole chapter — the bug
 * looks like a corrupt archive, not like a comparator.
 */
export function naturalCompare(a: string, b: string): number {
  const left = a.match(/(\d+|\D+)/g) ?? [];
  const right = b.match(/(\d+|\D+)/g) ?? [];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const one = left[i];
    const two = right[i];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    const oneIsNumber = /^\d+$/.test(one);
    const twoIsNumber = /^\d+$/.test(two);
    if (oneIsNumber && twoIsNumber) {
      const difference = Number(one) - Number(two);
      if (difference !== 0) return difference;
      continue;
    }
    const difference = one.localeCompare(two, undefined, { sensitivity: "base" });
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The image entries of an archive, in reading order. */
export function pageEntries(names: ReadonlyArray<string>): string[] {
  return names
    .filter((name) => !name.endsWith("/") && IMAGE_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension)))
    .sort(naturalCompare);
}

/** A MIME type from an extension, for the blob the reader draws. */
export function mimeOf(name: string): string {
  const extension = extensionOf(name);
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".avif") return "image/avif";
  if (extension === ".bmp") return "image/bmp";
  return "image/jpeg";
}
