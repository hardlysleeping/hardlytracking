/**
 * MihonProvider — the Mihon/Komikku source layer, behind one transport.
 *
 * The extensions are real, unmodified Mihon APKs; what differs between platforms
 * is only *where the JVM hosting them runs*:
 *
 *   browser / PWA   ->  POST /api/mihon/graphql   (self-hosted runtime, proxied)
 *   packaged (T6)   ->  invoke("mihon_graphql")   (embedded runtime, same API)
 *
 * Today the self-hosted runtime is Suwayomi v2.4.2366 (a Mihon extension host on
 * :4567). Its GraphQL is a stable, documented surface, so the provider talks to it
 * through `MihonTransport` and a later in-house `M-Extension-Server` can be swapped
 * in behind the same interface without touching the UI.
 *
 * Two facts about that API that are easy to get wrong, both verified against the
 * running server (see tests/unit/mihon-map.mjs for the shapes):
 *
 * 1. `fetchChapterPages` returns **relative paths** (`/api/v1/manga/12/chapter/1/page/0`),
 *    not URLs. They must be joined to the runtime base, or every page 404s.
 * 2. `thumbnailUrl` is relative in exactly the same way.
 */
import { joinId, nativeId, paged, type Chapter, type Page, type Paged, type Series, type Source, type SourceProvider } from "./source";
import { transport as defaultTransport, type Transport } from "./transport";

export interface MihonTransport {
  /** One GraphQL round-trip. Rejects on transport error or a GraphQL `errors` entry. */
  gql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  /** Runtime-relative path -> a URL this app can load. */
  asset(path: string): string;
}

/** The browser/PWA transport: same origin, `/api/mihon` proxied to the runtime. */
export function browserMihonTransport(base = "/api/mihon", transport: Transport = defaultTransport): MihonTransport {
  const gql = async <T,>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const res = await transport(`${base}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`mihon runtime answered ${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: { message?: string }[] };
    if (body.errors?.length) throw new Error(body.errors[0]?.message ?? "mihon runtime error");
    if (body.data === undefined) throw new Error("mihon runtime returned no data");
    return body.data;
  };
  return { gql, asset: (path: string) => `${base}${stripApiPrefix(path)}` };
}

/** `/api/v1/manga/12/page/0` -> `/v1/manga/12/page/0`; absolute URLs pass through. */
export function stripApiPrefix(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return path.startsWith("/api") ? path.slice(4) : path;
}

// ---- shapes as the runtime returns them -------------------------------------

export interface RawSource {
  id: string;
  displayName: string;
  name: string;
  lang: string;
  isNsfw?: boolean;
  supportsLatest?: boolean;
}

export interface RawManga {
  id: number;
  title: string;
  thumbnailUrl?: string | null;
  author?: string | null;
  description?: string | null;
  status?: string | null;
}

export interface RawChapter {
  id: number;
  name: string;
  chapterNumber: number;
  pageCount: number;
  isRead: boolean;
}

// ---- pure mapping (unit-tested without a network) ---------------------------

export function mapSource(raw: RawSource): Source {
  return {
    id: joinId("mihon", `src:${raw.id}`),
    provider: "mihon",
    name: raw.displayName || raw.name,
    lang: raw.lang,
    nsfw: raw.isNsfw === true,
    supportsLatest: raw.supportsLatest === true,
  };
}

export function mapSeries(raw: RawManga, asset: (p: string) => string): Series {
  const series: Series = { id: joinId("mihon", raw.id), provider: "mihon", title: raw.title };
  if (raw.thumbnailUrl) series.cover = asset(raw.thumbnailUrl);
  if (raw.author) series.author = raw.author;
  if (raw.description) series.description = raw.description;
  if (raw.status) series.status = raw.status;
  return series;
}

export function mapChapter(raw: RawChapter, seriesId: string): Chapter {
  return {
    id: joinId("mihon", `ch:${raw.id}`),
    seriesId,
    name: raw.name,
    number: raw.chapterNumber,
    pageCount: raw.pageCount,
    read: raw.isRead,
  };
}

