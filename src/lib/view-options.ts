/**
 * View options: the knobs that change how much room the content gets.
 *
 * Borrowed from HardlyReader, where the pane layout is a *setting* rather than a consequence of the
 * window size: the mode the reader picked is kept even when the window is too narrow to draw it, the
 * app renders what fits and says it is squeezed, and widening restores the layout with no click.
 *
 * Everything here is a decision, not a CSS class, so the numbers are testable and every screen makes
 * the same choice from the same inputs.
 */

export type Margins = "comfortable" | "compact" | "none";
export type PanePreference = "auto" | "single" | "split";
export type Density = "auto" | "manual" | "compact" | "comfortable" | "large";

export const MARGIN_CHOICES: Array<{ id: Margins; label: string; hint: string }> = [
  { id: "comfortable", label: "Comfortable", hint: "Room around the content" },
  { id: "compact", label: "Compact", hint: "Tighter edges, same layout" },
  { id: "none", label: "None", hint: "Content to the very edge" },
];

export const PANE_CHOICES: Array<{ id: PanePreference; label: string }> = [
  { id: "auto", label: "Automatic" },
  { id: "single", label: "One pane" },
  { id: "split", label: "Two panes" },
];

/** Horizontal and vertical padding for a screen, in px. */
export function contentPadding(margins: Margins): { x: number; y: number } {
  if (margins === "none") return { x: 4, y: 8 };
  if (margins === "compact") return { x: 10, y: 12 };
  return { x: 16, y: 16 };
}

/** The gap between cards and rows, which follows the margins rather than fighting them. */
export function contentGap(margins: Margins): number {
  if (margins === "none") return 6;
  if (margins === "compact") return 10;
  return 16;
}

/**
 * One pane or two, for a screen of this width.
 *
 * `split` is a preference, not a promise: below the width where both panes keep their minimum the
 * answer is a single pane, and the caller can say so instead of drawing a 40 px list. `auto` splits
 * only when there is room to spare — 1000 px is the same floor the tablet layout uses.
 */
export function paneMode(
  preference: PanePreference,
  width: number,
  minimums: { list: number; detail: number } = { list: 300, detail: 340 },
): "single" | "split" {
  // Both panes at their minimum plus a gutter is the floor — a split that leaves no room between
  // them is a single pane with a seam drawn in it.
  const floor = minimums.list + minimums.detail + 120;
  if (preference === "single") return "single";
  if (preference === "split") return width >= floor ? "split" : "single";
  return width >= Math.max(1000, floor) ? "split" : "single";
}

/** True when the reader asked for two panes and this screen cannot draw them. */
export function squeezed(preference: PanePreference, width: number, minimums?: { list: number; detail: number }): boolean {
  return preference === "split" && paneMode(preference, width, minimums) === "single";
}

/** The share of the width the list pane takes, clamped so neither side collapses. */
export function paneRatio(ratio: number, width: number, minimums: { list: number; detail: number } = { list: 300, detail: 340 }): number {
  if (!Number.isFinite(ratio) || width <= 0) return 0.5;
  const floor = Math.min(0.6, minimums.list / width);
  const ceiling = Math.max(0.4, 1 - minimums.detail / width);
  return Math.min(Math.max(ratio, Math.max(0.35, floor)), Math.min(0.7, ceiling));
}

/**
 * What "maximize space" turns off.
 *
 * It is not a zoom: it removes the things that exist for comfort only — the screen's own heading and
 * the Continue strip — and lets the grid keep the pixels. Every control stays reachable, so nothing
 * is lost, only spaced.
 */
export function spaceSavers(maximize: boolean): { hideHeading: boolean; hideContinue: boolean; padY: number } {
  return maximize ? { hideHeading: true, hideContinue: true, padY: 6 } : { hideHeading: false, hideContinue: false, padY: 16 };
}

/** The `<html>` attributes the stylesheet keys off, so one write changes every screen. */
export function chromeAttributes(options: { margins: Margins; maximize: boolean; density: Density }): Record<string, string> {
  return {
    "data-margins": options.margins,
    "data-space": options.maximize ? "max" : "normal",
    "data-density": options.density,
  };
}
