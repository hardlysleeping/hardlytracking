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
  import { MARKER_PATH } from "../lib/categories";

  let { compact = false }: { compact?: boolean } = $props();
</script>

<button
  class="pinseat"
  class:compact
  aria-label={`Pinned: ${categories.pinLabel}`}
  aria-pressed={categories.pinView !== "all"}
  title={`Picked shelves, not their contents — ${categories.pinLabel}`}
  onclick={() => void categories.cyclePinView()}
>
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d={MARKER_PATH} /></svg>
  <span class="lbl">{categories.pinLabel}</span>
</button>

<style>
  .pinseat {
    display: inline-flex;
    align-items: center;
    gap: var(--s2);
    min-height: 40px;
    padding: 3px 10px;
    border: 1px solid var(--line);
    border-radius: var(--r2);
    background: color-mix(in srgb, var(--surface) 60%, transparent);
    color: var(--text-2);
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
  .pinseat:hover,
  .pinseat:focus-visible {
    color: var(--text-1);
  }
  .pinseat:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .lbl {
    white-space: nowrap;
  }
</style>