export function mapPages(paths: string[], asset: (p: string) => string): Page[] {
  return paths.map((path, index) => ({ index, url: asset(path) }));
}

// ---- the provider -----------------------------------------------------------

const Q_SOURCES = `query Sources { sources { nodes { id displayName name lang isNsfw supportsLatest } } }`;

const M_FETCH_SOURCE = `mutation FetchSource($source: LongString!, $page: Int!, $type: FetchSourceMangaType!, $query: String) {
  fetchSourceManga(input: { source: $source, page: $page, type: $type, query: $query }) {
    mangas { id title thumbnailUrl author description status }
    hasNextPage
  }
}`;

const Q_MANGA = `query Manga($id: Int!) {
  manga(id: $id) { id title thumbnailUrl author description status }
}`;

const Q_CHAPTERS = `query Chapters($mangaId: Int!, $limit: Int!) {
  chapters(condition: { mangaId: $mangaId }, first: $limit) {
    nodes { id name chapterNumber pageCount isRead }
  }
}`;

const M_CHAPTER_PAGES = `mutation Pages($chapterId: Int!) {
  fetchChapterPages(input: { chapterId: $chapterId }) { pages }
}`;

const M_SET_READ = `mutation SetRead($id: Int!, $read: Boolean!) {
  updateChapter(input: { id: $id, patch: { isRead: $read } }) { chapter { id isRead } }
}`;

type FetchType = "POPULAR" | "LATEST" | "SEARCH";

export function createMihonProvider(t: MihonTransport): SourceProvider {
  const browse = async (sourceId: string, type: FetchType, page: number, query?: string): Promise<Paged<Series>> => {
    const native = nativeId(sourceId, "mihon").replace(/^src:/, "");
    const data = await t.gql<{ fetchSourceManga: { mangas: RawManga[]; hasNextPage: boolean } }>(M_FETCH_SOURCE, {
      source: native,
      page,
      type,
      query: query ?? null,
    });
    return paged(data.fetchSourceManga.mangas.map((m) => mapSeries(m, t.asset)), data.fetchSourceManga.hasNextPage);
  };

  return {
    kind: "mihon",
    // Suwayomi already stores read state; writing it locally too would be a second writer.
    ownsProgress: false,

    async sources() {
      const data = await t.gql<{ sources: { nodes: RawSource[] } }>(Q_SOURCES);
      return data.sources.nodes.map(mapSource);
    },

    popular: (sourceId, page) => browse(sourceId, "POPULAR", page),
    latest: (sourceId, page) => browse(sourceId, "LATEST", page),
    search: (sourceId, query, page) => browse(sourceId, "SEARCH", page, query),

    async details(seriesId) {
      const data = await t.gql<{ manga: RawManga | null }>(Q_MANGA, { id: Number(nativeId(seriesId, "mihon")) });
      if (data.manga === null) throw new Error(`no such series: ${seriesId}`);
      return mapSeries(data.manga, t.asset);
    },

    async chapters(seriesId) {
      const data = await t.gql<{ chapters: { nodes: RawChapter[] } }>(Q_CHAPTERS, {
        mangaId: Number(nativeId(seriesId, "mihon")),
        limit: 2000,
      });
      return data.chapters.nodes.map((c) => mapChapter(c, seriesId));
    },

    async pages(chapterId) {
      const data = await t.gql<{ fetchChapterPages: { pages: string[] } }>(M_CHAPTER_PAGES, {
        chapterId: Number(nativeId(chapterId, "mihon").replace(/^ch:/, "")),
      });
      return mapPages(data.fetchChapterPages.pages, t.asset);
    },

    async setRead(chapterId, read) {
      await t.gql(M_SET_READ, { id: Number(nativeId(chapterId, "mihon").replace(/^ch:/, "")), read });
    },
  };
}
