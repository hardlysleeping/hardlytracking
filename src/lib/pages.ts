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
