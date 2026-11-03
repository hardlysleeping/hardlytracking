<script lang="ts">
  /**
   * The shell: one navigation model, three presentations.
   *
   * A phone gets a bottom bar, a narrow window a rail, a desktop a sidebar with labels. The
   * destinations and the active state are the same in all three, so nothing about "where am I"
   * changes when the window is resized — only how much room the chrome takes.
   */
  import type { Snippet } from "svelte";
  import { DESTINATIONS } from "../lib/destinations";
  import { viewport } from "../lib/layout.svelte";
  import { deviceClass } from "../lib/layout-modes";
  import { go } from "../lib/nav";

  let { active, routeKey = "", children }: { active: string; routeKey?: string; children: Snippet } = $props();

  /** The scroller. Bound so the shell can decide whether this screen needs one at all. */
  let frame = $state<HTMLElement | null>(null);

  /**
   * A screen that fits does not scroll.
   *
   * `overflow-y: auto` is still a scroll container when its content is shorter than the box, and iOS
   * rubber-bands every scroll container it is given — so an empty Library, a three-line Settings
   * page and every other short screen could be dragged up and down like a page with content. The
   * shell turns the overflow off when the content fits and back on when it does not, which is the
   * only switch that exists: a scroll container cannot be told "bounce only if I overflow".
   *
   * Watched rather than measured once, because the answer changes as covers load, a list fills in,
   * a banner appears and the window is resized.
   */
  /**
   * A new screen starts at the top.
   *
   * The scroller is one element for every destination, so its `scrollTop` used to survive a route
   * change: leaving a long page half-way down arrived at the next one already partially scrolled, and
   * on a page that fits it looked stuck — partly down, with no way back up, because the shell had
   * switched the overflow off. Reset before the first paint of the new screen, not after a timer.
   */
  $effect(() => {
    void routeKey;
    const el = frame;
    if (el === null) return;
    el.scrollTop = 0;
  });

  $effect(() => {
    const el = frame;
    if (el === null) return;
    let queued = false;
    let watched: Element | null = null;
    const measure = () => {
      queued = false;
      const overflows = el.scrollHeight > el.clientHeight + 2;
      el.style.overflowY = overflows ? "auto" : "hidden";
      if (!overflows && el.scrollTop !== 0) el.scrollTop = 0;
      // A screen's height is usually its single content element's height (a grid, a form, a
      // message), so that element is watched too — otherwise a view that grows without resizing
      // the frame would keep a stale answer.
      const inner = el.firstElementChild;
      if (watched !== inner) {
        if (watched !== null) observer.unobserve(watched);
        if (inner !== null) observer.observe(inner);
        watched = inner;
      }
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    const mutations = new MutationObserver(schedule);
    mutations.observe(el, { childList: true, subtree: true, characterData: true });
    // Covers and page images settle after the frame is laid out.
    el.addEventListener("load", schedule, true);
    schedule();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      el.removeEventListener("load", schedule, true);
    };
  });

  /**
   * The chrome is the library's device class, from the same module the library's own layout comes
   * from — a rail the shell draws is a width the library may not use for a grid.
   */
  const device = $derived(deviceClass(viewport.width));
</script>

