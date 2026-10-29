/**
 * Collections: one model for the library, whether a shelf is hand-built or computed.
 *
 * The problem this solves: a Mihon user has categories (manual, mutually overlapping, imported from
 * a backup) and the app wants smart shelves too (Unread, Downloaded, Continue Reading). Implementing
 * those as two features is how a library ends up with "categories" in one menu and "filters" in
 * another, and neither can be pinned, ordered or hidden the same way.
 *
 * So there is one row type, `Collection`, with a `kind`:
 *
 *   manual  — membership is `series.categoryIds`, which is exactly what a Mihon category is. An
 *             imported backup lands here unchanged, and an export writes it back unchanged.
 *   smart   — membership is computed from facts we already keep: unread counts, downloads,
 *             positions, read marks, the source mapping and the newest chapter date.
 *
 * Continue Reading is deliberately **not** a smart collection of series: it is a position inside a
 * chapter, and it has its own rule (started and unfinished; or the next unread chapter, depending on
 * the setting). It is modelled below as `continueEntries`, because "which chapter and which page"
 * is a different question from "which titles belong on this shelf".
 *
 * Everything here is pure: facts in, rows out. The state layer builds the facts, the views draw the
 * result, and both can be tested without a database.
 */
import type { ProviderKind } from "../api/source";

export type CollectionKind = "manual" | "smart";

/** The built-in smart shelves. Continue Reading is separate: it is chapter-level. */
export type SystemCollection = "unread" | "downloaded" | "recent" | "completed";

/**
 * A smart collection's rule.
 *
 * Every field is optional and the ones present are ANDed. Only facts the app already stores are
 * expressible — a filter that needs data we do not have would silently match nothing, which is worse
 * than not offering it.
 */
export interface SmartFilter {
  /** At least one chapter is unread. */
  unread?: boolean;
  /** Every chapter is read (and there is at least one). */
  allRead?: boolean;
  /** At least one chapter is downloaded to this device. */
  downloaded?: boolean;
  /** A reading position exists. */
  started?: boolean;
  /** Only titles from this provider (`dalvik`, `mihon`, `local`, …). */
  provider?: ProviderKind;
  /** Only titles whose source mapping names this Mihon source id. */
  sourceId?: string;
  /** Only titles also filed under this manual collection. */
  inCollection?: string;
  /** Newest chapter published within this many days. */
  updatedWithinDays?: number;
}

/**
 * One row in the collections store.
 *
 * `hidden` is the eye and `pinned` the pin from the HardlyReader work, and they mean the same thing
 * here: hidden collections do not contribute titles to the library, pinned ones sort to the top and
 * can be surfaced as sections on the Library home.
 */
export interface Collection {
  /** `c:<n>` for a manual collection (a Mihon category), `s:<system>` for a built-in. */
  id: string;
  name: string;
  kind: CollectionKind;
  /** The user's own order, 0-based. */
  order: number;
  hidden: boolean;
  pinned: boolean;
  /** Present on the built-in smart shelves; absent on manual and custom-smart collections. */
  system?: SystemCollection;
  /** Present on smart collections (custom ones must have it; system ones have a preset). */
  filter?: SmartFilter;
}

/** What the evaluator needs to know about one title. Built once per library read. */
export interface SeriesFacts {
  seriesId: string;
  provider: ProviderKind;
  /** Manual collection ids this title is filed under. */
  categoryIds: string[];
  chapters: number;
  unread: number;
  /** Chapters present on this device. */
  downloaded: number;
  started: boolean;
  /** Newest chapter publication date, ms; 0 when no chapter carries one. */
  updatedAt: number;
  /** From the source mapping, when there is one. */
  sourceId?: string;
}

export interface ContinueEntry {
  seriesId: string;
  chapterId: string;
  page: number;
  /** Page count of that chapter, 0 when unknown. */
  total: number;
  /** When the reader was last in it, ms. */
  at: number;
  /** True when the entry points at the next unread chapter rather than the saved position. */
  next: boolean;
}

/** The built-in smart shelves, in the order they appear in the collection selector. */
export const SYSTEM_COLLECTIONS: Collection[] = [
  { id: "s:unread", name: "Unread", kind: "smart", order: 100, hidden: false, pinned: false, system: "unread", filter: { unread: true } },
  { id: "s:downloaded", name: "Downloaded", kind: "smart", order: 101, hidden: false, pinned: false, system: "downloaded", filter: { downloaded: true } },
  { id: "s:recent", name: "Recently updated", kind: "smart", order: 102, hidden: false, pinned: false, system: "recent", filter: { updatedWithinDays: 14 } },
  { id: "s:completed", name: "Completed", kind: "smart", order: 103, hidden: false, pinned: false, system: "completed", filter: { allRead: true } },
];

export const CONTINUE_ID = "s:continue";

export function isSmart(collection: Collection): boolean {
  return collection.kind === "smart";
}

/** A collection's rule: the stored filter, or the system preset's. */
export function ruleOf(collection: Collection): SmartFilter {
  if (collection.filter !== undefined) return collection.filter;
  return SYSTEM_COLLECTIONS.find((row) => row.id === collection.id)?.filter ?? {};
}

/**
 * Does this title belong to a smart collection?
 *
 * A missing fact fails its test rather than passing it: a title with no chapters is not "completed",
 * and a filter for a source id does not match a title with no mapping.
 */
