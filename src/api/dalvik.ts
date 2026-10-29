/**
 * The `/dalvik` bridge: how our app talks to a Mihon extension host that is not
 * Suwayomi.
 *
 * M-Extension-Server exposes exactly one call surface for extensions — `POST /dalvik`
 * with a `DataBody` — and no way to install over HTTP. Install is *the same call*: send
 * the APK bytes as base64 in `data`, and the response carries `X-Mangayomi-Extension-Id`,
 * which is the SHA-256 of those bytes. Every later call names that id instead of resending
 * the APK. That is the whole protocol, and it is why the packaged apps can do this on-device
 * with no server and no store.
 *
 * Verified against MExtensionServer v1.0.9 (Linux x64) with the real MangaDex APK:
 * `sourcesManga` returned 61 sources, `getPopularManga` a page with `hasNextPage`,
 * `getChapterList` 3 chapters, `getPageList` 21 pages.
 *
 * Two shapes worth knowing before reading the mapping code:
 *
 * - **Images come back through the runtime**, not from the site: `thumbnail_url` and a
 *   page's `imageUrl` are `http://<host>/image/<uuid>`. The runtime fetches with the
 *   source's own headers, so the reader never has to know them and the browser never hits
 *   a third-party origin. A page's `url` is a bridge memo (host, api url, timestamp), not
 *   an image address — do not use it as one.
 * - **`chapter_number` is a float**, and `-1` means the extension could not parse one.
 *   Keeping -1 as a number would sort specials to the top, so it becomes 0 and the name
 *   carries the truth.
 */
import { joinId, nativeId, paged, type Chapter, type Page, type Paged, type ProviderKind, type Series, type Source, type SourceProvider } from "./source";

export type DalvikMethod =
  | "sourcesManga"
  | "headersManga"
  | "filtersManga"
  | "supportLatestManga"
  | "getPopularManga"
  | "getLatestManga"
  | "getSearchManga"
  | "getDetailsManga"
  | "getChapterList"
  | "getPageList"
  | "preferencesManga"
  | "setPreferenceManga";

/** The runtime's own names, kept as they arrive so nothing is lost in translation. */
export interface DalvikSource {
  id: string;
  name: string;
  lang?: string;
  baseUrl?: string;
}

export interface DalvikManga {
  url: string;
  title?: string;
  artist?: string | null;
  author?: string | null;
  description?: string | null;
  genre?: string | null;
  status?: number | null;
  thumbnail_url?: string | null;
  initialized?: boolean;
}

export interface DalvikChapter {
  url: string;
  name: string;
  date_upload?: number;
  chapter_number?: number;
  scanlator?: string | null;
}

export interface DalvikPage {
  index: number;
  /** A bridge memo, not an image address. */
  url?: string;
  /** The address to load: the runtime's `/image/<uuid>` proxy. */
  imageUrl?: string;
  headers?: Record<string, string> | null;
}

export interface DalvikCall {
  method: DalvikMethod;
  /** Base64 APK bytes: installs (or re-installs) in the same request. */
  data?: string;
  /** The id the runtime handed back for an installed APK. */
  extensionId?: string;
  sourceId?: string;
  page?: number;
  search?: string;
  mangaData?: DalvikManga;
  chapterData?: DalvikChapter;
  filterList?: unknown[];
  preferences?: Array<Record<string, unknown>>;
  lang?: string;
  sourceBaseUrl?: string;
}

export class DalvikError extends Error {
  readonly status: number;
  readonly runtimeCode: number | null;

  constructor(message: string, status: number, runtimeCode: number | null = null) {
    super(message);
    this.name = "DalvikError";
    this.status = status;
    this.runtimeCode = runtimeCode;
  }
}

export interface DalvikOptions {
  /** `http://127.0.0.1:<port>` — the bridge is loopback by design. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DalvikResult<T> {
  body: T;
  /** Present when this call installed an APK; the key for every call after it. */
  extensionId: string | null;
}

const EXTENSION_HEADER = "x-mangayomi-extension-id";