<div class="app" class:compact={device === "phone"} class:medium={device === "tablet"} class:large={device === "desktop"}>
  {#if device === "desktop"}
    <aside class="sidebar">
      <div class="brand">HardlyTracking</div>
      <nav aria-label="Main">
        {#each DESTINATIONS as destination (destination.id)}
          <button
            class="item"
            class:on={active === destination.id}
            aria-current={active === destination.id ? "page" : undefined}
            onclick={() => go(destination.href)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={destination.icon} /></svg>
            <span>{destination.label}</span>
          </button>
        {/each}
      </nav>
    </aside>
  {:else if device === "tablet"}
    <nav class="rail" aria-label="Main">
      {#each DESTINATIONS as destination (destination.id)}
        <button
          class="item"
          class:on={active === destination.id}
          aria-current={active === destination.id ? "page" : undefined}
          onclick={() => go(destination.href)}
          title={destination.label}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={destination.icon} /></svg>
          <span>{destination.label}</span>
        </button>
      {/each}
    </nav>
  {/if}

  <main bind:this={frame}>
    {@render children()}
  </main>

  {#if device === "phone"}
    <nav class="bar" aria-label="Main">
      {#each DESTINATIONS as destination (destination.id)}
        <button
          class="item"
          class:on={active === destination.id}
          aria-current={active === destination.id ? "page" : undefined}
          aria-label={destination.label}
          title={destination.label}
          onclick={() => go(destination.href)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={destination.icon} /></svg>
        </button>
      {/each}
    </nav>
  {/if}
</div>

<style>
  /* A frame, not a document: the shell is exactly the screen and `main` is the scroller. A page
   * that scrolls as a document leaves whatever the webview's viewport arithmetic says at the
   * bottom — on an iPhone that was a band of empty space under the bar. */
  .app {
    height: 100dvh;
    max-height: 100dvh;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
    background: var(--bg);
  }

  main {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior-y: contain;
    /*
     * No `-webkit-overflow-scrolling: touch`. It is legacy (iOS 13 scrolls this way anyway) and in
     * WKWebView it hands the frame to a separate momentum scroller that `position: sticky` headings do
     * not stick to — the title rides up with the content during a flick and snaps back at the end.
     */
  }

  .app.large main {
    margin-left: var(--sidebar-w);
  }

  .app.medium main {
    margin-left: var(--rail-w);
  }

  .app.compact main {
    /* The shell is the one owner of the safe areas: the notch is paid for once here, and a view
     * adds only its own breathing room. Every view used to add `var(--safe-t)` again, which put
     * every heading an extra status-bar-height below the top on an iPhone. */
    padding-top: var(--safe-t);
    padding-bottom: calc(var(--nav-h) + var(--safe-b));
  }

  nav {
    display: flex;
  }

  .item {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--s3);
    color: var(--text-3);
    border-radius: var(--r2);
    transition: color var(--dur), background var(--dur);
  }

  .item svg {
    width: 22px;
    height: 22px;
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

  .item.on {
    color: var(--text-1);
  }

  /* ---- sidebar (large) ---- */
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    width: var(--sidebar-w);
    padding: calc(var(--s5) + var(--safe-t)) var(--s3) var(--s4) calc(var(--s3) + var(--safe-l));
    border-right: 1px solid var(--line);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    gap: var(--s5);
  }

  .brand {
    font-size: var(--t-sm);
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--text-2);
    padding: 0 var(--s3);
  }

  .sidebar nav {
    flex-direction: column;
    gap: 2px;
  }

  .sidebar .item {
    padding: var(--s2) var(--s3);
    font-size: var(--t-md);
    min-height: 40px;
  }

  .sidebar .item.on {
    background: var(--surface-2);
    font-weight: 600;
  }

  /* ---- rail (medium) ---- */
  .rail {
    position: fixed;
    inset: 0 auto 0 0;
    width: var(--rail-w);
    padding: calc(var(--s4) + var(--safe-t)) var(--s2) var(--s4) calc(var(--s2) + var(--safe-l));
    border-right: 1px solid var(--line);
    background: var(--surface);
    flex-direction: column;
    gap: var(--s2);
  }

  .rail .item {
    flex-direction: column;
    gap: 2px;
    padding: var(--s2) 0;
    font-size: var(--t-xs);
  }

  .rail .item.on {
    background: var(--surface-2);
  }

  /* ---- bottom bar (compact) ---- */
  .bar {
    position: fixed;
    inset: auto 0 0 0;
    z-index: 20;
    /* An iOS tab bar is 49 pt of content plus the home-indicator inset. Two steps of padding on
     * each side made ours ~20 px taller than that, which is the "fat band" a phone user sees. */
    padding: 4px var(--s1) calc(4px + var(--safe-b)) var(--s1);
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    backdrop-filter: blur(14px);
    border-top: 1px solid var(--line);
    justify-content: space-around;
  }

  .bar .item {
    flex: 1;
    /* Icon-only: the labels were taken off the phone bar, so the button is the icon and the tap
     * target. 48px of content keeps the target at Apple's 44pt minimum while the bar stays a
     * single row of glyphs — `--nav-h` in app.css is this height plus the padding and the hairline. */
    height: 48px;
    min-height: 48px;
    padding: 0;
    justify-content: center;
  }

  .bar .item.on {
    color: var(--accent);
  }
</style>
