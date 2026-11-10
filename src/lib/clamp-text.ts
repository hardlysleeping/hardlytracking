/**
 * Truncate text to a number of lines with a real ellipsis.
 *
 * `-webkit-line-clamp` cannot be trusted any more: Chromium resolves `display: -webkit-box` to
 * `flow-root`, so the clamp silently does nothing, `overflow: hidden` cuts the text mid-glyph, and a
 * cover title reads as "Absolute Superman vs The Black La" with no sign that anything is missing.
 * iOS WebKit still clamps, so the same markup looked right there and wrong on every Chromium build.
 *
 * So the lines are measured and cut here instead: the box is given the height of exactly `lines`
 * lines, and characters are dropped until the remainder plus an ellipsis fits. Where the CSS clamp
 * does still work this runs on the same text and finds it already fits — it never fights the browser,
 * it just makes the result the same everywhere.
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

export function clampText(node: HTMLElement, options: ClampOptions) {
  let current = options;
  let scheduled = 0;

  function apply(): void {
    const style = getComputedStyle(node);
    const size = Number.parseFloat(style.fontSize) || 12;
    const lineHeight = Number.parseFloat(style.lineHeight) || size * 1.2;
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

  function schedule(): void {
    if (scheduled !== 0) return;
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      apply();
    });
  }

  apply();
  // A grid re-flows on rotation, on a column change, and when the webfont swaps in; all three change
  // how much of the title fits, so all three re-measure.
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  observer?.observe(node);
  void document.fonts?.ready.then(schedule).catch(() => {});

  return {
    update(next: ClampOptions): void {
      current = next;
      schedule();
    },
    destroy(): void {
      if (scheduled !== 0) cancelAnimationFrame(scheduled);
      observer?.disconnect();
    },
  };
}
