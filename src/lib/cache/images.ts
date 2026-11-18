/**
 * Image cache: covers and page images, on this device, behind a ceiling.
 *
 * Why it exists: a source list re-downloads every cover on every visit, and a phone on a train
 * should still show the shelf. The rule from HardlyReader's cache carries over — the *list* is data
 * and is never evicted; only *copies* are, and the ceiling is a number the user chose.
 *
 * Storage is the app's own database: an `imageCache` row (key, bytes, at, usedAt) per picture and
 * its bytes in `imageCacheData` under the same key. The two are separate because they are written
 * for different reasons — a hit rewrites `usedAt` every time a cover is drawn, and that must not
 * re-encode a megabyte of JPEG to say "seen just now".
 * Reads return an object URL; the raw URL is the fallback when the cache is off, full, or the fetch
 * failed — a cover that cannot be cached must still be a cover.
 */
import type { Database } from "../db/open";
import {
  CACHE_POLICY_DEFAULT,
  planEviction,
  measureCache,
  type CacheEntry,
  type CachePolicy,
} from "./policy";

interface ImageRow {
  key: string;
  /** Absent on rows written since the bytes moved to `imageCacheData`. */
  blob?: Blob;
  bytes: number;
  at: number;
  usedAt: number;
}

/** The bytes for one cached picture, keyed like its row. */
interface ImageBytes {
  key: string;
  blob: Blob;
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/**
 * How many object URLs are held at once.
 *
 * Every resolved image is a `blob:` URL, and a blob URL pins its bytes in this process until it is
 * revoked — a cache that only counted the rows on disk kept thousands of covers alive in memory.
 * The bytes are still in the database, so dropping one from this map costs a re-read, never a
 * re-download.
 */
const MAX_LIVE_URLS = 160;
/** Covers are small; a page image is not. Refuse absurd things rather than fill the disk. */
const ALLOWED = /^image\//i;
/**
 * A key that is not a URL: a picture this app produced itself, such as a book's first page.
 *
 * It lives in the same store as the downloaded covers — one place for pictures, one ceiling, one
 * Settings sentence — but it is never fetched and never treated as a copy of anything remote.
 */
export const STORED_IMAGE_SCHEME = "book:";


export class ImageCache {
  private db: Database | null = null;
  /**
   * How bytes are fetched.
   *
   * A plain `fetch` is right on an http(s) origin (the browser, the self-hosted build) and useless
   * inside Tauri, where the webview is its own origin and a cover on archive.org has no CORS header:
   * the fetch failed, so the cover was never stored and every launch re-downloaded it. `transport`
   * (`api/transport.ts`) is the same seam the providers use — Rust does the request there.
   */
  private fetcher: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init);
  private urls = new Map<string, string>();
  private inflight = new Map<string, Promise<string>>();
  /**
   * Object URLs dropped from `urls` but not yet revoked.
   *
   * Trimming used to revoke the oldest URL the moment it left the map, and an `<img>` on another
   * screen — History, a search grid, the library — could still be pointing at it: the picture went
   * blank and stayed blank. A URL now survives one whole trim cycle before its bytes are released,
   * which is longer than any screen takes to re-render, and `Cover` re-asks for the picture if it
   * still loses the race (the bytes are in the database, so that is a re-read, never a re-download).
   */
  private retiring: string[] = [];
  policy: CachePolicy = { ...CACHE_POLICY_DEFAULT };

  attach(db: Database, policy?: Partial<CachePolicy>, fetcher?: (input: string, init?: RequestInit) => Promise<Response>): void {
    this.db = db;
    if (policy !== undefined) this.policy = { ...this.policy, ...policy };
    if (fetcher !== undefined) this.fetcher = fetcher;
  }

  setPolicy(policy: Partial<CachePolicy>): void {
    this.policy = { ...this.policy, ...policy };
    void this.prune();
  }

  /** Every row, for the Settings sentence and for eviction. */
  async entries(): Promise<CacheEntry[]> {
    if (this.db === null) return [];
    const rows = await this.db.all<ImageRow>("imageCache");
    return rows.map((row) => ({
      key: row.key,
      bytes: row.bytes,
      at: row.at,
      usedAt: row.usedAt,
      // A picture this app drew itself is not a copy of anything remote: an owned book has no
      // network to fall back on, so evicting its cover would blank it permanently. Never in the plan.
      pinned: row.key.startsWith(STORED_IMAGE_SCHEME),
    }));
  }

