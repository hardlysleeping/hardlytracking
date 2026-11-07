<script lang="ts">
  /**
   * The page title, and the way to every other page.
   *
   * The title used to be an `h1` and nothing else. It is now a button that looks exactly like that
   * `h1` and opens a list of every destination, because the phone bar is editable: a page taken off
   * the bar must still be reachable in one tap, and the title is the one control on every screen.
   *
   * Deliberately NOT editable and deliberately complete. The Settings editors change the bar; if
   * this list followed them, hiding Search would remove the only other way to Search and the page
   * would be unreachable until the preference was edited. So this menu always lists `DESTINATIONS`,
   * in `DESTINATIONS` order, whoever is on the bar.
   */
  import { tick } from "svelte";
  import { DESTINATIONS } from "../lib/destinations";
  import { go } from "../lib/nav";

  interface Props {
    /** The page's name, drawn where the `h1` used to be. */
    title: string;
    /** The destination this page is, marked `aria-current` in the list. */
    current: string;
    /** Search's heading is a step smaller than the other destinations'. */
    size?: "2xl" | "xl";
    /** The Library collapses its title while the shelf is scrolled. */
    compact?: boolean;
  }
  let { title, current, size = "2xl", compact = false }: Props = $props();

  let open = $state(false);
  let root = $state<HTMLElement | null>(null);
  let button = $state<HTMLButtonElement | null>(null);
  let menu = $state<HTMLElement | null>(null);

  function close(returnFocus = false): void {
    open = false;
    if (returnFocus) button?.focus();
  }

  async function show(): Promise<void> {
    open = true;
    // The current row gets the focus, so a keyboard reader lands where they are, and Tab still
    // walks out of the list into the page — this is a menu, not a dialog, and nothing is trapped.
    await tick();
    menu?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  }

  // Closing rules, while it is open: Escape hands the focus back to the title, a tap anywhere
  // outside closes it, and a route change (the bar, a hash link, Back) closes it too — a menu left
  // hanging over the next page would belong to a title that is no longer there.
  $effect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
        return;
      }
      // Arrow keys walk the list: a menu reached by the keyboard should not require Tab between
      // rows any more than a bar of buttons does. Home/End go to the ends. Only while the focus is
      // actually inside the menu, so an arrow pressed on the page still scrolls the page.
      const rows = menu === null ? [] : Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
      if (rows.length === 0) return;
      const at = rows.indexOf(document.activeElement as HTMLElement);
      if (at < 0 && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      let next: number;
      switch (event.key) {
        case "ArrowDown":
          next = at < 0 ? 0 : (at + 1) % rows.length;
          break;
        case "ArrowUp":
          next = at < 0 ? rows.length - 1 : (at - 1 + rows.length) % rows.length;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = rows.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      rows[next]?.focus();
    };
    const onDown = (event: PointerEvent): void => {
      if (root !== null && !root.contains(event.target as Node)) close();
    };
    const onRoute = (): void => close();
    document.addEventListener("keydown", onKey);
    // Capture, so a press on a control that stops propagation still closes the menu.
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("hashchange", onRoute);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("hashchange", onRoute);
    };
  });
</script>

<div class="pagemenu" bind:this={root}>
  <button
    class="title"
    class:compact
    class:xl={size === "xl"}
    type="button"
    aria-haspopup="menu"
    aria-expanded={open}
    title="Switch page"
    bind:this={button}
    onclick={() => (open ? close() : void show())}
  >
    <span class="label">{title}</span>
    <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
  </button>

  {#if open}
    <div class="sheet" role="menu" aria-label="Go to page" bind:this={menu}>
      {#each DESTINATIONS as destination (destination.id)}
        <button
          class="row"
          type="button"
          role="menuitem"
          aria-current={destination.id === current ? "page" : undefined}
          onclick={() => {
            open = false;
            go(destination.href);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={destination.icon} /></svg>
          <span>{destination.label}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .pagemenu {
    /* The menu is positioned against the title, and the title is the first thing in a sticky bar. */
    position: relative;
    display: inline-flex;
    min-width: 0;
    max-width: 100%;
  }

  /*
   * The `h1`'s own type, on a button: 650 weight and the same size token, so the heading looks
   * unchanged to anyone who has not tapped it. The 44 px minimum is the tap target — it was already
   * this tall as a 28 px heading with its line box.
   */
  .title {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    gap: var(--s1);
    min-height: 44px;
    max-width: 100%;
    margin: 0;
    font-size: var(--t-2xl);
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--text-1);
    cursor: pointer;
    border-radius: var(--r2);
    transition: font-size var(--dur);
  }

  .title.xl {
    font-size: var(--t-xl);
  }

  /* The Library's scrolled state: the name stays, the type gets small. */
  .title.compact {
    font-size: var(--t-lg);
  }

  .title:active {
    opacity: 0.7;
  }

  .label {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .chev {
    flex: none;
    width: 14px;
    height: 14px;
    margin-top: 2px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.55;
  }

  /*
   * Opens downward, away from the notch: the bar the title sits in is under the status area, so a
   * menu above it would be half under the sensor housing. The safe insets and the viewport width
   * still cap it, and it scrolls if five 44 px rows are taller than the room left on screen.
   */
  .sheet {
    position: absolute;
    top: calc(100% + var(--s1));
    left: 0;
    z-index: 60;
    min-width: 208px;
    width: max-content;
    max-width: min(calc(100vw - var(--safe-l) - var(--safe-r) - 2 * var(--s3)), 320px);
    max-height: min(60dvh, 420px);
    overflow-y: auto;
    padding: var(--s1);
    border: 1px solid var(--line-strong);
    border-radius: var(--r2);
    background: var(--elevated);
    box-shadow: var(--shadow-2);
  }

  .row {
    all: unset;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: var(--s3);
    width: 100%;
    min-height: 44px;
    padding: 0 var(--s3);
    border-radius: var(--r2);
    font-size: var(--t-md);
    color: var(--text-2);
    cursor: pointer;
  }

  .row:hover {
    background: var(--surface-2);
    color: var(--text-1);
  }

  .row[aria-current="page"] {
    color: var(--accent);
    font-weight: 600;
  }

  .row svg {
    flex: none;
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
