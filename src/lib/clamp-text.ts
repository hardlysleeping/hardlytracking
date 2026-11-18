/**
 * Truncate text to a number of lines with a real ellipsis.
 *
 * `-webkit-line-clamp` cannot be trusted: Chromium resolves `display: -webkit-box` to `flow-root`,
 * so the clamp silently does nothing, `overflow: hidden` cuts the text mid-glyph, and a cover title
 * reads as "Absolute Superman vs The Black La" with no sign that anything is missing. Measured in
 * Chromium 152 (the engine this app ships against on desktop) rather than assumed: with
 * `display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden`, the
 * computed display is `flow-root`, four lines are laid out for a two-line box, and no ellipsis is
 * ever drawn — inside a `content-visibility: auto` tile or outside one. The `line-clamp` longhand
 * computes to `none` there. iOS WebKit does clamp, so the same markup looked right on the phone and
 * wrong on every Chromium build, which is worse than being wrong everywhere.
 *
 * So the lines are measured and cut here instead: the box is given the height of exactly `lines`
 * lines, and characters are dropped until the remainder plus an ellipsis fits. Where the CSS clamp
 * does still work this runs on the same text and finds it already fits — it never fights the browser,
 * it just makes the result the same everywhere.
 *
 * The measurement is shared, because a shelf draws hundreds of these: one `ResizeObserver` for every
 * title instead of one per title, one `document.fonts.ready` hook instead of one per title, and a run
 * skipped when nothing that affects wrapping changed (same text, same lines, same width, same font).
 * The observer only reports elements whose box changed, so a resize costs one pass per re-wrapped
 * title rather than a pass over the shelf.
 */
export interface ClampOptions {
  /** How many lines the box may use. Two is a cover title. */
  lines: number;
  /** The whole text. Passed in, not read from the DOM, so a Svelte update re-clamps. */
  text: string;
}

/**
 * The visible text: the whole thing when it fits, otherwise the longest prefix that fits with an
 * ellipsis. `fits` renders a candidate and answers whether it stayed inside the box, so this stays
 * pure and testable with a fake measure.
 */
export function clampToLines(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text;
  let low = 0;
  let high = text.length;
  let best = "…";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    // Cut on a character, then drop trailing punctuation/space so the ellipsis is not glued to a
    // half word or to a comma.
    const candidate = `${text.slice(0, middle).replace(/[\s,;:.\-–—]+$/u, "")}…`;
    if (fits(candidate)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/** One clamped node, as the shared observer needs it. */
interface ClampEntry {
  /** Width the last measurement was made at, so a height-only resize is not a re-measure. */
  width: number;
  /** Coalesced re-measure, with `force` for a font change (same width, different glyphs). */
  schedule: (force: boolean) => void;
}

/** Every live clamped node, by element. A `Map`, so a torn-down tile leaves with its entry. */
const entries = new Map<HTMLElement, ClampEntry>();

/**
 * One observer for every title on screen.
 *
 * Created on first use, and never disconnected: an empty observer costs nothing, and a shelf that
 * comes back after a route change does not pay to build a new one.
 */
let shared: ResizeObserver | null = null;

/** Whether the webfont hook is installed. One `fonts.ready` is enough for every title. */
let fontsHooked = false;

/**
 * Width below which two measurements are the same measurement.
 *
 * A sub-pixel change cannot move a line break, and treating a fractional resize as a re-wrap would
 * put the binary search back on every frame of a window drag.
 */
const WIDTH_EPSILON = 0.5;

function observer(): ResizeObserver | null {
  if (typeof ResizeObserver === "undefined") return null;
  shared ??= new ResizeObserver((records) => {
    for (const record of records) {
      const entry = entries.get(record.target as HTMLElement);
      if (entry === undefined) continue;
      const width = record.contentRect.width;
      if (Math.abs(width - entry.width) < WIDTH_EPSILON) continue;
      entry.width = width;
      entry.schedule(false);
    }
  });
  return shared;
}

export function clampText(node: HTMLElement, options: ClampOptions) {
  let current = options;
  let scheduled = 0;
  /** A run is already queued; is it a forced one? (A font swap must not be swallowed by the queue.) */
  let forced = false;
  /** What the last run measured. A repeat of this is a run with nothing to decide. */
  let measured = "";

  function run(force: boolean): void {
    const style = getComputedStyle(node);
    const size = Number.parseFloat(style.fontSize) || 12;
    const lineHeight = Number.parseFloat(style.lineHeight) || size * 1.2;
    const width = node.clientWidth;
    const key = `${current.lines}\u0000${width}\u0000${size}\u0000${lineHeight}\u0000${current.text}`;
    if (!force && key === measured) return;
    measured = key;
    const entry = entries.get(node);
    if (entry !== undefined) entry.width = width;

    const text = current.text;
    const padTop = Number.parseFloat(style.paddingTop) || 0;
    const padBottom = Number.parseFloat(style.paddingBottom) || 0;
    const content = Math.ceil(lineHeight * current.lines);
    // The cover title's padding is what carries the gradient under the text, so the box is taller
    // than its two lines and `max-height` has to keep that padding in mind.
    const box = style.boxSizing === "border-box" ? content + padTop + padBottom : content;
    node.style.maxHeight = `${box}px`;
    node.style.overflow = "hidden";
    node.textContent = clampToLines(text, (candidate) => {
      node.textContent = candidate;
      // scrollHeight is what the text *wants*; clientHeight is what the box allows. Equal means it
      // fit — and because the limit is the box we just set, this cannot feed back on itself.
      return node.scrollHeight <= node.clientHeight + 1;
    });
  }

  function schedule(force: boolean): void {
    if (force) forced = true;
    if (scheduled !== 0) return;
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      const runForced = forced;
      forced = false;
      run(runForced);
    });
  }

  const entry: ClampEntry = {
    width: node.clientWidth,
    schedule,
  };
  entries.set(node, entry);
  observer()?.observe(node);

  run(false);

  // A grid re-flows on rotation, on a column change, and when the webfont swaps in; all three change
  // how much of the title fits. The first two arrive through the shared observer above; the font
  // arrives once for the whole app, and every title re-measures at that point.
  if (!fontsHooked && typeof document !== "undefined" && document.fonts !== undefined) {
    fontsHooked = true;
    void document.fonts.ready
      .then(() => {
        for (const live of entries.values()) live.schedule(true);
      })
      .catch(() => {});
  }

  return {
    update(next: ClampOptions): void {
      current = next;
      schedule(false);
    },
    destroy(): void {
      if (scheduled !== 0) cancelAnimationFrame(scheduled);
      entries.delete(node);
      shared?.unobserve(node);
    },
  };
}