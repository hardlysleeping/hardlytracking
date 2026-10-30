/**
 * The filter model, as data.
 *
 * A filter is not a bag of booleans the sheet happens to hold: it is a value that the query
 * reads, the chip row draws and a reload can carry. The unread rule is tri-state because
 * "only unread" and "only read" are two different questions and a checkbox can only ask one.
 *
 * `QueryFacts` lives here rather than in `query.ts` because the filter, the sort and the badges
 * all read the same per-series numbers — one shape, filled once per recount, passed down.
 */
import type { Series } from "../../api/source";

export type UnreadFilter = "any" | "unread" | "read";

export interface LibraryFilter {
  unread: UnreadFilter;
  /** Both false = don't care. Both true = a contradiction, and `matchesFilter` says so. */
  downloaded: boolean;
  notDownloaded: boolean;
  /** `Series.status` values: Ongoing / Completed / Hiatus / … */
  statuses: string[];
  /** Provider kinds (`mihon`, `dalvik`, …) or source names. */
  sources: string[];
  /** Reads the mapping rows: a series with a source mapping is "tracked". */
  tracked: "any" | "tracked" | "untracked";
}

export const EMPTY_FILTER: LibraryFilter = {
  unread: "any",
  downloaded: false,
  notDownloaded: false,
  statuses: [],
  sources: [],
  tracked: "any",
};

/**
 * What the query knows about one series.
 *
 * Filled once per recount from the chapters, positions, downloads and mappings we already hold,
 * so a filter or a sort never asks the database anything mid-render.
 */
export interface QueryFacts {
  unread: Map<string, number>;
  downloaded: Map<string, number>;
  lastRead: Map<string, number>;
  newUpdates: Set<string>;
  status: Map<string, string>;
  total: Map<string, number>;
  /** Series with a source mapping. Absent means "no mapping information", not "untracked". */
  tracked?: Set<string>;
  /** Newest `uploadedAt` per series, for the last-updated sort. */
  lastUpdated?: Map<string, number>;
  /** `addedAt`, for the date-added sort. The store drops it from `Series`, so it is a fact. */
  added?: Map<string, number>;
  /** Newest chapter number per series, for the latest-chapter sort. */
  latestChapter?: Map<string, number>;
}

/** True when the filter would keep everything — the sheet's "no filters" state. */
export function isEmptyFilter(filter: LibraryFilter): boolean {
  return (
    filter.unread === "any" &&
    !filter.downloaded &&
    !filter.notDownloaded &&
    filter.statuses.length === 0 &&
    filter.sources.length === 0 &&
    filter.tracked === "any"
  );
}

/**
 * Does one series survive the filter?
 *
 * Every clause is a conjunction: two different boxes ticked means both must hold, which is why
 * "downloaded" and "not downloaded" together keep nothing. A contradiction is answered honestly
 * rather than silently ignored — an empty grid with two chips is easier to understand than a
 * filter that quietly drops half of itself.
 */
export function matchesFilter(filter: LibraryFilter, facts: QueryFacts, series: Series): boolean {
  const unread = facts.unread.get(series.id) ?? 0;
  if (filter.unread === "unread" && unread === 0) return false;
  if (filter.unread === "read") {
    // Fully read means every chapter is read, and there is at least one chapter to be read.
    const total = facts.total.get(series.id) ?? 0;
    if (total === 0 || unread > 0) return false;
  }

  if (filter.downloaded && filter.notDownloaded) return false;
  const downloaded = facts.downloaded.get(series.id) ?? 0;
  if (filter.downloaded && downloaded === 0) return false;
  if (filter.notDownloaded && downloaded > 0) return false;

  if (filter.statuses.length > 0) {
    const status = facts.status.get(series.id);
    if (status === undefined || !filter.statuses.includes(status)) return false;
  }

  if (filter.sources.length > 0 && !filter.sources.includes(series.provider)) return false;

  const tracked = facts.tracked?.has(series.id) ?? false;
  if (filter.tracked === "tracked" && !tracked) return false;
  if (filter.tracked === "untracked" && tracked) return false;

  return true;
}

