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

export const ARCHIVE_BASE = "https://archive.org";

/** One source, because archive.org is one corpus; the collections are the query, not the source. */
export const ARCHIVE_SOURCE: Source = {
  id: "archive:src:texts",
  provider: "archive",
  name: "Internet Archive",
  lang: "en",
  supportsLatest: true,
};

/** Leaf width for streamed pages. 1200 is legible on a phone at 3x without pulling the 2 MB scan. */
export const ARCHIVE_PAGE_WIDTH = 1200;

/** Collections that actually hold readable comics and magazines, not every text on the site. */
const COMIC_COLLECTIONS = ["comicbooks", "comics", "magazine_rack", "pulpmagazinearchive"];

/** Fields asked of `advancedsearch.php`. Asking for fewer makes rows poorer, not faster. */
const SEARCH_FIELDS = ["identifier", "title", "creator", "year", "description", "downloads", "mediatype"];

/** A hard ceiling on one chapter: some dumps are thousands of leaves and the reader cannot preload it. */
export const ARCHIVE_MAX_PAGES = 600;

/** Members of a zip that are pages. Anything else in there is a note, a cover variant or junk. */
const PAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];

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
  const scope = collections.length === 0 ? "mediatype:texts" : `mediatype:texts AND (${collections.map((c) => `collection:${c}`).join(" OR ")})`;
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
 * What counts as a book file.
 *
 * The extension is the reliable half: archive.org's `format` labels are human strings ("Comic Book
 * ZIP", "Text PDF", "JPEG ZIP") and matching on them alone both misses real books and accepts leaf
 * dumps that are not books at all. The `zip` extension is deliberately absent — an item's `_jp2.zip`
 * or `_jpeg.zip` is the scan behind the pages, not a downloadable book.
 */
const BOOK_EXTENSIONS = ["cbz", "cbr", "cbt", "pdf"];
const BOOK_FORMATS = ["comic book zip", "comic book rar", "text pdf", "comic book"];

/**
 * Formats whose pages can be listed without downloading the whole file.
 *
 * Only zip: archive.org can show the directory of a zip, and cannot show the contents of a RAR or a
 * PDF. A `.cbr` volume is still listed as a chapter — it exists — but reading it says so plainly
 * instead of drawing an empty book.
 */
const STREAMABLE_EXTENSIONS = ["cbz"];

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
    const name = firstOf(file.name);
    if (name === "" || !name.includes(".")) continue;
    const extension = (name.split(".").pop() ?? "").toLowerCase();
    const format = (firstOf(file.format) || extension).toLowerCase();
    const isBook = BOOK_EXTENSIONS.includes(extension) || BOOK_FORMATS.some((known) => format.startsWith(known));
    if (!isBook) continue;
    const size = Number.parseInt(firstOf(file.size), 10);
    const book: BookFile = { name, format, extension, size: Number.isFinite(size) ? size : 0 };
    // An item usually ships each volume twice — a `.cbz` and a `.pdf` of the same scan. Two rows
    // for one volume reads as a duplicate, so the base name keeps one: a zip, because its pages can
    // be listed and read, where a PDF's cannot be without downloading it.
    const base = name.replace(/\.[^.]+$/, "").toLowerCase();
    const existing = seenBase.get(base);
    if (existing === undefined) {
      seenBase.set(base, book);
      continue;
    }
    if (STREAMABLE_EXTENSIONS.includes(book.extension) && !STREAMABLE_EXTENSIONS.includes(existing.extension)) {
      seenBase.set(base, book);
    }
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

/** A page inside a book file: `/download/{id}/{file.cbz}/{member.jpg}`. */
export function memberUrl(identifier: string, book: string, member: string, base = ARCHIVE_BASE): string {
  return `${base}/download/${encodeURIComponent(identifier)}/${encodeURIComponent(book)}/${encodeURIComponent(member)}`;
}

/**
 * The directory page of a zip: archive.org lists every member with a link, in zip order.
 *
 * Members are filtered to images and kept in the order listed, because that order is the reading
 * order — sorting by name would put "p10" before "p9" on any archive without zero padding.
 */
