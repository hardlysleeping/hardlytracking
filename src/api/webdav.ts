/**
 * A WebDAV folder as a source — the comics the user already owns, on their own server.
 *
 * **What it is:** Nextcloud, ownCloud, Synology, a NAS, Apache `mod_dav`. No OAuth, no developer
 * account, no token to mint: an address and a login, which is what the person already has. That is
 * the whole reason it exists before Drive in this codebase.
 *
 * **How a folder becomes a library:** one `Series` per comic file in the folder, one chapter each —
 * the same shape an imported CBZ has, because a book is a book. Nothing is downloaded to *list*.
 *
 * **Reading downloads once, then never again.** `pages()` fetches the file the first time it is
 * opened, writes it to the `books` store through `putBook` (exactly what a local import does), and
 * reads the pages out of that copy from then on. So the second open needs no network and no password,
 * and a WebDAV server that goes away does not take the user's library with it. This is the rule the
 * Drive dialog follows too, in the opposite order: there the user picks files to import, here the
 * folder is browsable and the download happens on the first read.
 *
 * **Ids carry the path.** `webdav:ch:<base64url(path relative to the folder)>` — reversible, so a
 * chapter can be fetched from an id alone. A hash would need a mapping table that a fresh install
 * does not have, and a series id that changes when the table is lost is worse than a long id.
 *
 * `PROPFIND` is not a simple request, so a browser tab needs the server to answer a CORS preflight;
 * most do not. The desktop build sends it through Rust's HTTP client and the phone through
 * Capacitor's, and both reach the server directly. The card says so rather than reporting a 403 as a
 * broken address.
 */
import { nativeId, paged, type Chapter, type Page, type Paged, type Series, type Source, type SourceProvider } from "./source";
import type { LibraryStore } from "../lib/db/store";
import { openComic, titleFromFile, kindOf } from "../lib/files/index";
import { keepCover, shrinkToCover } from "../lib/files/cover";

/** Anything that can do what `fetch` does; a parameter so tests need no network. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** One entry in a `PROPFIND` answer. */
export interface DavEntry {
  /** The href as the server sent it: usually a URL path, sometimes an absolute URL. */
  href: string;
  isDir: boolean;
  size?: number;
  modified?: string;
}

const TAG = (name: string) => new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, "i");

/**
 * Read a `multistatus` answer.
 *
 * A regex rather than `DOMParser` on purpose: this module runs in the browser, in the Tauri webview,
 * in the Capacitor webview *and* under `node --test`, and only three of those have a DOM. The shape
 * WebDAV servers actually send is narrow — a list of `response`s each with an `href` and a
 * `propstat` — and RFC 4918 does not allow the parts this reads to be nested inside themselves.
 */
export function parseMultistatus(xml: string): DavEntry[] {
  const entries: DavEntry[] = [];
  const blocks = xml.split(/<(?:[\w.-]+:)?response\b/i).slice(1);
  for (const block of blocks) {
    const href = TAG("href").exec(block)?.[1];
    if (href === undefined) continue;
    const isDir = /<(?:[\w.-]+:)?collection\b/i.test(block);
    const size = TAG("getcontentlength").exec(block)?.[1];
    const modified = TAG("getlastmodified").exec(block)?.[1];
    const entry: DavEntry = { href: decodeEntities(href.trim()), isDir };
    if (size !== undefined && size.trim() !== "") entry.size = Number(size.trim());
    if (modified !== undefined && modified.trim() !== "") entry.modified = modified.trim();
    entries.push(entry);
  }
  return entries;
}

/** `&amp;` and friends appear in hrefs often enough that a name with `&` must not be mangled. */
export function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

/** A file's path relative to the folder, as the id carries it. Percent-decoded. */
export function encodePath(relative: string): string {
  return toBase64Url(relative);
}

export function decodePath(encoded: string): string {
  return fromBase64Url(encoded);
}

/**
 * The path of an href relative to the configured folder, or `null` when it is the folder itself.
 *
 * Servers disagree about whether `href` is absolute (`https://host/dav/files/me/x.cbz`) or a path
 * (`/dav/files/me/x.cbz`), and Nextcloud percent-encodes the whole thing including `%2F`-able
 * characters. Both are folded here so the rest of the module only sees one shape.
 */
export function relativePath(folderUrl: string, href: string): string | null {
  const base = new URL(folderUrl.endsWith("/") ? folderUrl : `${folderUrl}/`);
  const target = new URL(href, base);
  let path = target.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A stray `%` in a file name is not worth failing the listing over.
  }
  const basePath = decodeURIComponent(base.pathname);
  const withSlash = basePath.endsWith("/") ? basePath : `${basePath}/`;
  const trimmed = path.replace(/\/+$/, "");
  const baseTrimmed = withSlash.replace(/\/+$/, "");
  if (trimmed === baseTrimmed) return null;
  if (!trimmed.startsWith(withSlash)) return null;
  return trimmed.slice(withSlash.length);
}