/**
 * Fold a second filter into the first, one field at a time.
 *
 * Used when a search operator (`source:mangadex`) has to narrow the same grid the sheet narrows:
 * the two are one model seen two ways, not two pipelines that happen to compose.
 */
export function mergeFilter(base: LibraryFilter, extra: Partial<LibraryFilter>): LibraryFilter {
  const merged: LibraryFilter = { ...base };
  if (extra.unread !== undefined && extra.unread !== "any") merged.unread = extra.unread;
  if (extra.downloaded === true) merged.downloaded = true;
  if (extra.notDownloaded === true) merged.notDownloaded = true;
  if (extra.statuses !== undefined && extra.statuses.length > 0) {
    merged.statuses = [...new Set([...base.statuses, ...extra.statuses])];
  }
  if (extra.sources !== undefined && extra.sources.length > 0) {
    merged.sources = [...new Set([...base.sources, ...extra.sources])];
  }
  if (extra.tracked !== undefined && extra.tracked !== "any") merged.tracked = extra.tracked;
  return merged;
}

/** One removable chip: the key `withoutChip` takes back, and the words the row shows. */
export interface FilterChip {
  key: string;
  label: string;
}

/** The chip key for a status or a source, so the row and the removal cannot disagree. */
export const STATUS_PREFIX = "status:";
export const SOURCE_PREFIX = "source:";

/**
 * The chips the filter row draws, in the order it draws them.
 *
 * A chip is a *question*, not a checkbox: ticking both download boxes is one contradictory
 * question ("downloaded and not downloaded"), so it is one chip that keeps nothing — which is
 * easier to see and to remove than two chips that silently cancel each other.
 */
export function activeChips(filter: LibraryFilter): FilterChip[] {
  const chips: FilterChip[] = [];
  if (filter.unread === "unread") chips.push({ key: "unread", label: "Has unread" });
  if (filter.unread === "read") chips.push({ key: "unread", label: "Fully read" });
  if (filter.downloaded && filter.notDownloaded) {
    chips.push({ key: "downloads", label: "Downloaded and not downloaded" });
  } else if (filter.downloaded) {
    chips.push({ key: "downloaded", label: "Downloaded" });
  } else if (filter.notDownloaded) {
    chips.push({ key: "notDownloaded", label: "Not downloaded" });
  }
  for (const status of filter.statuses) chips.push({ key: STATUS_PREFIX + status, label: status });
  for (const source of filter.sources) chips.push({ key: SOURCE_PREFIX + source, label: source });
  if (filter.tracked === "tracked") chips.push({ key: "tracked", label: "Tracked" });
  if (filter.tracked === "untracked") chips.push({ key: "tracked", label: "Untracked" });
  return chips;
}

/** How many chips the row draws — the number on the `Filter` button. */
export function countActive(filter: LibraryFilter): number {
  return activeChips(filter).length;
}

/**
 * Take one chip back. An unknown key returns the filter unchanged, so a stale chip (a source that
 * was uninstalled) can be pressed without throwing.
 */
export function withoutChip(filter: LibraryFilter, key: string): LibraryFilter {
  if (key === "unread") return { ...filter, unread: "any" };
  if (key === "downloaded") return { ...filter, downloaded: false };
  if (key === "notDownloaded") return { ...filter, notDownloaded: false };
  if (key === "downloads") return { ...filter, downloaded: false, notDownloaded: false };
  if (key === "tracked") return { ...filter, tracked: "any" };
  if (key.startsWith(STATUS_PREFIX)) {
    const status = key.slice(STATUS_PREFIX.length);
    return { ...filter, statuses: filter.statuses.filter((row) => row !== status) };
  }
  if (key.startsWith(SOURCE_PREFIX)) {
    const source = key.slice(SOURCE_PREFIX.length);
    return { ...filter, sources: filter.sources.filter((row) => row !== source) };
  }
  return { ...filter };
}
