/**
 * The cache policy, as numbers a test can pin.
 *
 * Same split HardlyReader settled on: the *library* is never evicted — it is the reader's data —
 * only the *copies* (covers, page images, search answers) are. A limit is a ceiling on copies, and
 * when nothing left can be dropped the honest answer is "over the limit", not silently deleting a
 * cover the reader is looking at.
 */

export interface CacheEntry {
  key: string;
  bytes: number;
  /** When it was stored, ms. Oldest goes first. */
  at: number;
  /** When it was last used, ms — read entries go first when `keepRead` is off. */
  usedAt: number;
  /** A pinned entry is never evicted (a downloaded chapter's pages, say). */
  pinned?: boolean;
}

export interface CachePolicy {
  /** Bytes the copies may occupy. */
  limitBytes: number;
  /** Cache cover/page images at all. */
  cacheImages: boolean;
  /** Keep images the reader has already seen, and evict unseen ones first. */
  keepRead: boolean;
}

/** What Settings offers. 256 MB is the default: a few hundred covers and a couple of chapters. */
export const CACHE_LIMIT_CHOICES: Array<{ id: string; label: string; bytes: number }> = [
  { id: "64", label: "64 MB", bytes: 64 * 1024 * 1024 },
  { id: "128", label: "128 MB", bytes: 128 * 1024 * 1024 },
  { id: "256", label: "256 MB", bytes: 256 * 1024 * 1024 },
  { id: "512", label: "512 MB", bytes: 512 * 1024 * 1024 },
  { id: "1024", label: "1 GB", bytes: 1024 * 1024 * 1024 },
];

export const CACHE_POLICY_DEFAULT: CachePolicy = {
  limitBytes: 256 * 1024 * 1024,
  cacheImages: true,
  keepRead: true,
};

/** Total bytes of the copies on disk. */
export function measureCache(entries: readonly CacheEntry[]): number {
  return entries.reduce((sum, entry) => sum + Math.max(entry.bytes, 0), 0);
}

/**
 * Which entries to delete to get under the limit, oldest-and-least-useful first.
 *
 * Order: entries the reader has not touched (when `keepRead` is off), then by `usedAt`, then by
 * `at`, then by key so the plan is deterministic. Pinned entries are never in the plan, and if the
 * pinned ones alone exceed the limit the plan comes back short — the caller reports `overLimit`
 * instead of dropping something it was told to keep.
 */
export function planEviction(entries: readonly CacheEntry[], policy: CachePolicy): string[] {
  const total = measureCache(entries);
  if (total <= policy.limitBytes) return [];

  const droppable = entries.filter((entry) => entry.pinned !== true);
  const ordered = [...droppable].sort((a, b) => {
    if (!policy.keepRead && a.usedAt !== b.usedAt) return a.usedAt - b.usedAt;
    if (a.at !== b.at) return a.at - b.at;
    if (a.usedAt !== b.usedAt) return a.usedAt - b.usedAt;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const doomed: string[] = [];
  let remaining = total;
  for (const entry of ordered) {
    if (remaining <= policy.limitBytes) break;
    doomed.push(entry.key);
    remaining -= Math.max(entry.bytes, 0);
  }
  return doomed;
}

/** True when the pinned copies alone are over the ceiling — the caller must say so. */
export function overLimit(entries: readonly CacheEntry[], policy: CachePolicy): boolean {
  const pinned = measureCache(entries.filter((entry) => entry.pinned === true));
  return pinned > policy.limitBytes;
}

/** `1.4 MB`, `812 KB`, `0 KB` — the same shape the rest of the app prints sizes in. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** One sentence for the Settings row, in the shape HardlyReader uses for its cache. */
export function describeCache(entries: readonly CacheEntry[], policy: CachePolicy): string {
  const used = measureCache(entries);
  const share = `${formatBytes(used)} of ${formatBytes(policy.limitBytes)}`;
  if (overLimit(entries, policy)) return `${share} — over the limit, but what is left is pinned`;
  if (entries.length === 0) return `Nothing cached yet · limit ${formatBytes(policy.limitBytes)}`;
  return `${entries.length} image${entries.length === 1 ? "" : "s"} · ${share}`;
}
