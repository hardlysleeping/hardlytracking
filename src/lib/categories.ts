/**
 * Categories: the two marks the owner asked for — hidden and pinned — ported from
 * HardlyReader so the two apps read the same way.
 *
 * Pure functions only: the rail, the library filter and the ordering are decided
 * here so they can be tested without a browser, and so the Svelte state holds no
 * policy of its own.
 *
 * The wording and the cycle order are the owner's, copied from the extensions that
 * ship them (xExtension-HiddenCategories 1.5.19, xExtension-FavoriteCategories 1.4.0):
 *
 *   eye:  Hidden -> Revealed -> Only        (a filter that hides, or reveals, or
 *                                            shows only what is hidden)
 *   pin:  Active -> Only -> Hidden          (no filter, only pinned, everything
 *                                            except pinned)
 *
 * In HardlyReader the same two features are server-side (an extension writes
 * `feed.priority`). Here the library is ours, so both marks are local state and
 * nothing is written to the runtime — the behaviour is the same, the storage is
 * simpler, and there is no Strict mode to reconcile.
 */

export type HiddenView = "hidden" | "revealed" | "only";
export type PinView = "all" | "only" | "without";

export const HIDDEN_VIEW_CYCLE: readonly HiddenView[] = ["hidden", "revealed", "only"];
export const PIN_VIEW_CYCLE: readonly PinView[] = ["all", "only", "without"];

/** The extension's own words, in its own order. */
export const HIDDEN_VIEW_LABELS: Record<HiddenView, string> = {
  hidden: "Hidden",
  revealed: "Revealed",
  only: "Only",
};

/** The pin filter's three states, in the owner's words. */
export const PIN_VIEW_LABELS: Record<PinView, string> = {
  all: "Active",
  only: "Only",
  without: "Hidden",
};

/** The pin's words are fixed: Pinned / Pin / Unpin. */
export const PIN_WORDS = { count: "Pinned", add: "Pin", remove: "Unpin" } as const;

/** The pin glyph: a stroke-only marker, so it takes the tone without a fill. */
export const MARKER_PATH = "M9 3h6l-1 6 4 4H6l4-4-1-6zM12 13v8";

/**
 * The eye, three states in one glyph.
 *
 * The slash means *the thing itself is put away*: hidden is a grey eye crossed out, and revealed is
 * a plain open eye. Drawing the slash on revealed reads as the opposite of what the state says.
 * `only` keeps a half eye plus the slash — it is still a narrowing, just one that keeps its colour.
 */
export const EYE_PATHS: Record<HiddenView, string> = {
  hidden: "M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M4 20 20 4",
  revealed: "M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  only: "M2 12s3.6-6 10-6c2 0 3.7.6 5.1 1.4M22 12s-3.6 6-10 6c-2 0-3.7-.6-5.1-1.4 M4 20 20 4",
};

/**
 * The lock, in the two states the band can be in.
 *
 * `closed` is a shackle with both legs in the body — the curtain is down. `open` swings the shackle
 * up and out of the body with nothing coming back down on the right, which is the only difference
 * the eye reads at 18 px; two locks that both stopped short of the body looked like the same lock.
 */
export const LOCK_PATHS = {
  closed: "M5 10h14v11H5z M7 10V7a5 5 0 0 1 10 0v3",
  open: "M5 10h14v11H5z M7 10V7a5 5 0 0 1 9.4-2.4",
} as const;

/** The pin wears the same three states: a marker, and a marker crossed out when pinned is excluded. */
export const PIN_PATHS: Record<PinView, string> = {
  all: MARKER_PATH,
  only: MARKER_PATH,
  without: `${MARKER_PATH} M4 20 20 4`,
};

export function nextHiddenView(view: HiddenView): HiddenView {
  const index = HIDDEN_VIEW_CYCLE.indexOf(view);
  return HIDDEN_VIEW_CYCLE[(index + 1) % HIDDEN_VIEW_CYCLE.length] ?? "hidden";
}

export function nextPinView(view: PinView): PinView {
  const index = PIN_VIEW_CYCLE.indexOf(view);
  return PIN_VIEW_CYCLE[(index + 1) % PIN_VIEW_CYCLE.length] ?? "all";
}

export function isHiddenView(value: unknown): value is HiddenView {
  return value === "hidden" || value === "revealed" || value === "only";
}

export function isPinView(value: unknown): value is PinView {
  return value === "all" || value === "only" || value === "without";
}

export interface Category {
  id: string;
  name: string;
  /** The user's own order, 0-based. */
  order: number;
  hidden: boolean;
  pinned: boolean;
  /**
   * The tab-row pin — a different mark from `pinned`, which floats the shelf in the rail.
   * Optional so a row written before the tab row existed reads as "not pinned".
   */
  tabPinned?: boolean;
}

