/**
 * Marks that hide, on sources as well as categories.
 *
 * HardlyReader's eye and pin, extended: there the two marks belong to a category (or a feed) and
 * hiding one hides that shelf. Here a title also comes *from* somewhere, and the owner asked for the
 * same controls to work on sources — "it works not just on categories, but also hides sources, and
 * reading history of comics in those categories and/or sources that are hidden".
 *
 * One rule, and every view calls it, so the library grid and the history list can never disagree
 * about what is hidden:
 *
 *   a title is hidden when every category it is filed under is hidden,
 *                     OR its source is hidden.
 *
 * The category half is "every" on purpose (and is what `lib/categories` already documented): a title
 * filed under a visible shelf and a hidden one stays visible, because hiding one shelf is not hiding
 * the title. The source half is absolute, because a source is not a shelf a title was put on — it is
 * where the title came from, so hiding it hides everything from it.
 *
 * Pure functions only: the rail, the grid, history and continue all read from here.
 */
import type { Category, HiddenView, PinView } from "./categories";

/** A mark on one source. The id is the app's own source id: `dalvik:src:<n>`, `local:src:library`. */
export interface SourceMark {
  id: string;
  hidden: boolean;
  pinned: boolean;
}

/** A stored value may be older, partial or hand-edited; keep only what is sound. */
export function normaliseSourceMarks(raw: unknown): SourceMark[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SourceMark[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, hidden: row.hidden === true, pinned: row.pinned === true });
  }
  return out;
}

/**
 * The key a source mark is stored under, from the parts a mapping row has.
 *
 * `dalvik`/`htserver`/`mihon` sources live inside an extension and are named by their own source id;
 * a provider that is a single server (Komga, Archive) is its own source and needs no suffix. One
 * function, because `sourceKeyOf` derives the same key from an id and the two must never disagree.
 */
export function sourceKeyOfMapping(provider: string, sourceId: string): string {
  if (provider === "dalvik" || provider === "htserver" || provider === "mihon") return `${provider}:src:${sourceId}`;
  // This device's own source is `local:src:library` — its mapping already spells the `src:` half, so
  // the key is the provider plus that, not a second prefix.
  if (provider === "local") return sourceId === "" ? "local:src:library" : `local:${sourceId}`;
  return provider;
}

/** The stored mapping a title has, in the only two fields this file needs. */
export interface MappedSource {
  provider?: string;
  sourceId?: string;
}

/**
 * Which source a title came from, as a source id.
 *
 * `dalvik` and `htserver` ids carry it (`dalvik:<sourceId>:<manga url>` — see `api/dalvik.ts`), so
 * they need no help. `mihon` ids do not (`mihon:12` is a manga id, not a source), so the caller
 * passes what the stored mapping knows; without a mapping the title is not attributable and is left
 * alone rather than guessed at. `undefined` therefore means "no source known", never "hidden".
 *
 * **A mapping wins over the id.** After a migration the id still spells the source the title was
 * added from while the title now reads from another one — so the mark that governs it has to be the
 * new source's, or a title would stay hidden because of a source it no longer uses.
 */
export function sourceKeyOf(seriesId: string, mapped?: string | MappedSource): string | undefined {
  if (mapped !== undefined && typeof mapped === "object") {
    const provider = (mapped.provider ?? "").trim();
    const sourceId = (mapped.sourceId ?? "").trim();
    if (provider !== "" && sourceId !== "") return sourceKeyOfMapping(provider, sourceId);
  }
  const [provider, second] = seriesId.split(":");
  if (provider === "dalvik" || provider === "htserver") {
    return second === undefined || second === "" ? undefined : `${provider}:src:${second}`;
  }
  if (provider === "mihon") {
    // The older call shape: a bare source id from the mapping.
    const sourceId = typeof mapped === "string" ? mapped : "";
    return sourceId === "" ? undefined : `mihon:src:${sourceId}`;
  }
  if (provider === "local") return "local:src:library";
  if (provider === undefined || provider === "") return undefined;
  // A provider with a single source (Komga, Archive) is its own source.
  return provider;
}

