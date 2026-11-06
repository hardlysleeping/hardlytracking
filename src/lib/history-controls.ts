/** Horizontal intent only: a vertical scroll must never expose a destructive action. */
export function historySwipe(dx: number, dy: number): "reveal" | "close" | null {
  if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.5) return null;
  return dx < 0 ? "reveal" : "close";
}

/** Hidden/private rows must never be included by a stale selection or Select all. */
export function selectedHistoryIds(selected: ReadonlySet<string>, shown: readonly { chapterId: string }[]): string[] {
  return shown.filter((row) => selected.has(row.chapterId)).map((row) => row.chapterId);
}
