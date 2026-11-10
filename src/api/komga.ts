/**
 * Komga as a source.
 *
 * Komga is a comic server the user runs themselves, and it keeps reading state — that is why the
 * provider says `ownsProgress: false`: ours is a mirror, and a mirror has to be refreshed from the
 * thing it mirrors (see `src/lib/read-state.ts`).
 *
 * Verified against Komga's own OpenAPI (`komga/docs/openapi.json` in the project repo), not guessed:
 *
 * - `GET /api/v1/libraries` → `[{ id, name }]`
 * - `GET /api/v1/series?library_id&search&sort&page&size` → `{ content: SeriesDto[], last }`
 * - `GET /api/v1/series/{id}` → `SeriesDto`
 * - `GET /api/v1/books?series_id&sort&size` → `{ content: BookDto[], last }`
 * - `GET /api/v1/books/{id}/pages` → `[{ number, fileName, mediaType, width, height }]`
 * - `PATCH /api/v1/books/{id}/read-progress { page?, completed? }`, `DELETE` to clear
 * - auth: **normal login** — HTTP basic (`Authorization: Basic …`) — or an `X-API-Key` header. Every
 *   client of Komga uses the login; this provider does too, because that is what a person has.
 *
 * Two consequences worth stating, because they shape the code:
 *
 * 1. **Images need the header, and an `<img>` cannot send one.** Covers and pages are returned as
 *    Komga URLs *plus* the header they need (`coverHeaders`, `Page.headers`), and the app fetches
 *    those bytes itself (`imageCache.resolve(url, { headers })`) so the result is a blob on this
 *    device. `/api/img` is not used: it refuses private addresses, and a Komga is almost always a
 *    private address. In a browser tab every URL goes through `/api/komga` instead, because Komga
 *    sends no CORS headers at all — see `komgaUrl()` in `src/lib/komga.ts`.
 * 2. **A wrong password is not an empty shelf.** A 401 says so, by name, because "no series here"
 *    and "your login was refused" are different problems with different fixes.
 */
import {
  joinId,
  nativeId,
  paged,
  type Chapter,
  type Page,
  type Paged,
  type RemoteRead,
  type Series,
  type Source,
  type SourceProvider,
} from "./source";
import { RUNTIME_DEADLINE_MS, deadlined } from "../lib/deadline";
import { hasLocalServer } from "../lib/host";
import { komgaUrl } from "../lib/komga";

export interface KomgaRawLibrary {
  id: string;
  name: string;
}

interface KomgaRawAuthor {
  name?: string;
  role?: string;
}

export interface KomgaRawSeries {
  id: string;
  name: string;
  libraryId?: string;
  booksCount?: number;
  booksReadCount?: number;
  created?: string;
  lastModified?: string;
  metadata?: {
    title?: string;
    summary?: string;
    status?: string;
    publisher?: string;
    language?: string;
    titleSort?: string;
  };
  booksMetadata?: { authors?: KomgaRawAuthor[]; releaseDate?: string; tags?: string[] };
}

export interface KomgaRawBook {
  id: string;
  name: string;
  number?: number;
  seriesId?: string;
  media?: { pagesCount?: number; mediaType?: string; status?: string };
  metadata?: { title?: string; numberSort?: number; releaseDate?: string };
  readProgress?: {
    page?: number;
    completed?: boolean;
    readDate?: string;
    lastModified?: string;
  };
}

export interface KomgaPageDto {
  number: number;
  fileName?: string;
  mediaType?: string;
}

/** What a Komga page list looks like when it is a page of results rather than an array. */
interface KomgaPaged<T> {
  content: T[];
  last?: boolean;
  totalPages?: number;
  number?: number;
}

