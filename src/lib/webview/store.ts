/**
 * Where this device keeps cookies.
 *
 * The runtime has a cookie jar and it is **memory only**: `MemoryCookieJar`, inside the loaded
 * extension's `NetworkHelper`, gone when the process is. There is no route that reads it back
 * either, so the app cannot ask "what did the site set?" — which leaves two jobs only the app can
 * do:
 *
 * 1. **Remember what a login produced.** A WebView hands us `Set-Cookie` strings; if they only
 *    live in the WebView's store, the next runtime process starts logged out (matrix row HTTP-07,
 *    "cookie restart").
 * 2. **Send them again on every call.** The runtime adopts a `Cookie:` header per request, so
 *    sharing is not a one-off hand-off at login: it is this jar, read on every `/dalvik` call.
 *
 * Both engines are here for the same reason `db/open.ts` has two: the browser/PWA build and a
 * test both run without SQLite, and the packaged app will use the same `Database` seam.
 */
import type { Database } from "../db/open";
import { cookieKey, cookiesFor, domainMatches, isLive, mergeCookies, parseSetCookie, type StoredCookie } from "./cookies";

export interface CookieJar {
  /** The `Cookie:` header for a host, or `undefined` when nothing applies. */
  header(host: string): Promise<string | undefined>;
  /**
   * Store what a page or the runtime handed us. `host` scopes a cookie that names no domain.
   * Returns how many cookies the jar holds for that host afterwards.
   */
  remember(host: string, setCookie: string[]): Promise<number>;
  /** Every live cookie for a host — what a settings screen shows and a test asserts on. */
  list(host: string): Promise<StoredCookie[]>;
  /** Clear one host's cookies, or all of them. Logging out is this call (matrix row WEB-05). */
  clear(host?: string): Promise<void>;
}

/** A jar over the app's database. One row per domain, path and name, keyed `key`. */
export function dbCookieJar(db: Database, now: () => number = Date.now): CookieJar {
  async function rows(): Promise<StoredCookie[]> {
    return db.all<StoredCookie>("cookies");
  }

  async function save(next: StoredCookie[]): Promise<void> {
    // One pass over what is there, then a write per row that changed. The jar is small — a few
    // dozen cookies for a handful of sources — so a full reconcile is cheaper than tracking keys.
    const current = await rows();
    const wanted = new Map(next.map((cookie) => [cookieKey(cookie), cookie]));
    for (const [key, cookie] of wanted) {
      const before = current.find((row) => cookieKey(row) === key);
      if (before === undefined || before.value !== cookie.value || before.expires !== cookie.expires) {
        await db.put("cookies", { ...cookie, key });
      }
    }
    for (const row of current) {
      const key = cookieKey(row);
      if (!wanted.has(key) || !isLive(row, now())) await db.remove("cookies", key);
    }
  }

  return {
    async header(host: string) {
      const cookies = await rows();
      const live = cookiesFor(cookies, host, now());
      if (live.length === 0) return undefined;
      return live.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    },

    async remember(host: string, setCookie: string[]) {
      const incoming = setCookie
        .map((raw) => parseSetCookie(raw, host, now()))
        .filter((cookie): cookie is StoredCookie => cookie !== null);
      if (incoming.length === 0) return cookiesFor(await rows(), host, now()).length;
      const merged = mergeCookies(await rows(), incoming, now());
      await save(merged);
      return cookiesFor(merged, host, now()).length;
    },

    async list(host: string) {
      return cookiesFor(await rows(), host, now());
    },

    async clear(host?: string) {
      const current = await rows();
      const keep = host === undefined ? [] : current.filter((row) => !domainMatches(row.domain, host));
      await save(keep);
    },
  };
}

/**
 * A jar in memory, for a build with no database open yet and for tests.
 *
 * It has the same shape on purpose: the seam is exercised through this one in the unit tests, and
 * a difference between the two would be a difference between what is tested and what ships.
 */
export function memoryCookieJar(now: () => number = Date.now): CookieJar {
  let rows: StoredCookie[] = [];
  return {
    async header(host: string) {
      const live = cookiesFor(rows, host, now());
      if (live.length === 0) return undefined;
      return live.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    },
    async remember(host: string, setCookie: string[]) {
      const incoming = setCookie
        .map((raw) => parseSetCookie(raw, host, now()))
        .filter((cookie): cookie is StoredCookie => cookie !== null);
      rows = mergeCookies(rows, incoming, now());
      return cookiesFor(rows, host, now()).length;
    },
    async list(host: string) {
      return cookiesFor(rows, host, now());
    },
    async clear(host?: string) {
      rows = host === undefined ? [] : rows.filter((row) => !(row.domain === host || row.domain.endsWith(`.${host}`)));
    },
  };
}
