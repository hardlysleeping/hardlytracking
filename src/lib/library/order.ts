/**
 * Manual order: one list of ids per collection, and the move a drag makes.
 *
 * The order is stored as ids, not on the series rows, because a series row is rebuilt from the
 * runtime on every `addSeries` — anything written onto it is gone on the next save. Ids also make
 * the rule for a stale list obvious: an id we no longer have is ignored, and a title the list does
 * not mention goes last in title order, so adding something never scrambles the shelf.
 */

/**
 * `list` with the item at `from` moved to `to`.
 *
 * Out-of-range indices are clamped rather than thrown at: a drag can end on the shelf's padding, and
 * the honest reading of that is "the nearest slot", not a crash mid-gesture. The result is always a
 * permutation of the input — same items, no duplicates, no losses.
 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (list.length === 0) return [];
  const start = Math.max(0, Math.min(list.length - 1, Math.trunc(from)));
  const end = Math.max(0, Math.min(list.length - 1, Math.trunc(to)));
  if (start === end) return [...list];
  const next = [...list];
  const [item] = next.splice(start, 1);
  next.splice(end, 0, item as T);
  return next;
}

/**
 * The id list after dragging `fromId` onto `toId`, given what is on screen.
 *
 * `visible` is the order the shelf is drawing right now — which is already the stored order plus
 * anything new — so the write is always "this is what I see, minus the drag".
 */
export function orderAfterMove(visible: string[], fromId: string, toId: string): string[] {
  const from = visible.indexOf(fromId);
  const to = visible.indexOf(toId);
  if (from < 0 || to < 0) return [...visible];
  return moveItem(visible, from, to);
}

/**
 * The stored order, made safe to draw: duplicates collapse to their first slot and ids are kept as
 * strings. A hand-edited or half-merged list must not put one title on the shelf twice.
 */
export function cleanOrder(stored: string[] | undefined): string[] {
  if (stored === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of stored) {
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
