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
import { imageCache } from "./cache/images";

/**
 * The URL to put in an `<img>` for one page, asynchronously, when the source needs a header.
 *
 * `/api/img` is the right answer for a *remote* source that wants a `Referer`: our server can send
 * what a browser cannot. It is the wrong answer for a server on the private network — that route
 * refuses private addresses, and a Komga is nearly always one — so a page that carries a header is
 * fetched here instead and handed back as a blob. Both paths end in one string the reader uses.
 */
export async function pageSrc(page: Page): Promise<string> {
  // A page this device can produce itself (an image inside a CBZ, a PDF page): the reader asks for it
  // when it is near the viewport, and the blob URL is reused while the page stays in the window.
  if (page.open !== undefined) return localPageSrc(page);
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

async function localPageSrc(page: Page): Promise<string> {
  const cached = localPages.get(page.url);
  if (cached !== undefined) {
    localPages.delete(page.url);
    localPages.set(page.url, cached);
    return cached;
  }
  const blob = await page.open!();
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
