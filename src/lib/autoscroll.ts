/**
 * Autoscroll: the page moves on its own at a speed the reader chose.
 *
 * The rule this file exists to keep: **it never runs unless it was started**, and its pace is a
 * function of elapsed time rather than of frames. A loop that adds "one step per frame" scrolls at
 * double speed on a 120 Hz screen and at half speed when the webview is throttled; a loop that adds
 * `speed × dt` scrolls at the speed the slider says, on any screen.
 */

/** What the speed control offers, in pixels per second. 0 is not a choice: it is off. */
export const AUTOSCROLL_SPEEDS: Array<{ id: string; label: string; pxPerSecond: number }> = [
  { id: "slow", label: "Slow", pxPerSecond: 18 },
  { id: "steady", label: "Steady", pxPerSecond: 40 },
  { id: "quick", label: "Quick", pxPerSecond: 80 },
  { id: "fast", label: "Fast", pxPerSecond: 140 },
];

export const DEFAULT_AUTOSCROLL_SPEED = "steady";

export type AutoscrollSpeed = (typeof AUTOSCROLL_SPEEDS)[number]["id"];

/**
 * How the pace changes as the page nears its end.
 *
 * `linear` is what the number says. `slower-bottom` eases off over the last screens so the end of a
 * chapter arrives rather than runs away; `faster-bottom` does the opposite, for readers who want the
 * tail of a chapter out of the way.
 */
export const AUTOSCROLL_CURVES: Array<{ id: "linear" | "slow-bottom" | "fast-bottom"; label: string }> = [
  { id: "linear", label: "Steady pace" },
  { id: "slow-bottom", label: "Ease out at the end" },
  { id: "fast-bottom", label: "Speed up at the end" },
];

export type AutoscrollCurve = (typeof AUTOSCROLL_CURVES)[number]["id"];
export const DEFAULT_AUTOSCROLL_CURVE: AutoscrollCurve = "linear";

/** A stored speed id, or the default — a value from an older build must not stop the loop. */
export function autoscrollSpeedOf(value: unknown): AutoscrollSpeed {
  const match = AUTOSCROLL_SPEEDS.find((entry) => entry.id === value);
  return match === undefined ? DEFAULT_AUTOSCROLL_SPEED : match.id;
}

export function autoscrollCurveOf(value: unknown): AutoscrollCurve {
  const match = AUTOSCROLL_CURVES.find((entry) => entry.id === value);
  return match === undefined ? DEFAULT_AUTOSCROLL_CURVE : match.id;
}

export function pxPerSecondOf(speed: AutoscrollSpeed): number {
  return AUTOSCROLL_SPEEDS.find((entry) => entry.id === speed)?.pxPerSecond ?? 40;
}

/** How much a curve multiplies the base pace at a given point in the scroll. */
export function curveFactor(curve: AutoscrollCurve, progress: number): number {
  // Progress is 0 at the top and 1 at the bottom; anything outside that is clamped, not compounded.
  const at = Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : 0;
  // The last 25% of the scroll is where a curve has anything to say.
  const tail = Math.max(0, (at - 0.75) / 0.25);
  if (curve === "slow-bottom") return 1 - 0.65 * tail;
  if (curve === "fast-bottom") return 1 + 1.6 * tail;
  return 1;
}

/**
 * Pixels to advance for a frame that lasted `elapsedMs`.
 *
 * Deliberately unrounded: rounding each frame down (or up) turns a 40 px/s choice into 42 px/s over
 * a minute. The reader keeps the fraction and spends it on a later frame. A clock that appears to go
 * backwards (a suspend and resume, a fake timer) contributes nothing rather than scrolling back up.
 */
export function advancePx(
  elapsedMs: number,
  speed: AutoscrollSpeed,
  curve: AutoscrollCurve,
  progress: number,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  const base = pxPerSecondOf(speed) * (elapsedMs / 1000);
  const stepped = base * curveFactor(curve, progress);
  return Math.max(stepped, 0);
}

/** Where the scroller is, as a fraction, with a one-pixel bottom treated as the end. */
export function progressOf(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const span = scrollHeight - clientHeight;
  if (!Number.isFinite(span) || span <= 0) return 1;
  return Math.min(Math.max(scrollTop / span, 0), 1);
}
