/**
 * Search: an index for the library, a cache for the sources.
 *
 * Two different problems, and HardlyReader's lesson applies to both — *the list is data, the answers
 * are copies*:
 *
 * 1. **The library is indexed on the device.** Titles and authors are already in the database, so a
 *    query must not be a network call and must not be a linear `includes` over five thousand rows on
 *    every keystroke. The index is built from the rows in memory (a few hundred KB at 5 000 titles)
 *    and rebuilt when the library changes; it also answers prefixes, so "one pi" finds "One Piece".
 * 2. **Source answers are cached.** A global search fans out to a dozen extensions; repeating the
 *    same query within the TTL paints from the cache immediately and refreshes in the background,
 *    and with no network at all it still shows what it had.
 */
import type { Chapter, Series } from "../../api/source";

/** How long a cached source answer is trusted before the network decides again. */
export const SEARCH_CACHE_TTL_MS = 10 * 60_000;

/** Words too common to be worth indexing; they would match everything. */
const STOPWORDS = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "on", "vol", "volume", "chapter", "ch"]);

/** Lowercase words, punctuation stripped, one character is not a word. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

export interface SearchHit<T> {
  row: T;
  /** Higher is better: a title prefix beats a word in the author, a whole word beats a prefix. */
  score: number;
}

/**
 * Score one row against the query.
 *
 * The order is the one a reader expects: the title *starts* with what was typed, then a title word
 * starts with it, then the author does, then any token contains it. Everything is scored, nothing is
 * filtered out on a technicality — a typo-free substring match still finds "Berserk" for "serk".
 */
export function scoreRow(row: { title: string; author?: string }, query: string): number {
  const needle = query.trim().toLowerCase();
  if (needle === "") return 0;
  const title = row.title.toLowerCase();
  const author = (row.author ?? "").toLowerCase();
  let score = 0;
  if (title.startsWith(needle)) score += 100;
  if (tokenize(row.title).some((word) => word.startsWith(needle))) score += 60;
  if (title.includes(needle)) score += 30;
  if (author.startsWith(needle)) score += 20;
  if (author.includes(needle)) score += 10;
  // A whole-word hit in the title outranks a mid-word one, so "one" finds "One Piece" first.
  if (tokenize(row.title).includes(needle)) score += 25;
  return score;
}

/** Rank the rows a query matches. Ties break by title so the order is stable across keystrokes. */
export function searchRows<T extends { title: string; author?: string }>(rows: readonly T[], query: string, limit = 200): T[] {
  const needle = query.trim();
  if (needle === "") return [...rows];
  const hits: Array<SearchHit<T>> = [];
  for (const row of rows) {
    const score = scoreRow(row, needle);
    if (score > 0) hits.push({ row, score });
  }
  hits.sort((a, b) => b.score - a.score || a.row.title.localeCompare(b.row.title));
  return hits.slice(0, limit).map((hit) => hit.row);
}

/** The key a cached source answer is stored under. */
export function searchCacheKey(sourceId: string, query: string): string {
  return `${sourceId}\u0000${query.trim().toLowerCase()}`;
}

export interface CachedSearch {
  key: string;
  sourceId: string;
  query: string;
  items: Series[];
  at: number;
}

/** Is a cached answer still worth painting? */
export function isFresh(cached: CachedSearch, now = Date.now(), ttl = SEARCH_CACHE_TTL_MS): boolean {
  return now - cached.at <= ttl;
}

/**
 * How long an issue list or a title's details are treated as current.
 *
 * Longer than a search answer because both change when a source *publishes*, not when it is asked:
 * a day-old issue list is the right list, and re-asking costs a request per card opened. Age never
 * hides an answer — a stored list paints at once and is refreshed behind the paint (see the view);
 * this is only the sentence that says which one you are looking at.
 */
export const ISSUE_CACHE_TTL_MS = 24 * 60 * 60_000;

/** Keys share one store with search answers, so each kind gets its own prefix. */
export function issueCacheKey(seriesId: string): string {
  return `issues\u0000${seriesId}`;
}

export function detailsCacheKey(seriesId: string): string {
  return `details\u0000${seriesId}`;
}

export interface CachedIssues {
  key: string;
  seriesId: string;
  chapters: Chapter[];
  at: number;
}

export interface CachedDetails {
  key: string;
  seriesId: string;
  series: Series;
  at: number;
}

export function issuesAreCurrent(cached: CachedIssues, now = Date.now(), ttl = ISSUE_CACHE_TTL_MS): boolean {
  return now - cached.at <= ttl;
}