export class DalvikClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DalvikOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** One call, one body. Errors carry the runtime's own message, never a guess. */
  async call<T = unknown>(call: DalvikCall): Promise<DalvikResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/dalvik`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(call),
        signal: controller.signal,
      });
    } catch (error) {
      throw new DalvikError(`the extension host is not answering at ${this.baseUrl}: ${(error as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      throw new DalvikError(`the extension host answered ${response.status} with something that is not JSON`, response.status);
    }

    if (!response.ok) {
      const detail = body as { error?: string; code?: number } | null;
      throw new DalvikError(
        detail?.error ?? `the extension host answered ${response.status}`,
        response.status,
        typeof detail?.code === "number" ? detail.code : null,
      );
    }

    return { body: body as T, extensionId: response.headers.get(EXTENSION_HEADER) };
  }

  /**
   * Install an APK by sending its bytes, and learn what it exposes in the same round trip.
   *
   * The extension id is the SHA-256 of the bytes, so the same APK always installs to the
   * same id and a client can remember it instead of resending megabytes on every call.
   */
  async install(apk: Uint8Array): Promise<{ extensionId: string; sources: DalvikSource[] }> {
    const result = await this.call<DalvikSource[]>({ method: "sourcesManga", data: base64(apk) });
    if (result.extensionId === null) {
      throw new DalvikError("the extension host accepted the APK but returned no extension id", 0);
    }
    return { extensionId: result.extensionId, sources: Array.isArray(result.body) ? result.body : [] };
  }

  /** `/image/<uuid>` is relative to the host that minted it; make it loadable. */
  asset(url: string | null | undefined): string | undefined {
    if (url === null || url === undefined || url === "") return undefined;
    if (/^https?:\/\//i.test(url)) return url;
    return `${this.baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
  }
}

function base64(bytes: Uint8Array): string {
  // Node and the browser disagree about how to feed btoa, so go through Buffer where it exists.
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** An APK this device has installed, as the provider needs to know it. */
export interface InstalledExtension {
  extensionId: string;
  packageId: string;
  sources: DalvikSource[];
}

export interface DalvikProviderOptions {
  client: DalvikClient;
  extensions: InstalledExtension[];
  /** Titles seen this session, so a chapter call can name the manga it is about. */
  titles?: Map<string, string>;
}

/** `<sourceId>:<url>` — the native half of a series or chapter id. */
function splitNative(native: string): { sourceId: string; url: string } {
  const at = native.indexOf(":");
  if (at < 1) throw new Error(`not a dalvik id: ${native}`);
  return { sourceId: native.slice(0, at), url: native.slice(at + 1) };
}

/**
 * The provider. Ids stay in the app's namespaced form so a row from this host and a row
 * from Suwayomi or the device library can never collide:
 *
 *   source    mihon:src:<sourceId>
 *   series    mihon:<sourceId>:<manga url>
 *   chapter   mihon:ch:<sourceId>:<chapter url>
 */
export function createDalvikProvider(options: DalvikProviderOptions): SourceProvider {
  const { client } = options;
  const titles = options.titles ?? new Map<string, string>();
  const kind: ProviderKind = "mihon";

  function extensionFor(sourceId: string): InstalledExtension {
    const found = options.extensions.find((extension) => extension.sources.some((source) => source.id === sourceId));
    if (found === undefined) {
      throw new Error(`no installed extension exposes source ${sourceId} — install or re-enable it`);
    }
    return found;
  }

  function toSeries(sourceId: string, manga: DalvikManga): Series {
    const id = joinId(kind, `${sourceId}:${manga.url}`);
    if (typeof manga.title === "string" && manga.title !== "") titles.set(id, manga.title);
    return {
      id,
      provider: kind,
      title: manga.title ?? titles.get(id) ?? "",
      ...(client.asset(manga.thumbnail_url) === undefined ? {} : { cover: client.asset(manga.thumbnail_url) }),
      ...(typeof manga.author === "string" ? { author: manga.author } : {}),
      ...(typeof manga.description === "string" ? { description: manga.description } : {}),
    };
  }

  /** The runtime needs the manga's url to answer; the title only improves its cache key. */
  function mangaDataFor(seriesId: string): DalvikManga {
    const { url } = splitNative(nativeId(seriesId, kind));
    const title = titles.get(seriesId);
    return { url, initialized: true, ...(title === undefined ? {} : { title }) };
  }

  function toChapter(sourceId: string, chapter: DalvikChapter): Chapter {
    const number = typeof chapter.chapter_number === "number" && chapter.chapter_number > 0 ? chapter.chapter_number : 0;
    return {
      id: joinId(kind, `ch:${sourceId}:${chapter.url}`),
      seriesId: "",
      name: chapter.name,
      number,
      pageCount: 0,
      read: false,
    };
  }

  return {
    kind,
    /**
     * Our database is the only place a read mark can live for this host: the runtime has
     * no read-state API, so `setRead` refuses rather than pretending to write somewhere.
     */
    ownsProgress: true,

    async sources(): Promise<Source[]> {
      return options.extensions.flatMap((extension) =>
        extension.sources.map((source) => ({
          id: joinId(kind, `src:${source.id}`),
          provider: kind,
          name: source.name,
          ...(source.lang === undefined ? {} : { lang: source.lang }),
        })),
      );
    },

    async popular(sourceId: string, page: number): Promise<Paged<Series>> {
      const extension = extensionFor(sourceId);
      const result = await client.call<{ mangas: DalvikManga[]; hasNextPage: boolean }>({
        method: "getPopularManga",
        extensionId: extension.extensionId,
        sourceId,
        page,
      });
      return paged((result.body.mangas ?? []).map((manga) => toSeries(sourceId, manga)), result.body.hasNextPage === true);
    },

    async latest(sourceId: string, page: number): Promise<Paged<Series>> {
      const extension = extensionFor(sourceId);
      const result = await client.call<{ mangas: DalvikManga[]; hasNextPage: boolean }>({
        method: "getLatestManga",
        extensionId: extension.extensionId,
        sourceId,
        page,
      });
      return paged((result.body.mangas ?? []).map((manga) => toSeries(sourceId, manga)), result.body.hasNextPage === true);
    },

    async search(sourceId: string, query: string, page: number): Promise<Paged<Series>> {
      const extension = extensionFor(sourceId);
      const result = await client.call<{ mangas: DalvikManga[]; hasNextPage: boolean }>({
        method: "getSearchManga",
        extensionId: extension.extensionId,
        sourceId,
        page,
        search: query,
      });
      return paged((result.body.mangas ?? []).map((manga) => toSeries(sourceId, manga)), result.body.hasNextPage === true);
    },

    async details(seriesId: string): Promise<Series> {
      const { sourceId, url } = splitNative(nativeId(seriesId, kind));
      const extension = extensionFor(sourceId);
      const result = await client.call<DalvikManga>({
        method: "getDetailsManga",
        extensionId: extension.extensionId,
        sourceId,
        mangaData: { url, initialized: true },
      });
      return toSeries(sourceId, result.body);
    },

    async chapters(seriesId: string): Promise<Chapter[]> {
      const { sourceId } = splitNative(nativeId(seriesId, kind));
      const extension = extensionFor(sourceId);
      const result = await client.call<DalvikChapter[]>({
        method: "getChapterList",
        extensionId: extension.extensionId,
        sourceId,
        mangaData: mangaDataFor(seriesId),
      });
      return (Array.isArray(result.body) ? result.body : []).map((chapter) => ({
        ...toChapter(sourceId, chapter),
        seriesId,
      }));
    },

    async pages(chapterId: string): Promise<Page[]> {
      const { sourceId, url } = splitNative(nativeId(chapterId, kind).replace(/^ch:/, ""));
      const extension = extensionFor(sourceId);
      const result = await client.call<DalvikPage[]>({
        method: "getPageList",
        extensionId: extension.extensionId,
        sourceId,
        chapterData: { url, name: "" },
      });
      const pages = Array.isArray(result.body) ? result.body : [];
      return pages.map((page, index) => {
        const address = client.asset(page.imageUrl) ?? client.asset(page.url);
        if (address === undefined) {
          throw new DalvikError(`page ${index} came back without an image address`, 0);
        }
        return { index: typeof page.index === "number" ? page.index : index, url: address };
      });
    },

    async setRead(chapterId: string, read: boolean): Promise<void> {
      throw new Error(
        `this host has no read-state API, so it cannot set ${chapterId} to read=${String(read)}; read marks live in our database`,
      );
    },
  };
}