export interface MarkInputs {
  categories: Category[];
  sources: SourceMark[];
  /** Resolves a title's source id. Built once per read by the caller, from ids and mappings. */
  sourceOf: (seriesId: string) => string | undefined;
}

/** Anything with a category list and an id — a library row, a history row, a continue entry. */
export interface Marked {
  id: string;
  categoryIds?: string[];
}

/**
 * The inputs, indexed once.
 *
 * A library read is thousands of rows and the rule runs per row, so the lookups are built once and
 * the predicate is a map hit — not a `find` over every category for every title.
 */
export interface MarkContext {
  byCategory: Map<string, Category>;
  bySource: Map<string, SourceMark>;
  pinnedCategories: Set<string>;
  sourceOf: (seriesId: string) => string | undefined;
}

export function contextOf(inputs: MarkInputs): MarkContext {
  return {
    byCategory: new Map(inputs.categories.map((category) => [category.id, category])),
    bySource: new Map(inputs.sources.map((mark) => [mark.id, mark])),
    pinnedCategories: new Set(inputs.categories.filter((category) => category.pinned).map((category) => category.id)),
    sourceOf: inputs.sourceOf,
  };
}

/** Is this title hidden by the eye? Both halves of the rule, in one place. */
export function isHidden(row: Marked, context: MarkContext): boolean {
  const mine = (row.categoryIds ?? [])
    .map((id) => context.byCategory.get(id))
    .filter((category): category is Category => category !== undefined);
  if (mine.length > 0 && mine.every((category) => category.hidden)) return true;
  const source = context.sourceOf(row.id);
  if (source === undefined) return false;
  return context.bySource.get(source)?.hidden === true;
}

/** Is this title pinned — by a category, or by the source it came from? */
export function isPinned(row: Marked, context: MarkContext): boolean {
  if ((row.categoryIds ?? []).some((id) => context.pinnedCategories.has(id))) return true;
  const source = context.sourceOf(row.id);
  if (source === undefined) return false;
  return context.bySource.get(source)?.pinned === true;
}

/**
 * The rows a view shows, and in what order. Takes a prepared `MarkContext`, so a view that redraws
 * on every keystroke is not re-indexing the categories each time.
 *
 * The three-state eye and the three-state pin are the same words and the same cycle as the category
 * rail — `hidden`/`revealed`/`only` and `all`/`only`/`without` — because they are the same control,
 * and a second vocabulary for the same thing is how a settings screen starts lying.
 */
export function applyMarks<T extends Marked>(
  items: T[],
  context: MarkContext,
  view: { hiddenView: HiddenView; pinView: PinView },
): T[] {
  const kept = items.filter((item) => {
    const hidden = isHidden(item, context);
    if (view.hiddenView === "hidden" && hidden) return false;
    if (view.hiddenView === "only" && !hidden) return false;
    const pinned = isPinned(item, context);
    if (view.pinView === "only" && !pinned) return false;
    if (view.pinView === "without" && pinned) return false;
    return true;
  });

  // Pinned first, each group keeping the order it arrived in: pinning floats, it does not sort.
  return kept
    .map((item, index) => ({ item, index, pinned: isPinned(item, context) }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * The source list the rail draws, per the eye and the pin.
 *
 * Same rule as `visibleCategories`: `hidden` drops the marked ones, `revealed` draws them all,
 * `only` draws just the marked ones. Pinned sources sort first.
 */
export function visibleSources<T extends { id: string }>(
  sources: T[],
  marks: SourceMark[],
  view: { hiddenView: HiddenView; pinView: PinView },
): T[] {
  const byId = new Map(marks.map((mark) => [mark.id, mark]));
  const marked = (source: T): SourceMark | undefined => byId.get(source.id);
  const kept = sources.filter((source) => {
    const hidden = marked(source)?.hidden === true;
    if (view.hiddenView === "hidden" && hidden) return false;
    if (view.hiddenView === "only" && !hidden) return false;
    const pinned = marked(source)?.pinned === true;
    if (view.pinView === "only" && !pinned) return false;
    if (view.pinView === "without" && pinned) return false;
    return true;
  });
  return [...kept].sort((a, b) => Number(marked(b)?.pinned === true) - Number(marked(a)?.pinned === true));
}
