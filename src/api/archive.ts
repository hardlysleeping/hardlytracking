/**
 * Internet Archive as a source.
 *
 * HardlyReading's archive.org reading path (`~/apps/HardlyReading/engine.py`) brought into the seam:
 * search `advancedsearch.php`, read `metadata/{id}`, and stream pages. What archive.org looks like
 * up close, and what this file is built around:
 *
 * 1. **Two kinds of item.** A scanned book has *leaves*, addressed as
 *    `/download/{id}/page/n{i}_w{w}.jpg`, with a length that comes from `imagecount`. A *bundle* —
 *    one item holding forty-one CBZ volumes — has no leaves at all: that same route answers **200
 *    with the same placeholder for every index, forever**. A client that trusts it shows one page
 *    and a Next button that never moves. So a bundle's chapters are its book files, and a book's
 *    pages are that file's zip members (`/download/{id}/{file.cbz}/{member.jpg}`), listed by the
 *    zip's own directory page.
 * 2. **Length is stated, never probed.** Pages past the end are not a 404, so "fetch until it
 *    fails" never fails. `imagecount`/`page_count` are used when present, a zip's member list is
 *    the count for a bundle, and when neither exists the provider says so instead of inventing a
 *    total that would show a blank page mid-chapter.
 * 3. **`title`, `creator` and `description` are sometimes strings and sometimes arrays.** Arrays are
 *    normal, not an error, so each is flattened at the boundary and never reaches the UI.
 * 4. **The default search is full-text.** Asking for `berserk` matches items that merely mention it,
 *    so queries are scoped to `mediatype:texts` and rows without an identifier are dropped rather
 *    than rendered as untitled, unopenable cards.
 * 5. **A zip's members live in its own listing page, and the page is HTML that may become unreadable
 *    halfway.** The listing is a 302 to a storage node, and a refusing node answers 403/503 with no
 *    `Access-Control-Allow-Origin`, which a browser can only report as "Failed to fetch" — the status
 *    is lost. So the listing is the one call here that must name its own failure instead of letting
 *    the browser's message reach the reader, and the members are read out of the HTML carefully: a
 *    zip that keeps its pages in a folder (`Sports-Illustrated/page001.jpg`) is ordinary, not junk.
 *    Nothing else can enumerate a zip without downloading it — `/page/n{i}` answers 404 for a book
 *    file, metadata lists the volume but not what is inside it, and a range read of the bytes is
 *    refused by CORS.
 *
 * Progress is ours (`ownsProgress: true`): archive.org has no read-state API for these items, and a
 * mark we cannot write is a mark we must not pretend to have written.
 */
import {
  joinId,
  nativeId,
  paged,
  type Chapter,
  type Page,
  type Paged,
  type Series,
  type Source,
  type SourceProvider,
} from "./source";
import { BOOK_DEADLINE_MS, RUNTIME_DEADLINE_MS, DeadlineError, deadlined, withDeadline } from "../lib/deadline";
import { apiUrl, hasLocalServer, withToken } from "../lib/host";
import { openComic, kindOf } from "../lib/files/index";
import type { LibraryStore } from "../lib/db/store";

export const ARCHIVE_BASE = "https://archive.org";

/** One source, because archive.org is one corpus; the collections are the query, not the source. */
export const ARCHIVE_SOURCE: Source = {
  id: "archive:src:texts",
  provider: "archive",
  name: "Internet Archive",
  lang: "en",
  supportsLatest: true,
  baseUrl: ARCHIVE_BASE,
  /**
   * Trending first, because Popular is sorted by *all-time* downloads and therefore reads the same
   * list for months — the one row on this page that never appeared to change. Trending sorts by
   * downloads in the last week, Popular keeps the all-time list, Latest keeps new uploads.
   */
  browseTabs: ["trending", "popular", "latest"],
};

/** Leaf width for streamed pages. 1200 is legible on a phone at 3x without pulling the 2 MB scan. */
export const ARCHIVE_PAGE_WIDTH = 1200;

/** Collections that actually hold readable comics and magazines, not every text on the site. */
const COMIC_COLLECTIONS = ["comicbooks", "comics", "magazine_rack", "pulpmagazinearchive"];

