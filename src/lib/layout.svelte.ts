/**
 * How much room we have, and what that means for the shell.
 *
 * Three classes, and only three: `compact` (a phone, one pane, bottom bar), `medium` (a small
 * tablet or a narrow window, rail + one or two panes), `large` (a desktop, sidebar + master/detail).
 * Views ask `viewport.size`; they do not read `innerWidth` themselves, because two components
 * disagreeing about the breakpoint is how a layout ends up half-adapted.
 *
 * The thresholds are the plan's: < 600 one pane, 600–1000 rail, > 1000 sidebar.
 */
export type Size = "compact" | "medium" | "large";

class Viewport {
  width = $state(1200);
  height = $state(800);

  /**
   * The shorter side decides, for the same reason `deviceClass` does: a phone on its side must not
   * become a tablet, or its chrome changes under a finger that merely rotated the device.
   */
  get size(): Size {
    // A phone on its side is still a phone; everything wider than that is judged by width alone.
    if (Math.min(this.width, this.height) < 600) return "compact";
    if (this.width <= 1000) return "medium";
    return "large";
  }

  /** Two panes side by side: a list and its detail. */
  get canSplit(): boolean {
    return this.width > 1000;
  }

  /** The reader wants the whole width even on a phone in landscape. */
  get landscape(): boolean {
    return this.width > this.height;
  }

  private frame = 0;

  start(): () => void {
    if (typeof window === "undefined") return () => {};
    const read = () => {
      this.width = window.innerWidth;
      this.height = window.innerHeight;
    };
    read();
    const onResize = () => {
      // A resize drag fires per frame; one write per frame is enough for a layout decision.
      if (this.frame !== 0) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        read();
      });
    };
    addEventListener("resize", onResize, { passive: true });
    return () => {
      removeEventListener("resize", onResize);
      if (this.frame !== 0) cancelAnimationFrame(this.frame);
    };
  }
}

export const viewport = new Viewport();
