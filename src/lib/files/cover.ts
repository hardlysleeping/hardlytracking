/**
 * The cover of a book that is a file on this device.
 *
 * A book from a source has a thumbnail URL. A book the user owns has page 1 and nothing else, so
 * without this the shelf draws the title in a box while every other shelf draws a picture — which
 * reads as a broken import, not as a missing feature. So page 1 is drawn once, at import, and kept in
 * the image cache under a key that needs no network and no file: `book:<series id>#cover`.
 *
 * It is shrunk on the way in. A comic scan is a 300 KB JPEG; four hundred of those is 120 MB of a
 * cache whose whole ceiling is 256 MB, and a shelf that evicts its own covers then falls back to the
 * title again. 400 px wide is twice a large tile at 2×, and lands around 40 KB.
 */
import { imageCache, STORED_IMAGE_SCHEME } from "../cache/images";
import type { ComicBook } from "./comic";

/** Wide enough for a large tile on a phone at 2×, and nothing more. */
export const COVER_WIDTH = 400;

/** The key a book's cover is filed under: not a URL, and never fetched. */
export function coverKey(seriesId: string): string {
  return `${STORED_IMAGE_SCHEME}${seriesId}#cover`;
}

/** Whether a cover string is one of these, rather than something to fetch. */
export function isCoverKey(cover: string | undefined): boolean {
  return cover !== undefined && cover.startsWith(STORED_IMAGE_SCHEME);
}

/**
 * One page as a cover, or `null` when this browser cannot draw it.
 *
 * `null` is not a failure the caller must report: the book opens either way, and a cover that could
 * not be made leaves the shelf exactly as it was before this feature existed.
 */
export async function shrinkToCover(page: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  const bitmap = await createImageBitmap(page);
  try {
    // Never upscale: a 200 px webcomic strip behind a blurred 400 px cover looks worse than itself.
    const scale = Math.min(1, COVER_WIDTH / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  } finally {
    bitmap.close();
  }
}

/** Page 1 of an open book, as a cover. */
export async function coverFromBook(book: ComicBook): Promise<Blob | null> {
  return await shrinkToCover(await book.open(0));
}

/**
 * Keep a cover and hand back the key to store on the row.
 *
 * `""` means "no cover": nothing was drawn, or there is no database to keep it in. The caller then
 * writes no cover at all, which is the old behaviour rather than a key that resolves to nothing.
 */
export async function keepCover(seriesId: string, picture: Blob | null): Promise<string> {
  if (picture === null) return "";
  const key = coverKey(seriesId);
  return (await imageCache.remember(key, picture)) ? key : "";
}