/**
 * A row must carry a file the reader can actually open.
 *
 * The collections are a shelf's label, not a promise: `comicbooks` holds scanned newsletters and
 * text-only uploads beside the comics, and a row with only EPUB/Daisy/TXT derivatives opens onto a
 * blank page. Requiring one of these formats keeps a comic, a magazine, a CBZ/CBR bundle, a PDF of
 * scans or a loose-image scan, and drops the text-only uploads — measured against the live corpus:
 * 737 015 rows with no format rule, 417 430 with this one, and every magazine and comic in the
 * first page of both survived it.
 *
 * `Text PDF` is deliberately absent: it is the one label shared by comics and by plain prose, so
 * keeping it lets a light novel back in, which is exactly the "random docs" this is for.
 */
const READABLE_FORMATS = ["Comic Book ZIP", "Comic Book RAR", "Comic Book", "Image Container PDF", "JPEG", "JPEG 2000"];

/** The format clause, as archive.org's own query syntax spells it. */
const READABLE_CLAUSE = `format:(${READABLE_FORMATS.map((format) => `"${format}"`).join(" OR ")})`;

/** Fields asked of `advancedsearch.php`. Asking for fewer makes rows poorer, not faster. */
const SEARCH_FIELDS = ["identifier", "title", "creator", "year", "description", "downloads", "mediatype"];

/** A hard ceiling on one chapter: some dumps are thousands of leaves and the reader cannot preload it. */
export const ARCHIVE_MAX_PAGES = 600;


export interface ArchiveProviderOptions {
  fetchImpl?: typeof fetch;
  base?: string;
  /**
   * Whether the built-in extension is enabled.
   *
   * A disabled extension is not offered — `sources()` answers with nothing, exactly as a disabled
   * dalvik extension does — but a *read* of something already in the library still works, because
   * turning an extension off should not make a saved book unopenable.
   */
  enabled?: () => boolean;
  /**
   * Where a downloaded book is kept, so the second read is offline and instant.
   *
   * An archive item is a PDF or a CBR — there is no page listing to walk (a per-file directory
   * answers 404 today), so a volume is read by fetching it once and opening it exactly like a file
   * the user owns. Left out (tests, and any caller that only wants the catalogue), volumes download
   * into a small in-memory cache instead.
   */
  store?: LibraryStore;
}

/** archive.org's own list-vs-string habit, flattened once here so nothing downstream has to know. */
export function firstOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = firstOf(entry);
      if (text !== "") return text;
    }
  }
  return "";
}