export interface Categorised {
  /** Ids of the categories this row belongs to; empty is "uncategorised". */
  categoryIds: string[];
}

/** A stored value may be older, partial or hand-edited; keep only what is sound. */
export function normaliseCategories(raw: unknown): Category[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Category[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : "";
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (id === "" || name === "" || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      order: typeof e.order === "number" && Number.isFinite(e.order) ? e.order : out.length,
      hidden: e.hidden === true,
      pinned: e.pinned === true,
      // The tab pin survives a read; a row without it is simply not pinned to the tab row.
      ...(e.tabPinned === true ? { tabPinned: true } : {}),
    });
  }
  return out.sort((a, b) => a.order - b.order);
}

/**
 * Pinned categories sort to the top behind the pushpin, each group keeping the
 * user's own order — so unpinning puts a category back exactly where it was.
 */
export function orderedCategories(categories: Category[]): Category[] {
  const byOrder = [...categories].sort((a, b) => a.order - b.order);
  return [...byOrder.filter((c) => c.pinned), ...byOrder.filter((c) => !c.pinned)];
}

/**
 * Which categories the rail, the chip row and the library draw.
 *
 * The eye says what a shelf's *contents* do; the pin says which shelves are worth showing. Both are
 * applied here, and the pin wins where they cross: with the eye revealing hidden shelves and the pin
 * asking for pinned only, a pinned-but-hidden shelf stays and an unpinned visible one goes, because
 * "only pinned" is a narrower request than "show me everything".
 *
 * Pinned shelves come first in every list — pinning is how a shelf gets to the front, and a mark
 * that only glows makes the reader hunt for the thing they just pinned.
 */
export function visibleCategories(categories: Category[], view: HiddenView, pinView: PinView = "all"): Category[] {
  const byEye =
    view === "revealed" ? categories : view === "only" ? categories.filter((c) => c.hidden) : categories.filter((c) => !c.hidden);
  const byPin =
    pinView === "only" ? byEye.filter((c) => c.pinned) : pinView === "without" ? byEye.filter((c) => !c.pinned) : byEye;
  return orderedCategories(byPin);
}

/** The categories a row is filed under, resolved and in rail order. */
export function categoriesOf(item: Categorised, categories: Category[]): Category[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return orderedCategories(item.categoryIds.map((id) => byId.get(id)).filter((c): c is Category => c !== undefined));
}

export interface ViewOptions {
  hiddenView: HiddenView;
  pinView: PinView;
}

/**
 * The library's rows for the two marks.
 *
 * Rules, in order:
 * 1. **Hidden** — a row is on the hidden shelf when every category it is filed under
 *    is hidden (so a title that also sits in a visible category stays visible, which
 *    is what hiding one shelf means). In `hidden` the shelf is out, in `revealed` it
 *    is back, in `only` it is the only thing in. A row in no category is never on the
 *    shelf: the eye has nothing to hide it with, and `only` leaves it out.
 * 2. **Pinned** — `only` keeps rows in a pinned category, `without` drops them, `all`
 *    keeps everything.
 * 3. **Order** — rows in a pinned category come first, each group keeping its own
 *    order, so pinning floats a shelf to the top and unpinning restores the rest.
 */
export function applyView<T extends Categorised>(items: T[], categories: Category[], options: ViewOptions): T[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const pinnedIds = new Set(categories.filter((c) => c.pinned).map((c) => c.id));

  const kept = items.filter((item) => {
    const mine = item.categoryIds.map((id) => byId.get(id)).filter((c): c is Category => c !== undefined);
    const isHidden = mine.length > 0 && mine.every((c) => c.hidden);
    if (options.hiddenView === "hidden" && isHidden) return false;
    if (options.hiddenView === "only" && !isHidden) return false;

    const isPinned = item.categoryIds.some((id) => pinnedIds.has(id));
    if (options.pinView === "only" && !isPinned) return false;
    if (options.pinView === "without" && isPinned) return false;
    return true;
  });

  const pinnedFirst = (item: T): number => (item.categoryIds.some((id) => pinnedIds.has(id)) ? 0 : 1);
  return kept
    .map((item, index) => ({ item, index }))
    .sort((a, b) => pinnedFirst(a.item) - pinnedFirst(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

/** One line under the rail: the state in words, never a number without a word. */
export function viewSummary(hiddenView: HiddenView, pinView: PinView, hiddenCount: number, pinnedCount: number): string {
  const eye = `${HIDDEN_VIEW_LABELS[hiddenView]} ${hiddenCount}`;
  const pin = `${PIN_WORDS.count} ${pinnedCount}`;
  const pinLabel = pinView === "all" ? pin : `${pinLabelOf(pinView)} ${pinnedCount}`;
  return `${eye} · ${pinLabel}`;
}

function pinLabelOf(view: PinView): string {
  return view === "only" ? "Only pinned" : "Without pinned";
}