export interface KomgaOptions {
  /** e.g. `http://192.168.1.20:25600`, no trailing slash. */
  baseUrl: string;
  username: string;
  password: string;
  /**
   * Which configured server this provider speaks for.
   *
   * Several Komga entries may share a `baseUrl` (two logins on one box, each seeing different
   * libraries), so the address cannot identify a provider or its ids. This id does: every source,
   * series and chapter id carries it, and `owns()` refuses an id that belongs to another server.
   */
  serverId?: string;
  /**
   * The server's own label, so its aggregate source can be named for it.
   *
   * One source per server lists every library; its name has to say *which* server, because two
   * entries may point at one box with different logins.
   */
  label?: string;
  /**
   * Which library the aggregate source shows: absent/empty is All.
   *
   * Only the aggregate source reads this. A per-library source always asks for its own library,
   * whatever this says — otherwise narrowing one source would silently narrow every other one.
   */
  libraryId?: string;
  fetchImpl?: typeof fetch;
  /** How many rows a browse page asks for. Komga caps it server-side; 40 is a grid on a phone. */
  pageSize?: number;
}

export class KomgaError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "KomgaError";
    this.status = status;
  }
}

function basicAuth(username: string, password: string): string {
  // `btoa` is Latin-1; a password can be anything, so encode UTF-8 first.
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

export function komgaAuthHeaders(username: string, password: string): Record<string, string> {
  return { authorization: basicAuth(username, password) };
}

export function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Namespacing, one segment deeper than a single server needed.
 *
 * `komga:<serverId>:<libraryId>` for a source, `komga:<serverId>:<seriesId>` for a series and
 * `komga:<serverId>:ch:<bookId>` for a chapter. The server segment is not decoration: two entries
 * can point at the same address with different logins, and their libraries must stay distinct or a
 * mark hidden on one login would hide the same-named library on the other.
 */
/**
 * The sentence inside a JSON error body, when it has one.
 *
 * Komga answers plain text, but the app's own `/api/komga` hop writes `{ error, detail }` — printing
 * that object at a person is noise, and its `error` is the sentence they need ("Komga unreachable at
 * http://…"). Anything else falls through as the raw text, cut to a length a note can hold.
 */
export function errorDetail(body: string): string {
  const text = body.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error !== "") return parsed.error.slice(0, 160);
    } catch {
      // Not JSON after all: the raw text is the answer.
    }
  }
  return text.slice(0, 160);
}

export function komgaSourceId(serverId: string, libraryId: string): string {
  return joinId("komga", `${serverId}:${libraryId}`);
}
/**
 * The native library segment of the one server-level source, as distinct from a library id.
 *
 * Komga's library ids are UUIDs, so `all` is not a value one of them can take in practice. It is
 * spelled once here, because both the aggregate id and `nativeFor`'s branch must agree.
 */
export const KOMGA_AGGREGATE_LIBRARY = "all";

/** `komga:<serverId>:all` — one source that lists every library of that server. */
export function komgaAggregateSourceId(serverId: string): string {
  return komgaSourceId(serverId, KOMGA_AGGREGATE_LIBRARY);
}

/** Is this source id the aggregate one for `serverId` (and not a per-library source)? */
export function isKomgaAggregateSource(serverId: string, id: string): boolean {
  return id === komgaAggregateSourceId(serverId);
}
export function komgaSeriesId(serverId: string, id: string): string {
  return joinId("komga", `${serverId}:${id}`);
}
export function komgaChapterId(serverId: string, id: string): string {
  return joinId("komga", `${serverId}:ch:${id}`);
}

/** The id a provider answers to when several Komga servers are configured. */
export function komgaOwnsId(serverId: string, id: string): boolean {
  try {
    const native = nativeId(id, "komga");
    if (isLegacyKomgaNative(native)) return serverId === "default";
    return native.startsWith(`${serverId}:`);
  } catch {
    return false;
  }
}

/**
 * An id from before the list existed: `komga:<seriesId>`, `komga:lib:<id>`, `komga:ch:<id>`.
 *
 * Those rows are still in the owner's library, so the migrated entry (`default`) keeps answering
 * them instead of making a title that was readable yesterday fail today.
 */
export function isLegacyKomgaNative(native: string): boolean {
  return native.indexOf(":") < 1 || native.startsWith("ch:") || native.startsWith("lib:");
}

