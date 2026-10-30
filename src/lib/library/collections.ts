/**
 * The collection tab row: which collections are one tap away, and which are behind `+N`.
 *
 * Komikku's row is `All | Reading | Favorites | Manhwa | +7`, and the reason it works on a phone is
 * that it is *five* things, not a scroller you have to hunt through. So the user chooses which
 * collections stay: a **tab pin** is a new mark, separate from `Category.pinned` (which means
 * "float this shelf to the top of the rail" and must not change meaning).
 *
 * The decision is pure: categories and the eye's answer in, a row and an overflow out.
 */
import type { Category } from "../categories";

/** The most tabs the row draws, beside `All`, `+N` and `Categories…`. */
export const MAX_TABS = 5;

/** A collection is a tab when the user pinned it; `pinned` here is `tabPinned`. */
export function isTabPinned(category: Category): boolean {
  return category.tabPinned === true;
}

/**
 * Split the visible collections into the row and the overflow.
 *
 * Tab-pinned collections come first, in the user's own order, and are never behind `+N` — that is
 * what pinning is for. Then the rest, in order, until the row is full. Everything left is
 * overflow. `All` is the caller's own first chip and is never in either list.
 */
export function tabRow(
  categories: Category[],
  visible: Category[],
  max: number = MAX_TABS,
): { tabs: Category[]; overflow: Category[] } {
  const allowed = new Set(visible.map((category) => category.id));
  const ordered = [...categories]
    .filter((category) => allowed.has(category.id))
    .sort((a, b) => a.order - b.order);
  const limit = Math.max(1, max);
  const pinned = ordered.filter(isTabPinned);
  const rest = ordered.filter((category) => !isTabPinned(category));
  const tabs = [...pinned.slice(0, limit), ...rest.slice(0, Math.max(limit - Math.min(pinned.length, limit), 0))];
  const inRow = new Set(tabs.map((category) => category.id));
  return { tabs, overflow: ordered.filter((category) => !inRow.has(category.id)) };
}

/**
 * Set one collection's tab pin.
 *
 * Pinning something already in the row is a no-op (the list comes back equivalent), and so is
 * unpinning something that was never pinned: a mark that toggles on a repeated press is a bug the
 * user sees as the row jumping under their thumb.
 */
export function setTabPinned(categories: Category[], id: string, pinned: boolean): Category[] {
  return categories.map((category) => {
    if (category.id !== id) return category;
    if (isTabPinned(category) === pinned) return category;
    return { ...category, tabPinned: pinned };
  });
}

/** Every collection with the tab mark flipped — the sheet's tick. */
export function toggleTabPin(categories: Category[], id: string): Category[] {
  const current = categories.find((category) => category.id === id);
  if (current === undefined) return categories;
  return setTabPinned(categories, id, !isTabPinned(current));
}

/** How many collections the sheet must mention as not-in-the-row. */
export function overflowCount(categories: Category[], visible: Category[]): number {
  return tabRow(categories, visible).overflow.length;
}