  async usage(): Promise<number> {
    return measureCache(await this.entries());
  }

  /**
   * The URL to put in an `<img>`.
   *
   * Cached → an object URL. Not cached → the network URL *and* a background fetch that stores it,
   * so the second visit is instant. `null` means "do not cache this" (a blob:, a data:).
   */
  async resolve(url: string, options: { fetch?: boolean; headers?: Record<string, string> } = {}): Promise<string> {
    // A picture this app drew itself is served first and unconditionally: switching the cover cache
    // off is about not keeping copies downloaded from the network, and an owned book has no network
    // to fall back on — its cover would blank to the title.
    if (url.startsWith(STORED_IMAGE_SCHEME)) return await this.stored(url);
    if (this.db === null) return url;

    // Covers and page images go through the app's own `/api/img` proxy, so the interesting URLs are
    // same-origin paths, not absolute ones. A blob: or data: URL is already local — never cached.
    if (!/^(https?:|\/)/i.test(url)) return url;

    // Caching off means "keep no copies of what the network gave us". A cover that needs the login
    // has no anonymous URL an `<img>` could draw, so it is still fetched — into this session's
    // object URLs only, never onto the disk — or the tile would read "not available" for good.
    if (!this.policy.cacheImages && options.headers === undefined) return url;

    const cached = this.urls.get(url);
    if (cached !== undefined) {
      // Re-insert so the map's order is least-recently-used first: `trimLive` drops from the front.
      this.urls.delete(url);
      this.urls.set(url, cached);
      void this.touch(url);
      return cached;
    }
    if (options.fetch === false) return url;

    const pending = this.inflight.get(url);
    if (pending !== undefined) return pending;

    const task = (async (): Promise<string> => {
      try {
        const row = await this.db!.get<ImageRow>("imageCache", url);
        const bytes = row === undefined ? undefined : await this.bytesOf(row);
        if (bytes !== undefined) {
          const objectUrl = URL.createObjectURL(bytes);
          this.urls.set(url, objectUrl);
          this.trimLive();
          void this.touch(url);
          return objectUrl;
        }
        // A source that will not serve an image to an anonymous request (Komga) hands its URL with
        // the header it needs; this is the only place those bytes are fetched.
        const response = await this.fetcher(url, options.headers === undefined ? {} : { headers: options.headers });
        if (!response.ok) return url;
        const type = response.headers.get("content-type") ?? "";
        if (!ALLOWED.test(type)) return url;
        const blob = await response.blob();
        if (blob.size === 0 || blob.size > MAX_IMAGE_BYTES) return url;
        // With the cache switched off the bytes live for this session only: same object URL, same
        // trimming, no row on disk.
        if (this.policy.cacheImages) await this.keep(url, blob);
        const objectUrl = URL.createObjectURL(blob);
        this.urls.set(url, objectUrl);
        this.trimLive();
        void this.prune();
        return objectUrl;
      } catch {
        return url; // a cache miss is not an error: the plain URL still renders
      } finally {
        this.inflight.delete(url);
      }
    })();

    this.inflight.set(url, task);
    return task;
  }

  /**
   * Keep a picture this app produced — a book's first page, drawn once at import.
   *
   * Storage, not a downloaded copy: it is served even with the image cache switched off, because a
   * book the user owns must still have a cover. Returns whether it was actually kept; without a
   * database there is nowhere to keep it, and the caller should then write no cover at all.
   */
  async remember(key: string, blob: Blob): Promise<boolean> {
    if (this.db === null) return false;
    const objectUrl = URL.createObjectURL(blob);
    this.urls.delete(key);
    this.urls.set(key, objectUrl);
    this.trimLive();
    await this.keep(key, blob);
    void this.prune();
    return true;
  }

  /** Write one picture: its description in the index, its bytes beside it. */
  private async keep(key: string, blob: Blob): Promise<void> {
    const now = Date.now();
    await this.db!.put("imageCache", { key, bytes: blob.size, at: now, usedAt: now } as unknown as Record<string, unknown>);
    await this.db!.put("imageCacheData", { key, blob });
  }

  /** The bytes for a row, from where they are: beside it (new rows) or inside it (old ones). */
  private async bytesOf(row: ImageRow): Promise<Blob | undefined> {
    if (row.blob !== undefined) return row.blob;
    const bytes = await this.db!.get<ImageBytes>("imageCacheData", row.key);
    return bytes?.blob;
  }