/** HTML descriptions arrive with tags and entities; a card shows the sentence, not the markup. */
export function plainText(value: unknown): string {
  const raw = firstOf(value);
  if (raw === "") return "";
  return raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A description that only repeats the title reads as a rendering bug, so it is dropped.
 *
 * Straight from HardlyReading: a card with no blurb looks deliberate, a card whose blurb is its own
 * title looks broken.
 */
export function usefulDescription(value: unknown, title: string): string {
  const text = plainText(value);
  if (text === "") return "";
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(text) === norm(title) ? "" : text;
}

/** The scoped query for a browse/search request. `sort` is archive.org's own `field dir` syntax. */
export function buildQuery(input: { query?: string; sort?: string; collections?: string[] } = {}): URLSearchParams {
  const collections = input.collections ?? COMIC_COLLECTIONS;
  const scope =
    collections.length === 0
      ? `mediatype:texts AND ${READABLE_CLAUSE}`
      : `mediatype:texts AND (${collections.map((c) => `collection:${c}`).join(" OR ")}) AND ${READABLE_CLAUSE}`;
  const term = (input.query ?? "").trim();
  // A quote in the term would end the phrase and let the user add clauses; strip it rather than
  // letting a search box become a query builder.
  const safe = term.replace(/"/g, " ").replace(/\s+/g, " ").trim();
  const params = new URLSearchParams();
  params.set("q", safe === "" ? scope : `(${scope}) AND (${safe})`);
  for (const field of SEARCH_FIELDS) params.append("fl[]", field);
  params.set("rows", "30");
  params.set("output", "json");
  params.set("sort[]", input.sort ?? "-downloads");
  return params;
}

interface SearchDoc {
  identifier?: unknown;
  title?: unknown;
  creator?: unknown;
  year?: unknown;
  description?: unknown;
  downloads?: unknown;
}

/** One search row as the seam's `Series`, or `null` when there is nothing openable in it. */
export function rowToSeries(doc: SearchDoc): Series | null {
  const identifier = firstOf(doc.identifier);
  if (identifier === "") return null;
  const title = firstOf(doc.title) || identifier;
  const creator = firstOf(doc.creator);
  const description = usefulDescription(doc.description, title);
  const year = firstOf(doc.year);
  return {
    id: joinId("archive", identifier),
    provider: "archive",
    title,
    cover: `${ARCHIVE_BASE}/services/img/${encodeURIComponent(identifier)}`,
    url: `${ARCHIVE_BASE}/details/${encodeURIComponent(identifier)}`,
    ...(creator === "" ? {} : { author: creator }),
    ...(description === "" ? {} : { description }),
    ...(year === "" ? {} : { status: `Published ${year}` }),
  };
}

/** `metadata/{id}` reduced to what the app asks for. */
export interface ItemMetadata {
  identifier: string;
  title: string;
  creator: string;
  description: string;
  /** Leaves the item exposes, or `null` when archive.org does not say. */
  leafCount: number | null;
  /** Files a reader can open as a volume, in the order archive.org lists them. */
  books: BookFile[];
}

export interface BookFile {
  name: string;
  format: string;
  extension: string;
  size: number;
}

/**
 * Which volume a file is, ignoring how it was packed.
 *
 * "[space]TITANS N°1 .cbz" and "TITANS N°1.pdf" are one volume: padding, the space before the
 * extension, the extension itself and the `_text` OCR derivative are not part of the identity. The
 * raw name is only needed for the download URL. Without the final trim the padded copy keys as
 * "titans n°1 " and the plain one as "titans n°1", and the same volume appears twice.
 */
export function volumeKey(name: string): string {
  return name
    .trim()
    .replace(/\.[^.]+$/, "")
    .replace(/_text$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The volume files in reading order.
 *
 * archive.org lists a collection's files lexicographically, which is not reading order: "TITANS
 * N°1, N°10, N°100, N°101" is what a plain sort gives, and numbering chapters from that made issue 10
 * the second issue on both the series page and the search card — the number was ours, so "sort by
 * number" could not repair it. Natural order compares the digits as digits.
 */
export function naturalBookOrder(books: readonly BookFile[]): BookFile[] {
  return [...books].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * How long one volume may take to arrive before the reader gives up on it.
 *
 * A scanned volume is 10-60 MB. Thirty seconds — the deadline every runtime call uses — is a
 * sensible limit on a JSON answer and an unreasonable one on a 40 MB scan over a phone connection,
 * so this is the one call with its own, longer limit. It is still a limit: waiting four minutes for
 * a page to appear is worse than being told the archive did not send it.
 */
export const BOOK_DOWNLOAD_DEADLINE_MS = BOOK_DEADLINE_MS;

/** A volume, opened: enough for the reader to ask for page N without knowing where it came from. */
export interface ArchivedBook {
  name: string;
  pageCount: number;
  open(index: number): Promise<Blob>;
}

/**
 * The fetch a volume download uses.
 *
 * The provider's own `fetchImpl` is `deadlined(...)` at thirty seconds, which is right for metadata
 * and wrong for a 40 MB scan; the volume download is raced against `BOOK_DOWNLOAD_DEADLINE_MS`
 * instead, through the same `withDeadline` the rest of the app uses. An injected `fetchImpl` is used
 * as it is — a caller that brought its own (a test, an app with a custom transport) owns its limits.
 */

/**
 * The URL a volume's bytes come from.
 *
 * `/download/<id>/<file>` is the file itself, and unlike the per-file *directory* it answers 200.
 * Through a browser page it is still cross-origin, so with a server of our own the bytes come
 * through `/api/file`; a packaged app fetches it directly.
 */
export function bookUrl(base: string, identifier: string, book: string, proxied = hasLocalServer()): string {
  const direct = `${base}/download/${encodeURIComponent(identifier)}/${encodeURIComponent(book)}`;
  return proxied ? withToken(apiUrl(`/api/file?url=${encodeURIComponent(direct)}`)) : direct;
}

export function chapterNameOf(fileName: string, taken: ReadonlySet<string> = new Set()): string {
  const cleaned = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return "Complete book";
  if (!taken.has(cleaned)) return cleaned;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${cleaned} (${suffix})`;
    if (!taken.has(candidate)) return candidate;
  }
  return cleaned;
}

/**
 * What counts as a book file.
 *
 * The extension is the reliable half: archive.org's `format` labels are human strings ("Comic Book
 * ZIP", "Text PDF", "JPEG ZIP") and matching on them alone both misses real books and accepts leaf
 * dumps that are not books at all. The `zip` extension is deliberately absent — an item's `_jp2.zip`
 * or `_jpeg.zip` is the scan behind the pages, not a downloadable book.
 */
const BOOK_EXTENSIONS = ["cbz", "cbr", "cbt", "pdf"];
const BOOK_FORMATS = ["comic book zip", "comic book rar", "text pdf", "comic book"];

function positiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseInt(firstOf(value), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, ARCHIVE_MAX_PAGES) : null;
}

/**
 * Read the item's own statement of its length.
 *
 * `imagecount` is the one field that answers this directly; `page_count`/`pagecount` appear on
 * newer derivatives. When none is present the answer is `null` — the caller may then ask for the
 * page index, and if that fails too the reader shows an honest "unknown" total.
 */
export function metadataToItem(identifier: string, body: unknown): ItemMetadata {
  const record = (body ?? {}) as Record<string, unknown>;
  const md = (record.metadata ?? {}) as Record<string, unknown>;
  const files = Array.isArray(record.files) ? (record.files as Record<string, unknown>[]) : [];

  const leafCount =
    positiveInt(md.imagecount) ?? positiveInt(md.page_count) ?? positiveInt(md.pagecount) ?? positiveInt(record.imagecount);

  const books: BookFile[] = [];
  const seenBase = new Map<string, BookFile>();
  for (const file of files) {
    // The name is used *as a URL* as well as a label: archive.org stores `" TITANS N°1 .cbz"` with a
    // leading space, and `/download/<id>/<name>` answers 404 without it. Trimming here silently
    // broke every volume on such an item, so only the emptiness check trims.
    const name = typeof file.name === "string" ? file.name : firstOf(file.name);
    if (name.trim() === "" || !name.includes(".")) continue;
    const extension = (name.split(".").pop() ?? "").toLowerCase();
    const format = (firstOf(file.format) || extension).toLowerCase();
    const isBook = BOOK_EXTENSIONS.includes(extension) || BOOK_FORMATS.some((known) => format.startsWith(known));
    if (!isBook) continue;
    const size = Number.parseInt(firstOf(file.size), 10);
    const book: BookFile = { name, format, extension, size: Number.isFinite(size) ? size : 0 };
    // An item usually ships each volume more than once: a `.cbz` and a `.pdf` of the same scan, and
    // often a `_text.pdf` beside the plain one — the same pages with an OCR layer, re-encoded as
    // JPEG 2000 and JBIG2. Two rows for one volume reads as a duplicate, so a volume keeps the copy
    // that is cheapest to read: a zip (unpacked entry by entry, nothing decoded), then the plain
    // PDF (its scans are JPEG), and the `_text` derivative only when it is all there is — pdf.js
    // decodes JPEG 2000 in JavaScript, which is minutes per page rather than milliseconds.
    const base = volumeKey(name);
    const existing = seenBase.get(base);
    if (existing === undefined) {
      seenBase.set(base, book);
      continue;
    }
    if (volumeRank(book) > volumeRank(existing)) seenBase.set(base, book);
  }
  books.push(...seenBase.values());

  const title = firstOf(md.title) || identifier;
  return {
    identifier,
    title,
    creator: firstOf(md.creator),
    description: usefulDescription(md.description, title),
    leafCount,
    books,
  };
}

/**
 * How good a volume is to read, best last.
 *
 * A zip needs no decoder; a plain PDF's scans are JPEG, which pdf.js draws straight onto the canvas;
 * a `_text` PDF holds the same scans as JPEG 2000 and JBIG2, which pdf.js decodes in JavaScript.
 */
function volumeRank(book: BookFile): number {
  if (book.extension === "cbz" || book.extension === "zip" || book.extension === "cbr") return 3;
  if (/^application\/(vnd\.comicbook\+zip|x-cbz)/i.test(book.format)) return 3;
  if (book.extension === "pdf") return 2;
  return 1;
}

/**
 * The leaf count from the page index, when metadata is silent.
 *
 * `_hocr_pageindex.json.gz` is a few hundred bytes and `_page_numbers.json` a few kB — both far
 * cheaper than downloading anything, and both list one row per leaf in reading order.
 */
export async function pageIndexCount(fetchImpl: typeof fetch, base: string, identifier: string, files: string[]): Promise<number | null> {
  const name = files.find((file) => file.toLowerCase().endsWith("_page_numbers.json"));
  if (name === undefined) return null;
  const url = `${base}/download/${encodeURIComponent(identifier)}/${encodeURIComponent(name)}`;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const rows = Array.isArray(body)
      ? body
      : typeof body === "object" && body !== null && Array.isArray((body as { pages?: unknown[] }).pages)
        ? ((body as { pages: unknown[] }).pages as unknown[])
        : null;
    if (rows === null) return null;
    return rows.length === 0 ? null : Math.min(rows.length, ARCHIVE_MAX_PAGES);
  } catch {
    return null;
  }
}

/** One page of a streamed book. `n{i}` is archive.org's leaf selector, not a page number it will
 *  bound-check for us — the count above is what keeps the reader from walking past the end. */
export function pageUrl(identifier: string, index: number, width = ARCHIVE_PAGE_WIDTH): string {
  return `${ARCHIVE_BASE}/download/${encodeURIComponent(identifier)}/page/n${Math.max(0, Math.floor(index))}_w${width}.jpg`;
}

/** `archive:ch:<identifier>:<book>` — a scanned item's single chapter carries an empty book. */
export function chapterId(identifier: string, book: string): string {
  return joinId("archive", `ch:${encodeURIComponent(identifier)}:${encodeURIComponent(book)}`);
}

export function parseChapterId(native: string): { identifier: string; book: string } | null {
  if (!native.startsWith("ch:")) return null;
  const parts = native.slice(3).split(":");
  if (parts.length !== 2) return null;
  const identifier = decodeURIComponent(parts[0]);
  const book = decodeURIComponent(parts[1]);
  return identifier === "" ? null : { identifier, book };
}

export function createArchiveProvider(options: ArchiveProviderOptions = {}): SourceProvider {
  // archive.org is usually quick and occasionally not; a stalled `advancedsearch.php` used to leave
  // the search screen with no spinner and no way forward.
  const fetchImpl = options.fetchImpl ?? deadlined(fetch, RUNTIME_DEADLINE_MS, "the Internet Archive");
  const base = (options.base ?? ARCHIVE_BASE).replace(/\/+$/, "");
  const enabled = options.enabled ?? (() => true);
  const bookFetch = options.fetchImpl ?? ((url: string) => fetch(url));

  /**
   * Volumes in flight, and volumes already fetched in this session.
   *
   * Two things ask for the same book at once — the quick sheet's Read and the reader itself — and a
   * 40 MB scan must not be fetched twice for that reason. `pending` makes the second caller wait on
   * the first; the memory cache keeps a book that was read once readable without a store (tests, and
   * any build where the caller passed none).
   */
  const pendingBooks = new Map<string, Promise<ArchivedBook>>();
  const memoryBooks = new Map<string, Blob>();
  const MEMORY_BOOKS = 2;

  /**
   * A volume as a book this device can page through.
   *
   * archive.org has no page listing for a file: `/download/<id>/<book>/` answers 404 today, and the
   * item's metadata lists the volume but not what is inside it. So a volume is *downloaded* once and
   * opened exactly like a file the user owns — pdf.js for a PDF, the zip reader for a CBZ — which is
   * also the only way to read a PDF at all.
   */
  const book = async (identifier: string, name: string): Promise<ArchivedBook> => {
    const key = `${identifier}/${name}`;
    const stored = await options.store?.getBook(key);
    if (stored !== undefined) {
      if (stored.blob === undefined) throw new Error(`${stored.name} is not stored on this device`);
      const comic = await openComic(stored.blob, stored.name);
      return { name: stored.name, pageCount: comic.pageCount, open: (index) => comic.open(index) };
    }
    const running = pendingBooks.get(key);
    if (running !== undefined) return await running;

    const work = (async (): Promise<ArchivedBook> => {
      const remembered = memoryBooks.get(key);
      let blob = remembered;
      if (blob === undefined) {
        blob = await fetchBook(identifier, name);
        memoryBooks.set(key, blob);
        while (memoryBooks.size > MEMORY_BOOKS) {
          const oldest = memoryBooks.keys().next();
          if (oldest.done === true) break;
          memoryBooks.delete(oldest.value);
        }
      }
      const comic = await openComic(blob, name);
      if (options.store !== undefined) {
        await options.store.putBook({
          // Keyed by the volume, not the series: one item ships several, and each is its own file.
          seriesId: key,
          chapterId: key,
          name,
          kind: kindOf(name) ?? "pdf",
          pageCount: comic.pageCount,
          bytes: blob.size,
          blob,
          addedAt: Date.now(),
        });
      }
      return { name, pageCount: comic.pageCount, open: (index) => comic.open(index) };
    })();
    pendingBooks.set(key, work);
    try {
      return await work;
    } finally {
      pendingBooks.delete(key);
    }
  };

  /** The volume's bytes, with the long deadline and a sentence when it never lands. */
  const fetchBook = async (identifier: string, name: string): Promise<Blob> => {
    const url = bookUrl(base, identifier, name);
    let response: Response;
    try {
      response = await withDeadline(bookFetch(url), BOOK_DOWNLOAD_DEADLINE_MS, name);
    } catch (error) {
      if (error instanceof DeadlineError) {
        throw new Error(`${name} did not arrive from archive.org within ${Math.round(error.ms / 1000)} s`);
      }
      throw new Error(`${name} could not be fetched from archive.org: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new Error(`archive.org answered HTTP ${response.status} for ${name} — the item may be restricted`);
    }
    return await response.blob();
  };

  /**
   * Identifiers archive.org itself has denied to us in this session.
   *
   * The index keeps answering for an item that has been taken down or restricted: it appears in a
   * search page, often near the top, and only the metadata request discovers it is gone. Remembering
   * the refusal means the next list does not offer it again — a dead row cannot stay the first
   * result of a feed for as long as the app is open.
   */
  const gone = new Set<string>();

  const search = async (query: string, page: number, sort: string): Promise<Paged<Series>> => {
    const params = buildQuery({ query, sort });
    params.set("page", String(Math.max(1, Math.floor(page))));
    const response = await fetchImpl(`${base}/advancedsearch.php?${params.toString()}`);
    if (!response.ok) throw new Error(`archive.org search failed (HTTP ${response.status})`);
    const body = (await response.json()) as { response?: { docs?: SearchDoc[]; numFound?: number; start?: number } };
    const docs = body.response?.docs ?? [];
    const items = docs
      .map(rowToSeries)
      .filter((row): row is Series => row !== null)
      // An item archive.org has already refused is not a result, however recently it was indexed.
      .filter((row) => !gone.has(nativeId(row.id, "archive")));
    const start = body.response?.start ?? 0;
    const found = body.response?.numFound ?? 0;
    return paged(items, start + docs.length < found);
  };

  const item = async (identifier: string): Promise<ItemMetadata> => {
    const response = await fetchImpl(`${base}/metadata/${encodeURIComponent(identifier)}`);
    if (!response.ok) {
      // 404 and 403 are the two ways a taken-down item answers. Both are final for this session,
      // and both are named as what they are rather than as a transport failure.
      if (response.status === 404 || response.status === 403) {
        gone.add(identifier);
        throw new Error(
          `This item is no longer available from archive.org (HTTP ${response.status}). It has been hidden from the Archive's lists.`,
        );
      }
      throw new Error(`archive.org item ${identifier} failed (HTTP ${response.status})`);
    }
    return metadataToItem(identifier, await response.json());
  };

  return {
    kind: "archive",
    ownsProgress: true,

    async sources() {
      return enabled() ? [{ ...ARCHIVE_SOURCE }] : [];
    },

    /**
     * Downloads in the last week — archive.org's own `week` sort field, not a date filter of ours.
     *
     * This is the listing that moves: an item is here because people are reading it now, so the
     * first row of an Archive page changes day to day instead of once a season.
     */
    async trending(_sourceId, page) {
      return search("", page, "-week");
    },

    /** All-time downloads. Stable by definition, which is why it is no longer the first tab. */
    async popular(_sourceId, page) {
      return search("", page, "-downloads");
    },

    async latest(_sourceId, page) {
      return search("", page, "-publicdate");
    },

    async search(_sourceId, query, page) {
      return search(query, page, "-downloads");
    },

    async details(seriesId) {
      const identifier = nativeId(seriesId, "archive");
      const meta = await item(identifier);
      return {
        id: seriesId,
        provider: "archive",
        title: meta.title,
        cover: `${ARCHIVE_BASE}/services/img/${encodeURIComponent(identifier)}`,
        url: `${ARCHIVE_BASE}/details/${encodeURIComponent(identifier)}`,
        ...(meta.creator === "" ? {} : { author: meta.creator }),
        ...(meta.description === "" ? {} : { description: meta.description }),
      };
    },

    async chapters(seriesId) {
      const identifier = nativeId(seriesId, "archive");
      const meta = await item(identifier);

      if (meta.books.length > 0) {
        const taken = new Set<string>();
        return naturalBookOrder(meta.books).map((book, index) => {
          const name = chapterNameOf(book.name, taken);
          taken.add(name);
          return {
            id: chapterId(identifier, book.name),
            seriesId,
            name,
            number: index + 1,
            // The zip's directory page is the real count and costs one request per chapter:
            // asking for forty-one of them on a series screen is a stampede. `pages()` fetches
            // the one chapter actually opened, and the row stays quiet until then.
            pageCount: 0,
            read: false,
          } satisfies Chapter;
        });
      }

      const leaves = meta.leafCount ?? (await pageIndexCount(fetchImpl, base, identifier, [])) ?? null;
      if (leaves === null) {
        throw new Error(`${meta.title} does not state a page count and holds no readable book file`);
      }
      return [
        {
          id: chapterId(identifier, ""),
          seriesId,
          name: "Read online",
          number: 1,
          pageCount: leaves,
          read: false,
        } satisfies Chapter,
      ];
    },

    async pages(chapterIdValue) {
      const parsed = parseChapterId(nativeId(chapterIdValue, "archive"));
      if (parsed === null) throw new Error(`not an archive chapter id: ${chapterIdValue}`);

      if (parsed.book !== "") {
        // A volume is a file, not a directory: archive.org answers 404 for `/download/<id>/<book>/`
        // today, so there is nothing to walk. It is downloaded once and opened like a file the user
        // owns — pdf.js for a PDF, the zip reader for a CBZ — and each page is produced on demand by
        // `pageSrc`, exactly as a local import's pages are.
        const opened = await book(parsed.identifier, parsed.book);
        return Array.from({ length: Math.min(opened.pageCount, ARCHIVE_MAX_PAGES) }, (_, index) => ({
          index,
          // A stable key rather than a URL: `pages.ts` keys its blob cache on it.
          url: `book:${parsed.identifier}/${parsed.book}#${index}`,
          open: () => opened.open(index),
        }));
      }

      const meta = await item(parsed.identifier);
      if (meta.leafCount === null) {
        throw new Error(`${meta.title} does not state a page count; its pages cannot be listed`);
      }
      const pages: Page[] = [];
      for (let index = 0; index < meta.leafCount; index += 1) {
        pages.push({ index, url: pageUrl(parsed.identifier, index) });
      }
      return pages;
    },

    /**
     * Progress is ours, so there is nothing to write through to. The store that owns the mark is
     * the caller's; this provider refuses rather than pretending, which is the seam's rule.
     */
    async setRead() {
      throw new Error("archive.org has no read state; the local store owns these marks");
    },
  };
}
