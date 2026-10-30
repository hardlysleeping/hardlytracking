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
