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
  import { INACTIVITY_TIMEOUT_MS, sessionEndAt, shouldEndForBackground, type SessionClose } from "../lib/history";
  import Sheet from "../components/Sheet.svelte";
  import { plugins } from "../state/plugins.svelte";
  import { READ_AHEAD_CHOICES, readAheadOf } from "../lib/reader-ahead";
  import { SCALE_MAX, SCALE_MAX_PERCENT, SCALE_MIN_PERCENT, scaleFor, scaleOf, scalePercent, withScale } from "../lib/reader-scale";
  import { advancePx, AUTOSCROLL_CURVES, AUTOSCROLL_SPEEDS, progressOf } from "../lib/autoscroll";
  import { ReaderQueue, ReaderTap, readerOrder, type ReaderJob } from "../lib/reader";

  interface Props {
    seriesId: string;
    chapterId: string;
  }
  let { seriesId, chapterId }: Props = $props();

  let pages = $state<Page[]>([]);


  const ahead = $derived(readAheadOf(settings.readerAhead));
  const pageWindow = $derived(Math.max(4, ahead));
  let queue = new ReaderQueue();
  let loadController: AbortController | null = null;
  let disposed = false;
  const jobs = new Map<number, ReaderJob>();
  let pageAspect = $state(0);
  let aspects = $state<Record<number, number>>({});
  let notes = $state<Record<number, string>>({});
  let generation = 0;

  function schedulePages(): void {
    if (disposed) return;
    queue.set(readerOrder(index, pages.length, ahead, ahead === 0 ? 0 : 1).flatMap(i => {
      const job = jobs.get(i);
      return job ? [job] : [];
    }));
  }
  $effect(() => {
    index; pages; ahead;
    // Actions register after the DOM flush. No observer races or browser eager-image fan-out.
    void tick().then(schedulePages);
  });
  $effect(() => () => {
    disposed = true;
    generation++; loadController?.abort(); queue.cancel();
    if (saveTimer !== null) clearTimeout(saveTimer);
    flushScale();
    if (scaleTimer !== null) { clearTimeout(scaleTimer); scaleTimer = null; }
  });

  function lazyPage(node: HTMLImageElement, page: Page): { destroy: () => void } {
    let live = true;
    const job: ReaderJob = { async run(signal) {
      try {
        // Producers may not accept AbortSignal. Cancel our wait/activity immediately and discard
        // late results; native work may finish internally but cannot own the next chapter's UI.
        const src = await withDeadline(pageSrc(page, signal), 45_000, `page ${page.index + 1}`, signal);
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
        await withDeadline(node.decode(), 45_000, `decoding page ${page.index + 1}`, signal);
        if (!live || signal.aborted) return;
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

  /**
   * Autoscroll: off until started, and it moves the scroller itself.
   *
   * The loop advances by elapsed time, so the pace the slider names is the pace on a 60 Hz panel, a
   * 120 Hz panel and a throttled webview alike. It stops when the chapter ends, when the reader
   * touches the page, when the app goes away and when the reader leaves — a page that keeps
   * scrolling under a hidden screen is a bug, not a feature.
   */
  let autoRunning = $state(false);
  let autoFrame: number | null = null;
  let autoLast = 0;
  /** Sub-pixel remainder, so a slow pace is not rounded away frame by frame. */
  let autoCarry = 0;

  function stopAuto(): void {
    autoRunning = false;
    if (autoFrame !== null) cancelAnimationFrame(autoFrame);
    autoFrame = null;
    autoLast = 0;
    autoCarry = 0;
  }

  function autoStep(now: number): void {
    const host = scroller;
    if (!autoRunning || host === null) {
      autoFrame = null;
      return;
    }
    const elapsed = autoLast === 0 ? 16 : now - autoLast;
    autoLast = now;
    const progress = progressOf(host.scrollTop, host.scrollHeight, host.clientHeight);
    if (progress >= 1) {
      stopAuto();
      return;
    }
    autoCarry += advancePx(elapsed, settings.autoscrollSpeed, settings.autoscrollCurve, progress);
    const whole = Math.floor(autoCarry);
    if (whole > 0) {
      autoCarry -= whole;
      host.scrollBy({ top: whole, behavior: "instant" });
    }
    autoFrame = requestAnimationFrame(autoStep);
  }

  function startAuto(): void {
    if (autoRunning || scroller === null) return;
    autoRunning = true;
    autoLast = 0;
    autoFrame = requestAnimationFrame(autoStep);
  }

  function toggleAuto(): void {
    if (autoRunning) stopAuto();
    else startAuto();
  }

  /**
   * The reader is stuck when it has nothing to read: a failed load, or a page list that came back
   * empty. Chrome hides itself on a timer, and a hidden header is a reader with no way out — so in
   * that state the header stays on screen however long the reader sits there.
   */
  const stuck = $derived(busy || error !== null || pages.length === 0);

  /** Autoscroll only makes sense where the page scrolls vertically as one column. */
  const canAutoscroll = $derived(settings.readerMode === "vertical" || settings.readerMode === "webtoon");

  // A mode change or a new chapter ends the run: the page it was scrolling no longer exists.
  $effect(() => {
    void settings.readerMode;
    return () => stopAuto();
  });
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
  /**
   * When the page last settled: the last evidence that reading was happening rather than a session
   * simply being open. A close that follows an idle stretch ends here, not at the timer's late fire.
   */
  let plateauAt: number | null = null;
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

  /**
   * Page size, per title (see `lib/reader-scale`).
   *
   * `1` is the fit, which is what every title is drawn at until the reader says otherwise; below it
   * the image keeps its proportions and is centred, so a wide tablet can have margins. The choice
   * belongs to the series, so `scaleOwner` — not `owner` — is what the map is keyed by: it is
   * `$state`, and it follows the corrected owner after `load()` has asked the library.
   *
   * A drag writes `draftScale` only, so the surface follows the thumb without an IndexedDB write
   * per pixel; the pref is written when the drag settles.
   */
  let scaleOwner = $state(seriesId);
  let draftScale = $state<number | null>(null);
  let scaleTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingScale: number | null = null;

  const pageScale = $derived(draftScale ?? scaleFor(settings.readerScale, scaleOwner));
  const scaled = $derived(pageScale < SCALE_MAX);
  const scaleValue = $derived(scalePercent(pageScale));

  function writeScale(value: number): void {
    if (scaleTimer !== null) clearTimeout(scaleTimer);
    scaleTimer = null;
    pendingScale = null;
    settings.set("readerScale", withScale(settings.readerScale, scaleOwner, value));
  }

  /** A scale still waiting for its debounce is written now: a closed sheet must not lose it. */
  function flushScale(): void {
    const value = pendingScale;
    if (value !== null) writeScale(value);
  }

  /**
   * Shrink or grow the page, and keep the reader's place.
   *
   * Scaling changes every page's height, so a scroll position measured in pixels lands somewhere
   * else — on a long webtoon, half a chapter away. The current page's own offset is the anchor:
   * measure it before the change, put it back after the layout has settled.
   */
  function setPageScale(value: number): void {
    const next = scaleOf(value);
    if (next === pageScale) return;
    const host = scroller;
    const anchor = host?.querySelector<HTMLElement>(`[data-page="${index}"]`);
    // How far *into* the current page the reader is, not where the page was in pixels: shrinking
    // the pages changes every offset above it, and the browser clamps a shrunken scroll range
    // before this runs, so a delta of offsets would leave the reader somewhere else entirely.
    const offset = (element: HTMLElement): number => horizontal ? element.offsetLeft : element.offsetTop;
    const carry = anchor == null || host === null ? 0 : (horizontal ? host.scrollLeft : host.scrollTop) - offset(anchor);
    draftScale = next;
    pendingScale = next;
    if (scaleTimer !== null) clearTimeout(scaleTimer);
    scaleTimer = setTimeout(() => { scaleTimer = null; const held = pendingScale; pendingScale = null; if (held !== null) writeScale(held); }, 250);
    void tick().then(() => {
      const after = host?.querySelector<HTMLElement>(`[data-page="${index}"]`);
      if (host === null || !after || !after.isConnected) return;
      const target = offset(after) + carry;
      if (horizontal) host.scrollTo({ left: target, behavior: "instant" });
      else host.scrollTo({ top: target, behavior: "instant" });
    });
  }

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
    void seriesId; // A corrected route/profile also owns a distinct load lifecycle.
    if (library.profile !== null) untrack(() => { void load(id); });
    return () => { generation++; loadController?.abort(); queue.cancel(); };
  });

  /**
   * Close the open session at the page it reached, with whether the chapter was finished.
   *
   * Closing twice is a no-op: the store refuses to rewrite a closed session, so a chapter change
   * followed by the reader closing cannot double-count the time. The end timestamp is not "now" but
   * the last moment reading was real — see `sessionEndAt` — so an absence or an idle stretch is not
   * billed as pages.
   */
  function closeSession(reason: SessionClose = "reader"): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    const id = sessionId;
    sessionId = null;
    if (id === null) return;
    const at = sessionEndAt(reason, Date.now(), { plateauAt, hiddenAt });
    plateauAt = null;
    const finished = pages.length > 0 && lastPage >= pages.length - 1;
    void library.endSession(id, lastPage, finished, at);
  }

  /** Restart the inactivity clock: any page turn is evidence of reading. */
  function armIdle(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    if (sessionId === null) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      // The wait itself is what the timeout measured: the session ends at the last page turn.
      closeSession("idle");
    }, INACTIVITY_TIMEOUT_MS);
  }

  $effect(() => {
    // No reactive reads: this runs once, and its cleanup is the reader closing — by Back, by a
    // route change, or by the tab going away. A session left open is still visible as unfinished.
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        // A page that scrolls itself under a hidden screen is motion nobody asked to see.
        stopAuto();
        return;
      }
      const hidden = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      // A quick glance at another app is the same sitting; a long absence is not, and it ends the
      // session at the moment the page left the screen rather than at the moment it came back.
      if (shouldEndForBackground(hidden)) closeSession("away");
      else armIdle();
      hiddenAt = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stopAuto();
      closeSession("away");
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
  async function chapterList(seriesId: string, signal: AbortSignal): Promise<Chapter[]> {
    try {
      return await withDeadline(library.chapters(seriesId), RUNTIME_DEADLINE_MS, "the chapter list", signal);
    } catch {
      signal.throwIfAborted();
      // A stored list is the fallback when the source is down — and it too can hang, if the database
      // is the thing that stopped answering. An empty chapter list is a reader that still reads.
      try {
        return (await withDeadline(library.profile?.store.listChapters(seriesId) ?? Promise.resolve([]), RUNTIME_DEADLINE_MS, "the stored chapter list", signal)) ?? [];
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
  function openLocal(local: LocalChapter, signal: AbortSignal): void {
    // Local bytes paint immediately. Only a missing page asks for remote metadata/bytes, inside
    // the same one-worker queue as every other page; no Promise.all gate over the whole chapter.
    let remote: Promise<Page[]> | null = null;
    pages = local.urls.map((url, index) => url !== null ? {index, url} : {
      index, url: `missing:${local.chapterId}:${index}`,
      open: async () => {
        signal.throwIfAborted();
        remote ??= withDeadline(library.pages(local.chapterId), RUNTIME_DEADLINE_MS, 'the missing pages', signal);
        const fallback = (await remote)[index];
        if (!fallback) throw new Error(`Page ${index + 1} is not on this device`);
        const src = await pageSrc(fallback, signal);
        const response = await fetch(src, {signal});
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
  async function ownerOf(routeId: string, id: string, signal: AbortSignal): Promise<string> {
    try {
      const row = await withDeadline(
        library.profile?.store.getChapter(id) ?? Promise.resolve(undefined),
        RUNTIME_DEADLINE_MS,
        "the library database",
        signal,
      );
      const stated = row?.seriesId ?? "";
      return stated === "" ? routeId : stated;
    } catch {
      return routeId;
    }
  }

  async function load(id: string): Promise<void> {
    if (library.profile === null) return;
    loadController?.abort();
    const controller = loadController = new AbortController();
    const signal = controller.signal;
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
    // A new chapter must not wait behind an old non-abortable page producer.
    queue = new ReaderQueue();
    stopAuto();
    settingsOpen = false;
    chrome = true;
    jobs.clear();
    pageAspect = 0;
    aspects = {};
    notes = {};
    busy = true;
    error = null;
    index = 0;
    // A page size belongs to the title, so a chapter change keeps it and a new title starts at the
    // fit — but a drag that had not been written yet belongs to the title being left.
    flushScale();
    draftScale = null;
    scaleOwner = seriesId;
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
      const local = await guard(withDeadline(downloads.local(id), RUNTIME_DEADLINE_MS, "this device's downloads", signal));
      const nextPages = local === null
        ? await guard(withDeadline(library.pages(id), RUNTIME_DEADLINE_MS, 'the page list', signal)) : null;
      const progress = await guard(withDeadline(library.profile.store.getProgress(id), RUNTIME_DEADLINE_MS, 'the library database', signal));
      index = Math.min(progress?.page ?? 0, Math.max((local?.urls.length ?? nextPages?.length ?? 0) - 1, 0));
      fromDownload = local !== null;
      if (local !== null) openLocal(local, signal);
      else pages = nextPages ?? [];
      // Only the resumed/current page may start first. Metadata/history are not a paint gate.
      busy = false;
      await tick();
      if (token !== generation) return;
      scrollToPage(index, 'auto');
      read = library.ownsProgress(id)
        ? await guard(withDeadline(library.profile.store.isRead(id), RUNTIME_DEADLINE_MS, "the library database", signal))
        : false;

      // A URL that names another series is corrected before anything is written with it: from here
      // on the address bar, the back link and the two chapter buttons all use `owner`.
      owner = await guard(ownerOf(seriesId, id, signal));
      scaleOwner = owner;
      if (owner !== seriesId) history.replaceState(null, "", `#${pathTo("read", owner, id)}`);

      // The chapter list is a nicety for the name and the prev/next buttons; with the host down
      // it must not stop a downloaded chapter from opening, so the stored list is the fallback.
      const list = await guard(chapterList(owner, signal));
      chapters = list;
      chapterName =
        list.find((row) => row.id === id)?.name ??
        (fromDownload ? (downloads.rows.find((row) => row.chapterId === id)?.chapterName ?? "") : "");
      // Opening a chapter is the moment history exists; it is not a read mark. Neither write is
      // worth a reader that never opens, so both are bounded: a place that cannot be saved in 30 s
      // is reported, and the pages are still shown.
      await guard(withDeadline(library.remember(owner, id, index, pages.length), RUNTIME_DEADLINE_MS, "saving your place", signal));
      // One session per chapter opened: the previous one is closed at the page it reached, so a
      // chapter-to-chapter jump does not leave a session running forever.
      closeSession();
      lastPage = index;
      const openedAtPage = index;
      const opening = library.beginSession(owner, id, openedAtPage);
      void opening.then(opened => {
        if (signal.aborted && opened !== null) void library.endSession(opened, openedAtPage, false);
      }, () => {});
      const opened = await withDeadline(opening, RUNTIME_DEADLINE_MS, "saving your place", signal);
      if (token !== generation) {
        if (opened !== null) void library.endSession(opened, index, false);
        return;
      }
      sessionId = opened;
      // The clock that an idle close is measured from starts when the chapter is actually on screen.
      plateauAt = Date.now();
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
    plateauAt = Date.now();
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
    const token = generation;
    const nextRead = !read;
    try {
      if (library.ownsProgress(chapterId)) {
        await library.profile.store.setRead(chapterId, !read);
      } else {
        const provider = providerFor(library.profile.providers, chapterId);
        await provider.setRead(chapterId, !read);
      }
      if (token === generation) read = nextRead;
    } catch (e) {
      if (token === generation) error = e instanceof Error ? e.message : String(e);
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
  <header class="chrome top" class:shown={chrome || stuck}>
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

  {#if error}
    <div class="banner">
      <p>{error}</p>
      <!-- A dead chapter must still leave a way back: the header can be hidden by the idle timer,
           and a banner with no exit is a screen the reader is trapped on. -->
      <div class="banneracts">
        <button class="btn" onclick={() => void load(chapterId)}>Try again</button>
        <button class="btn ghost" onclick={() => go(pathTo("series", owner))}>Back to the series</button>
        <button class="btn ghost" onclick={() => go("/library")}>Library</button>
      </div>
    </div>
  {/if}
  {#if partialNotice}<p class="banner note">{partialNotice}</p>{/if}
  {#if busy}<p class="loading">Fetching pages…</p>{/if}
  <!-- A chapter that loaded and produced nothing used to be a blank screen with "—" in the footer:
       no error, no pages, nothing to press. It is the shape of a page list that came back empty —
       a row whose file is gone, a source that answered with nothing — and it must say so. -->
  {#if !busy && error === null && pages.length === 0}
    <div class="banner note">
      <p>
        This chapter has no pages. Its file is no longer on this device, or the source that owns it
        returned nothing.
      </p>
      <div class="banneracts">
        <button class="btn ghost" onclick={() => go(pathTo("series", owner))}>Back to the series</button>
        <button class="btn ghost" onclick={() => go("/library")}>Library</button>
      </div>
    </div>
  {/if}

  {#if pages.length > 0}
    <div
      class="scroller"
      class:horizontal
      class:rtl
      class:webtoon={settings.readerMode === 'webtoon'}
      class:scaled
      data-fit={settings.readerFit}
      bind:this={scroller}
      onscroll={onScroll}
      onpointerdown={(event) => {
        // Taking hold of the page takes the wheel back: a scroll that keeps moving under a finger
        // is the reader arguing with the app.
        stopAuto();
        surfaceDown(event);
      }}
      onpointermove={(event) => tap.move(event.pointerId, event.clientX, event.clientY)}
      onpointerup={surfaceUp}
      onpointercancel={() => tap.cancel()}
      onpointerleave={(event) => { if (event.pointerType === 'mouse') tap.cancel(); }}
      role="region"
      aria-label="Reading surface"
      style:--gap="{settings.pageGap}px"
      style:--page-scale={pageScale}
    >
      {#each pages as page (page.index)}
        <div
          class="page"
          data-page={page.index}
          data-note={notes[page.index]}
          style:--aspect={aspects[page.index] ?? (pageAspect || .7)}
        >
          {#if Math.abs(page.index - index) > pageWindow}
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
    {#if canAutoscroll}
      <div class="autoline">
        <button class="btn" class:on={autoRunning} aria-pressed={autoRunning} onclick={toggleAuto}>
          {autoRunning ? "Pause autoscroll" : "Autoscroll"}
        </button>
        {#if autoRunning}
          <span class="autospeed">{AUTOSCROLL_SPEEDS.find((option) => option.id === settings.autoscrollSpeed)?.label}</span>
        {/if}
      </div>
    {/if}
    <div class="turn">
      <button class="btn" disabled={previous === null} onclick={() => previous && go(pathTo("read", owner, previous.id))}>‹ Previous chapter</button>
      <button class="btn" disabled={following === null} onclick={() => following && go(pathTo("read", owner, following.id))}>Next chapter ›</button>
    </div>
  </footer>
</section>

<Sheet open={settingsOpen} title="Reader" onclose={() => { settingsOpen = false; flushScale(); }}>
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
  <div class="group">
    <span class="label">Page size</span>
    <div class="sizer">
      <input
        type="range"
        min={SCALE_MIN_PERCENT}
        max={SCALE_MAX_PERCENT}
        step="1"
        value={scaleValue}
        aria-label="Page size"
        aria-valuetext={`${scaleValue} percent`}
        oninput={(event) => setPageScale(Number(event.currentTarget.value) / 100)}
        onchange={() => flushScale()}
      />
      <span class="scaleval">{scaleValue}%</span>
      {#if scaled}
        <button class="chip" onclick={() => { setPageScale(SCALE_MAX); flushScale(); }}>Fit</button>
      {/if}
    </div>
    <p class="hint">Remembered for this title, in every reading mode. All the way out is the fit: the page fills the screen.</p>
  </div>
  <div class="group">
    <span class="label">Read ahead</span>
    <div class="chips ahead" role="group" aria-label="Read ahead pages">
      {#each READ_AHEAD_CHOICES as count (count)}
        <button class="chip" class:on={ahead === count} aria-pressed={ahead === count} onclick={() => settings.set("readerAhead", count)}>{count === 0 ? "None" : String(count)}</button>
      {/each}
    </div>
    <p class="hint">Pages load one at a time, starting with the page you are reading. None fetches only the current page.</p>
  </div>
  <div class="group">
    <span class="label">Autoscroll speed</span>
    <div class="chips" role="group" aria-label="Autoscroll speed">
      {#each AUTOSCROLL_SPEEDS as option (option.id)}
        <button class="chip" class:on={settings.autoscrollSpeed === option.id} onclick={() => settings.set("autoscrollSpeed", option.id)}>{option.label}</button>
      {/each}
    </div>
    <div class="chips" role="group" aria-label="How the pace changes near the end">
      {#each AUTOSCROLL_CURVES as option (option.id)}
        <button class="chip" class:on={settings.autoscrollCurve === option.id} onclick={() => settings.set("autoscrollCurve", option.id)}>{option.label}</button>
      {/each}
    </div>
    <p class="hint">Off until you start it from the reading controls. It pauses when you touch the page, when the app goes to the background, and it stops at the end of the chapter.</p>
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
    padding: var(--s2) calc(var(--s3) + var(--safe-r)) var(--s2) calc(var(--s3) + var(--safe-l));
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
    /* The surface, not just its controls, stays below the status bar. Reading may
       use the full bottom edge; only interactive chrome reserves the home inset. */
    --reader-width: calc(100vw - var(--safe-l) - var(--safe-r));
    --reader-height: calc(100dvh - var(--safe-t));
    /* The title's page size. 1 is the fit; below it every fit is drawn at that fraction and
       centred, so the reader gets margins without the fit changing underneath. */
    --page-scale: 1;
    position: absolute;
    top: var(--safe-t);
    bottom: 0;
    left: var(--safe-l);
    right: var(--safe-r);
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
    min-height: calc(min(var(--reader-width), 900px) * var(--page-scale) / var(--aspect));
  }
  /* A scaled page centres in its slot: a margin on both sides is the point of the setting, and a
     page pinned to one edge of a wide tablet is not centred. Unscaled pages keep the fit's own
     alignment, so nothing moves at 100 %. */
  .scroller.scaled .page { align-items: center; }
  .scroller.horizontal .page { scroll-snap-align: start; }
  img {
    display: block;
    flex: none;
    width: calc(min(var(--reader-width), 900px) * var(--page-scale));
    height: auto;
    max-width: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  img:not([src]) { visibility: hidden; }
  /* object-fit cannot resize an auto-sized image, and width/height are not valid values.
     Give each fit actual dimensions. Height may pan horizontally; Whole page never clips. */
  .scroller[data-fit='height'] .page { min-height: calc(var(--reader-height) * var(--page-scale)); }
  .scroller[data-fit='height'] img { width: auto; height: calc(var(--reader-height) * var(--page-scale)); }
  .scroller[data-fit='contain'] .page {
    width: 100%;
    min-height: var(--reader-height);
    align-items: center;
  }
  .scroller[data-fit='contain'] img {
    width: auto;
    height: auto;
    max-width: calc(var(--reader-width) * var(--page-scale));
    max-height: calc(var(--reader-height) * var(--page-scale));
  }
  /* Paged slots stay surface-wide/high even for a small image. */
  .scroller.horizontal .page { min-height: var(--reader-height); }

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

  /* Autoscroll sits above the chapter buttons: it is a mode, and a mode needs one control, not a
     hidden gesture. 44 px is the smallest target a thumb can hit without aiming. */
  .autoline {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-bottom: var(--s2);
  }

  .autoline .btn {
    min-height: 44px;
    flex: 1;
    justify-content: center;
    color: var(--text-1);
    border-color: var(--line-strong);
    background: color-mix(in srgb, var(--surface) 70%, transparent);
  }

  .autoline .btn.on {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 22%, var(--surface));
  }

  .autospeed {
    font-size: var(--t-xs);
    color: var(--text-3);
    min-width: 3.5em;
    text-align: right;
  }

  .turn {
    display: flex;
    justify-content: space-between;
    gap: var(--s2);
  }

  .turn .btn {
    min-height: 44px;
    padding: 0 var(--s2);
    font-size: var(--t-sm);
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

  /* The page-size slider: the track takes the room, the readout keeps a fixed width so the number
     does not shove the Fit button around as it changes. */
  .sizer {
    display: flex;
    align-items: center;
    gap: var(--s3);
    min-height: 44px;
  }

  .sizer input {
    flex: 1;
    min-width: 0;
    accent-color: var(--accent);
  }

  .scaleval {
    min-width: 3.6em;
    font-size: var(--t-sm);
    color: var(--text-2);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  @media (pointer: coarse) {
    .ahead .chip { box-sizing: border-box; min-height: 44px; min-width: 44px; justify-content: center; }
    /* A range input's box is the track; on a finger it has to be a thumb-sized target, and a
       percentage that can only be dragged in a 16 px band is a slider nobody can use. */
    .sizer input { min-height: 44px; }
    .sizer { gap: var(--s2); }
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
    top: calc(var(--safe-t) + 56px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 7;
    /* A banner that explains a failure also has to offer the way out, so it is a card with a
       wrapping action row rather than one line of text. */
    display: grid;
    gap: var(--s2);
    width: min(92vw, 460px);
    margin: 0;
    background: color-mix(in srgb, var(--danger) 20%, #000);
    text-align: left;
  }

  .banner p {
    margin: 0;
    line-height: 1.5;
  }

  .banneracts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }

  .banneracts .btn {
    min-height: 40px;
  }
</style>
