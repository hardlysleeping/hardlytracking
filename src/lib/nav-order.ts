/**
 * The order the reader arranged, and the rules that keep it usable.
 *
 * Two lists live in prefs: the phone bar's destinations and the Library's section tabs. Both are
 * `string[]` in the database, which means the value can come from an older build, a hand-edited
 * export, or a sync from another device — so "which ids survive, in what order" is a decision worth
 * testing on its own, without a database or a component around it.
 *
 * Ids, not rows: a destination is rebuilt from `DESTINATIONS` on every render, so the preference
 * names ids and anything it names that no longer exists is simply dropped.
 */
import { DESTINATIONS } from "./destinations";

/** The bar a phone has always drawn, in the order it has always drawn it. */
export const DEFAULT_BOTTOM_NAV: string[] = ["library", "browse", "search", "history", "more"];

export const DEFAULT_LIBRARY_TABS: string[] = ["titles", "updates"];

/** Every destination id a stored bar may name. Anything else is dropped, not guessed at. */
export const DESTINATION_IDS: string[] = DESTINATIONS.map((destination) => destination.id);

export interface LibrarySection {
  id: string;
  label: string;
}

/** The Library's two sections. A closed list: a stored tab order names these, never a screen. */
export const LIBRARY_SECTIONS: LibrarySection[] = [
  { id: "titles", label: "Titles" },
  { id: "updates", label: "Updates" },
];

export const LIBRARY_SECTION_IDS: string[] = LIBRARY_SECTIONS.map((section) => section.id);

/**
 * A stored list, cleaned into something the app can render.
 *
 * Known ids only, duplicates dropped, stored order kept. An empty or unreadable value is the
 * default — a preference that cannot be read must not leave the bar or the tabs blank.
 */
export function normaliseOrder(ids: unknown, knownIds: readonly string[], fallback: readonly string[]): string[] {
  if (!Array.isArray(ids)) return [...fallback];
  const known = new Set(knownIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > 0 ? out : [...fallback];
}

/**
 * Add or remove one id, never leaving the list empty.
 *
 * The last item is kept because a bar with nothing in it is a screen with no way out, and a tabs
 * row with nothing in it is a Library that cannot show the Updates. The UI says why; this makes the
 * refusal unconditional, so a caller that forgets to ask still cannot strand the reader.
 */
export function toggleItem(list: readonly string[], id: string, fallback: readonly string[]): string[] {
  // `fallback` is also the closed set of known ids: both shipped lists name every id they can hold.
  const current = normaliseOrder(list, fallback, fallback);
  if (!fallback.includes(id)) return current;
  if (current.includes(id)) return current.length <= 1 ? current : current.filter((item) => item !== id);
  return [...current, id];
}

/**
 * Move one item by `delta` places, clamped by refusing a move that would fall off either end.
 *
 * Returned as a new array: the caller stores it through `settings.set`, and a mutation in place
 * would edit a `$state` proxy behind the setter's back.
 */
export function moveItem(list: readonly string[], index: number, delta: number): string[] {
  const next = [...list];
  const target = index + delta;
  if (index < 0 || index >= next.length || delta === 0) return next;
  if (target < 0 || target >= next.length) return next;
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}
