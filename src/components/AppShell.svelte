<script lang="ts">
  /**
   * The shell: one navigation model, three presentations.
   *
   * A phone gets a bottom bar, a narrow window a rail, a desktop a sidebar with labels. The
   * destinations and the active state are the same in all three, so nothing about "where am I"
   * changes when the window is resized — only how much room the chrome takes.
   */
  import type { Snippet } from "svelte";
  import { DESTINATIONS, type Destination } from "../lib/destinations";
  import { viewport } from "../lib/layout.svelte";
  import { deviceClass } from "../lib/layout-modes";
  import { go } from "../lib/nav";
  import { navHistory } from "../lib/nav-history.svelte";
  import { settings } from "../state/settings.svelte";

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
  const device = $derived(deviceClass(viewport.width, viewport.height));

  /**
   * The navigation, in the reader's order — the bar, the rail and the sidebar all draw this.
   *
   * One order for every layout was the point of the preference: a page hidden on the phone was still
   * on the tablet rail and the desktop sidebar, so the same account looked like two different apps
   * with two different sets of pages. Three layouts, one list. A page taken off it is still reachable
   * from the page-title menu, which lists every destination and is deliberately not editable.
   *
   * A pref that names nothing drawable still draws the five shipped destinations. The loader and
   * `settings.set` already coerce that away; this is the last line, because an empty bar is a phone
   * with no way out of the page it is on.
   */
  const bar = $derived.by(() => {
    const picked = settings.bottomNav
      .map((id) => DESTINATIONS.find((destination) => destination.id === id))
      .filter((destination): destination is Destination => destination !== undefined);
    return picked.length > 0 ? picked : DESTINATIONS;
  });
</script>

<div class="app" class:compact={device === "phone"} class:medium={device === "tablet"} class:large={device === "desktop"}>
  <!-- First stop in the tab order: the nav repeats on every screen, and a
       keyboard reader should be able to jump past it. -->
  <a class="skip-link" href="#content">Skip to content</a>
  {#if device === "desktop"}
    <aside class="sidebar">
      <div class="brand">HardlyTracking</div>
      <nav aria-label="Main">
        {#each bar as destination (destination.id)}
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
      {#each bar as destination (destination.id)}
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

  <main id="content" tabindex="-1" bind:this={frame}>
    {@render children()}
  </main>

  {#if device === "phone" && (navHistory.depth > 0 || navHistory.canForward)}
    <div class="history-nav" class:br={settings.historyNavCorner === "bottom-right"} class:bl={settings.historyNavCorner === "bottom-left"} class:tl={settings.historyNavCorner === "top-left"} class:tr={settings.historyNavCorner === "top-right"}>
      {#if navHistory.depth > 0}
        <button class="hbtn" aria-label="Back" title="Back" onclick={() => history.back()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
      {/if}
      {#if navHistory.canForward}
        <button class="hbtn" aria-label="Forward" title="Forward" onclick={() => history.forward()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
        </button>
      {/if}
    </div>
  {/if}

  {#if device === "phone"}
    <nav class="bar" aria-label="Main">
      {#each bar as destination (destination.id)}
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
    /*
     * The notch moves to a side edge when the phone is on its side, and nothing used to pay for it:
     * buttons sat under the sensor housing and the first and last column of every grid were clipped.
     * Paying it once, here, keeps every presentation (bar, rail, sidebar, scroller) inside the safe
     * area without each one remembering the two insets.
     */
    padding-left: var(--safe-l);
    padding-right: var(--safe-r);
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
    /* The bottom bar is outside the scroller, so reserve its height here. */
    /* The pinned header owns the top safe area in normal flow. Padding main would make
     * sticky top:0 clamp below the status bar and lift the header over following content. */
    padding-top: 0;
    padding-bottom: calc(var(--nav-h) + var(--safe-b));
  }

  nav {
    display: flex;
  }

  /* Floating back/forward, tucked above the phone bar so it never fights it. Sits over the content
     rather than in the scroll flow, so a long page keeps its room. Bottom right by default (the
     thumb's corner in one hand); the other three are a setting, and each keeps clear of the safe
     areas and of the bar itself. */
  .history-nav {
    position: fixed;
    display: flex;
    gap: var(--s2);
    z-index: 40;
  }
  .history-nav.br {
    right: calc(var(--s3) + var(--safe-r));
    bottom: calc(var(--nav-h) + var(--safe-b) + var(--s2));
  }
  .history-nav.bl {
    left: calc(var(--s3) + var(--safe-l));
    bottom: calc(var(--nav-h) + var(--safe-b) + var(--s2));
  }
  .history-nav.tl {
    left: calc(var(--s3) + var(--safe-l));
    top: calc(var(--safe-t) + var(--s3));
  }
  .history-nav.tr {
    right: calc(var(--s3) + var(--safe-r));
    top: calc(var(--safe-t) + var(--s3));
  }

  .hbtn {
    all: unset;
    box-sizing: border-box;
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border-radius: var(--r-pill);
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    border: 1px solid var(--line-strong);
    color: var(--text-1);
    cursor: pointer;
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    box-shadow: 0 6px 18px rgb(0 0 0 / 35%);
  }

  .hbtn:active {
    transform: scale(0.94);
  }

  .hbtn svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
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
    /* Full-bleed background, inset content: on its side the notch eats the first and last item. */
    inset: auto var(--safe-r) 0 var(--safe-l);
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
  /* Visible only while focused: a skip link that shows all the time is chrome
     the reader did not ask for. */
  .skip-link {
    position: absolute;
    top: 0;
    left: 50%;
    z-index: 100;
    transform: translate(-50%, -120%);
    padding: 10px 16px;
    border-radius: 0 0 10px 10px;
    background: var(--text-1);
    color: var(--bg);
    font-size: var(--t-sm);
    font-weight: 600;
    text-decoration: none;
    transition: transform 0.12s ease;
  }
  .skip-link:focus-visible {
    transform: translate(-50%, 0);
    outline: 2px solid var(--accent-text);
    outline-offset: 2px;
  }
</style>
