<script lang="ts">
  /**
   * The pin: which shelves are shown, not what is on them.
   *
   * It lives outside the visibility band on purpose. The band folds, and a control that decides
   * *which* shelves are on screen should not disappear with the thing it does not belong to — so
   * above the band while the library is open, and in the top bar (centred, on the search row) while
   * the curtain is down, where it is the one control that still has something to say.
   *
   * One component for both homes: the words in `aria-label`/`title` are the same in each, so the
   * button cannot mean two things in two places.
   */
  import { categories } from "../state/categories.svelte";
  import { PIN_PATHS } from "../lib/categories";

  let { compact = false }: { compact?: boolean } = $props();
</script>

<button
  class="pinseat"
  class:compact
  class:off={categories.pinView === "without"}
  class:loud={categories.pinView === "only"}
  aria-label={`Pinned: ${categories.pinLabel}`}
  aria-pressed={categories.pinView !== "all"}
  title={`Picked shelves, not their contents — ${categories.pinLabel}`}
  onclick={() => void categories.cyclePinView()}
>
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d={PIN_PATHS[categories.pinView]} /></svg>
  <span class="lbl">{categories.pinLabel}</span>
</button>

<style>
  .pinseat {
    display: inline-flex;
    align-items: center;
    gap: var(--s2);
    min-height: 40px;
    padding: 3px 10px;
    /* The frame is the glyph's colour, so the pill reads as the pin rather than as chrome. */
    border: 1px solid color-mix(in srgb, currentColor 40%, transparent);
    border-radius: var(--r2);
    background: color-mix(in srgb, currentColor 8%, transparent);
    color: var(--tone-pinned);
    font-size: var(--t-xs);
    cursor: pointer;
    -webkit-backdrop-filter: blur(12px) saturate(1.2);
    backdrop-filter: blur(12px) saturate(1.2);
  }
  .pinseat.compact {
    min-height: 44px;
    padding: 0 10px;
    gap: var(--s1);
  }
  .pinseat svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linejoin: round;
  }
  /* Put away: crossed out and grey. Narrowed to one shelf: the same blue, and the word goes white. */
  .pinseat.off { color: var(--text-3); }
  .pinseat.loud .lbl { color: var(--text-1); font-weight: 600; }
  .pinseat:hover { background: color-mix(in srgb, currentColor 18%, transparent); }
  .pinseat:focus-visible {
    color: inherit;
  }
  .pinseat:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .lbl {
    white-space: nowrap;
  }
</style>
