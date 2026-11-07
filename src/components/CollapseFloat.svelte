<script lang="ts">
  /**
   * The way back out of an opened card.
   *
   * An opened item used to carry a "Close details" button at its own top, which meant scrolling back
   * up to the thing you had just opened in order to close it. This is the same gesture as the
   * floating Back: one control, in the thumb's corner, above the back/forward pair — so the two ways
   * out of a screen sit together and neither moves the page.
   *
   * It follows the reader's corner preference (`historyNavCorner`), because a control that appears
   * where the thumb is not is a control you have to hunt for.
   */
  import { settings } from "../state/settings.svelte";

  let { oncollapse }: { oncollapse: () => void } = $props();
  const corner = $derived(settings.historyNavCorner);
</script>

<button
  class="collapse-float"
  class:br={corner === "bottom-right"}
  class:bl={corner === "bottom-left"}
  class:tl={corner === "top-left"}
  class:tr={corner === "top-right"}
  type="button"
  aria-label="Collapse details"
  title="Collapse details"
  onclick={oncollapse}
>
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
</button>

<style>
  /* The same shape as `.hbtn` in the shell, one row above it: same size, same glass, same shadow, so
     the pair reads as one control cluster rather than two floating buttons that happen to be near
     each other. */
  .collapse-float {
    all: unset;
    box-sizing: border-box;
    position: fixed;
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border-radius: var(--r-pill);
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    border: 1px solid var(--line-strong);
    color: var(--text-1);
    cursor: pointer;
    z-index: 41;
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    box-shadow: 0 6px 18px rgb(0 0 0 / 35%);
  }
  .collapse-float:active {
    transform: scale(0.94);
  }
  .collapse-float svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  /* 40 px button + 8 px of air: the back pair's own offsets, lifted by one button. */
  .collapse-float.br {
    right: calc(var(--s3) + var(--safe-r));
    bottom: calc(var(--nav-h) + var(--safe-b) + var(--s2) + 48px);
  }
  .collapse-float.bl {
    left: calc(var(--s3) + var(--safe-l));
    bottom: calc(var(--nav-h) + var(--safe-b) + var(--s2) + 48px);
  }
  .collapse-float.tl {
    left: calc(var(--s3) + var(--safe-l));
    top: calc(var(--safe-t) + var(--s3) + 48px);
  }
  .collapse-float.tr {
    right: calc(var(--s3) + var(--safe-r));
    top: calc(var(--safe-t) + var(--s3) + 48px);
  }
</style>
