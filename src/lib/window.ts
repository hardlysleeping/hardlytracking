/**
 * Which rows of a shelf are worth having in the DOM.
 *
 * A 5 000-title library used to grow until every tile existed: `content-visibility: auto` skips a
 * tile's *rendering*, not its creation, so the first paint paid for 5 000 covers and every scroll
 * afterwards carried them. The window below renders the rows around the viewport plus a few screens
 * either side, and two spacers keep the scrollable height exactly what the whole shelf would have
 * been — so the scrollbar, the scroll offset and a drag do not notice the rest is missing.
 *
 * The arithmetic is pure and separate from the component: a window is a question about numbers, and
 * a test can ask it about a 5 000-row shelf without a browser.
 */

/** How many rows above and below the viewport a window keeps. Three screens is the "~3 viewport
 *  heights" the shelf is specified with: enough that a flick does not outrun the render. */
export const OVERSCAN_ROWS = 3;

export interface ItemWindow {
  /** First item index in the window. */
  start: number;
  /** One past the last item index in the window. */
  end: number;
  /** Height to reserve above the window, in pixels. */
  padTop: number;
  /** Height to reserve below the window, in pixels. */
  padBottom: number;
}

/**
 * The items around `scrollTop`, as a slice of `count`.
 *
 * `rowHeight` is the height one row occupies, gap included. Every mode that windows has a uniform
 * row (a cover plus a title clamped to a fixed number of lines, or a list row of a fixed height), so
 * the estimate is the layout, not a guess — which is what keeps the spacers honest for a library of
 * thousands of rows.
 */
export function itemWindow(options: {
  count: number;
  columns: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscanRows?: number;
}): ItemWindow {
  const count = Math.max(0, Math.floor(options.count));
  const columns = Math.max(1, Math.floor(options.columns));
  const rowHeight = options.rowHeight > 0 ? options.rowHeight : 1;
  const totalRows = Math.ceil(count / columns);
  if (count === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };

  const overscan = Math.max(0, Math.floor(options.overscanRows ?? OVERSCAN_ROWS));
  const scrolled = Math.max(0, options.scrollTop);
  const viewport = Math.max(0, options.viewportHeight);

  const firstRow = Math.max(0, Math.floor(scrolled / rowHeight) - overscan);
  const lastRow = Math.min(totalRows, Math.ceil((scrolled + viewport) / rowHeight) + overscan);
  const start = Math.min(count, firstRow * columns);
  const end = Math.min(count, Math.max(start, lastRow * columns));
  return {
    start,
    end,
    padTop: firstRow * rowHeight,
    padBottom: Math.max(0, (totalRows - lastRow) * rowHeight),
  };
}

/**
 * The element a grid actually scrolls inside.
 *
 * The shelf is not its own scroller: the shell's `main` is, and so is a library column. Walking up
 * for the first ancestor that can scroll keeps the grid usable in all three without each caller
 * telling it where it lives. A document-scrolled page (no such ancestor) answers the document
 * element, which has the same `scrollTop`/`clientHeight` shape.
 */
export function scrollRoot(from: Element | null): HTMLElement | null {
  let node: Element | null = from?.parentElement ?? null;
  while (node !== null) {
    const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
    const overflowY = style?.overflowY ?? "";
    if (overflowY === "auto" || overflowY === "scroll") return node as HTMLElement;
    node = node.parentElement;
  }
  return typeof document === "undefined" ? null : document.documentElement;
}