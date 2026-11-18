import { apiUrl, hasLocalServer, withToken } from "./host";

/**
 * Any remote image through our own `/api/img`: page images need headers, extension icons need a
 * host that does not answer a bare `<img>`, and one route means one place where a token is added.
 */
export function proxiedImage(url: string): string {
  // No server of our own (a packaged app with no desktop paired): point the <img> at the URL. An
  // image request needs no CORS, and `/api/img` there is the SPA's index.html, not a picture.
  if (!hasLocalServer()) return url;
  return withToken(apiUrl(`/api/img?url=${encodeURIComponent(url)}`));
}

/**
 * Turning a page into something an `<img>` can load.
 *
 * Most pages are a plain URL. Some sources (MangaFire among them) answer 403 unless the request
 * carries their `Referer` and `Origin`, and a browser will not let us set those on an image — so
 * the page is fetched by our own server, which can. The rule lives here so the reader and the
 * downloader cannot disagree about it.
 */
import type { Page } from "../api/source";
import { transport } from "../api/transport";
import { imageCache } from "./cache/images";
import { DeadlineError, withDeadline } from "./deadline";

/**
 * The URL to put in an `<img>` for one page, asynchronously, when the source needs a header.
 *
 * `/api/img` is the right answer for a *remote* source that wants a `Referer`: our server can send
 * what a browser cannot. It is the wrong answer for a server on the private network — that route
 * refuses private addresses, and a Komga is nearly always one — so a page that carries a header is
 * fetched here instead and handed back as a blob. Both paths end in one string the reader uses.
 */
export async function pageSrc(page: Page, signal?: AbortSignal): Promise<string> {
  // A page this device can produce itself (an image inside a CBZ, a PDF page): the reader asks for it
  // when it is near the viewport, and the blob URL is reused while the page stays in the window.
  if (page.open !== undefined) return localPageSrc(page, signal);
  if (page.headers === undefined || Object.keys(page.headers).length === 0) return page.url;
  // Two reasons to fetch the bytes here instead of pointing at the proxy: there is no proxy (a
  // packaged app), or the source is on the private network and `/api/img` refuses those by design.
  if (!hasLocalServer() || isPrivate(page.url)) {
    return imageCache.resolve(page.url, { headers: page.headers });
  }
  return imageSrc(page);
}

/** Loopback and the RFC1918 ranges: an address `/api/img` will refuse. */
export function isPrivate(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * A locally produced page, as a blob URL.
 *
 * The reader keeps nine pages mounted and asks again when the window moves, so a page is fetched once
 * and reused — but only a handful are held: a 200-page book would otherwise pin every decoded scan in
 * the process, which is the fault the reader's window exists to avoid.
 */
const LOCAL_PAGE_LIMIT = 12;
const localPages = new Map<string, string>();

/**
 * How long one page may take to be produced here.
 *
 * A page out of a zip is milliseconds; a PDF page is pdf.js drawing a JPEG. A page encoded as JPEG
 * 2000 takes pdf.js *minutes*, because it decodes that format in JavaScript — so the wait has an end
 * and a sentence, rather than a box that stays blank for as long as the tab is open.
 */
const LOCAL_PAGE_DEADLINE_MS = 45_000;

async function localPageSrc(page: Page, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const cached = localPages.get(page.url);
  if (cached !== undefined) {
    localPages.delete(page.url);
    localPages.set(page.url, cached);
    return cached;
  }
  const label = `page ${page.index + 1}`;
  let blob: Blob;
  try {
    blob = await withDeadline(page.open!(), LOCAL_PAGE_DEADLINE_MS, label, signal);
  } catch (error) {
    if (error instanceof DeadlineError) {
      throw new Error(`${label} is still being drawn after ${Math.round(error.ms / 1000)} s — this book's page encoding is slow to decode`);
    }
    throw error;
  }
  signal?.throwIfAborted();
  const url = URL.createObjectURL(blob);
  localPages.set(page.url, url);
  while (localPages.size > LOCAL_PAGE_LIMIT) {
    const oldest = localPages.keys().next();
    if (oldest.done === true) break;
    const stale = localPages.get(oldest.value);
    localPages.delete(oldest.value);
    if (stale !== undefined) URL.revokeObjectURL(stale);
  }
  return url;
}

/** Forget every locally produced page — used when a book is closed. */
export function forgetLocalPages(): void {
  for (const url of localPages.values()) URL.revokeObjectURL(url);
  localPages.clear();
}

/**
 * A second attempt at one page, after an `<img>` already failed on it.
 *
 * Repeating the same `<img src>` repeats the same request, so it fails the same way: no `Referer`
 * that the host insists on, a webview origin the host refuses, an at-home URL whose token has
 * expired, or a CORS-less fetch the browser will not even report. The bytes are therefore asked for
 * here through the native transport — the same Rust-side client the sources use, which is not
 * subject to the webview's origin rules — with the page's own headers, and handed back as a blob
 * URL. One attempt: a page that fails twice is a page that is not going to load, and a control that
 * keeps retrying hides that.
 */
export async function retryPageSrc(page: Page, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (page.open !== undefined) return localPageSrc(page, signal);
  const label = `page ${page.index + 1}`;
  const response = await withDeadline(
    transport(page.url, { headers: page.headers, signal }),
    LOCAL_PAGE_DEADLINE_MS,
    label,
    signal,
  );
  if (!response.ok) throw new Error(`${label} could not be fetched (${response.status})`);
  const blob = await response.blob();
  if (blob.size === 0) throw new Error(`${label} came back empty`);
  signal?.throwIfAborted();
  const url = URL.createObjectURL(blob);
  // Bounded like the locally produced pages: a shelf of retries must not pin every scan in memory.
  retried.set(page.url, url);
  while (retried.size > LOCAL_PAGE_LIMIT) {
    const oldest = retried.keys().next();
    if (oldest.done === true) break;
    const stale = retried.get(oldest.value);
    retried.delete(oldest.value);
    if (stale !== undefined) URL.revokeObjectURL(stale);
  }
  return url;
}

/** Blob URLs produced by a retry, keyed by the page URL that needed one. */
const retried = new Map<string, string>();

/** Forget every retried page, and any blob URLs they are still holding. */
export function forgetRetriedPages(): void {
  for (const url of retried.values()) URL.revokeObjectURL(url);
  retried.clear();
}

export function imageSrc(page: Page): string {
  if (page.headers === undefined || Object.keys(page.headers).length === 0) return page.url;
  const encoded = base64url(JSON.stringify(page.headers));
  return withToken(apiUrl(`/api/img?url=${encodeURIComponent(page.url)}&h=${encoded}`));
}

function base64url(text: string): string {
  // `btoa` is Latin-1; a header value can be anything, so go through UTF-8 first.
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
