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
  /** The eye: this source's titles leave the library and history. */
  hidden: boolean;
  pinned: boolean;
  /**
   * Incognito: reading from this source is not logged.
   *
   * A third, independent mark. It is *not* the eye and must never hide anything — the source list,
   * the library grid and History keep drawing its titles. It only suppresses the writes a reading
   * session would otherwise make (history rows, sessions), exactly as `settings.historyPaused` and
   * the temporary global incognito do. Progress, read marks and downloads still save.
   */
  incognito: boolean;
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
    // Rows written before incognito existed have no field; they must read as "not incognito".
    out.push({ id, hidden: row.hidden === true, pinned: row.pinned === true, incognito: row.incognito === true });
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
  /**
   * Komga is one source per *library*, so the key is the whole source id.
   *
   * A row recorded since the server list holds `komga:<server>:<library>`, which is already the key.
   * An older row holds only the series' native id or the bare server, neither of which names a
   * library — those answer the legacy `komga` key the old single-server mark was stored under, so an
   * existing mark keeps working instead of silently losing its comics.
   */
  if (provider === "komga") {
    if (sourceId.startsWith("komga:")) return sourceId;
    return "komga";
  }
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
  /**
   * A Komga id without a mapping names the server and the series, never the library — and the library
   * is what the marks are on. Answering the server would hide every library of it, which is the one
   * thing this must not do, so an unattributed Komga title is left alone. The legacy single-server
   * shape (`komga:<seriesId>`) is still the one old mark's key.
   */
  if (provider === "komga") {
    const native = seriesId.slice(provider.length + 1);
    return native.includes(":") ? undefined : "komga";
  }
  // A provider with a single source (Archive) is its own source.
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
 * Is this title's source in incognito?
 *
 * The third mark is deliberately absent from `isHidden`: a source in incognito is still shown
 * everywhere. This predicate is for the write paths only, so a title that is incognito is read
 * normally and simply leaves no trace in history or the reading log.
 */
export function isIncognito(row: Marked, context: MarkContext): boolean {
  const source = context.sourceOf(row.id);
  if (source === undefined) return false;
  return context.bySource.get(source)?.incognito === true;
}

/**
 * Is the source of `seriesId` in incognito, resolved the same way the views resolve it?
 *
 * The library's write path has the stored mapping row in hand and cannot build a whole
 * `MarkContext` per page turn, so this is the small form: mapping first, id second, through
 * `sourceKeyOf`. No key means "not attributable", which is never incognito.
 */
export function isIncognitoSource(
  seriesId: string,
  mapped: string | MappedSource | undefined,
  marks: readonly SourceMark[],
): boolean {
  const key = sourceKeyOf(seriesId, mapped);
  if (key === undefined) return false;
  return marks.some((mark) => mark.id === key && mark.incognito === true);
}

/**
 * A ghost, for the incognito mark.
 *
 * Not an eye: the eye already means "leave the library and history", and a second eye on the same
 * row would read as the same control. Drawn in a 24×24 box, stroke-only like `EYE_PATHS`.
 */
export const INCOGNITO_PATH =
  "M12 3a7 7 0 0 0-7 7v9.5l2.5-2 2.5 2 2-2 2 2 2.5-2 2.5 2V10a7 7 0 0 0-7-7Z" +
  "M9.2 10.2h.01M14.8 10.2h.01";


/**
 * The rows of a rail or a list whose title is not hidden.
 *
 * Continue Reading and Updates are built from positions and chapter lists, not from the library
 * grid, so they never went through `applyMarks` and a hidden source kept filling them — a shelf that
 * still shows its comics on two other screens has been labelled, not hidden. One call, so the three
 * lists and the grid cannot drift apart.
 *
 * `categoryOf` reads a title's categories from wherever the caller has them: a rail row carries only
 * a series id, and the library grid already holds the categories.
 */
export function visibleRows<T extends { seriesId: string }>(
  rows: T[],
  context: MarkContext,
  categoryOf: (seriesId: string) => string[] | undefined,
): T[] {
  return rows.filter((row) => !isHidden({ id: row.seriesId, categoryIds: categoryOf(row.seriesId) }, context));
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
