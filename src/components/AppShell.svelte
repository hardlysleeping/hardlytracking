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
  import { rememberScroll, scrollFor } from "../lib/scroll-memory";
  import { isWebKitShell } from "../lib/shell-scroll";
  import { detectPlatform } from "../lib/webview";
  import { settings } from "../state/settings.svelte";
  import BottomBar from "./BottomBar.svelte";

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
   * A screen starts where it was left; the first time it is opened, at the top.
   *
   * The scroller is one element for every destination, so its `scrollTop` used to survive a route
   * change: leaving a long page half-way down arrived at the next one already partly scrolled, and
   * on a page that fits it looked stuck — partly down, with no way back up. Zeroing it fixed that,
   * but it also threw away the reader's own place: the reader is its own route, so opening a chapter
   * tore the list down, and Back rebuilt it at the top of a page that had been half read.
   *
   * The offset now belongs to the route it was read on. A route seen for the first time starts at
   * the top; a route you come back to starts where you left it. The restore is retried for half a
   * second, because a list still loading its covers is shorter than the place being restored and
   * the browser clamps the first attempt.
   */
  let restoring = false;

  $effect(() => {
    const key = routeKey;
    const el = frame;
    if (el === null) return;
    const wanted = scrollFor(key);
    if (wanted <= 0) {
      el.scrollTop = 0;
      return;
    }
    restoring = true;
    let tries = 0;
    let live = true;
    const attempt = () => {
      if (!live) return;
      el.scrollTop = wanted;
      tries += 1;
      if (Math.abs(el.scrollTop - wanted) < 1 || tries > 40) {
        restoring = false;
        return;
      }
      requestAnimationFrame(attempt);
    };
    attempt();
    return () => {
      live = false;
      restoring = false;
    };
  });

  /**
   * Remember a route's place as it scrolls.
   *
   * Written on a frame, not per scroll event: this runs on a cover grid on a phone, and an
   * IndexedDB-free map write per event is still work done forty times a second for one number.
   */
  $effect(() => {
    const el = frame;
    const key = routeKey;
    if (el === null) return;
    let queued = false;
    const save = () => {
      queued = false;
      if (!restoring) rememberScroll(key, el.scrollTop);
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(save);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (!restoring) rememberScroll(key, el.scrollTop);
    };
  });

  $effect(() => {
    const el = frame;
    if (el === null) return;
    // A browser tab, a Linux webview and a Windows webview do not rubber-band a short screen: the
    // frame is a plain `overflow-y: auto` container there, owned by CSS, with no measurement pass.
    if (!isWebKitShell(detectPlatform(), navigator.userAgent)) return;
    let queued = false;
    let watched: Element | null = null;
    const measure = () => {
      queued = false;
      const overflows = el.scrollHeight > el.clientHeight + 2;
      el.style.overflowY = overflows ? "auto" : "hidden";
      if (!overflows && el.scrollTop !== 0) el.scrollTop = 0;
      // A screen's height is usually its single content element's height (a grid, a form, a
      // message), so that element is watched too — otherwise a view that grows without resizing
      // the frame would keep a stale answer. A ResizeObserver already sees that growth; a
      // `childList/subtree` MutationObserver on the whole frame reloaded this answer for every
      // node any screen ever added, which is the cost this replaces.
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
    // Covers and page images settle after the frame is laid out.
    el.addEventListener("load", schedule, true);
    schedule();
    return () => {
      observer.disconnect();
      el.removeEventListener("load", schedule, true);
      el.style.removeProperty("overflow-y");
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
  /**
   * One pane or two, from the shelf's own sidebar.
   *
   * The library's collections column only exists when collections are laid out as a column, so
   * putting the swap there meant most readers never saw it. It belongs to the shell's navigation
   * column instead: the shape of the shelf is a standing choice, like where you are.
   */
  const paneSwap = active === "library";
</script>

<div class="app" class:compact={device === "phone"} class:medium={device !== "phone"}>
  <!-- First stop in the tab order: the nav repeats on every screen, and a
       keyboard reader should be able to jump past it. -->
  <a class="skip-link" href="#content">Skip to content</a>
  {#if device !== "phone"}
    <nav class="rail" aria-label="Main">
      {#each bar as destination (destination.id)}
        <button
          class="item"
          class:on={active === destination.id}
          aria-current={active === destination.id ? "page" : undefined}
          aria-label={destination.label}
          onclick={() => go(destination.href)}
          title={destination.label}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={destination.icon} /></svg>
        </button>
      {/each}
      {#if paneSwap}
        <div class="panemenu" role="group" aria-label="Library panes">
          <button
            class="pane"
            class:on={settings.libraryPane === "single"}
            aria-pressed={settings.libraryPane === "single"}
            title="One pane"
            onclick={() => settings.set("libraryPane", "single")}
          >1</button>
          <button
            class="pane"
            class:on={settings.libraryPane === "split"}
            aria-pressed={settings.libraryPane === "split"}
            title="Two panes"
            onclick={() => settings.set("libraryPane", "split")}
          >2</button>
          <button
            class="pane"
            class:on={settings.libraryPane === "three"}
            aria-pressed={settings.libraryPane === "three"}
            title="Three panes"
            onclick={() => settings.set("libraryPane", "three")}
          >3</button>
        </div>
      {/if}
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
    <!--
      One component for the real menu and for the picture of it in Settings, so the settings preview
      cannot show a bar the app does not draw.
    -->
    <BottomBar items={bar} {active} floating onpick={(destination) => go(destination.href)} />
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
    position: relative;
  }

  /* A 40 px pill with 44 px of reach: 3 px past the padding box, invisible, so the pill keeps the
     size it was drawn at and the back door is still a full target on a phone. */
  .hbtn::after {
    content: "";
    position: absolute;
    inset: -3px;
    border-radius: inherit;
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

  /* One control, not three buttons: a single frame with the answers stacked inside it, the
     chosen one filled. The rows share a border, so it reads as a vertical menu. */
  .panemenu {
    display: grid;
    gap: 0;
    margin-top: var(--s3);
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--r2);
    overflow: hidden;
    background: var(--surface);
  }
  .panemenu .pane {
    all: unset;
    cursor: pointer;
    display: grid;
    place-items: center;
    min-height: 28px;
    border-radius: 0;
    font-size: var(--t-sm);
    font-variant-numeric: tabular-nums;
    color: var(--text-3);
  }
  .panemenu .pane + .pane { border-top: 1px solid var(--line); }
  .panemenu .pane:hover { color: var(--text-1); background: var(--surface-2); }
  .panemenu .pane.on { color: var(--accent); background: var(--surface-2); }
  .panemenu .pane:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  /* ---- rail (medium) ---- */
  .rail {
    position: fixed;
    inset: 0 auto 0 0;
    width: var(--rail-w);
    padding: calc(var(--s4) + var(--safe-t)) var(--s2) var(--s4) calc(var(--s2) + var(--safe-l));
    border-right: 1px solid var(--line);
    background: var(--surface);
    flex-direction: column;
    /* Same as the sidebar: the rail is a full-height column, so its icons belong in the middle. */
    justify-content: center;
    gap: var(--s2);
  }

  .rail .item {
    /* Icons only: the name is in the tooltip and the accessible name, the way the phone's bar
       does it. A 44 px target is the floor for a thumb, label or not. */
    justify-content: center;
    width: 100%;
    min-height: 44px;
    padding: var(--s2) 0;
  }

  .rail .item.on {
    background: var(--surface-2);
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
