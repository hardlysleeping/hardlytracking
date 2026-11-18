/**
 * Which row a tile is in, without asking the browser where every tile is.
 *
 * The expansion panel opens above the row that holds the chosen title. The first version found that
 * row by measuring every sibling's `getBoundingClientRect().top` — one forced layout per tile on
 * every selection, on a shelf that can hold thousands. A grid lays its children out in order, so the
 * row head is arithmetic: `index - index % columns`.
 */

/** The first tile of the row that holds `index`. */
export function rowStart(index: number, columns: number): number {
  if (!Number.isFinite(index) || index < 0) return 0;
  const width = Math.floor(columns);
  if (!Number.isFinite(width) || width < 1) return Math.max(0, Math.floor(index));
  return Math.floor(index) - (Math.floor(index) % width);
}

/**
 * How many columns a resolved `grid-template-columns` describes.
 *
 * `getComputedStyle` returns one length per column (`"204px 204px 204px"`), or `none` for anything
 * that is not a grid — a list view, or a flex row. Anything unparseable is one column, which is the
 * answer that opens the panel under the row itself.
 */
export function columnCount(resolved: string | null | undefined): number {
  if (resolved === null || resolved === undefined) return 1;
  const text = resolved.trim();
  if (text === "" || text === "none") return 1;
  return Math.max(1, text.split(/\s+/).length);
}