export function mapKomgaLibrary(raw: KomgaRawLibrary, serverId: string): Source {
  return {
    id: komgaSourceId(serverId, raw.id),
    provider: "komga",
    name: raw.name,
    supportsLatest: true,
  };
}

/**
 * One server as one source: every library until the picker names one.
 *
 * This is the Komikku-shaped choice — the source's own settings decide what it displays, instead of
 * reading two source cards to see a whole server. The per-library sources stay, so a hidden mark on
 * one library and a pinned mark on another keep working exactly as they did.
 */
export function mapKomgaAggregateSource(serverId: string, label: string): Source {
  const named = label.trim() === "" ? "Komga" : label.trim();
  return {
    id: komgaAggregateSourceId(serverId),
    provider: "komga",
    name: `Komga — ${named}`,
    supportsLatest: true,
  };
}

export function mapKomgaSeries(
  raw: KomgaRawSeries,
  baseUrl: string,
  headers: Record<string, string>,
  serverId: string,
  proxied: boolean = hasLocalServer(),
): Series {
  const authors = (raw.booksMetadata?.authors ?? [])
    .map((author) => author.name ?? "")
    .filter((name) => name !== "");
  const unique = [...new Set(authors)];
  const title = raw.metadata?.title ?? raw.name;
  return {
    id: komgaSeriesId(serverId, raw.id),
    provider: "komga",
    // The library is a source and a mark target; the series id cannot spell it, so it travels here
    // and onto the mapping row. Without it a title from a hidden library would still be listed.
    ...(raw.libraryId === undefined || raw.libraryId === "" ? {} : { sourceId: komgaSourceId(serverId, raw.libraryId) }),
    title,
    // The URL *and* the header it needs: an `<img>` cannot send the login, so the app fetches this
    // itself and hands the UI a blob. See the header comment.
    // Through the proxy in the page: an `<img>` cannot send the login, the image cache fetches it
    // with the header, and the same server passes that header on.
    cover: komgaUrl(baseUrl, `/api/v1/series/${raw.id}/thumbnail`, proxied),
    coverHeaders: headers,
    // Komga's own web UI answers at /series/{id}: the same title opened where it is managed, not a
    // second front end for it.
    url: `${baseUrl}/series/${raw.id}`,
    ...(unique.length === 0 ? {} : { author: unique.slice(0, 3).join(", ") }),
    ...(raw.metadata?.summary ? { description: raw.metadata.summary } : {}),
    ...(raw.metadata?.status ? { status: raw.metadata.status } : {}),
  };
}

/** A book is a chapter. Komga's `numberSort` is the sort key, and `number` the printed one. */
export function mapKomgaBook(raw: KomgaRawBook, seriesId: string, serverId: string): Chapter {
  const number = raw.metadata?.numberSort ?? raw.number ?? -1;
  const release = raw.metadata?.releaseDate;
  const uploaded = release === undefined ? undefined : Date.parse(`${release}T00:00:00Z`);
  return {
    id: komgaChapterId(serverId, raw.id),
    seriesId,
    name: raw.metadata?.title ?? raw.name,
    number: typeof number === "number" ? number : -1,
    pageCount: raw.media?.pagesCount ?? 0,
    read: raw.readProgress?.completed === true,
    ...(uploaded === undefined || Number.isNaN(uploaded) ? {} : { uploadedAt: uploaded }),
  };
}

/** What Komga says is read, for the reconcile in `src/lib/read-state.ts`. */
export function mapKomgaReadState(books: readonly KomgaRawBook[], serverId: string): RemoteRead[] {
  return books.map((book) => {
    const read = book.readProgress?.completed === true;
    const page = book.readProgress?.page;
    const at = book.readProgress?.readDate === undefined ? undefined : Date.parse(book.readProgress.readDate);
    return {
      chapterId: komgaChapterId(serverId, book.id),
      read,
      // Komga's `page` is a 0-based index, which is what our own progress stores — no +1 here.
      ...(typeof page === "number" && page > 0 ? { page } : {}),
      ...(at === undefined || Number.isNaN(at) ? {} : { at }),
    };
  });
}

