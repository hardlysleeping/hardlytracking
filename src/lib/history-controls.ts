/** Horizontal intent only: a vertical scroll must never expose a destructive action. */
export function historySwipe(dx: number, dy: number): "reveal" | "close" | null {
  if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.5) return null;
  return dx < 0 ? "reveal" : "close";
}

/** Hidden/private rows must never be included by a stale selection or Select all. */
export function selectedHistoryIds(selected: ReadonlySet<string>, shown: readonly { chapterId: string }[]): string[] {
  return shown.filter((row) => selected.has(row.chapterId)).map((row) => row.chapterId);
}

/**
 * Add or remove one series from the History pins, keeping the order they were pinned in.
 *
 * A pin names a *title*, not a chapter: every history row of that series floats to the Pinned
 * group, and removing one chapter's log (or a whole selection of logs) leaves the pin alone.
 */
export function toggleHistoryPin(pins: readonly string[], seriesId: string): string[] {
  return pins.includes(seriesId) ? pins.filter((id) => id !== seriesId) : [...pins, seriesId];
}

/** The label of the group the pins draw. */
export const PINNED_GROUP = "Pinned";

/** A history row, reduced to what grouping needs. */
export interface HistoryGroupable {
  seriesId: string;
  at: number;
}

/**
 * The History list's groups: one pinned group at the top, then the day buckets.
 *
 * `rows` arrives newest-first from the store, but grouping sorts each bucket by `at` itself so the
 * order is a property of the helper rather than of the caller. A pinned row appears once — in
 * `Pinned`, not also under Today — because the group is a placement, not a duplicate. An id in
 * `pins` with no rows (every entry removed, or the title is gone) draws no empty group.
 */
export function historyGroups<T extends HistoryGroupable>(
  rows: readonly T[],
  pins: readonly string[],
  now = Date.now(),
): Array<{ label: string; rows: T[] }> {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const pinned = new Set(pins);
  const buckets: Array<{ label: string; rows: T[] }> = [
    { label: PINNED_GROUP, rows: [] },
    { label: "Today", rows: [] },
    { label: "Yesterday", rows: [] },
    { label: "Earlier this week", rows: [] },
    { label: "Older", rows: [] },
  ];
  for (const row of rows) {
    buckets[bucketIndex(row, pinned, today)].rows.push(row);
  }
  return buckets
    .map((bucket) => ({ label: bucket.label, rows: [...bucket.rows].sort((a, b) => b.at - a.at) }))
    .filter((bucket) => bucket.rows.length > 0);
}

/** Which bucket a row belongs in: pinned wins, then the day it was read. */
function bucketIndex(row: HistoryGroupable, pinned: Set<string>, today: number): number {
  if (pinned.has(row.seriesId)) return 0;
  if (row.at >= today) return 1;
  if (row.at >= today - 86_400_000) return 2;
  if (row.at >= today - 7 * 86_400_000) return 3;
  return 4;
}
