/**
 * Where a seam goes when the pointer is at `clientX`.
 *
 * The drag handlers in `Library.svelte` were arithmetic buried in three event listeners: the same
 * clamp written three times, once against the window and twice against the slack three panes leave
 * above their floors. Numbers a pointer produces are exactly the kind of thing that is wrong at the
 * edges and right in the middle, so they live here, pure, and the tests ask them about the edges.
 *
 * Two rules hold in every one of these:
 *
 * - A pointer past a pane's floor cannot ask for less than the floor. The clamp is not a
 *   convenience: dragging the seam to the edge used to squeeze a pane to nothing and leave the
 *   reader with a column of half-covers and no handle to drag back.
 * - A number that cannot be computed (a box of zero width, a window with no slack at all) is the
 *   value the seam already had, never `NaN`. A `NaN` width reaches the layout as `width: NaNpx`,
 *   which every browser drops, so the pane silently takes the space of its content and the layout
 *   looks broken in a way nothing in the console explains.
 */

/** The box the seam moves inside: the panes element's own rect. */
export interface DragBox {
  left: number;
  width: number;
}

export interface SplitDragOptions {
  box: DragBox;
  /** The shelf's floor, in px. */
  minGrid: number;
  /** The detail pane's floor, in px. */
  minDetail: number;
  /** The ratio to keep when the box cannot be measured. */
  fallback: number;
}

/**
 * Two panes: the shelf's share of the whole box.
 *
 * The shelf is on the left, so the ratio is the pointer's distance from the box's left edge over the
 * box's width, clamped so neither column can be pushed under its floor.
 */
export function splitRatioAt(clientX: number, options: SplitDragOptions): number {
  const { box, minGrid, minDetail, fallback } = options;
  if (!(box.width > 0)) return fallback;
  const px = clientX - box.left;
  // A pointer event can carry a value that is not a number at all (a cancelled touch, a synthetic
  // event). `Math.max(low, NaN)` is `NaN`, and a `NaN` ratio becomes `width: NaNpx`, which the
  // browser drops — so the pane takes whatever its content is and the seam stops moving.
  if (!Number.isFinite(px)) return fallback;
  const low = minGrid / box.width;
  const high = (box.width - minDetail) / box.width;
  const raw = px / box.width;
  return Math.min(Math.max(high, low), Math.max(low, raw));
}

export interface ShareDragOptions {
  box: DragBox;
  /** The width every column already has in pixels before the slack is divided. */
  minGrid: number;
  /** The room left once the three floors are paid for. Zero means the columns are pinned. */
  slack: number;
  /** The share to keep when there is no slack to divide. */
  fallback: number;
}

/**
 * Three panes, the shelf's seam: its share of the *slack*, not of the window.
 *
 * Each column keeps its floor and the two shares divide what is left, so both seams have somewhere
 * to go at any width that can hold three panes at all.
 */
export function shelfShareAt(clientX: number, options: ShareDragOptions): number {
  const { box, minGrid, slack, fallback } = options;
  if (!(box.width > 0) || !(slack > 0)) return fallback;
  const px = clientX - box.left;
  if (!Number.isFinite(px)) return fallback;
  return Math.min(1, Math.max(0, (px - minGrid) / slack));
}

export interface SeriesShareOptions extends ShareDragOptions {
  /** The shelf's width: the seam being dragged starts where the shelf ends. */
  gridWidth: number;
  /** The series column's floor, which its share is measured from. */
  minDetail: number;
}

/**
 * Three panes, the seam between the series and the chapter.
 *
 * Measured inside the room the shelf leaves, from the series' own floor: a pointer at the shelf's
 * edge plus `minDetail` is share 0, and a pointer a full slack further right is share 1.
 */
export function seriesShareAt(clientX: number, options: SeriesShareOptions): number {
  const { box, gridWidth, minDetail, slack, fallback } = options;
  if (!(box.width > 0) || !(slack > 0)) return fallback;
  const px = clientX - (box.left + gridWidth);
  if (!Number.isFinite(px)) return fallback;
  return Math.min(1, Math.max(0, (px - minDetail) / slack));
}