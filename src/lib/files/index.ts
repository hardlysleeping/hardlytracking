/**
 * Opening the file the user picked: a CBZ/ZIP, or a PDF.
 *
 * Both are lazy in the same way — the book knows how many pages it has, and hands out one page when
 * the reader asks. A CBZ keeps its bytes and inflates a single entry per page; a PDF asks pdf.js to
 * draw one page onto a canvas. Neither keeps a decoded page alive after the caller drops it.
 */
import { kindOf, mimeOf, pageEntries, type ComicBook } from "./comic";
import { openZip } from "./zip";

export { kindOf, titleFromFile, extensionOf, naturalCompare, pageEntries } from "./comic";
export type { ComicBook } from "./comic";

/** A CBZ/ZIP of images, read one entry at a time. */
async function openZipBook(blob: Blob, name: string): Promise<ComicBook> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const zip = openZip(bytes);
  const pages = pageEntries(zip.names);
  if (pages.length === 0) throw new Error(`${name} has no page images in it`);

  return {
    kind: "cbz",
    pageCount: pages.length,
    async open(index: number): Promise<Blob> {
      const entry = pages[index];
      if (entry === undefined) throw new Error(`page ${index + 1} is past the end of ${name}`);
      const data = zip.read(entry);
      // `slice()` gives the Blob its own copy of the bytes, so the archive can be dropped afterwards.
      return new Blob([data.slice().buffer], { type: mimeOf(entry) });
    },
    close(): void {
      // Nothing is held: every page is inflated on demand.
    },
  };
}

/**
 * A PDF, drawn page by page.
 *
 * pdf.js is imported lazily: it is over a megabyte and a comic that is a CBZ must never pay for it.
 */
async function openPdfBook(blob: Blob, name: string): Promise<ComicBook> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const data = new Uint8Array(await blob.arrayBuffer());
  // `destroy()` lives on the loading task, not on the document proxy.
  const task = pdfjs.getDocument({ data });
  const pdf = await task.promise;

  return {
    kind: "pdf",
    pageCount: pdf.numPages,
    async open(index: number): Promise<Blob> {
      const page = await pdf.getPage(index + 1);
      // A comic PDF is a scan, so drawing at twice the CSS size keeps it sharp without guessing DPI.
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("this browser cannot draw a PDF page");
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      page.cleanup();
      const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (image === null) throw new Error(`page ${index + 1} of ${name} could not be drawn`);
      return image;
    },
    close(): void {
      void task.destroy();
    },
  };
}

/** Open a file the user picked, or say plainly that it is not a comic this app can read. */
export async function openComic(blob: Blob, name: string): Promise<ComicBook> {
  const kind = kindOf(name);
  if (kind === "cbz") return openZipBook(blob, name);
  if (kind === "pdf") return openPdfBook(blob, name);
  throw new Error(`${name} is not a comic file — this reads CBZ, ZIP and PDF`);
}
