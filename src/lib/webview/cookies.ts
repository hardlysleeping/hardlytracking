/**
 * Cookies: the rules, with no platform and no storage in them.
 *
 * Two very different things call a cookie a cookie, and this file is where they are made to
 * agree:
 *
 * - **The site's**, collected by a WebView when a person logs in (`Set-Cookie`), or handed back
 *   by the runtime on a `/dalvik` response.
 * - **The runtime's**, which takes cookies only as one `Cookie:` request header on the next
 *   `/dalvik` call — it parses that header itself and puts the pairs into the extension's own
 *   jar, scoped to the *source's* base url host (verified against M-Extension-Server v1.0.9:
 *   `DalvikHandler` splits the header on `;`, builds `okhttp3.Cookie`s with `path=/` and that
 *   host, and calls `NetworkHelper.getCookieJar().addAll(...)`).
 *
 * So a cookie the app holds has to be reducible to `name=value` for a host, and a cookie the
 * app receives has to be storable under the host it belongs to. Everything here is synchronous
 * and pure: the store (`store.ts`) and the seam (`index.ts`) are the parts that touch a device.
 *
 * The domain rule is the browser's, not a guess: a cookie with `Domain=` covers that domain and
 * its subdomains; a cookie without one belongs to exactly the host that set it. That is what
 * keeps two sources on two sites from seeing each other's session (matrix row HTTP-08).
 */

/** One cookie, as this device keeps it. */
export interface StoredCookie {
  /** The host it belongs to: lowercase, no leading dot, no port. */
  domain: string;
  name: string;
  value: string;
  /** Almost always `/`; kept because two cookies of the same name can differ by path. */
  path: string;
  /** Epoch ms. Absent means a session cookie — kept until the app clears it. */
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
}

/**
 * The host a URL or base url belongs to, or `null` when it has none.
 *
 * A bare host is accepted too, because the runtime reports a source's `baseUrl` and a person can
 * type `toonily.com` into a settings field. A `data:` or `about:` address has no host and is
 * refused rather than turned into `"null"`.
 */
export function hostOf(address: string): string | null {
  const raw = address.trim();
  if (raw === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const host = new URL(withScheme).hostname.toLowerCase().replace(/^\.+|\.+$/g, "");
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/** A `Domain=` attribute as a comparable host: lowercase, no leading dot, no trailing dot. */
export function normaliseDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
}

/**
 * Whether a cookie scoped to `domain` may be sent to `host`.
 *
 * `example.com` matches `example.com` and `cdn.example.com`, never `notexample.com` — the dot is
 * part of the test, which is the whole reason this is not `endsWith(domain)`.
 */
export function domainMatches(domain: string, host: string): boolean {
  const target = host.toLowerCase();
  const scope = normaliseDomain(domain);
  if (scope === "" || target === "") return false;
  return target === scope || target.endsWith(`.${scope}`);
}

/** The key a cookie is stored under: one row per host, path and name, as a browser would. */
export function cookieKey(cookie: StoredCookie): string {
  return `${normaliseDomain(cookie.domain)}\t${cookie.path === "" ? "/" : cookie.path}\t${cookie.name}`;
}

/**
 * One `Set-Cookie` header, as a stored cookie — or `null` when there is nothing usable in it.
 *
 * `host` is the page's host: it is the cookie's domain when the header names none, and it is what
 * an unqualified cookie belongs to. `now` is passed in so a test can expire a cookie without
 * waiting for one.
 */
export function parseSetCookie(raw: string, host: string, now: number = Date.now()): StoredCookie | null {
  const parts = raw.split(";");
  const pair = parts.shift() ?? "";
  const at = pair.indexOf("=");
  if (at <= 0) return null;
  const name = pair.slice(0, at).trim();
  const value = pair.slice(at + 1).trim();
  if (name === "") return null;

  const cookie: StoredCookie = {
    domain: normaliseDomain(host),
    name,
    value,
    path: "/",
  };

  for (const attribute of parts) {
    const eq = attribute.indexOf("=");
    const key = (eq < 0 ? attribute : attribute.slice(0, eq)).trim().toLowerCase();
    const val = eq < 0 ? "" : attribute.slice(eq + 1).trim();
    if (key === "domain" && val !== "") cookie.domain = normaliseDomain(val);
    else if (key === "path" && val.startsWith("/")) cookie.path = val;
    else if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "max-age") {
      const seconds = Number(val);
      // `Max-Age=0` is the standard way to delete a cookie: store it already expired, so the
      // merge removes the old row instead of leaving a live one behind.
      if (Number.isFinite(seconds)) cookie.expires = now + seconds * 1000;
    } else if (key === "expires") {
      const at = Date.parse(val);
      if (Number.isFinite(at)) cookie.expires = at;
    }
  }

  return cookie;
}

/**
 * A `Cookie:` header as stored cookies, all scoped to `host`.
 *
 * The runtime hands the pairs back one way and a WebView hands them back another, so this is the
 * other direction of the same conversion. Attributes are ignored: a `Cookie` header has none.
 */
export function parseCookieHeader(raw: string, host: string): StoredCookie[] {
  const cookies: StoredCookie[] = [];
  for (const part of raw.split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    if (name === "") continue;
    cookies.push({
      domain: normaliseDomain(host),
      name,
      value: part.slice(at + 1).trim(),
      path: "/",
    });
  }
  return cookies;
}

/** Whether a stored cookie is still alive at `now`. A session cookie (`expires` absent) is. */
export function isLive(cookie: StoredCookie, now: number = Date.now()): boolean {
  return cookie.expires === undefined || cookie.expires > now;
}

/**
 * The `Cookie:` header for a host, or `undefined` when nothing applies.
 *
 * Sorted by name so the same jar always produces the same header: the runtime dedupes by name and
 * a stable order keeps two calls comparable in a log.
 */
export function cookieHeader(cookies: StoredCookie[], host: string, now: number = Date.now()): string | undefined {
  const live = cookies
    .filter((cookie) => isLive(cookie, now) && domainMatches(cookie.domain, host))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (live.length === 0) return undefined;
  return live.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/**
 * The jar after `incoming` arrives: same key replaces, expired ones are dropped.
 *
 * A cookie that arrives already expired (a logout's `Max-Age=0`) *deletes* the stored row rather
 * than replacing it — otherwise logging out would leave the session live in our store forever,
 * which is matrix row WEB-05 failing quietly.
 */
export function mergeCookies(current: StoredCookie[], incoming: StoredCookie[], now: number = Date.now()): StoredCookie[] {
  const byKey = new Map(current.filter((cookie) => isLive(cookie, now)).map((cookie) => [cookieKey(cookie), cookie]));
  for (const cookie of incoming) {
    const key = cookieKey(cookie);
    if (isLive(cookie, now)) byKey.set(key, cookie);
    else byKey.delete(key);
  }
  return [...byKey.values()].sort((a, b) => cookieKey(a).localeCompare(cookieKey(b)));
}

/** Everything stored for a host, live or not — a settings screen wants to show what is there. */
export function cookiesFor(cookies: StoredCookie[], host: string, now: number = Date.now()): StoredCookie[] {
  return cookies
    .filter((cookie) => isLive(cookie, now) && domainMatches(cookie.domain, host))
    .sort((a, b) => cookieKey(a).localeCompare(cookieKey(b)));
}
