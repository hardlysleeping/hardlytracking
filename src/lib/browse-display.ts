/** One durable display choice shared by Library and Search. Collection snapshots never override it. */
export type BrowseMode = "row" | "grid" | "card";
export function browseMode(value: unknown): BrowseMode {
  if (value === "row" || value === "list") return "row";
  if (value === "card") return "card";
  return "grid";
}

/**
 * The shapes a `row` can take.
 *
 * Three candidates, because the list is the density most of a library is read in, and the owner
 * compares layouts by using them rather than by reading about them. `line` is the original
 * three-line row; `preview` borrows HardlyReader's row (a wider thumbnail, a real sentence, the
 * numbers pulled out to the trailing edge); `table` borrows HardlyListening's list (columns, zebra
 * rows, one line per title). The switcher lives in the display menu, so a choice costs one tap.
 */
export type RowStyle = "line" | "preview" | "table";
export const ROW_STYLES: ReadonlyArray<{ id: RowStyle; label: string; note: string }> = [
  { id: "line", label: "Line", note: "Title, a line of what it is about, who made it" },
  { id: "preview", label: "Preview", note: "Wider cover, a sentence of the blurb, numbers at the end" },
  { id: "table", label: "Table", note: "One line per title in columns, like a track list" },
];
export function rowStyleOf(value: unknown): RowStyle {
  return value === "preview" || value === "table" ? value : "line";
}
export function knownSize(bytes: unknown): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
