/** One durable display choice shared by Library and Search. Collection snapshots never override it. */
export type BrowseMode = "row" | "grid" | "card";
export function browseMode(value: unknown): BrowseMode {
  if (value === "row" || value === "list") return "row";
  if (value === "card") return "card";
  return "grid";
}
export function maxColumns(width: number): number { return width >= 1200 ? 8 : 6; }
export function columnsFor(value: unknown, width: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 3;
  return Math.min(maxColumns(width), Math.max(2, n));
}
export function knownSize(bytes: unknown): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