export function createKomgaProvider(options: KomgaOptions): SourceProvider {
  const baseUrl = trimBase(options.baseUrl);
  const serverId = options.serverId ?? "default";
  const headers = komgaAuthHeaders(options.username, options.password);
  // A Komga box that is asleep accepts the socket and then says nothing. The deadline names it in
  // the error instead of leaving the grid on "loading" until the platform gives up.
  const doFetch = options.fetchImpl ?? deadlined(fetch, RUNTIME_DEADLINE_MS, "your Komga server");
  const pageSize = options.pageSize ?? 40;

  /**
   * The Komga id inside one of ours, after checking it belongs to *this* server.
   *
   * Two servers can share an address, so an id that merely names a Komga is not enough: handing
   * server A's library id to server B would list the wrong libraries (or the same ones twice).
   */
  function nativeFor(id: string): string {
    const native = nativeId(id, "komga");
    if (isLegacyKomgaNative(native)) {
      if (serverId !== "default") {
        throw new KomgaError(`${id} predates the server list and belongs to the migrated Komga server`, 0);
      }
      return native.replace(/^lib:/, "");
    }
    const at = native.indexOf(":");
    const owner = native.slice(0, at);
    if (owner !== serverId) {
      throw new KomgaError(`${id} belongs to Komga server "${owner}", not "${serverId}"`, 0);
    }
    return native.slice(at + 1);
  }

  /** The last books list per series, so `chapters()` then `readState()` is one request. */
  const lastBooks = new Map<string, KomgaRawBook[]>();

  async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(komgaUrl(baseUrl, path), {
        ...init,
        headers: { accept: "application/json", ...headers, ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (error) {
      throw new KomgaError(`Komga is not answering at ${baseUrl}: ${(error as Error).message}`, 0);
    }
    if (response.status === 401 || response.status === 403) {
      throw new KomgaError(`Komga refused the login for "${options.username}" at ${baseUrl}`, response.status);
    }
    if (!response.ok) {
      const detail = errorDetail(await response.text().catch(() => ""));
      // The address, not just the number: a 404 with a right login is almost always a wrong path
      // (a reverse proxy in front of Komga, a typo, another service on that port), and the only way
      // to see which is to know what was asked.
      throw new KomgaError(
        `Komga answered ${response.status} for ${baseUrl}${path}${detail === "" ? "" : `: ${detail}`}`,
        response.status,
      );
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  /**
   * The `library_id` one browse call should send, or `null` for "every library".
   *
   * The aggregate source answers `all` from `nativeFor`; it is a picker, not a library, so the saved
   * choice is used instead. A per-library source ignores the picker entirely and always sends its
   * own id — that is the promise the two kinds of card make to each other.
   */
  function libraryParam(sourceId: string): string | null {
    const native = nativeFor(sourceId);
    if (native !== KOMGA_AGGREGATE_LIBRARY) return native;
    const picked = (options.libraryId ?? "").trim();
    return picked === "" ? null : picked;
  }

  /** One page of series, for a library or a search. `popular` and `latest` differ only in the sort. */
  async function seriesPage(sourceId: string, page: number, sort: string, query?: string): Promise<Paged<Series>> {
    const library = libraryParam(sourceId);
    const params = new URLSearchParams({
      page: String(Math.max(0, page - 1)),
      size: String(pageSize),
      sort,
    });
    // Absent, not empty: `library_id=` would filter on a library id that cannot exist. Komga treats
    // a missing parameter as "all libraries", which is exactly the All choice.
    if (library !== null) params.set("library_id", library);
    if (query !== undefined && query !== "") params.set("search", query);
    const data = await json<KomgaPaged<KomgaRawSeries>>(`/api/v1/series?${params.toString()}`);
    const rows = data.content ?? [];
    return paged(
      rows.map((row) => mapKomgaSeries(row, baseUrl, headers, serverId)),
      data.last === false || (typeof data.totalPages === "number" && typeof data.number === "number" && data.number + 1 < data.totalPages),
    );
  }

  async function books(seriesId: string): Promise<KomgaRawBook[]> {
    const stashed = lastBooks.get(seriesId);
    if (stashed !== undefined) return stashed;
    const native = nativeFor(seriesId);
    const params = new URLSearchParams({
      series_id: native,
      size: "500",
      sort: "metadata.numberSort,asc",
    });
    const data = await json<KomgaPaged<KomgaRawBook>>(`/api/v1/books?${params.toString()}`);
    // Komga answers an unrecognised `series_id` by ignoring the filter rather than refusing it, so
    // one bad id handed back the whole library as "this title's issues". Every book names its own
    // series, so the answer is checked against the question: a row that belongs to someone else is
    // not this chapter list, whatever the request said.
    const asked = native;
    const rows = (data.content ?? []).filter(
      (row) => typeof row.seriesId !== "string" || row.seriesId === "" || row.seriesId === asked,
    );
    lastBooks.set(seriesId, rows);
    return rows;
  }

  return {
    kind: "komga",
    // Komga keeps the read state; ours mirrors it and is reconciled from the server.
    ownsProgress: false,

    // With several servers of the same kind, `providerFor` asks this before handing over an id.
    owns: (id) => komgaOwnsId(serverId, id),

    async sources() {
      const libraries = await json<KomgaRawLibrary[]>("/api/v1/libraries");
      // The aggregate first: it is the card that reads the whole server by default. The per-library
      // ones follow unchanged, so their ids, marks and filters keep resolving.
      return [
        mapKomgaAggregateSource(serverId, options.label ?? "Komga"),
        ...libraries.map((row) => mapKomgaLibrary(row, serverId)),
      ];
    },

    // Komga has no popularity: newest *added* is the honest stand-in, and it is stable, unlike a
    // random order that would make "Load more" hand back rows the reader already scrolled past.
    popular: (sourceId, page) => seriesPage(sourceId, page, "created,desc"),
    latest: (sourceId, page) => seriesPage(sourceId, page, "lastModified,desc"),
    search: (sourceId, query, page) => seriesPage(sourceId, page, "metadata.titleSort,asc", query),

    async details(seriesId) {
      const native = nativeFor(seriesId);
      const raw = await json<KomgaRawSeries>(`/api/v1/series/${encodeURIComponent(native)}`);
      return mapKomgaSeries(raw, baseUrl, headers, serverId);
    },

    async chapters(seriesId) {
      lastBooks.delete(seriesId);
      const rows = await books(seriesId);
      return rows.map((row) => mapKomgaBook(row, seriesId, serverId));
    },

    async pages(chapterId) {
      const native = nativeFor(chapterId).replace(/^ch:/, "");
      const list = await json<KomgaPageDto[]>(`/api/v1/books/${encodeURIComponent(native)}/pages`);
      return list.map(
        (row, index): Page => ({
          index,
          url: komgaUrl(baseUrl, `/api/v1/books/${encodeURIComponent(native)}/pages/${row.number}`),
          // The login, because Komga serves the image to a logged-in client and an `<img>` cannot
          // send a header: the app fetches these bytes itself.
          headers,
        }),
      );
    },

    async readState(seriesId) {
      return mapKomgaReadState(await books(seriesId), serverId);
    },

    /**
     * Write one book's read state back to Komga.
     *
     * `completed` is the honest flag for "read", and a page is only sent when the caller has one —
     * PATCHing `page: 0` would claim the reader is at the top of a book they finished.
     */
    async setRead(chapterId, read, page) {
      const native = nativeFor(chapterId).replace(/^ch:/, "");
      const path = `/api/v1/books/${encodeURIComponent(native)}/read-progress`;
      if (!read) {
        await json<void>(path, { method: "DELETE" });
        return;
      }
      const body: { completed?: boolean; page?: number } =
        typeof page === "number" && page > 0 ? { page } : { completed: true };
      await json<void>(path, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
}