  /** The object URL for a stored picture, or the key back when nothing is stored under it. */
  private async stored(key: string): Promise<string> {
    const live = this.urls.get(key);
    if (live !== undefined) return live;
    if (this.db === null) return key;
    const row = await this.db.get<ImageRow>("imageCache", key);
    if (row === undefined) return key;
    const bytes = await this.bytesOf(row);
    if (bytes === undefined) return key;
    const objectUrl = URL.createObjectURL(bytes);
    this.urls.set(key, objectUrl);
    this.trimLive();
    void this.touch(key);
    return objectUrl;
  }

  /**
   * Prefetch a screenful, so scrolling does not wait on the network.
   *
   * The batch size comes from the CPU level: warming sixty covers at once is exactly the kind of
   * work that makes a laptop feel frozen while the app looks idle.
   */
  warm(urls: readonly string[], batch = 12): void {
    for (const url of urls.slice(0, Math.max(1, batch))) void this.resolve(url);
  }

  /**
   * Record that a picture was drawn.
   *
   * A metadata write and nothing else: the row is rewritten without its bytes, so marking a cover
   * "seen just now" costs one small document rather than a re-encoded megabyte. It used to read the
   * row — blob included — and put it back on every hit, which is a base64 encode per visible cover
   * per scroll.
   */
  private async touch(url: string): Promise<void> {
    if (this.db === null) return;
    const row = await this.db.get<ImageRow>("imageCache", url);
    if (row === undefined) return;
    const { blob: _blob, ...metadata } = row;
    await this.db.put("imageCache", { ...metadata, usedAt: Date.now() } as unknown as Record<string, unknown>);
  }

  /** Enforce the ceiling. Never touches anything pinned; reports what it removed. */
  /**
   * Drop the oldest object URLs beyond the ceiling, one generation late.
   *
   * The previous generation is revoked here — not the ones leaving the map now — so a URL can never
   * be revoked while a screen that resolved it a moment ago is still drawing it.
   */
  private trimLive(): void {
    if (this.urls.size <= MAX_LIVE_URLS) return;
    for (const objectUrl of this.retiring) URL.revokeObjectURL(objectUrl);
    this.retiring = [];
    while (this.urls.size > MAX_LIVE_URLS) {
      const oldest = this.urls.keys().next();
      if (oldest.done === true) return;
      const objectUrl = this.urls.get(oldest.value);
      this.urls.delete(oldest.value);
      if (objectUrl !== undefined) this.retiring.push(objectUrl);
    }
  }

  /**
   * Ask for the picture again after an `<img>` refused the URL it was given.
   *
   * A revoked object URL is the usual reason: the picture is on disk, so forgetting the map entry
   * and resolving again mints a fresh URL instead of leaving the tile on its title for good.
   */
  async reacquire(url: string, headers?: Record<string, string>): Promise<string> {
    this.urls.delete(url);
    return await this.resolve(url, headers === undefined ? {} : { headers });
  }

  async prune(): Promise<{ removed: number; freed: number }> {
    if (this.db === null) return { removed: 0, freed: 0 };
    const entries = await this.entries();
    const doomed = planEviction(entries, this.policy);
    let freed = 0;
    for (const key of doomed) {
      const row = await this.db.get<ImageRow>("imageCache", key);
      freed += row?.bytes ?? 0;
      const objectUrl = this.urls.get(key);
      if (objectUrl !== undefined) {
        URL.revokeObjectURL(objectUrl);
        this.urls.delete(key);
      }
      await this.db.remove("imageCache", key);
      await this.db.remove("imageCacheData", key);
    }
    return { removed: doomed.length, freed };
  }

  /** Clear every cached copy. The library is untouched — this only drops pictures. */
  async clear(): Promise<{ removed: number; freed: number }> {
    if (this.db === null) return { removed: 0, freed: 0 };
    const rows = await this.db.all<ImageRow>("imageCache");
    let freed = 0;
    for (const row of rows) {
      freed += row.bytes;
      await this.db.remove("imageCache", row.key);
      await this.db.remove("imageCacheData", row.key);
    }
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    for (const url of this.retiring) URL.revokeObjectURL(url);
    this.retiring = [];
    this.urls.clear();
    return { removed: rows.length, freed };
  }
}

export const imageCache = new ImageCache();
