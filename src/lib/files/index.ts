/**
 * Opening the file the user picked: a CBZ/ZIP, a CBR, or a PDF.
 *
 * All three are lazy in the same way — the book knows how many pages it has, and hands out one page
 * when the reader asks. A CBZ keeps its bytes and inflates a single entry per page; a CBR does the
 * same through a wasm decoder; a PDF asks pdf.js to draw one page onto a canvas. None keeps a decoded
 * page alive after the caller drops it.
 */
import { kindOf, mimeOf, pageEntries, type ComicBook, type PageRequest } from "./comic";
import { openRar } from "./rar";
import { openZip } from "./zip";

export { kindOf, titleFromFile, extensionOf, naturalCompare, pageEntries } from "./comic";
export type { ComicBook, PageRequest } from "./comic";
export { coverFromBook, coverKey, isCoverKey, keepCover, shrinkToCover } from "./cover";

/**
 * The widest a PDF page is drawn, in pixels.
 *
 * A phone at 3x asks for about 1200 px of page; 2400 leaves room for a pinch without turning a
 * full-page scan into a canvas the size of a small poster.
 */
const PAGE_MAX_WIDTH = 2400;

/** A RAR of images — every `.cbr` — read one entry at a time through the wasm decoder. */
async function openRarBook(blob: Blob, name: string, decoder?: () => Promise<ArrayBuffer>): Promise<ComicBook> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const rar = await openRar(bytes, decoder === undefined ? {} : { wasm: decoder });
  const pages = pageEntries(rar.names);
  if (pages.length === 0) throw new Error(`${name} has no page images in it`);

  return {
    kind: "cbr",
    pageCount: pages.length,
    async open(index: number): Promise<Blob> {
      const entry = pages[index];
      if (entry === undefined) throw new Error(`page ${index + 1} is past the end of ${name}`);
      const data = await rar.read(entry);
      // `slice()` gives the Blob its own copy of the bytes, so nothing is pinned in the decoder's heap.
      return new Blob([data.slice().buffer], { type: mimeOf(entry) });
    },
    close(): void {
      // Nothing is held between pages: the archive's bytes are the caller's, and one entry is
      // decompressed per page.
    },
  };
}

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
 * Draw a page that is one image and nothing else; say whether it did.
 *
 * Every scanned comic PDF is this shape: `save`, `transform`, `dependency`, `paintImageXObject`,
 * `restore`. Drawing that image is a `drawImage` onto the canvas — milliseconds. pdf.js's renderer
 * does the same work but does not *finish* on these documents in WebKit, so the image is taken from
 * the page's own object cache and drawn here. A page with text, paths or several images answers
 * `false` and is left to the renderer, which is what knows how to draw those.
 */
async function drawSingleImagePage(
  pdfjs: { OPS: Record<string, number> },
  page: { getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>; objs: { get(name: string, cb: (value: unknown) => void): void } },
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): Promise<boolean> {
  const { fnArray, argsArray } = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  // What a single-image page is allowed to contain besides the image itself.
  const allowed = new Set([
    OPS.save,
    OPS.restore,
    OPS.transform,
    OPS.setLineWidth,
    OPS.setHScale,
    OPS.setLeading,
    OPS.dependency,
    OPS.beginMarkedContent,
    OPS.beginMarkedContentProps,
    OPS.endMarkedContent,
  ]);
  let painted: string | null = null;
  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    if (fn === OPS.paintImageXObject) {
      if (painted !== null) return false;
      const args = argsArray[i] as [string, number, number];
      painted = args[0];
      continue;
    }
    if (!allowed.has(fn)) return false;
  }
  if (painted === null) return false;

  const image = await new Promise<{ bitmap?: ImageBitmap; data?: Uint8ClampedArray } | null>((resolve) => {
    page.objs.get(painted, (value: unknown) => resolve(value as { bitmap?: ImageBitmap; data?: Uint8ClampedArray } | null));
  });
  if (image === null) return false;
  let source: ImageBitmap | null = image.bitmap ?? null;
  if (source === null && image.data !== undefined) {
    // A JPEG's own bytes are a picture already; copy them into a fresh buffer so the Blob owns what
    // it reads — pdf.js hands back a view into a buffer it may reuse.
    const bytes = new Uint8Array(image.data.length);
    bytes.set(image.data);
    source = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" })).catch(() => null);
  }
  if (source === null) return false;

  const ratio = source.width / source.height;
  if (Math.abs(ratio - width / height) > 0.06) return false;
  context.drawImage(source, 0, 0, width, height);
  return true;
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
    async open(index: number, request: PageRequest = {}): Promise<Blob> {
      const page = await pdf.getPage(index + 1);
      // A comic PDF is a scan, so drawing at twice the CSS size keeps it sharp without guessing DPI
      // — but that is the reader's need. A cover asks for a cover's width, and a scan exported with
      // its page box in pixels would otherwise be drawn 5100 px wide to become a 400 px tile.
      const natural = page.getViewport({ scale: 1 });
      // A page asked for by the reader is drawn at most `PAGE_MAX_WIDTH` px wide. Two things meet
      // here: a scan whose page box is stated in points (`612 x 792`) needs more than 1:1 to be
      // sharp on a 3x phone, and a scan whose page box is already in pixels (2550 x 3300) must not be
      // doubled — that is a 33-megapixel canvas, which took over ninety seconds and drew nothing.
      const wanted = request.maxWidth ?? PAGE_MAX_WIDTH;
      const scale = Math.min(2, wanted / natural.width);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("this browser cannot draw a PDF page");
      // A scanned page is one image and nothing else, and pdf.js's own renderer does not finish on
      // those in WebKit — measured: the operator list resolves, the page image is in hand, drawing it
      // takes 8 ms, and `page.render().promise` never settles. So a page that is a single image is
      // drawn here, and only a page with text or paths is handed to the renderer.
      const drawn = await drawSingleImagePage(pdfjs, page, context, canvas.width, canvas.height);
      if (drawn === false) await page.render({ canvas, viewport }).promise;
      page.cleanup();
      const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (image === null) throw new Error(`page ${index + 1} of ${name} could not be drawn`);
      return image;
    },
    close(): void {
      // An import that gave up on the cover leaves this render running; `destroy()` ends the worker
      // underneath it, and the abandoned promise must not surface as an unhandled rejection.
      void task.destroy().catch(() => {});
    },
  };
}

export interface OpenOptions {
  /**
   * Where the RAR decoder's bytes come from.
   *
   * Left out in the app, where Vite's emitted file is fetched once. A test passes the same bytes off
   * disk, because the test runner has no asset pipeline.
   */
  wasm?: () => Promise<ArrayBuffer>;
}

/** Open a file the user picked, or say plainly that it is not a comic this app can read. */
export async function openComic(blob: Blob, name: string, options: OpenOptions = {}): Promise<ComicBook> {
  const kind = kindOf(name);
  if (kind === "cbz") return openZipBook(blob, name);
  if (kind === "cbr") return openRarBook(blob, name, options.wasm);
  if (kind === "pdf") return openPdfBook(blob, name);
  throw new Error(`${name} is not a comic file — this reads CBZ, CBR, ZIP and PDF`);
}
