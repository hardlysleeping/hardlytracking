/**
 * Image cache: covers and page images, on this device, behind a ceiling.
 *
 * Why it exists: a source list re-downloads every cover on every visit, and a phone on a train
 * should still show the shelf. The rule from HardlyReader's cache carries over — the *list* is data
 * and is never evicted; only *copies* are, and the ceiling is a number the user chose.
 *
 * Storage is the app's own database (`imageCache` store: key, blob, bytes, at, usedAt), so it
 * travels with the same open/close lifecycle as everything else and works in a packaged build.
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
  blob: Blob;
  bytes: number;
  at: number;
  usedAt: number;
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
  private urls = new Map<string, string>();
  private inflight = new Map<string, Promise<string>>();
  policy: CachePolicy = { ...CACHE_POLICY_DEFAULT };

  attach(db: Database, policy?: Partial<CachePolicy>): void {
    this.db = db;
    if (policy !== undefined) this.policy = { ...this.policy, ...policy };
  }

  setPolicy(policy: Partial<CachePolicy>): void {
    this.policy = { ...this.policy, ...policy };
    void this.prune();
  }

  /** Every row, for the Settings sentence and for eviction. */
  async entries(): Promise<CacheEntry[]> {
    if (this.db === null) return [];
    const rows = await this.db.all<ImageRow>("imageCache");
    return rows.map((row) => ({ key: row.key, bytes: row.bytes, at: row.at, usedAt: row.usedAt }));
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
    if (this.db === null || !this.policy.cacheImages) return url;

    // Covers and page images go through the app's own `/api/img` proxy, so the interesting URLs are
    // same-origin paths, not absolute ones. A blob: or data: URL is already local — never cached.
    if (!/^(https?:|\/)/i.test(url)) return url;

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
        if (row !== undefined) {
          const objectUrl = URL.createObjectURL(row.blob);
          this.urls.set(url, objectUrl);
          this.trimLive();
          void this.touch(url);
          return objectUrl;
        }
        // A source that will not serve an image to an anonymous request (Komga) hands its URL with
        // the header it needs; this is the only place those bytes are fetched.
        const response = await fetch(url, options.headers === undefined ? {} : { headers: options.headers });
        if (!response.ok) return url;
        const type = response.headers.get("content-type") ?? "";
        if (!ALLOWED.test(type)) return url;
        const blob = await response.blob();
        if (blob.size === 0 || blob.size > MAX_IMAGE_BYTES) return url;
        const now = Date.now();
        await this.db!.put("imageCache", { key: url, blob, bytes: blob.size, at: now, usedAt: now } as unknown as Record<string, unknown>);
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
    const now = Date.now();
    await this.db.put("imageCache", { key, blob, bytes: blob.size, at: now, usedAt: now } as unknown as Record<string, unknown>);
    void this.prune();
    return true;
  }

  /** The object URL for a stored picture, or the key back when nothing is stored under it. */
  private async stored(key: string): Promise<string> {
    const live = this.urls.get(key);
    if (live !== undefined) return live;
    if (this.db === null) return key;
    const row = await this.db.get<ImageRow>("imageCache", key);
    if (row === undefined) return key;
    const objectUrl = URL.createObjectURL(row.blob);
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

  private async touch(url: string): Promise<void> {
    if (this.db === null) return;
    const row = await this.db.get<ImageRow>("imageCache", url);
    if (row === undefined) return;
    await this.db.put("imageCache", { ...row, usedAt: Date.now() } as unknown as Record<string, unknown>);
  }

  /** Enforce the ceiling. Never touches anything pinned; reports what it removed. */
  /** Drop the oldest object URLs beyond the ceiling, revoking them so the bytes go with them. */
  private trimLive(): void {
    while (this.urls.size > MAX_LIVE_URLS) {
      const oldest = this.urls.keys().next();
      if (oldest.done === true) return;
      const objectUrl = this.urls.get(oldest.value);
      this.urls.delete(oldest.value);
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    }
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
    }
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    return { removed: rows.length, freed };
  }
}

export const imageCache = new ImageCache();