export function membersFromListing(html: string, identifier: string, book: string, base = ARCHIVE_BASE): string[] {
  const seen = new Set<string>();
  const members: string[] = [];
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = match[1];
    const decoded = (() => {
      try {
        return decodeURIComponent(href);
      } catch {
        return href;
      }
    })();
    if (!decoded.includes(book)) continue;
    const member = decoded.slice(decoded.indexOf(book) + book.length).replace(/^\/+/, "");
    if (member === "" || member.includes("/")) continue;
    const extension = (member.split(".").pop() ?? "").toLowerCase();
    if (!PAGE_EXTENSIONS.includes(extension)) continue;
    if (seen.has(member)) continue;
    seen.add(member);
    members.push(memberUrl(identifier, book, member, base));
  }
  return members;
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

/** Listings are stable and cost one request each; re-opening the same chapter should be free. */
const listingCache = new Map<string, string[]>();
const LISTING_CACHE_SIZE = 24;

export function createArchiveProvider(options: ArchiveProviderOptions = {}): SourceProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.base ?? ARCHIVE_BASE).replace(/\/+$/, "");
  const enabled = options.enabled ?? (() => true);

  const search = async (query: string, page: number, sort: string): Promise<Paged<Series>> => {
    const params = buildQuery({ query, sort });
    params.set("page", String(Math.max(1, Math.floor(page))));
    const response = await fetchImpl(`${base}/advancedsearch.php?${params.toString()}`);
    if (!response.ok) throw new Error(`archive.org search failed (HTTP ${response.status})`);
    const body = (await response.json()) as { response?: { docs?: SearchDoc[]; numFound?: number; start?: number } };
    const docs = body.response?.docs ?? [];
    const items = docs.map(rowToSeries).filter((row): row is Series => row !== null);
    const start = body.response?.start ?? 0;
    const found = body.response?.numFound ?? 0;
    return paged(items, start + docs.length < found);
  };

  const item = async (identifier: string): Promise<ItemMetadata> => {
    const response = await fetchImpl(`${base}/metadata/${encodeURIComponent(identifier)}`);
    if (!response.ok) throw new Error(`archive.org item ${identifier} failed (HTTP ${response.status})`);
    return metadataToItem(identifier, await response.json());
  };

  const listing = async (identifier: string, book: string): Promise<string[]> => {
    const key = `${identifier}/${book}`;
    const cached = listingCache.get(key);
    if (cached !== undefined) return cached;
    const response = await fetchImpl(`${base}/download/${encodeURIComponent(identifier)}/${encodeURIComponent(book)}/`);
    if (!response.ok) throw new Error(`archive.org listed no directory for ${book} (HTTP ${response.status})`);
    const members = membersFromListing(await response.text(), identifier, book, base);
    if (members.length === 0) throw new Error(`archive.org lists no pages inside ${book}`);
    if (listingCache.size >= LISTING_CACHE_SIZE) {
      const oldest = listingCache.keys().next().value;
      if (oldest !== undefined) listingCache.delete(oldest);
    }
    listingCache.set(key, members);
    return members;
  };

  return {
    kind: "archive",
    ownsProgress: true,

    async sources() {
      return enabled() ? [{ ...ARCHIVE_SOURCE }] : [];
    },

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
        ...(meta.creator === "" ? {} : { author: meta.creator }),
        ...(meta.description === "" ? {} : { description: meta.description }),
      };
    },

    async chapters(seriesId) {
      const identifier = nativeId(seriesId, "archive");
      const meta = await item(identifier);

      if (meta.books.length > 0) {
        return meta.books.map(
          (book, index) =>
            ({
              id: chapterId(identifier, book.name),
              seriesId,
              name: book.name.replace(/\.[^.]+$/, ""),
              number: index + 1,
              // The zip's directory page is the real count and costs one request per chapter:
              // asking for forty-one of them on a series screen is a stampede. `pages()` fetches
              // the one chapter actually opened, and the row stays quiet until then.
              pageCount: 0,
              read: false,
            }) satisfies Chapter,
        );
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
        const members = await listing(parsed.identifier, parsed.book);
        return members.slice(0, ARCHIVE_MAX_PAGES).map((url, index) => ({ index, url }));
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