/** The comics in a listing: no folders, no `ComicInfo.xml`, nothing this app cannot open. */
export function comicEntries(entries: readonly DavEntry[], folderUrl: string): { relative: string; entry: DavEntry }[] {
  const out: { relative: string; entry: DavEntry }[] = [];
  for (const entry of entries) {
    if (entry.isDir) continue;
    const relative = relativePath(folderUrl, entry.href);
    if (relative === null || relative === "") continue;
    if (kindOf(relative) === null) continue;
    out.push({ relative, entry });
  }
  return out.sort((a, b) => a.relative.localeCompare(b.relative, undefined, { numeric: true }));
}

/** One book, opened: its ids, how many pages, and how to produce them. */
interface OpenedBook {
  seriesId: string;
  chapterId: string;
  name: string;
  pages: number;
  open: (index: number) => Promise<Blob>;
}

/** Everything the provider needs that is not the network. */
export interface WebdavOptions {
  url: string;
  username: string;
  password: string;
  /** Where a downloaded file is kept, so the second read is local. */
  store: LibraryStore;
  fetchImpl?: Fetcher;
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`;

export class WebdavError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "WebdavError";
    this.status = status;
  }
}

/**
 * Ask a saved address whether it works, for the card's Test button — a listing, counted.
 *
 * Deliberately not a `HEAD` or a `Depth: 0` request: those answer "the server exists", which a
 * wrong folder or a user with no read permission also does. The question the user is asking is
 * "will my comics show up", and only a real listing answers it.
 */
export async function probeWebdav(
  settings: { url: string; username: string; password: string },
  fetcher?: Fetcher,
): Promise<{ ok: boolean; message: string }> {
  const folderUrl = settings.url.replace(/\/+$/, "");
  const doFetch = fetcher ?? fetch;
  const authorization = `Basic ${btoa(`${settings.username}:${settings.password}`)}`;
  try {
    const response = await doFetch(`${folderUrl}/`, {
      method: "PROPFIND",
      headers: { depth: "1", authorization, "content-type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `the server refused the login for "${settings.username}"` };
    }
    if (response.status !== 207 && !response.ok) {
      return { ok: false, message: `the server answered ${response.status}` };
    }
    const comics = comicEntries(parseMultistatus(await response.text()), folderUrl);
    return comics.length === 0
      ? { ok: false, message: "signed in, but no CBZ, CBR, ZIP or PDF in that folder" }
      : { ok: true, message: `${comics.length} comic${comics.length === 1 ? "" : "s"} in that folder` };
  } catch (error) {
    return { ok: false, message: `could not reach ${folderUrl}: ${(error as Error).message}` };
  }
}

export function createWebdavProvider(options: WebdavOptions): SourceProvider {
  const folderUrl = options.url.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const authorization = `Basic ${btoa(`${options.username}:${options.password}`)}`;
  const sourceId = `webdav:src:folder`;
  /**
   * Downloads in flight, by series id.
   *
   * The reader and the quick sheet can both ask for pages before the first download has finished —
   * measured live: two GETs for one book, and the second was pure waste. A second caller now waits
   * on the same promise instead of starting its own.
   */
  const pending = new Map<string, Promise<OpenedBook>>();

  async function list(): Promise<{ relative: string; entry: DavEntry }[]> {
    let response: Response;
    try {
      response = await doFetch(`${folderUrl}/`, {
        method: "PROPFIND",
        headers: { depth: "1", authorization, "content-type": "application/xml; charset=utf-8" },
        body: PROPFIND_BODY,
      });
    } catch (error) {
      throw new WebdavError(`${folderUrl} did not answer: ${(error as Error).message}`, 0);
    }
    if (response.status === 401 || response.status === 403) {
      throw new WebdavError(`the server refused the login for "${options.username}"`, response.status);
    }
    // 207 is the success status for PROPFIND; `ok` is false for it, so it has to be named.
    if (response.status !== 207 && !response.ok) {
      throw new WebdavError(`the server answered ${response.status}`, response.status);
    }
    return comicEntries(parseMultistatus(await response.text()), folderUrl);
  }

  /** The bytes for one file, with the same login. */
  async function download(relative: string): Promise<Blob> {
    const target = new URL(folderUrl + "/");
    target.pathname = `${target.pathname.replace(/\/$/, "")}/${relative.split("/").map(encodeURIComponent).join("/")}`;
    let response: Response;
    try {
      response = await doFetch(target.toString(), { headers: { authorization } });
    } catch (error) {
      throw new WebdavError(`${relative} could not be downloaded: ${(error as Error).message}`, 0);
    }
    if (response.status === 401 || response.status === 403) {
      throw new WebdavError(`the server refused the login for "${options.username}"`, response.status);
    }
    if (!response.ok) throw new WebdavError(`${relative}: the server answered ${response.status}`, response.status);
    return await response.blob();
  }

  /** The folder as series rows, filtered by a query that the user typed. */
  async function folder(query: string): Promise<Paged<Series>> {
    const needle = query.toLowerCase().trim();
    const entries = await list();
    const items: Series[] = entries
      .filter(({ relative }) => needle === "" || relative.toLowerCase().includes(needle))
      .map(({ relative }) => ({
        id: `webdav:${encodePath(relative)}`,
        provider: "webdav" as const,
        title: titleFromFile(relative.split("/").pop() ?? relative),
      }));
    return paged(items, false);
  }

  /** The stored copy, downloading it first if this is the first read. */
  async function book(relative: string): Promise<OpenedBook> {
    const seriesId = `webdav:${encodePath(relative)}`;
    const chapterId = `webdav:ch:${encodePath(relative)}`;
    const name = relative.split("/").pop() ?? relative;

    const stored = await options.store.getBook(seriesId);
    if (stored !== undefined) {
      const comic = await openComic(stored.blob, stored.name);
      void coverOf(seriesId, (index) => comic.open(index));
      return { seriesId, chapterId, name: stored.name, pages: comic.pageCount, open: (index) => comic.open(index) };
    }

    const running = pending.get(seriesId);
    if (running !== undefined) return await running;

    const work = (async (): Promise<OpenedBook> => {
      const blob = await download(relative);
      const comic = await openComic(blob, name);
      await options.store.putBook({
        seriesId,
        chapterId,
        name,
        kind: kindOf(name) ?? "cbz",
        pageCount: comic.pageCount,
        bytes: blob.size,
        blob,
        addedAt: Date.now(),
      });
      void coverOf(seriesId, (index) => comic.open(index));
      return { seriesId, chapterId, name, pages: comic.pageCount, open: (index) => comic.open(index) };
    })();
    pending.set(seriesId, work);
    try {
      return await work;
    } finally {
      pending.delete(seriesId);
    }
  }

  /**
   * A shelf cover for a book that had none, drawn from its own page 1.
   *
   * A WebDAV book is in the library before anyone knows what it looks like — the listing is names, not
   * pictures — so it drew the title fallback until it was read. The first read now leaves a cover
   * behind. Failure is silent on purpose: a cover is a nicety, and the book just opened fine.
   */
  async function coverOf(seriesId: string, open: (index: number) => Promise<Blob>): Promise<void> {
    try {
      const picture = await shrinkToCover(await open(0));
      const key = await keepCover(seriesId, picture);
      if (key !== "") await options.store.setSeriesCover(seriesId, key);
    } catch {
      // No canvas, no cover: the title fallback is still there.
    }
  }

  return {
    kind: "webdav",
    // A folder has no read state to write back to: the server would have to store one, and WebDAV
    // is a file protocol. Progress is ours, exactly like a file imported from this device.
    ownsProgress: true,

    async setRead(): Promise<void> {
      // Never reached while `ownsProgress` is true; refusing by name is the rule for a provider that
      // cannot honour a call, and a folder is not somewhere to write a read mark.
      throw new WebdavError("a WebDAV folder keeps no read state — progress stays on this device", 0);
    },

    async sources(): Promise<Source[]> {
      return [{ id: sourceId, provider: "webdav", name: "WebDAV", supportsLatest: false }];
    },

    /** The folder is the whole listing; there is no "popular" on a WebDAV server, so all three agree. */
    async popular(_sourceId: string, _page: number): Promise<Paged<Series>> {
      return await folder("");
    },

    async latest(_sourceId: string, _page: number): Promise<Paged<Series>> {
      return await folder("");
    },

    async search(_sourceId: string, query: string, _page: number): Promise<Paged<Series>> {
      return await folder(query);
    },

    async details(seriesId: string): Promise<Series> {
      const relative = decodePath(nativeId(seriesId, "webdav"));
      const name = relative.split("/").pop() ?? relative;
      return { id: seriesId, provider: "webdav", title: titleFromFile(name) };
    },

    async chapters(seriesId: string): Promise<Chapter[]> {
      const relative = decodePath(nativeId(seriesId, "webdav"));
      const name = relative.split("/").pop() ?? relative;
      const stored = await options.store.getBook(seriesId);
      return [
        {
          id: `webdav:ch:${encodePath(relative)}`,
          seriesId,
          name: titleFromFile(name),
          number: 1,
          pageCount: stored?.pageCount ?? 0,
          read: false,
        },
      ];
    },

    async pages(chapterId: string): Promise<Page[]> {
      const relative = decodePath(nativeId(chapterId, "webdav").replace(/^ch:/, ""));
      const opened = await book(relative);
      return Array.from({ length: opened.pages }, (_, index): Page => ({
        index,
        // The same pseudo-URL an imported file uses, so the blob cache keeps one URL per page while
        // the reader's window holds it, and `Page.open` produces the bytes.
        url: `webdav-book:${opened.seriesId}:${index}`,
        open: () => opened.open(index),
      }));
    },
  };
}
