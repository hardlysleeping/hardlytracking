/**
 * Sorting, as one pure function over the facts the query already has.
 *
 * Two rules the owner sees directly:
 *
 * 1. **Equal keys keep the incoming order.** A sort that reshuffles ties makes the grid flicker
 *    between renders and looks like the app lost its place, so every comparator falls back to
 *    the row's original index.
 * 2. **A missing fact sorts last, never first.** A series that was never read has no last-read
 *    time; putting `undefined` at the top of "recently read" buries the rows the user asked for.
 */
import type { Series } from "../../api/source";
import type { QueryFacts } from "./filter";

export type SortKey =
  | "title"
  | "lastRead"
  | "lastUpdated"
  | "added"
  | "unread"
  | "totalChapters"
  | "latestChapter"
  | "downloaded"
  | "source"
  | "manual";

export interface SortSpec {
  key: SortKey;
  dir: "asc" | "desc";
}

export const DEFAULT_SORT: SortSpec = { key: "title", dir: "asc" };

/** The labels the sort sheet draws, in the order it draws them (§20). */
export const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: "title", label: "Title" },
  { key: "lastRead", label: "Last read" },
  { key: "lastUpdated", label: "Last updated" },
  { key: "added", label: "Date added" },
  { key: "unread", label: "Unread chapters" },
  { key: "totalChapters", label: "Total chapters" },
  { key: "latestChapter", label: "Latest chapter" },
  { key: "downloaded", label: "Downloaded" },
  { key: "source", label: "Source" },
  { key: "manual", label: "Manual" },
];

/** What one key reads; `null` means "this series has no answer for this key". */
function metricOf(key: SortKey, series: Series, facts: QueryFacts): string | number | null {
  switch (key) {
    case "title":
      return series.title.toLocaleLowerCase();
    case "source":
      return series.provider;
    case "lastRead":
      return facts.lastRead.get(series.id) ?? null;
    case "lastUpdated":
      return facts.lastUpdated?.get(series.id) ?? null;
    case "added":
      return facts.added?.get(series.id) ?? null;
    case "unread":
      return facts.unread.get(series.id) ?? 0;
    case "totalChapters":
      return facts.total.get(series.id) ?? 0;
    case "latestChapter":
      return facts.latestChapter?.get(series.id) ?? null;
    case "downloaded":
      return facts.downloaded.get(series.id) ?? 0;
    case "manual":
      return null;
  }
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  if (typeof a === "number" && typeof b === "number") return a - b;
  // A mixed pair cannot happen for one key, but a stored row can lie about its type.
  return String(a).localeCompare(String(b));
}

/**
 * Sort the rows for one collection.
 *
 * `manual` is that collection's id list (T-L8). Ids it does not know are ignored; rows it does
 * not list come last, in title order — so adding a title never scrambles the shelf.
 */
export function sortSeries(rows: Series[], spec: SortSpec, facts: QueryFacts, manual: string[] = []): Series[] {
  const indexed = rows.map((row, index) => ({ row, index }));

  if (spec.key === "manual") {
    const rank = new Map(manual.map((id, index) => [id, index]));
    return indexed
      .sort((a, b) => {
        const ra = rank.get(a.row.id);
        const rb = rank.get(b.row.id);
        if (ra !== undefined && rb !== undefined) return ra - rb;
        if (ra !== undefined) return -1;
        if (rb !== undefined) return 1;
        return a.row.title.localeCompare(b.row.title) || a.index - b.index;
      })
      .map((entry) => entry.row);
  }

  const direction = spec.dir === "asc" ? 1 : -1;
  return indexed
    .sort((a, b) => {
      const va = metricOf(spec.key, a.row, facts);
      const vb = metricOf(spec.key, b.row, facts);
      if (va === null && vb === null) return a.index - b.index;
      if (va === null) return 1;
      if (vb === null) return -1;
      const order = compareValues(va, vb);
      if (order !== 0) return order * direction;
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** The spec for a collection: its own, or the library default. `null` is the whole library. */
export function sortKeyOf(prefs: Record<string, SortSpec>, collection: string | null): SortSpec {
  return prefs[collection ?? "all"] ?? prefs.all ?? DEFAULT_SORT;
}
