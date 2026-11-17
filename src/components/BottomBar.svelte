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

  /**
   * Icons only, on every screen that draws this bar.
   *
   * The labels were the reason the bar needed a second line of type at 10 px, which is below what a
   * phone can read at arm's length and made five destinations into five cramped columns. The icon
   * is the destination; the name is still in `aria-label` and in the tooltip, so nothing is lost to
   * a screen reader or to a long press. The rail and the sidebar keep their labels — they have the
   * room.
   */
  .item {
    all: unset;
    cursor: pointer;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
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
    position: relative;
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

  .item.on {
    color: #fff;
  }

  /* The accent is an icon-sized pill, not the whole tap target.
   *
   * With a label under the icon the full-width pill read as a tab; with icons only it was a wide
   * empty oval four times the width of the glyph in it. The button stays the full width, so the
   * target and the even spacing are unchanged — only the painted shape is smaller. */
  .item.on::before {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 52px;
    height: 34px;
    border-radius: var(--r-pill);
    background: var(--accent);
    transform: translate(-50%, -50%);
  }

  .item.on:hover {
    color: #fff;
  }
</style>
