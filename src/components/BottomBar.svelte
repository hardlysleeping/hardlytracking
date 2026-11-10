<script lang="ts">
  /**
   * The phone menu: the one component that draws it, whether it is the real bar at the bottom of the
   * app or the picture in Settings while the reader rearranges it.
   *
   * It is one component on purpose. A preview built out of its own copy of this markup is a drawing
   * that drifts: the day a label moves onto two lines, or the active pill changes shape, the preview
   * is still showing last month's bar and quietly lying about what the setting does.
   *
   * `onpick` decides which of the two it is. Without one it draws the same buttons, inert, with no
   * page marked current — a picture, not a control.
   */
  import { flip } from "svelte/animate";
  import type { Destination } from "../lib/destinations";

  let {
    items,
    active = null,
    onpick = null,
    /** The real bar floats over the page; the preview sits inside the settings frame. */
    floating = false,
  }: {
    items: readonly Destination[];
    active?: string | null;
    onpick?: ((destination: Destination) => void) | null;
    floating?: boolean;
  } = $props();

  const live = $derived(onpick !== null);
</script>

<!--
  `inert` rather than `aria-hidden`: the preview's buttons must not be reachable by tab or by a
  screen reader's cursor, but `aria-hidden` on a container of buttons is its own accessibility
  complaint. It also keeps the preview out of the tab order without pretending the buttons are gone.
-->
<nav
  class="bar"
  class:floating
  aria-label={live ? "Main" : undefined}
  inert={!live}
  data-preview={live ? undefined : "true"}
>
  {#each items as destination (destination.id)}
    <button
      class="item"
      class:on={live && active === destination.id}
      aria-current={live && active === destination.id ? "page" : undefined}
      aria-label={destination.label}
      title={destination.label}
      tabindex={live ? undefined : -1}
      onclick={() => onpick?.(destination)}
      animate:flip={{ duration: 180 }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={destination.icon} /></svg>
      <span class="bar-label">{destination.label}</span>
    </button>
  {/each}
</nav>

<style>
  .bar {
    display: flex;
    align-items: center;
    box-sizing: border-box;
    height: 56px;
    padding: 5px;
    gap: 2px;
    border: 1px solid var(--line-strong);
    border-radius: var(--r-pill);
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    -webkit-backdrop-filter: blur(14px);
    backdrop-filter: blur(14px);
    justify-content: space-around;
  }

  /* Over the page, not inside it: this is the app's own bottom menu. */
  .bar.floating {
    position: fixed;
    left: calc(var(--s3) + var(--safe-l));
    right: calc(var(--s3) + var(--safe-r));
    bottom: calc(var(--s3) + var(--safe-b));
    z-index: 20;
    box-shadow: 0 10px 28px rgb(0 0 0 / 42%);
  }

  .item {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    color: var(--text-3);
    border-radius: var(--r-pill);
    transition:
      color var(--dur),
      background var(--dur);
    flex: 1;
    min-width: 0;
    height: 44px;
    min-height: 44px;
    padding: 2px 1px;
    justify-content: center;
    flex-direction: column;
    gap: 2px;
  }

  /* A picture of the bar: no pointer, no press, nothing that suggests it can be tapped. */
  .bar[data-preview] .item {
    cursor: default;
    /* The floating bar sits on glass over a page; here it sits in a form, so it needs its own
       contrast rather than inheriting the dim idle colour that reads as disabled against a card. */
    color: var(--text-2);
  }

  .item svg {
    width: 19px;
    height: 19px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex: none;
  }

  .item:hover {
    color: var(--text-1);
  }

  .bar[data-preview] .item:hover {
    color: var(--text-3);
  }

  .bar[data-preview] {
    background: var(--surface-2);
    box-shadow: 0 6px 18px rgb(0 0 0 / 35%);
  }

  .bar-label {
    font-size: 10px;
    line-height: 1;
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item.on {
    background: var(--accent);
    color: #fff;
  }

  .item.on:hover {
    color: #fff;
  }
</style>