export function matchesFilter(filter: SmartFilter, facts: SeriesFacts, now = Date.now()): boolean {
  if (filter.unread === true && facts.unread === 0) return false;
  if (filter.allRead === true && (facts.chapters === 0 || facts.unread > 0)) return false;
  if (filter.downloaded === true && facts.downloaded === 0) return false;
  if (filter.started === true && !facts.started) return false;
  if (filter.provider !== undefined && facts.provider !== filter.provider) return false;
  if (filter.sourceId !== undefined && facts.sourceId !== filter.sourceId) return false;
  if (filter.inCollection !== undefined && !facts.categoryIds.includes(filter.inCollection)) return false;
  if (filter.updatedWithinDays !== undefined) {
    if (facts.updatedAt === 0) return false;
    if (now - facts.updatedAt > filter.updatedWithinDays * 86_400_000) return false;
  }
  return true;
}

/**
 * The titles of one collection, in the order the facts arrived.
 *
 * A manual collection is membership; a smart one is a rule. A hidden collection still evaluates —
 * the eye decides whether its titles show in the library, not whether it exists.
 */
export function titlesIn(collection: Collection, facts: SeriesFacts[], now = Date.now()): SeriesFacts[] {
  if (collection.kind === "manual") return facts.filter((row) => row.categoryIds.includes(collection.id));
  const filter = ruleOf(collection);
  return facts.filter((row) => matchesFilter(filter, row, now));
}

/**
 * What the library shows: the union of every collection that is not hidden.
 *
 * Titles in no collection at all are kept: "uncategorised" is not "hidden", and a library that drops
 * them would lose anything imported before the user made a collection.
 */
export function visibleSeries(collections: Collection[], facts: SeriesFacts[], now = Date.now()): SeriesFacts[] {
  // No collections configured at all is different from every collection being hidden: the first
  // shows the whole library, the second hides what those shelves hold and keeps the loose titles.
  if (collections.length === 0) return facts;
  const shown = collections.filter((collection) => !collection.hidden);
  const kept = new Set<string>();
  for (const collection of shown) {
    for (const row of titlesIn(collection, facts, now)) kept.add(row.seriesId);
  }
  for (const row of facts) {
    if (row.categoryIds.length === 0) kept.add(row.seriesId);
  }
  return facts.filter((row) => kept.has(row.seriesId));
}

/**
 * The collection selector, in order: pinned first, then the user's order, then the system shelves.
 *
 * `pinned` sorting is what the pin glyph in the rail promises; it is a display order, not a
 * membership rule, so it never changes which titles a collection contains.
 */
export function orderedCollections(collections: Collection[]): Collection[] {
  return [...collections].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order || a.name.localeCompare(b.name),
  );
}

/**
 * The collections offered as Library home sections: pinned and not hidden.
 *
 * Continue Reading is excluded because the Library draws it itself, from positions, above these
 * sections — a pinned copy would be the same shelf twice.
 */
export function homeSections(collections: Collection[]): Collection[] {
  return orderedCollections(collections).filter((collection) => collection.pinned && !collection.hidden && !isContinue(collection)).slice(0, 6);
}

export function isContinue(collection: Collection): boolean {
  return collection.id === CONTINUE_ID;
}

/** What one continue entry needs: the saved position, and what comes after it. */
export interface ContinueInput {
  seriesId: string;
  chapterId: string;
  page: number;
  total: number;
  at: number;
  /** The saved chapter is finished (last page reached, or marked read). */
  finished: boolean;
  /** The next unread chapter, when there is one. */
  next?: { chapterId: string; total: number };
}

/**
 * Continue Reading, as a rule rather than a log.
 *
 * Newest first, one entry per title, and:
 *  - an unfinished chapter resumes at its saved page;
 *  - a finished chapter either offers the next unread chapter at page 1 (`afterFinish: "next"`) or
 *    drops the title until the reader starts something else (`"remove"`).
 *
 * History is a different question (what have I read, thousands of rows). This is only "what can I
 * resume right now", which is why it is capped and why it is not built from history.
 */
export function continueEntries(
  inputs: ContinueInput[],
  options: { afterFinish: "next" | "remove"; limit?: number } = { afterFinish: "next" },
): ContinueEntry[] {
  const limit = options.limit ?? 20;
  const bySeries = new Map<string, ContinueInput>();
  for (const input of inputs) {
    const existing = bySeries.get(input.seriesId);
    if (existing === undefined || input.at > existing.at) bySeries.set(input.seriesId, input);
  }
  const out: ContinueEntry[] = [];
  for (const input of [...bySeries.values()].sort((a, b) => b.at - a.at)) {
    if (input.finished) {
      if (options.afterFinish === "remove" || input.next === undefined) continue;
      out.push({
        seriesId: input.seriesId,
        chapterId: input.next.chapterId,
        page: 0,
        total: input.next.total,
        at: input.at,
        next: true,
      });
      continue;
    }
    out.push({ seriesId: input.seriesId, chapterId: input.chapterId, page: input.page, total: input.total, at: input.at, next: false });
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/**
 * A Mihon category id from an imported backup, as a collection id.
 *
 * Mihon categories are numeric and local to a backup; ours are `c:<n>`. The mapping is total and
 * reversible, which is what lets an import be re-exported without renumbering the user's shelves.
 */
export function collectionIdFromCategory(categoryId: string): string {
  return categoryId.startsWith("c:") ? categoryId : `c:${categoryId}`;
}

export function categoryIdFromCollection(collectionId: string): string {
  return collectionId.startsWith("c:") ? collectionId.slice(2) : collectionId;
}
