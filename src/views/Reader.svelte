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
  import { tick, untrack } from "svelte";
  import { go, pathTo } from "../lib/nav";
  import { pageSrc } from "../lib/pages";
  import { RUNTIME_DEADLINE_MS, withDeadline } from "../lib/deadline";
  import { INACTIVITY_TIMEOUT_MS, shouldEndForBackground } from "../lib/history";
  import Sheet from "../components/Sheet.svelte";
  import { plugins } from "../state/plugins.svelte";
  import { ReaderQueue, ReaderTap, readerOrder, type ReaderJob } from "../lib/reader";

  interface Props {
    seriesId: string;
    chapterId: string;
  }
  let { seriesId, chapterId }: Props = $props();

  let pages = $state<Page[]>([]);


  const WINDOW = 4;
  const queue = new ReaderQueue();
  const jobs = new Map<number, ReaderJob>();
  let pageAspect = $state(0);
  let aspects = $state<Record<number, number>>({});
  let notes = $state<Record<number, string>>({});
  let generation = 0;

  function schedulePages(): void {
    queue.set(readerOrder(index, pages.length).flatMap(i => {
      const job = jobs.get(i);
      return job ? [job] : [];
    }));
  }
  $effect(() => {
    index; pages;
    // Actions register after the DOM flush. No observer races or browser eager-image fan-out.
    void tick().then(schedulePages);
  });
  $effect(() => () => {
    generation++; queue.cancel();
    if (saveTimer !== null) clearTimeout(saveTimer);
  });

  function lazyPage(node: HTMLImageElement, page: Page): { destroy: () => void } {
    let live = true;
    const job: ReaderJob = { async run(signal) {
      try {
        // page.open / imageCache do not accept AbortSignal. Keep the one worker occupied until
        // they settle, then discard obsolete results; never start an old chapter's queued pages.
        const src = await withDeadline(pageSrc(page), 45_000, `page ${page.index + 1}`);
        if (!live || signal.aborted) return;
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            node.onload = null; node.onerror = null;
            signal.removeEventListener('abort', abort);
          };
          const abort = () => { cleanup(); node.removeAttribute('src'); resolve(); };
          const timer = setTimeout(() => {
            cleanup(); node.removeAttribute('src'); reject(new Error(`Page ${page.index + 1} timed out after 45 s`));
          }, 45_000);
          node.onload = () => { cleanup(); resolve(); };
          node.onerror = () => { cleanup(); reject(new Error(`Page ${page.index + 1} could not load`)); };
          signal.addEventListener('abort', abort, {once:true});
          node.src = src;
        });
        if (!live || signal.aborted) return;
        if (node.naturalHeight > 0) {
          const anchor = scroller?.querySelector<HTMLElement>(`[data-page="${index}"]`);
          const before = anchor?.getBoundingClientRect();
          aspects[page.index] = node.naturalWidth / node.naturalHeight;
          if (pageAspect === 0) pageAspect = aspects[page.index];
          await tick();
          // Unknown page sizes become measured sizes. Keep the reader's actual anchor, including
          // its within-page offset, rather than jumping a resumed chapter toward page one.
          if (before && anchor?.isConnected && live && !signal.aborted) {
            const after = anchor.getBoundingClientRect();
            scroller?.scrollBy(horizontal ? {left: after.left - before.left, behavior:'instant'} : {top: after.top - before.top, behavior:'instant'});
          }
        }
        await withDeadline(node.decode(), 45_000, `decoding page ${page.index + 1}`);
        // Two frames: the first commits layout, the second runs after that frame was painted.
        // Background tabs deliberately do not start more page work until painting resumes.
        await new Promise<void>(resolve => {
          const abort = () => { cancelAnimationFrame(frame); resolve(); };
          let frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => { signal.removeEventListener('abort', abort); resolve(); });
          });
          signal.addEventListener('abort', abort, {once:true});
        });
      } catch (error) {
        if (!live || signal.aborted) return;
        node.removeAttribute('src');
        notes[page.index] = error instanceof Error ? error.message : String(error);
      }
    }};
    jobs.set(page.index, job);
    void tick().then(schedulePages);
    return { destroy() {
      live = false;
      if (jobs.get(page.index) === job) jobs.delete(page.index);
      void tick().then(schedulePages);
      // pages.ts / imageCache own these URLs and their bounded caches, not the DOM action.
    }};
  }

  const tap = new ReaderTap();
  function surfaceDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    tap.down(event.pointerId, event.clientX, event.clientY);
  }
  function surfaceUp(event: PointerEvent): void {
    if (!tap.up(event.pointerId, event.clientX, event.clientY) || settingsOpen) return;
    const host = event.currentTarget as HTMLElement;
    const fraction = (event.clientX - host.getBoundingClientRect().left) / host.clientWidth;
    if (!chrome && settings.tapZones && (fraction < .32 || fraction > .68)) advance(fraction < .32 ? 'left' : 'right');
    else if (chrome) chrome = false;
    else showChrome();
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

  /**
   * The series that owns this chapter, which is the series id everything here writes and links to.
   *
   * It starts as the one in the URL, because that is what the route said, and `load()` replaces it
   * with the chapter mirror's answer when the two disagree. A URL can name the wrong series — an old
   * bookmark, a hand-written hash, `#read/None/<chapter>` — and the chapter is all `load()` needs, so
   * the chapter opened and then wrote that id into progress, history and Continue. Every resume from
   * there had a back link to a series that does not exist and two dead chapter buttons.
   */
  let owner = untrack(() => seriesId);

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

  /** Plugin reader entries. Empty unless a plugin declared one and the user granted ui.reader. */
  const pluginActions = $derived(plugins.actionsFor("reader"));
  const horizontal = $derived(settings.readerMode === "paged" || settings.readerMode === "ltr" || settings.readerMode === "rtl");
  const rtl = $derived(settings.readerMode === "rtl");

  $effect(() => {
    const id = chapterId;
    if (library.profile !== null) untrack(() => { void load(id); });
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
   * Local URLs paint without waiting on missing pages. Gaps join the sequential queue and report
   * their own failure when offline, while the available pages remain readable.
   */
  function openLocal(local: LocalChapter): void {
    // Local bytes paint immediately. Only a missing page asks for remote metadata/bytes, inside
    // the same one-worker queue as every other page; no Promise.all gate over the whole chapter.
    let remote: Promise<Page[]> | null = null;
    pages = local.urls.map((url, index) => url !== null ? {index, url} : {
      index, url: `missing:${local.chapterId}:${index}`,
      open: async () => {
        remote ??= withDeadline(library.pages(local.chapterId), RUNTIME_DEADLINE_MS, 'the missing pages');
        const fallback = (await remote)[index];
        if (!fallback) throw new Error(`Page ${index + 1} is not on this device`);
        const src = await pageSrc(fallback);
        const response = await fetch(src);
        if (!response.ok) throw new Error(`Page ${index + 1}: ${response.status}`);
        return response.blob();
      },
    });
    const missing = local.urls.filter(url => url === null).length;
    partialNotice = missing === 0 ? null : `${missing} of ${local.total} pages are not on this device. Missing pages will be fetched when reached if a connection is available.`;
  }

  /**
   * The series that owns a chapter, from the chapter mirror.
   *
   * One lookup, bounded like every other database step here. The route's answer is the fallback: a
   * chapter the library has no row for keeps the series the URL named instead of getting nothing.
   */
  async function ownerOf(routeId: string, id: string): Promise<string> {
    try {
      const row = await withDeadline(
        library.profile?.store.getChapter(id) ?? Promise.resolve(undefined),
        RUNTIME_DEADLINE_MS,
        "the library database",
      );
      const stated = row?.seriesId ?? "";
      return stated === "" ? routeId : stated;
    } catch {
      return routeId;
    }
  }

  async function load(id: string): Promise<void> {
    if (library.profile === null) return;
    const token = ++generation;
    const stale = Symbol('obsolete chapter');
    const guard = async <T,>(work: Promise<T>): Promise<T> => {
      const value = await work;
      if (token !== generation) throw stale;
      return value;
    };
    closeSession();
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
    queue.cancel();
    jobs.clear();
    pageAspect = 0;
    aspects = {};
    notes = {};
    busy = true;
    error = null;
    index = 0;
    partialNotice = null;
    // A chapter that fails to load must not leave the last one's pages on screen: "1 / 124" beside
    // another book's error reads as if this chapter were 124 pages long.
    pages = [];

    chapterName = "";
    chapters = [];
    read = false;
    owner = seriesId;
    fromDownload = false;
    try {
      // Every step below can wait on something outside this screen — a download row, the database,
      // a book being unpacked, the source that owns the chapter — and none of them used to have a
      // deadline. A step that never settled left the reader on "Fetching pages…" with no error and
      // no way out, which is indistinguishable from a frozen app. Each one now says which part it
      // was waiting on, in the same 30 s the rest of the app uses for a source that has gone quiet.
      // A downloaded chapter wins: it is the one that works with no network.
      const local = await guard(withDeadline(downloads.local(id), RUNTIME_DEADLINE_MS, "this device's downloads"));
      const nextPages = local === null
        ? await guard(withDeadline(library.pages(id), RUNTIME_DEADLINE_MS, 'the page list')) : null;
      const progress = await guard(withDeadline(library.profile.store.getProgress(id), RUNTIME_DEADLINE_MS, 'the library database'));
      index = Math.min(progress?.page ?? 0, Math.max((local?.urls.length ?? nextPages?.length ?? 0) - 1, 0));
      fromDownload = local !== null;
      if (local !== null) openLocal(local);
      else pages = nextPages ?? [];
      // Only the resumed/current page may start first. Metadata/history are not a paint gate.
      busy = false;
      await tick();
      if (token !== generation) return;
      scrollToPage(index, 'auto');
      read = library.ownsProgress(id)
        ? await guard(withDeadline(library.profile.store.isRead(id), RUNTIME_DEADLINE_MS, "the library database"))
        : false;

      // A URL that names another series is corrected before anything is written with it: from here
      // on the address bar, the back link and the two chapter buttons all use `owner`.
      owner = await guard(ownerOf(seriesId, id));
      if (owner !== seriesId) history.replaceState(null, "", `#${pathTo("read", owner, id)}`);

      // The chapter list is a nicety for the name and the prev/next buttons; with the host down
      // it must not stop a downloaded chapter from opening, so the stored list is the fallback.
      const list = await guard(chapterList(owner));
      chapters = list;
      chapterName =
        list.find((row) => row.id === id)?.name ??
        (fromDownload ? (downloads.rows.find((row) => row.chapterId === id)?.chapterName ?? "") : "");
      // Opening a chapter is the moment history exists; it is not a read mark. Neither write is
      // worth a reader that never opens, so both are bounded: a place that cannot be saved in 30 s
      // is reported, and the pages are still shown.
      await guard(withDeadline(library.remember(owner, id, index, pages.length), RUNTIME_DEADLINE_MS, "saving your place"));
      // One session per chapter opened: the previous one is closed at the page it reached, so a
      // chapter-to-chapter jump does not leave a session running forever.
      closeSession();
      lastPage = index;
      const opened = await withDeadline(library.beginSession(owner, id, index), RUNTIME_DEADLINE_MS, "saving your place");
      if (token !== generation) {
        if (opened !== null) void library.endSession(opened, index, false);
        return;
      }
      sessionId = opened;
      armIdle();
      // `tick()` from Svelte flushes the DOM in a microtask; the old local version was a
      // `requestAnimationFrame`, so in a tab that was not painting "Fetching pages…" never cleared
      // at all — the reader was ready and said it was not.
    } catch (e) {
      if (token === generation && e !== stale) error = e instanceof Error ? e.message : String(e);
    } finally {
      if (token === generation) busy = false;
    }
  }

  /** Page elements are found by index; the scroller is the only element that moves. */
  function scrollToPage(target: number, behavior: ScrollBehavior = "smooth"): void {
    const host = scroller;
    if (host === null) return;
    const child = host.querySelector<HTMLElement>(`[data-page="${target}"]`);
    if (child === null) return;
    if (horizontal) {
      const bounds = child.getBoundingClientRect();
      const viewport = host.getBoundingClientRect();
      host.scrollBy({ left: rtl ? bounds.right - viewport.right : bounds.left - viewport.left, behavior });
    } else {
      host.scrollTo({ top: child.offsetTop, behavior });
    }
  }

  function onScroll(): void {
    const host = scroller;
    if (host === null || pages.length === 0) return;
    const position = host.scrollTop;
    const viewport = host.getBoundingClientRect();
    // The page whose top/left edge is nearest the viewport's is the one being read.
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const element of host.querySelectorAll<HTMLElement>("[data-page]")) {
      const bounds = element.getBoundingClientRect();
      const distance = horizontal
        ? Math.abs(rtl ? bounds.right - viewport.right : bounds.left - viewport.left)
        : Math.abs(element.offsetTop - position);
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
      void library.remember(owner, chapterId, index, pages.length);
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
      if (following !== null) go(pathTo("read", owner, following.id));
    } else if (key === "k" || key === "K") {
      if (previous !== null) go(pathTo("read", owner, previous.id));
    } else if (key === "f" || key === "F") {
      if (document.fullscreenElement === null) void document.documentElement.requestFullscreen?.();
      else void document.exitFullscreen?.();
    } else if (key === "r" || key === "R") {
      void toggleRead();
    } else if (key === "Escape") {
      if (chrome) go(pathTo("series", owner));
      else showChrome();
    }
  }

  function mode(next: typeof settings.readerMode): void {
    settings.set("readerMode", next);
  }
  $effect(() => {
    settings.readerMode; settings.readerFit;
    untrack(() => {
      const target = index;
      void tick().then(() => scrollToPage(target, 'auto'));
    });
  });
</script>

<svelte:window onkeydown={onKey} />

<section class="reader" class:hide={!chrome}>
  <header class="chrome top" class:shown={chrome}>
    <button class="btn ghost icon" aria-label="Back to series" onclick={() => go(pathTo("series", owner))}>
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
      class:webtoon={settings.readerMode === 'webtoon'}
      data-fit={settings.readerFit}
      bind:this={scroller}
      onscroll={onScroll}
      onpointerdown={surfaceDown}
      onpointermove={(event) => tap.move(event.pointerId, event.clientX, event.clientY)}
      onpointerup={surfaceUp}
      onpointercancel={() => tap.cancel()}
      onpointerleave={(event) => { if (event.pointerType === 'mouse') tap.cancel(); }}
      role="region"
      aria-label="Reading surface"
      style:--gap="{settings.pageGap}px"
    >
      {#each pages as page (page.index)}
        <div
          class="page"
          data-page={page.index}
          data-note={notes[page.index]}
          style:--aspect={aspects[page.index] ?? (pageAspect || .7)}
        >
          {#if Math.abs(page.index - index) > WINDOW}
            <!-- Outside the window: the box holds the scroll position, the bytes are not loaded. A
                 214-page chapter used to fetch every page at once because a zero-height page is
                 "on screen" for every lazy image in it. -->
          {:else if page.url !== '' || page.open !== undefined}
            <img
              use:lazyPage={page}
              alt={`Page ${page.index + 1} of ${pages.length}`}
              decoding="async"
              draggable="false"
            />
          {:else}
            <div class="missing" role="note">Page {page.index + 1} is not on this device</div>
          {/if}
        </div>
      {/each}
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
      <button class="btn" disabled={previous === null} onclick={() => previous && go(pathTo("read", owner, previous.id))}>‹ Previous chapter</button>
      <button class="btn" disabled={following === null} onclick={() => following && go(pathTo("read", owner, following.id))}>Next chapter ›</button>
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
  {#if pluginActions.length > 0}
    <!--
      A plugin's reader entry, in the sheet the reader already opens. It cannot draw over the page:
      the host gives a plugin no DOM, only calls — so an action opens the app's own panel or dialog.
    -->
    <div class="group">
      <span class="label">Plugins</span>
      <div class="chips">
        {#each pluginActions as action (action.pluginId + action.id)}
          <button class="chip" onclick={() => plugins.invoke(action.pluginId, action.id)}>{action.title}</button>
        {/each}
      </div>
    </div>
  {/if}
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
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--gap);
    scrollbar-width: none;
    touch-action: pan-x pan-y pinch-zoom;
    overscroll-behavior: contain;
    overflow-anchor: none;
  }
  .scroller::-webkit-scrollbar { display: none; }
  .scroller.webtoon { gap: 0; }
  .scroller.horizontal {
    flex-direction: row;
    align-items: flex-start;
    scroll-snap-type: x mandatory;
    gap: 0;
  }
  .scroller.horizontal.rtl { direction: rtl; }
  .page {
    position: relative;
    flex: none;
    display: flex;
    align-items: flex-start;
    justify-content: safe center;
    min-width: 100%;
    width: max-content;
    min-height: calc(min(100vw, 900px) / var(--aspect));
  }
  .scroller.horizontal .page { scroll-snap-align: start; }
  img {
    display: block;
    flex: none;
    width: min(100vw, 900px);
    height: auto;
    max-width: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  img:not([src]) { visibility: hidden; }
  /* object-fit cannot resize an auto-sized image, and width/height are not valid values.
     Give each fit actual dimensions. Height may pan horizontally; Whole page never clips. */
  .scroller[data-fit='height'] .page { min-height: 100dvh; }
  .scroller[data-fit='height'] img { width: auto; height: 100dvh; }
  .scroller[data-fit='contain'] .page {
    min-height: min(100dvh, calc(100vw / var(--aspect)));
  }
  .scroller[data-fit='contain'] img {
    width: auto;
    height: auto;
    max-width: 100vw;
    max-height: 100dvh;
  }
  /* Paged slots stay viewport-wide/high even for a small image. */
  .scroller.horizontal .page { min-height: 100dvh; }

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

  /* A page that failed to be produced keeps its box and explains itself. */
  .page[data-note]::after {
    content: attr(data-note);
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    max-width: 32ch;
    padding: var(--s3);
    color: var(--text-3);
    font-size: var(--t-sm);
    text-align: center;
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
