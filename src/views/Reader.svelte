<script lang="ts">
  /**
   * The reader. Immersive by default, and the most careful screen in the app.
   *
   * Three behaviours matter and everything else serves them:
   *
   * 1. **The page owns the screen.** No chrome until you ask for it — a tap in the middle, or a
   *    key. It hides again after three seconds.
   * 2. **A tap on an edge turns the page**, and which edge means "forward" follows the reading
   *    direction, not the physical side.
   * 3. **The position is written as you read**, debounced, together with history — never by
   *    opening the chapter, which is not the same thing as reading it.
   *
   * A downloaded chapter is read from this device: the pages come from the library database as
   * blobs, so the extension host can be offline and the chapter still opens.
   */
  import type { LocalChapter } from "../lib/downloads/engine";
  import { library } from "../state/library.svelte";
  import { downloads } from "../state/downloads.svelte";
  import { settings } from "../state/settings.svelte";
  import { providerFor } from "../api/registry";
  import type { Chapter, Page } from "../api/source";
  import { tick } from "svelte";
  import { go, pathTo } from "../lib/nav";
  import { pageSrc } from "../lib/pages";
  import { RUNTIME_DEADLINE_MS, withDeadline } from "../lib/deadline";
  import { INACTIVITY_TIMEOUT_MS, shouldEndForBackground } from "../lib/history";
  import Sheet from "../components/Sheet.svelte";

  interface Props {
    seriesId: string;
    chapterId: string;
  }
  let { seriesId, chapterId }: Props = $props();

  let pages = $state<Page[]>([]);
  let urls = $state<string[]>([]);

  /**
   * How many pages either side of the current one are actually loaded.
   *
   * Four each way is a screen and a half of scrolling in either direction: enough that a flick never
   * lands on a blank page, and small enough that a 214-page chapter holds nine images, not 214.
   */
  const WINDOW = 4;

  /**
   * A page that needs bytes we do not have a URL for: fetch them when it is near the viewport — and
   * the moment it is the page being read.
   *
   * The second half is not an optimisation. An `IntersectionObserver` is delivered with a rendered
   * frame, so a tab that is not painting — backgrounded, a screenshot run, a webview still occluded
   * behind the app that opened it — never delivers one. The reader then sat on "Fetching pages…"
   * with every page blank, however long it waited, and one frame later it was fine. So the page the
   * reader is on is fetched by itself; the observer stays for the neighbours it is meant to prefetch.
   */
  function lazyPage(
    node: HTMLImageElement,
    params: { page: Page; now: boolean },
  ): { update: (next: { page: Page; now: boolean }) => void; destroy: () => void } {
    const page = params.page;
    let live = true;
    let started = false;

    const load = (): void => {
      if (started) return;
      started = true;
      void pageSrc(page).then((src) => {
        if (!live) return;
        node.src = src;
      });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        load();
      },
      // A screen and a half ahead: enough that a scroll never shows a blank, and no more.
      { rootMargin: "150% 0px" },
    );

    if (params.now) load();
    else observer.observe(node);

    return {
      update(next) {
        if (!next.now) return;
        observer.disconnect();
        load();
      },
      destroy() {
        live = false;
        observer.disconnect();
        // The URL is not revoked here: `pages.ts` and `imageCache` own the blob URLs they hand out
        // and bound them themselves (12 local pages, 160 cached images). Revoking one here left that
        // cache pointing at a dead URL, and a page came back blank when the reader returned to it.
      },
    };
  }
  let index = $state(0);
  let busy = $state(true);
  let error = $state<string | null>(null);
  let read = $state(false);
  let chapterName = $state("");
  let chapters = $state<Chapter[]>([]);
  let fromDownload = $state(false);
  /** Set when the chapter is on this device but not all of it: pages that arrived, and the rest. */
  let partialNotice = $state<string | null>(null);

  let chrome = $state(true);
  let settingsOpen = $state(false);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  let scroller = $state<HTMLDivElement | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The open reading session, and the last page reached in it.
   *
   * A session is a data model, not analytics: it starts when the chapter is actually on screen,
   * ends when the reader closes, the chapter changes, the app has been in the background longer
   * than the grace period, or the page has not turned for the inactivity timeout. A short glance
   * at another app continues the same session — the rules live in `lib/history` and are tested
   * there, so this file only has to notice the moments.
   */
  let sessionId: string | null = null;
  let lastPage = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let hiddenAt: number | null = null;

  const MODES = [
    { id: "vertical", label: "Vertical" },
    { id: "webtoon", label: "Webtoon" },
    { id: "paged", label: "Paged" },
    { id: "ltr", label: "Left → right" },
    { id: "rtl", label: "Right → left" },
  ] as const;

  const FITS = [
    { id: "width", label: "Width" },
    { id: "height", label: "Height" },
    { id: "contain", label: "Whole page" },
  ] as const;

  const horizontal = $derived(settings.readerMode === "paged" || settings.readerMode === "ltr" || settings.readerMode === "rtl");
  const rtl = $derived(settings.readerMode === "rtl");

  $effect(() => {
    void load(chapterId);
  });

  /**
   * Close the open session at the page it reached, with whether the chapter was finished.
   *
   * Closing twice is a no-op: the store refuses to rewrite a closed session, so a chapter change
   * followed by the reader closing cannot double-count the time.
   */
  function closeSession(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    const id = sessionId;
    sessionId = null;
    if (id === null) return;
    const finished = pages.length > 0 && lastPage >= pages.length - 1;
    void library.endSession(id, lastPage, finished);
  }

  /** Restart the inactivity clock: any page turn is evidence of reading. */
  function armIdle(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    if (sessionId === null) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      closeSession();
    }, INACTIVITY_TIMEOUT_MS);
  }

  $effect(() => {
    // No reactive reads: this runs once, and its cleanup is the reader closing — by Back, by a
    // route change, or by the tab going away. A session left open is still visible as unfinished.
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const hidden = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      // A quick glance at another app is the same sitting; a long absence is not.
      if (shouldEndForBackground(hidden)) closeSession();
      else armIdle();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      closeSession();
    };
  });

  $effect(() => {
    // Chrome starts visible and then gets out of the way, so a reader who opened the chapter
    // knows where the controls are before they disappear.
    if (chrome) arm();
    return () => {
      if (hideTimer !== null) clearTimeout(hideTimer);
    };
  });

  function arm(): void {
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      chrome = false;
      hideTimer = null;
    }, 3200);
  }

  function showChrome(): void {
    chrome = true;
    arm();
  }

  /**
   * The chapter list, with the stored copy as the fallback.
   *
   * With the extension host down, a downloaded chapter must still open — the name and the
   * prev/next buttons are a nicety, and a failed fetch must not take the chapter with it.
   */
  async function chapterList(seriesId: string): Promise<Chapter[]> {
    try {
      return await withDeadline(library.chapters(seriesId), RUNTIME_DEADLINE_MS, "the chapter list");
    } catch {
      // A stored list is the fallback when the source is down — and it too can hang, if the database
      // is the thing that stopped answering. An empty chapter list is a reader that still reads.
      try {
        return (await withDeadline(library.profile?.store.listChapters(seriesId) ?? Promise.resolve([]), RUNTIME_DEADLINE_MS, "the stored chapter list")) ?? [];
      } catch {
        return [];
      }
    }
  }

  /**
   * Show the device's copy of a chapter.
   *
   * The URLs are already object URLs for the pages that are here; a page the device does not have
   * stays empty rather than pointing at the network, because this path exists precisely for the
   * case where the network is not available. A chapter that is only partly here says so.
   */
  async function openLocal(local: LocalChapter): Promise<void> {
    // Pages that are here come from the device. Pages that are not are filled from the source when
    // there is a connection — the alternative was `<img src="">`, which renders as a broken image
    // and reads as a broken chapter.
    const gaps = local.urls.some((url) => url === null);
    let remote: Page[] = [];
    if (gaps) {
      try {
        remote = await withDeadline(library.pages(local.chapterId), RUNTIME_DEADLINE_MS, "the missing pages");
      } catch {
        remote = [];
      }
    }
    const filled = await Promise.all(
      local.urls.map(async (url, index) => {
        if (url !== null) return { index, url } as Page;
        const fallback = remote[index];
        if (fallback === undefined) return { index, url: "" } as Page;
        return { index, url: await pageSrc(fallback) } as Page;
      }),
    );
    pages = filled;
    urls = filled.map((page) => page.url);
    const stillMissing = filled.filter((page) => page.url === "").length;
    partialNotice =
      stillMissing === 0
        ? null
        : `${stillMissing} of ${local.total} pages are not on this device and could not be fetched. Retry the download when you have a connection.`;
  }

  async function load(id: string): Promise<void> {
    if (library.profile === null) return;
    busy = true;
    error = null;
    index = 0;
    partialNotice = null;
    // A chapter that fails to load must not leave the last one's pages on screen: "1 / 124" beside
    // another book's error reads as if this chapter were 124 pages long.
    pages = [];
    urls = [];
    chapterName = "";
    try {
      // Every step below can wait on something outside this screen — a download row, the database,
      // a book being unpacked, the source that owns the chapter — and none of them used to have a
      // deadline. A step that never settled left the reader on "Fetching pages…" with no error and
      // no way out, which is indistinguishable from a frozen app. Each one now says which part it
      // was waiting on, in the same 30 s the rest of the app uses for a source that has gone quiet.
      // A downloaded chapter wins: it is the one that works with no network.
      const local = await withDeadline(downloads.local(id), RUNTIME_DEADLINE_MS, "this device's downloads");
      if (local !== null) {
        fromDownload = true;
        await openLocal(local);
      } else {
        fromDownload = false;
        pages = await withDeadline(library.pages(id), RUNTIME_DEADLINE_MS, "the page list");
        // A plain page is just its URL. A page that needs a header is resolved when it comes near
        // the viewport (`use:lazyPage`), because resolving all of them up front fetched every page
        // of a 214-page chapter the moment it opened — gigabytes of scans for one visible page.
        // A page with no URL of its own — one that needs a header, or one this device produces from a
        // CBZ/PDF — is resolved by `use:lazyPage` when it comes near the viewport.
        urls = pages.map((page) => (page.headers === undefined && page.open === undefined ? page.url : ""));
      }
      const progress = await withDeadline(
        library.profile.store.getProgress(id),
        RUNTIME_DEADLINE_MS,
        "the library database",
      );
      index = Math.min(progress?.page ?? 0, Math.max(pages.length - 1, 0));
      read = library.ownsProgress(id)
        ? await withDeadline(library.profile.store.isRead(id), RUNTIME_DEADLINE_MS, "the library database")
        : false;

      // The chapter list is a nicety for the name and the prev/next buttons; with the host down
      // it must not stop a downloaded chapter from opening, so the stored list is the fallback.
      const list = await chapterList(seriesId);
      chapters = list;
      chapterName =
        list.find((row) => row.id === id)?.name ??
        (fromDownload ? (downloads.rows.find((row) => row.chapterId === id)?.chapterName ?? "") : "");
      // Opening a chapter is the moment history exists; it is not a read mark. Neither write is
      // worth a reader that never opens, so both are bounded: a place that cannot be saved in 30 s
      // is reported, and the pages are still shown.
      await withDeadline(library.remember(seriesId, id, index, pages.length), RUNTIME_DEADLINE_MS, "saving your place");
      // One session per chapter opened: the previous one is closed at the page it reached, so a
      // chapter-to-chapter jump does not leave a session running forever.
      closeSession();
      lastPage = index;
      sessionId = await withDeadline(library.beginSession(seriesId, id, index), RUNTIME_DEADLINE_MS, "saving your place");
      armIdle();
      // `tick()` from Svelte flushes the DOM in a microtask; the old local version was a
      // `requestAnimationFrame`, so in a tab that was not painting "Fetching pages…" never cleared
      // at all — the reader was ready and said it was not.
      await tick();
      scrollToPage(index, "auto");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /** Page elements are found by index; the scroller is the only element that moves. */
  function scrollToPage(target: number, behavior: ScrollBehavior = "smooth"): void {
    const host = scroller;
    if (host === null) return;
    const child = host.querySelector<HTMLElement>(`[data-page="${target}"]`);
    if (child === null) return;
    if (horizontal) {
      host.scrollTo({ left: child.offsetLeft, behavior });
    } else {
      host.scrollTo({ top: child.offsetTop, behavior });
    }
  }

  function onScroll(): void {
    const host = scroller;
    if (host === null || pages.length === 0) return;
    const position = horizontal ? host.scrollLeft : host.scrollTop;
    // The page whose top/left edge is nearest the viewport's is the one being read.
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const element of host.querySelectorAll<HTMLElement>("[data-page]")) {
      const start = horizontal ? element.offsetLeft : element.offsetTop;
      const distance = Math.abs(start - position);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = Number(element.dataset.page);
      }
    }
    if (best !== index) {
      index = best;
      void saveSoon();
    }
  }

  function saveSoon(): void {
    lastPage = index;
    armIdle();
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void library.remember(seriesId, chapterId, index, pages.length);
    }, 500);
  }

  function step(delta: number): void {
    const next = Math.min(Math.max(index + delta, 0), Math.max(pages.length - 1, 0));
    if (next === index) return;
    index = next;
    scrollToPage(next);
    void saveSoon();
  }

  /** Which side of the screen means "next", given the reading direction. */
  function advance(direction: "left" | "right"): void {
    const forward = direction === (rtl ? "left" : "right");
    step(forward ? 1 : -1);
  }

  async function toggleRead(): Promise<void> {
    if (library.profile === null) return;
    try {
      if (library.ownsProgress(chapterId)) {
        await library.profile.store.setRead(chapterId, !read);
      } else {
        const provider = providerFor(library.profile.providers, chapterId);
        await provider.setRead(chapterId, !read);
      }
      read = !read;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  const position = $derived(chapters.findIndex((row) => row.id === chapterId));
  const previous = $derived(position > 0 ? chapters[position - 1] : null);
  const following = $derived(position >= 0 && position < chapters.length - 1 ? chapters[position + 1] : null);

  function onKey(event: KeyboardEvent): void {
    if (settingsOpen) return;
    const key = event.key;
    if (key === "ArrowRight" || key === "ArrowDown" || key === " " || key === "PageDown") {
      event.preventDefault();
      step(key === " " || key === "PageDown" ? 1 : rtl ? -1 : 1);
    } else if (key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp") {
      event.preventDefault();
      step(key === "PageUp" ? -1 : rtl ? 1 : -1);
    } else if (key === "j" || key === "J") {
      if (following !== null) go(pathTo("read", seriesId, following.id));
    } else if (key === "k" || key === "K") {
      if (previous !== null) go(pathTo("read", seriesId, previous.id));
    } else if (key === "f" || key === "F") {
      if (document.fullscreenElement === null) void document.documentElement.requestFullscreen?.();
      else void document.exitFullscreen?.();
    } else if (key === "r" || key === "R") {
      void toggleRead();
    } else if (key === "Escape") {
      if (chrome) go(pathTo("series", seriesId));
      else showChrome();
    }
  }

  function mode(next: typeof settings.readerMode): void {
    settings.set("readerMode", next);
    requestAnimationFrame(() => scrollToPage(index, "auto"));
  }
</script>

<svelte:window onkeydown={onKey} />

<section class="reader" class:hide={!chrome}>
  <header class="chrome top" class:shown={chrome}>
    <button class="btn ghost icon" aria-label="Back to series" onclick={() => go(pathTo("series", seriesId))}>
      <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>
    </button>
    <div class="titles">
      <span class="t">{chapterName || "Chapter"}</span>
      <span class="s">{pages.length > 0 ? `${index + 1} / ${pages.length}` : ""}{fromDownload ? " · offline" : ""}</span>
    </div>
    <button class="btn ghost icon" aria-label="Mark as read" aria-pressed={read} onclick={() => void toggleRead()}>
      <svg viewBox="0 0 24 24"><path d={read ? "M5 13l4 4L19 7" : "M5 12h14"} /></svg>
    </button>
    <button class="btn ghost icon" aria-label="Reader settings" onclick={() => (settingsOpen = true)}>
      <svg viewBox="0 0 24 24"><path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4" /></svg>
    </button>
  </header>

  {#if error}<p class="banner">{error}</p>{/if}
  {#if partialNotice}<p class="banner note">{partialNotice}</p>{/if}
  {#if busy}<p class="loading">Fetching pages…</p>{/if}
  <!-- A chapter that loaded and produced nothing used to be a blank screen with "—" in the footer:
       no error, no pages, nothing to press. It is the shape of a page list that came back empty —
       a row whose file is gone, a source that answered with nothing — and it must say so. -->
  {#if !busy && error === null && pages.length === 0}
    <p class="banner note">
      This chapter has no pages. Its file is no longer on this device, or the source that owns it
      returned nothing.
    </p>
  {/if}

  {#if pages.length > 0}
    <div
      class="scroller"
      class:horizontal
      class:rtl
      bind:this={scroller}
      onscroll={onScroll}
      style:--gap="{settings.pageGap}px"
      style:--fit={settings.readerFit}
    >
      {#each pages as page (page.index)}
        <div class="page" data-page={page.index}>
          {#if Math.abs(page.index - index) > WINDOW}
            <!-- Outside the window: the box holds the scroll position, the bytes are not loaded. A
                 214-page chapter used to fetch every page at once because a zero-height page is
                 "on screen" for every lazy image in it. -->
          {:else if page.headers !== undefined || page.open !== undefined}
            <!-- The bytes have to be fetched by us, which an `<img>` cannot do for a source that
                 wants a header: this action fetches them when the page is close to the viewport —
                 or at once, when it is the page being read, because that must not wait on a frame. -->
            <img
              use:lazyPage={{ page, now: page.index === index }}
              alt={`Page ${page.index + 1} of ${pages.length}`}
              loading={page.index < 3 ? "eager" : "lazy"}
              decoding="async"
            />
          {:else if (urls[page.index] ?? page.url) === ""}
            <div class="missing" role="note">Page {page.index + 1} is not on this device</div>
          {:else}
            <img
              src={urls[page.index] ?? page.url}
              alt={`Page ${page.index + 1} of ${pages.length}`}
              loading={page.index < 3 ? "eager" : "lazy"}
              decoding="async"
            />
          {/if}
        </div>
      {/each}
    </div>

    <!-- Tap zones: they sit above the pages and only exist when chrome is hidden, so a tap on a
         control is never swallowed by a zone. -->
    <div class="zones" class:off={chrome || !settings.tapZones}>
      <button class="zone left" aria-label="Previous page" onclick={() => advance("left")}></button>
      <button class="zone mid" aria-label="Show controls" onclick={showChrome}></button>
      <button class="zone right" aria-label="Next page" onclick={() => advance("right")}></button>
    </div>
  {/if}

  <footer class="chrome bottom" class:shown={chrome}>
    <div class="track">
      <span class="count">{pages.length > 0 ? `${index + 1} / ${pages.length}` : "—"}</span>
      <input
        type="range"
        min="0"
        max={Math.max(pages.length - 1, 0)}
        value={index}
        aria-label="Page"
        oninput={(event) => {
          index = Number(event.currentTarget.value);
          scrollToPage(index, "auto");
          void saveSoon();
        }}
      />
    </div>
    <!-- Both chapter buttons sit at the bottom edge, where a thumb already is. -->
    <div class="turn">
      <button class="btn" disabled={previous === null} onclick={() => previous && go(pathTo("read", seriesId, previous.id))}>‹ Previous chapter</button>
      <button class="btn" disabled={following === null} onclick={() => following && go(pathTo("read", seriesId, following.id))}>Next chapter ›</button>
    </div>
  </footer>
</section>

<Sheet open={settingsOpen} title="Reader" onclose={() => (settingsOpen = false)}>
  <div class="group">
    <span class="label">Reading mode</span>
    <div class="chips">
      {#each MODES as option (option.id)}
        <button class="chip" class:on={settings.readerMode === option.id} onclick={() => mode(option.id)}>{option.label}</button>
      {/each}
    </div>
  </div>
  <div class="group">
    <span class="label">Fit</span>
    <div class="chips">
      {#each FITS as option (option.id)}
        <button class="chip" class:on={settings.readerFit === option.id} onclick={() => settings.set("readerFit", option.id)}>{option.label}</button>
      {/each}
    </div>
  </div>
  <label class="row">
    <span>Page spacing</span>
    <input type="range" min="0" max="24" step="2" value={settings.pageGap} oninput={(event) => settings.set("pageGap", Number(event.currentTarget.value))} />
  </label>
  <label class="row">
    <span>Tap zones turn pages</span>
    <input type="checkbox" checked={settings.tapZones} onchange={(event) => settings.set("tapZones", event.currentTarget.checked)} />
  </label>
  <label class="row">
    <span>Keep the screen awake</span>
    <input type="checkbox" checked={settings.keepAwake} onchange={(event) => settings.set("keepAwake", event.currentTarget.checked)} />
  </label>
  <p class="hint">Keys: ← → turn pages, J/K change chapter, F fullscreen, R mark read, Esc back.</p>
</Sheet>

<style>
  .reader {
    position: fixed;
    inset: 0;
    background: #07070a;
    color: var(--text-1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .chrome {
    position: absolute;
    left: 0;
    right: 0;
    z-index: 6;
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding: var(--s2) var(--s3);
    background: color-mix(in srgb, #000 72%, transparent);
    backdrop-filter: blur(14px);
    transition: opacity var(--dur), transform var(--dur);
  }

  .chrome.top {
    top: 0;
    padding-top: calc(var(--s2) + var(--safe-t));
  }

  .chrome.bottom {
    bottom: 0;
    padding-bottom: calc(var(--s2) + var(--safe-b));
  }

  .chrome:not(.shown) {
    opacity: 0;
    pointer-events: none;
  }

  .chrome.top:not(.shown) {
    transform: translateY(-100%);
  }

  .chrome.bottom:not(.shown) {
    transform: translateY(100%);
  }

  .chrome svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .titles {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 1px;
  }

  .t {
    font-size: var(--t-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .s {
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .scroller {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--gap);
    scrollbar-width: none;
    /* Room for the chrome, so the first and last page are never under a bar. */
    padding: var(--s7) 0;
  }

  .scroller::-webkit-scrollbar {
    display: none;
  }

  .scroller.horizontal {
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    scroll-snap-type: x mandatory;
    gap: 0;
  }

  .scroller.horizontal.rtl {
    direction: rtl;
  }

  .page {
    flex: none;
    display: grid;
    place-items: center;
    width: 100%;
  }

  /* Vertical mode: a page's box is reserved before its bytes arrive, so the pages either side of
     the window still take their space and the scroll position does not jump when one mounts. */
  .scroller:not(.horizontal) .page {
    min-height: 100vh;
  }

  .scroller.horizontal .page {
    width: 100vw;
    height: 100%;
    scroll-snap-align: start;
  }

  img {
    display: block;
    max-width: 100%;
    height: auto;
    /* `--fit` is width / height / contain, and each is a different way to fill the screen. */
    object-fit: var(--fit);
  }

  .scroller:not(.horizontal) img {
    width: 100%;
    max-width: 900px;
  }

  .scroller.horizontal img {
    max-height: 100vh;
    width: auto;
    margin: auto;
  }

  .zones {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: grid;
    grid-template-columns: 32% 36% 32%;
  }

  .zones.off {
    pointer-events: none;
  }

  .zone {
    all: unset;
    cursor: pointer;
    height: 100%;
  }

  .loading {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: var(--text-3);
    font-size: var(--t-sm);
  }

  .chrome.bottom {
    display: grid;
    gap: var(--s2);
    padding-bottom: calc(var(--s3) + var(--safe-b));
  }

  .track {
    display: flex;
    align-items: center;
    gap: var(--s3);
  }

  .turn {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s2);
  }

  .turn .btn {
    min-height: 48px;
    justify-content: center;
    color: var(--text-1);
    border-color: var(--line-strong);
    background: color-mix(in srgb, var(--surface) 70%, transparent);
  }

  .turn .btn:disabled {
    opacity: 0.35;
  }

  .track input {
    flex: 1;
    accent-color: var(--accent);
  }

  .count {
    font-size: var(--t-sm);
    color: var(--text-2);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .group {
    display: grid;
    gap: var(--s2);
  }

  .label {
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    min-height: 36px;
    font-size: var(--t-md);
  }

  .hint {
    margin: 0;
    font-size: var(--t-xs);
    color: var(--text-3);
    line-height: 1.6;
  }

  .banner.note {
    color: var(--text-2);
    border-color: var(--line);
  }

  .missing {
    display: grid;
    place-items: center;
    min-height: 40vh;
    color: var(--text-3);
    font-size: var(--t-sm);
    border: 1px dashed var(--line);
    border-radius: var(--r2);
    margin: var(--s3);
  }

  .banner {
    position: absolute;
    top: 64px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 7;
    max-width: 90vw;
    background: color-mix(in srgb, var(--danger) 20%, #000);
  }
</style>
