/**
 * One query model: collections → filters → search → sort, in that order.
 *
 * Every screen that shows a subset of the library goes through this function, so category,
 * filter and search compose instead of each view inventing its own pipeline. The order is the
 * contract, not an implementation detail:
 *
 * 1. **`applyView`** — the eye and the pin decide membership and order first. A row hidden by
 *    the eye is not in the library for this query; nothing later can resurrect it.
 * 2. **collection** — the tab the user is on narrows further.
 * 3. **filter** — the sheet's filter, plus any operator the search box parsed into the same model.
 * 4. **search** — free words, ANDed.
 * 5. **sort** — only rows that survived 1–4 are ever sorted.
 *
 * Search adds relevance as the primary order while there is a query: a title that starts with
 * what was typed comes first, then a word, then the author — the same ranking the local index
 * already gives, kept as a tiebreak inside the chosen sort.
 */
import type { Series } from "../../api/source";
import { applyView, type Category, type ViewOptions } from "../categories";
import { matchesFilter, mergeFilter, type LibraryFilter, type QueryFacts } from "./filter";
import { EMPTY_SEARCH, matchesSearch, parseSearch, searchScore, type SearchState } from "./search";
import { DEFAULT_SORT, sortSeries, type SortSpec } from "./sort";

export type { QueryFacts } from "./filter";

export interface QueryInput {
  series: Series[];
  categories: Category[];
  marks: ViewOptions;
}

export interface QueryState {
  /** `null` is the whole library. */
  collection: string | null;
  filter: LibraryFilter;
  search: SearchState;
  sort: SortSpec;
  /** The current collection's manual order (T-L8); ignored by every other sort key. */
  manual?: string[];
}

/** A query with nothing narrowing it — the shape a view starts from. */
export function emptyQuery(collection: string | null = null): QueryState {
  return { collection, filter: { unread: "any", downloaded: false, notDownloaded: false, statuses: [], sources: [], tracked: "any" }, search: EMPTY_SEARCH, sort: DEFAULT_SORT };
}

/** Facts for a library with nothing in it, so a view can render before the recount lands. */
export function emptyFacts(): QueryFacts {
  return {
    unread: new Map(),
    downloaded: new Map(),
    lastRead: new Map(),
    newUpdates: new Set(),
    status: new Map(),
    total: new Map(),
  };
}

export function runQuery(input: QueryInput, state: QueryState, facts: QueryFacts): Series[] {
  // 1. the eye and the pin
  const visible = applyView(
    input.series.map((series) => ({ ...series, categoryIds: series.categoryIds ?? [] })),
    input.categories,
    input.marks,
  );

  // 2. the collection
  const collection = state.collection;
  const inCollection =
    collection === null
      ? visible
      : visible.filter((series) => (series.categoryIds ?? []).includes(collection));

  // 3. the filter (sheet + search operators, one model)
  const parsed = parseSearch(state.search.text);
  const filter = mergeFilter(state.filter, parsed.filter);
  const filtered = inCollection.filter((series) => matchesFilter(filter, facts, series));

  // 4. the search
  const matched = filtered.filter((series) => matchesSearch(parsed, series));

  // 5. the sort
  const sorted = sortSeries(matched, state.sort, facts, state.manual ?? []);
  if (parsed.terms.length === 0) return sorted;
  return [...sorted].sort((a, b) => searchScore(parsed, b) - searchScore(parsed, a));
}
