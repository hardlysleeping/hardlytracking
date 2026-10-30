/**
 * Selection rules for the library, as functions.
 *
 * The view holds a `Set<string>` of series ids; these are the questions it asks about it. Kept pure
 * because each one has a wrong answer that looks plausible: "select all" over the whole library
 * instead of the rows on screen, a collection row that says "some" when it means "all", or a
 * category change that silently drops half a selection.
 */

/** A row, as far as selection cares. */
export interface Selectable {
  id: string;
  categoryIds?: string[];
}

/**
 * Every row that is on screen, and nothing else.
 *
 * The filtered result is the contract: Select All after typing a search means "these", not "my whole
 * library" — the count in the button label is the promise.
 */
export function selectAll(rows: Selectable[]): Set<string> {
  return new Set(rows.map((row) => row.id));
}

/**
 * What one collection says about these titles: `all` when every one of them is filed there, `some`
 * when only part is, `none` when none is (and when there is nothing to file).
 */
export function collectionState(rows: Selectable[], categoryId: string): "all" | "some" | "none" {
  if (rows.length === 0) return "none";
  let count = 0;
  for (const row of rows) if ((row.categoryIds ?? []).includes(categoryId)) count += 1;
  if (count === 0) return "none";
  return count === rows.length ? "all" : "some";
}

/**
 * One series' categories after a collection row is ticked or unticked.
 *
 * Order is preserved and the id is never added twice: a title filed twice in the same collection is
 * a row the library cannot explain.
 */
export function applyCollection(categoryIds: string[], categoryId: string, want: boolean): string[] {
  const has = categoryIds.includes(categoryId);
  if (want === has) return [...categoryIds];
  return want ? [...categoryIds, categoryId] : categoryIds.filter((id) => id !== categoryId);
}

/**
 * Selected ids that the rows on screen no longer contain.
 *
 * A category, filter or search change can hide part of a selection. Those ids are the ones a bulk
 * action would still touch while the user cannot see them, so the view asks before it drops them.
 */
export function hiddenBy(selected: Set<string>, rows: Selectable[]): string[] {
  const visible = new Set(rows.map((row) => row.id));
  return [...selected].filter((id) => !visible.has(id));
}
