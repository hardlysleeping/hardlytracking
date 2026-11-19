<script lang="ts">
  import Updates from "./Updates.svelte";
  import Downloads from "./Downloads.svelte";
  /**
   * The library: the shelf, and the controls that narrow it.
   *
   * The eye and the pin still decide membership and order (`applyView`), the rail is still the
   * place those marks live, and this screen adds what a real library needs: search, sort, three
   * densities, filters and a selection mode. Nothing here writes to a source — the only writes are
   * read marks, category membership and removing a row from the shelf.
   */
  import LibraryBand from "../components/LibraryBand.svelte";
  import { privacy } from "../state/privacy.svelte";
  import { visibility } from "../state/visibility.svelte";
  $effect(() => { const store = library.profile?.store; if (store) void visibility.load(store); });
  import { tick } from "svelte";
  import { library } from "../state/library.svelte";
  import { libraryMemory } from "../state/libraryview.svelte";
  import { categories } from "../state/categories.svelte";
  import { settings } from "../state/settings.svelte";
  import { downloads } from "../state/downloads.svelte";
  import { viewStateKey } from "../lib/history";
  import CategoryRail from "../components/CategoryRail.svelte";
  import Reader from "./Reader.svelte";
  import { readerPane } from "../state/reader-pane.svelte";
  import SeriesGrid from "../components/SeriesGrid.svelte";
  import BrowseDisplay from "../components/BrowseDisplay.svelte";
  import { cleanOrder, orderAfterMove } from "../lib/library/order";
  import { applyCollection, collectionState, hiddenBy, selectAll } from "../lib/library/selection";
  import { BADGE_KINDS, DEFAULT_BADGES, badgeList, type Badge } from "../lib/library/badges";
  import Sheet from "../components/Sheet.svelte";
  import LibraryHeader from "../components/LibraryHeader.svelte";
  import LibrarySettingsPanel from "../components/LibrarySettingsPanel.svelte";
  import PageMenu from "../components/PageMenu.svelte";
  import { LIBRARY_SECTIONS } from "../lib/nav-order";
  import AddFiles from "../components/AddFiles.svelte";
  import { canReadDownloadsFolder } from "../lib/files/mihon-downloads";
  import DriveImport from "../components/DriveImport.svelte";
  import OverflowSheet, { type LibraryStats } from "../components/OverflowSheet.svelte";
  import FilterSheet from "../components/FilterSheet.svelte";
  import ChipRow from "../components/ChipRow.svelte";
  import CollectionTabs from "../components/CollectionTabs.svelte";
  import ContinueRail from "../components/ContinueRail.svelte";
  import SortSheet from "../components/SortSheet.svelte";
  import { go, pathTo } from "../lib/nav";
  import { visibleCategories } from "../lib/categories";
  import { contextOf, sourceKeyOf, visibleRows } from "../lib/marks";
  import { sourceMarks } from "../state/source-marks.svelte";
  import {
    DEFAULT_SERIES_SHARE,
    DEFAULT_SHELF_SHARE3,
    DEFAULT_SPLIT_RATIO,
    MIN_DETAIL_WIDTH,
    MIN_READER_WIDTH,
    MIN_SHELF_WIDTH,
    coverWidth,
    libraryLayout,
  } from "../lib/layout-modes";
  import { seriesShareAt, shelfShareAt, splitRatioAt } from "../lib/pane-drag";
  import { viewport } from "../lib/layout.svelte";
  import { emptyFacts, runQuery, type QueryFacts } from "../lib/library/query";
  import { EMPTY_FILTER, activeChips, countActive, isEmptyFilter, mergeFilter, withoutChip } from "../lib/library/filter";
  import { SORT_OPTIONS, sortKeyOf, type SortSpec } from "../lib/library/sort";
  import { parseSearch, withoutOperator } from "../lib/library/search";
  import { eligible } from "../lib/library/continue";
  import { sourceLabel } from "../lib/titles";
  import SeriesPage from "./Series.svelte";
  import type { Series } from "../api/source";

  let { current = null, initialTab = "titles" }: { current?: string | null; initialTab?: "titles" | "updates" | "downloads" } = $props();

  /** Where a section's tab goes. Titles is the Library itself; the rest are routes under it. */
  function sectionHref(id: string): string {
    if (id === "updates") return "/updates";
    if (id === "downloads") return "/downloads";
    return "/library";
  }

  /** The section tabs in the reader's order, with anything the pref forgot put back at the end. */
  const sections = $derived.by(() => {
    const ordered = settings.libraryTabs
      .map((id) => LIBRARY_SECTIONS.find((section) => section.id === id))
      .filter((section): section is (typeof LIBRARY_SECTIONS)[number] => section !== undefined);
    const missing = LIBRARY_SECTIONS.filter((section) => !ordered.includes(section));
    // Both sections are always drawn: a Library with one tab cannot reach Updates, and Updates is
    // the screen that clears the "new" badges.
    return [...ordered, ...missing];
  });

  /**
   * Which category the rail is pointing at; `null` is the whole library. It lives in
   * `libraryMemory` so Library → Series → back comes back here, and the durable copy in settings
   * so a relaunch does too.
   */
  const selected = $derived(privacy.locked && categories.items.some((c) => c.id === libraryMemory.collection && c.hidden) ? null : libraryMemory.collection);
  const query = $derived(libraryMemory.query);
  const searching = $derived(libraryMemory.searching);
  /** `This collection` narrows the tab you are on; `All library` looks past it (§29). */
  const searchScope = $derived(libraryMemory.scope);

  function setCollection(id: string | null): void {
    libraryMemory.collection = id;
    settings.set("libraryCollection", id);
  }
  let filterOpen = $state(false);
  let sortOpen = $state(false);
  let categoriesOpen = $state(false);
  /** Display knobs (cover size, continue strip) — the settings that are not a filter. */
  let displayOpen = $state(false);
  /**
   * The Library's own options, in a popup on this page.
   *
   * The same panel the Settings page draws, one door closer: the gear in the top bar and the
   * `⋯` sheet's "Library settings" both open this, and neither changes the route.
   */
  let settingsOpen = $state(false);
  let header = $state<{ focusSettings: () => void } | null>(null);

  function closeSettings(): void {
    settingsOpen = false;
    // Focus goes back to the control that opened the sheet, not to the top of the document.
    void tick().then(() => header?.focusSettings());
  }
  let driveOpen = $state(false);
  /**
   * The local-file component, mounted without its buttons.
   *
   * Its two pickers are opened from the `⋯` sheet. The sheet closes first (its `run` helper), and
   * the input must still be in the document at that moment, so the component lives here rather
   * than inside the sheet's `{#if open}` block.
   */
  let adders = $state<{ pickFiles: () => void; pickFolder: () => void } | null>(null);
  /**
   * "Import Mihon downloads…" — another app's download folder, indexed in place.
   *
   * Offered only on a build whose shell can read a folder (Android). The line under the shelf says
   * what happened, because an import that quietly does nothing is indistinguishable from a bug.
   */
  let canImportDownloads = $state(false);
  let downloadsNote = $state<string | null>(null);
  $effect(() => {
    void canReadDownloadsFolder().then((can) => {
      canImportDownloads = can;
    });
  });

  async function exportToMihon(): Promise<void> {
    downloadsNote = "Writing downloaded chapters…";
    try {
      const outcome = await library.exportToMihonDownloads();
      const parts: string[] = [];
      if (outcome.written > 0) parts.push(`${outcome.written} chapters written to ${outcome.folder}`);
      if (outcome.skipped > 0) parts.push(`${outcome.skipped} skipped (nothing downloaded, or no matching source installed)`);
      downloadsNote = parts.length === 0 ? "Nothing downloaded to send yet" : parts.join(" · ");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      downloadsNote = /no folder|cancel/i.test(message) ? null : message;
    }
  }

  async function importDownloads(): Promise<void> {
    downloadsNote = "Reading the download folder…";
    try {
      const { result, folder } = await library.importDownloadsFolder();
      const parts: string[] = [];
      if (result.series > 0) parts.push(`${result.series} titles, ${result.chapters} chapters from ${folder}`);
      if (result.skipped.length > 0) parts.push(`${result.skipped.length} already here`);
      if (result.errors.length > 0) parts.push(result.errors.join("; "));
      downloadsNote = parts.length === 0 ? `Nothing to import in ${folder}` : parts.join(" · ");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      downloadsNote = /no folder|cancel/i.test(message) ? null : message;
    }
  }

  /** The applied filter is a setting, not component state: a reload must keep it. */
  const filter = $derived(settings.libraryFilter);

  let selection = $state<Set<string> | null>(null);
  /** The collection sheet's working set (category id -> ticked), applied once so Cancel cancels. */
  let pendingCollections = $state<Record<string, boolean>>({});
  /** The change a "these would be hidden" sheet was already answered for. */
  let hiddenAcknowledged = $state<string | null>(null);
  let busy = $state<string | null>(null);
  /** The Remove button's second tap: a bulk delete is never one tap. */
  let confirmingRemove = $state(false);
  let removeError = $state<string | null>(null);

  // ---- the shape of this screen, and the pane that belongs to it -----------------------------
  //
  // Decided by `lib/layout-modes`, drawn here: a phone is one pane with collection chips, a tablet
  // gets the collection column when there is room for it beside a usable grid, a desktop adds the
  // detail pane. Nothing below reads a device name.

  /** The title in the detail pane, on a screen wide enough for one. */
  let picked = $state<string | null>(null);
  /** The series/chapter share while its seam is being dragged; committed on release. */
  let dragShare = $state<number | null>(null);
  /** The shelf's share of the three-pane slack while its seam is being dragged. */
  let dragRatio3 = $state<number | null>(null);

  /** The split ratio while the divider is being dragged; committed to `settings` on release. */
  let dragRatio = $state<number | null>(null);
  /** The `⋯` sheet: refresh, select, categories, settings, statistics. */
  let menuOpen = $state(false);
  let panes = $state<HTMLElement | null>(null);

  // ---- what this collection looked like when it was last left -------------------------------
  //
  // Komikku's tablet library opens where you left it: same collection, same sort, same filters,
  // same scroll. The state is written to the database (not session storage) because a packaged
  // build must remember it across launches, and because Sync will carry it later.
  //
  // Saving is debounced and always keyed by the collection that was *current when the change
  // happened* — `savedKey` — so switching collections flushes the old state under the old key
  // before the new key is read.

  let savedKey = viewStateKey(null);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let restoring = true;

  function captureViewState() {
    return {
      sort: settings.librarySort,
      view: settings.libraryView,
      coverSize: settings.coverSize,
      // The two old fields are still written, so a row saved by an older build restores.
      onlyUnread: settings.libraryFilter.unread === "unread",
      onlySource: settings.libraryFilter.sources[0] ?? null,
      // A plain copy: the database refuses a `$state` proxy (DataCloneError).
      filter: {
        ...settings.libraryFilter,
        statuses: [...settings.libraryFilter.statuses],
        sources: [...settings.libraryFilter.sources],
      },
      // Not the query: a stored search restored at launch reads as an empty library. The words
      // survive a route change in `libraryMemory`; a reload starts with an empty box.
      query: "",
      scroll: scroller()?.scrollTop ?? 0,
      selectedSeriesId: null as string | null,
    };
  }

  /**
   * The shell scrolls `main`, not the document — `window.scrollY` is always 0 here, which is why a
   * remembered offset never landed. One function, so the reader and the writer cannot disagree.
   */
  function scroller(): HTMLElement | null {
    if (typeof document === "undefined") return null;
    return document.querySelector("main");
  }

  /**
   * Put the offset back after the grid has a real height. Two frames, then a second attempt: the
   * first lands the layout, the second catches a cover that changed the row height under it.
   */
  async function restoreScroll(top: number): Promise<void> {
    await tick();
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    scroller()?.scrollTo({ top, behavior: "auto" });
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    const box = scroller();
    if (box !== null && Math.abs(box.scrollTop - top) > 1) box.scrollTo({ top, behavior: "auto" });
  }

  function saveViewSoon(): void {
    if (restoring) return;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void library.saveViewState(savedKey === "all" ? null : savedKey, captureViewState());
    }, 400);
  }

  async function restoreView(collectionId: string | null): Promise<void> {
    const key = viewStateKey(collectionId);
    const row = await library.viewState(collectionId);
    savedKey = key;
    if (row === undefined) {
      restoring = false;
      saveViewSoon();
      return;
    }
    // A remembered view is applied, not merely stored: the point is that it looks the same.
    // Display is global across Library and Search; legacy collection snapshots cannot rewind it.
    if (row.filter !== undefined) {
      settings.set("libraryFilter", row.filter);
    } else if (row.onlyUnread !== undefined || row.onlySource !== undefined) {
      // A row written before the filter was one value: rebuild the filter it meant.
      settings.set("libraryFilter", {
        ...EMPTY_FILTER,
        unread: row.onlyUnread === true ? "unread" : "any",
        sources: row.onlySource == null ? [] : [row.onlySource],
      });
    }
    if (row.query !== undefined) {
      // A stored query is deliberately not restored: a search box that comes back filled after a
      // relaunch reads as an empty library. The words survive a route change in `libraryMemory`,
      // which is the promise §31 makes; a reload starts clean.
    }
    restoring = false;
    // Record the visit even if nothing is changed: the next launch should open here.
    saveViewSoon();
    // The offset survives a route change in `libraryMemory` (no database read, no flicker); the
    // stored row is the answer after a relaunch. Either way it is applied after the grid has laid
    // out, or the scroller clamps it to a half-built height.
    const target = libraryMemory.scroll || row.scroll || 0;
    libraryMemory.scroll = target;
    if (target > 0) await restoreScroll(target);
  }

  $effect(() => {
    if (!library.ready) return;
    if (!libraryMemory.mounted) {
      // A reload: the shelf opens where it was left (§31's durable list). A route change keeps
      // whatever the memory already holds, which is why this runs once, not on every mount.
      libraryMemory.mounted = true;
      libraryMemory.collection = settings.libraryCollection;
    }
    void restoreView(selected);

    // A tab close or a reload does not destroy the component, so the flush cannot live only in
    // the cleanup: `pagehide` and a hidden tab are the moments a phone app is killed.
    const flush = (): void => {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = null;
      if (restoring) return;
      void library.saveViewState(savedKey === "all" ? null : savedKey, captureViewState());
    };
    const box = scroller();
    const onScroll = (): void => {
      libraryMemory.scroll = box?.scrollTop ?? 0;
      saveViewSoon();
    };
    box?.addEventListener("scroll", onScroll, { passive: true });
    const onHide = (): void => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);

    return () => {
      box?.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      // Leaving this collection (or the screen) still writes what it looked like.
      flush();
    };
  });

  // Any change to how the collection is shown is remembered, without waiting for navigation.
  $effect(() => {
    void [settings.librarySort, settings.libraryView, settings.coverSize, settings.libraryFilter, query];
    saveViewSoon();
  });

  const visible = $derived(
    library.library.map((series) => ({ ...series, categoryIds: series.categoryIds ?? [] })).filter((row) => visibility.allows(row)),
  );

  /** The chips obey the eye, exactly as the rail does. */
  const shownCategories = $derived(visibleCategories(categories.items, categories.hiddenView, categories.pinView));

  const layout = $derived(
    libraryLayout(viewport.width, viewport.height, {
      nav: settings.categoryNav,
      collectionCount: shownCategories.length,
      pinnedCount: shownCategories.filter((category) => category.pinned).length,
      splitRatio: dragRatio ?? settings.splitRatio,
      splitRatio3: dragRatio3 ?? settings.splitRatio3,
      detailShare: dragShare ?? settings.detailShare,
      pane: settings.libraryPane,
    }),
  );

  /**
   * A chapter open beside the shelf, and whether it is drawn as a two-page spread.
   *
   * The spread is the reader's `Two pages` mode: the gutter belongs in the middle of the reading
   * surface, which in a pane means the two panes together — so the shelf steps aside and the
   * divider stops being a handle. The shelf is hidden, never unmounted: coming back to it is a
   * toggle, not a walk through the library again.
   */
  const openChapter = $derived(readerPane.open);
  // This screen can always draw an opened chapter — as the detail pane in a split, or as the whole
  // page in one column — so it says so, and "Read" hands the chapter to the pane here rather than
  // to the reader screen. Browse and Source share the same tap and can draw neither.
  $effect(() => readerPane.showsPane());
  const chapterOpen = $derived(openChapter !== null);
  /**
   * Two pages with two panes: the shelf steps aside and the gutter falls where the divider was.
   * With three panes the series column stays, so the spread is drawn inside the reading column.
   */
  const spread = $derived(chapterOpen && settings.readerMode === "duo" && layout.thirdWidth === 0);
  /** One-pane mode has no second column, so reading takes the shelf's place entirely. */
  const solo = $derived(chapterOpen && layout.mode === "single");
  /**
   * Three panes with the reader open: the reading column is drawn outside the page, so the band,
   * the field and the tab row can only ever occupy the two columns beside it. It is not a column
   * of the library page; it is the reader, and the reader has always been the whole screen.
   */
  const thirds = $derived(layout.thirdWidth > 0 && initialTab !== "updates" && initialTab !== "downloads");
  /**
   * The reader is the page here: one pane reading, or a spread that has taken both.
   *
   * The library's own chrome belongs to the shelf. Above a reading surface it was only an offset —
   * a 100dvh reader starting 150 px down the page is a reader with its bottom off screen, and a
   * sticky panel inside a scrolling document is what scrolls raggedly.
   */
  const readingPage = $derived(solo || spread);

  /** Auto is the device class's density, Custom is the slider, a preset wins over both. */
  const cover = $derived(coverWidth(settings.libraryDensity, layout.device, settings.coverSize));

  /**
   * The facts every stage of the query reads, from one pass over what we already hold.
   *
   * Unread, totals, last-read order and downloads are all questions about the same rows, so they
   * are gathered together: a filter or a sort must never ask the database anything mid-render.
   */
  /** seriesId -> the source id its mapping names, when one exists. */
  let mappedSource = $state<Map<string, { provider: string; sourceId: string }>>(new Map());

  let bookSizes = $state<Map<string, number>>(new Map());
  const fileSizes = $derived.by(() => {
    const sizes = new Map<string, number>();
    for (const row of downloads.rows) if (row.bytes > 0) sizes.set(row.seriesId, (sizes.get(row.seriesId) ?? 0) + row.bytes);
    for (const [id, bytes] of bookSizes) sizes.set(id, bytes);
    return sizes;
  });

  let counts = $state<{
    unread: Map<string, number>;
    total: Map<string, number>;
    lastRead: Map<string, number>;
    status: Map<string, string>;
    lastUpdated: Map<string, number>;
    /** Series bound to a tracker. A tracker row is not a source mapping — it is a list entry. */
    tracked: Set<string>;
  }>({
    unread: new Map(),
    total: new Map(),
    lastRead: new Map(),
    status: new Map(),
    lastUpdated: new Map(),
    tracked: new Set(),
  });

  async function recount(): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    const [chapters, prefs, positions, mappings, trackerRows] = await Promise.all([
      store.listAllChapters(),
      store.listPrefs(),
      store.listPositions(),
      // A `mihon:12` id does not name its source; the stored mapping is the only thing that does.
      // Read here, in the same pass as the counts, so hiding a Suwayomi source works like hiding a
      // dalvik one instead of silently doing nothing.
      store.listMappings(),
      // The Tracked filter asks about tracker bindings, which only this store knows.
      store.listTrackers(),
    ]);
    bookSizes = new Map((await store.listBookMetadata()).map((book) => [book.seriesId, book.bytes]));
    // The whole mapping, not just the source id: a migrated title is governed by the source it
    // reads from now, and only the mapping knows which one that is.
    mappedSource = new Map(mappings.map((row) => [row.seriesId, { provider: row.provider, sourceId: row.sourceId }]));
    const read = new Set(
      prefs.filter((row) => String(row.key).startsWith("read:")).filter((row) => row.value === true).map((row) => String(row.key).slice(5)),
    );
    const unread = new Map<string, number>();
    const total = new Map<string, number>();
    const lastUpdated = new Map<string, number>();
    for (const chapter of chapters) {
      total.set(chapter.seriesId, (total.get(chapter.seriesId) ?? 0) + 1);
      const at = chapter.uploadedAt ?? 0;
      if (at > (lastUpdated.get(chapter.seriesId) ?? 0)) lastUpdated.set(chapter.seriesId, at);
      if (chapter.read || read.has(chapter.id)) continue;
      unread.set(chapter.seriesId, (unread.get(chapter.seriesId) ?? 0) + 1);
    }
    counts = {
      unread,
      total,
      lastUpdated,
      tracked: new Set(trackerRows.map((row) => row.seriesId)),
      lastRead: new Map(positions.map((row, index) => [row.seriesId, positions.length - index])),
      status: new Map(
        library.library.filter((row) => row.status !== undefined).map((row) => [row.id, row.status as string]),
      ),
    };
  }

  $effect(() => {
    if (library.profile === null) return;
    void recount();
  });

  /** Unread per series, for the badge the grid draws. */
  const unread = $derived(counts.unread);

  /** A download finishing changes the downloaded badge and the filter, without a full recount. */
  const downloaded = $derived.by(() => {
    const map = new Map<string, number>();
    for (const row of downloads.rows) map.set(row.seriesId, (map.get(row.seriesId) ?? 0) + 1);
    return map;
  });

  const facts = $derived<QueryFacts>({
    ...emptyFacts(),
    unread: counts.unread,
    total: counts.total,
    lastRead: counts.lastRead,
    status: counts.status,
    downloaded,
    lastUpdated: counts.lastUpdated,
    tracked: counts.tracked,
    // New since the Updates screen was last opened — the mark, not a date, so opening it clears
    // the badge for exactly the titles it showed.
    newUpdates: new Set(
      [...counts.lastUpdated.entries()]
        .filter(([id, at]) => at > (settings.updatesSeen[id] ?? 0))
        .map(([id]) => id),
    ),
  });

  /** Continue reading, newest first — the shortcut back into a book. */
  let continuing = $state<Array<{ seriesId: string; chapterId: string; page: number; title: string; cover?: string; chapterName: string }>>([]);
  $effect(() => {
    if (library.profile === null) return;
    void library.continueReading(20).then((rows) => (continuing = rows));
  });

  /**
   * The strip's rows: hidden titles gone, dismissed titles dropped, capped at the setting.
   *
   * Hiding a category or a source has to empty this strip too — it is the second place a comic can
   * reappear after being hidden, and a hidden shelf that still reads here has not been hidden.
   */
  const continueRows = $derived(
    eligible(
      visibleRows(
        continuing.filter((row) => visibility.allows({ id: row.seriesId })),
        contextOf({
          categories: categories.items,
          sources: sourceMarks.marks,
          sourceOf: (seriesId: string) => sourceKeyOf(seriesId, mappedSource.get(seriesId)),
        }),
        (seriesId: string) => library.library.find((series) => series.id === seriesId)?.categoryIds,
      ),
      new Set(settings.continueDismissed),
      settings.continueMax,
    ),
  );

  /** Drawn only on the whole shelf, with nothing typed, when the setting is on. */
  const continueVisible = $derived(
    library.ready && selected === null && settings.showContinue && continueRows.length > 0 && query.trim() === "",
  );

  const sources = $derived([...new Set(library.library.map((series) => series.provider))]);

  /** The statuses the filter can offer: the ones this library actually contains. */
  const statusOptions = $derived([...new Set([...counts.status.values()])].sort());

  /** The providers as ids for the filter and names for the sheet. */
  const sourceOptions = $derived(sources.map((id) => ({ id, label: sourceLabel(id) })));

  /** The filter the grid is actually answering: the sheet's, plus any operator in the box. */
  const effectiveFilter = $derived(mergeFilter(filter, parseSearch(query).filter));

  /** The number on the `Filter` button, and the chips under the tools row. */
  const filterCount = $derived(countActive(effectiveFilter));
  const filterChips = $derived(activeChips(effectiveFilter));

  /** Clear is one tap: a filter the user cannot undo is a screen that looks broken. */
  function clearFilters(): void {
    settings.set("libraryFilter", { ...EMPTY_FILTER, statuses: [], sources: [] });
  }

  /**
   * Take one chip back. A chip that came from the search box is removed from the box — the sheet
   * never held it, so clearing the sheet's field would do nothing.
   */
  function removeChip(key: string): void {
    const next = withoutChip(filter, key);
    const wasInSheet = countActive(next) < countActive(filter);
    settings.set("libraryFilter", next);
    if (!wasInSheet) libraryMemory.query = withoutOperator(query, key);
  }

  /** The numbers the `⋯` sheet reports, from what the screen already counted. */
  const stats = $derived<LibraryStats>({
    series: visible.length,
    unread: visible.reduce((sum, row) => sum + (counts.unread.get(row.id) ?? 0), 0),
    downloaded: downloads.rows.filter((row) => visibility.allows({ id: row.seriesId })).length,
    categories: categories.items.filter((c) => !privacy.locked || !c.hidden).map((category) => ({
      name: category.name,
      count: visible.filter((row) => (row.categoryIds ?? []).includes(category.id)).length,
    })),
  });

  /**
   * A refresh re-reads the shelf and asks the sources again. A failed check is a note, never an
   * empty library: everything on this screen — the rows, the covers already cached, the collections,
   * the progress, the unread marks, the download badges — comes from the local store, so being
   * offline changes exactly one line of text.
   */
  const OFFLINE_NOTE = "Your Library is available offline. Some source updates could not be checked.";
  let offline = $state(false);

  async function refreshLibrary(): Promise<void> {
    try {
      await library.refreshLibrary();
      await library.loadSources();
      await recount();
      offline = false;
    } catch {
      offline = true;
    }
    // `loadSources` reports a dead provider into `library.error` rather than throwing, so a refresh
    // that "succeeded" with no sources at all is the same situation as one that threw.
    if (library.error !== null) offline = true;
  }

  /** Each collection remembers its own key and direction; All is the fallback. */
  const sortSpec = $derived<SortSpec>(sortKeyOf(settings.sortByCollection, selected));

  const sortLabel = $derived(SORT_OPTIONS.find((option) => option.key === sortSpec.key)?.label ?? "Title");

  /** Applying a sort writes only the collection it was applied to. */
  function setSort(spec: SortSpec): void {
    settings.set("sortByCollection", { ...settings.sortByCollection, [selected ?? "all"]: spec });
  }

  /** This collection's manual order, and the key its list is stored under. */
  const orderKey = $derived(selected ?? "all");
  const manualOrder = $derived(cleanOrder(settings.manualOrder[orderKey]));

  /** Every row this screen shows, through the one query model. */
  const rows = $derived(
    runQuery(
      {
        series: visible,
        categories: categories.items,
        marks: { hiddenView: categories.hiddenView, pinView: categories.pinView },
        sources: sourceMarks.withSearchPins(settings.pinnedSources),
        sourceOf: (seriesId: string) => sourceKeyOf(seriesId, mappedSource.get(seriesId)),
      },
      {
        collection: selected,
        filter,
        search: { text: query, scope: searchScope },
        sort: sortSpec,
        manual: manualOrder,
      },
      facts,
    ),
  );

  /**
   * A drag writes the order the shelf was drawing, minus the drag.
   *
   * Written to this collection only, and only when the sort is Manual: every other key decides its
   * own order, so storing one there would be a preference that silently does nothing.
   */
  function moveRow(fromId: string, toId: string): void {
    const next = orderAfterMove(
      rows.map((row) => row.id),
      fromId,
      toId,
    );
    settings.set("manualOrder", { ...settings.manualOrder, [orderKey]: next });
  }

  const emptyMessage = $derived.by(() => {
    if (library.library.length === 0) return "Your library is empty.";
    if (query.trim() !== "") return `Nothing matches “${query.trim()}”.`;
    if (selected !== null) return "Nothing in this category yet.";
    if (!isEmptyFilter(filter)) return "Nothing matches these filters.";
    if (categories.hiddenView === "only") return "No hidden category has anything in it.";
    return "Every row here is filed under a hidden category. Reveal it in Categories to see them.";
  });

  /** The pane's row, or null when nothing is picked (or it was removed from the shelf). */
  const pickedRow = $derived(picked === null ? null : rows.find((row) => row.id === picked) ?? null);

  /**
   * A tile in a split swaps the pane instead of pushing a route: the shelf keeps its scroll,
   * its collection and its selection, which is the whole point of the pane. Everywhere else a tap
   * opens the series page, as before.
   */
  function pick(row: Series): void {
    if (layout.mode === "split") {
      picked = row.id;
      return;
    }
    go(pathTo("series", row.id));
  }

  /**
   * Drag the shelf's seam.
   *
   * Two panes drag a share of the window; three drag a share of the *slack* — the room left once
   * each column has its floor — because that is what the layout divides. The handle follows the
   * pointer in both, and neither can push a column under its minimum.
   */
  function startDrag(event: PointerEvent): void {
    if (panes === null) return;
    const handle = event.currentTarget as HTMLElement;
    const box = panes.getBoundingClientRect();
    handle.setPointerCapture(event.pointerId);
    const minGrid = MIN_SHELF_WIDTH;
    const three = layout.thirdWidth > 0;
    /*
     * The room the layout divides, which is not the box this handle sits in any more: with three
     * panes the reading column is drawn beside the page, so the handle's box ends where the reader
     * begins and subtracting three floors from it asked for more room than the box holds. The sum
     * of the columns is the width the shares are actually a share of.
     */
    const space = layout.gridWidth + layout.detailWidth + layout.thirdWidth;
    const slack = space - minGrid - MIN_DETAIL_WIDTH - MIN_READER_WIDTH;
    const move = (moveEvent: PointerEvent) => {
      if (box.width === 0) return;
      if (three) {
        dragRatio3 = shelfShareAt(moveEvent.clientX, {
          box,
          minGrid,
          slack,
          fallback: settings.splitRatio3,
        });
        return;
      }
      dragRatio = splitRatioAt(moveEvent.clientX, {
        box,
        minGrid,
        minDetail: MIN_DETAIL_WIDTH,
        fallback: settings.splitRatio,
      });
    };
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      if (dragRatio !== null) settings.set("splitRatio", dragRatio);
      if (dragRatio3 !== null) settings.set("splitRatio3", dragRatio3);
      dragRatio = null;
      dragRatio3 = null;
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  }

  /**
   * Put a seam back where it started.
   *
   * A drag is easy to overdo and hard to undo by hand: the pane it shrank is the one holding the
   * handle, so there is no way to drag it back from inside. Double-clicking the handle is the way
   * out, and it restores the documented default (`DEFAULT_SPLIT_RATIO` and friends) rather than
   * whatever the layout happened to pick for this window — those are two different numbers once the
   * window is narrow enough to clamp.
   */
  function resetDrag(): void {
    if (layout.thirdWidth > 0) settings.set("splitRatio3", DEFAULT_SHELF_SHARE3);
    else settings.set("splitRatio", DEFAULT_SPLIT_RATIO);
  }

  function resetShare(): void {
    settings.set("detailShare", DEFAULT_SERIES_SHARE);
  }

  /**
   * The seam between the series and the chapter.
   *
   * The same arithmetic as the shelf's handle, measured against the space the two right-hand
   * columns share: the series' floor at one end, the reading column's at the other.
   */
  function startShareDrag(event: PointerEvent): void {
    if (panes === null) return;
    const handle = event.currentTarget as HTMLElement;
    const box = panes.getBoundingClientRect();
    handle.setPointerCapture(event.pointerId);
    // Measured against the slack the two columns share, not their total width: their floors are
    // already spoken for, so a pointer past them must not be able to ask for a sliver.
    const space = layout.gridWidth + layout.detailWidth + layout.thirdWidth;
    const slack = space - layout.gridWidth - MIN_DETAIL_WIDTH - MIN_READER_WIDTH;
    const move = (moveEvent: PointerEvent) => {
      dragShare = seriesShareAt(moveEvent.clientX, {
        box,
        gridWidth: layout.gridWidth,
        minGrid: layout.gridWidth,
        minDetail: MIN_DETAIL_WIDTH,
        slack,
        fallback: settings.detailShare,
      });
    };
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      if (dragShare !== null) settings.set("detailShare", dragShare);
      dragShare = null;
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  }

  $effect(() => {
    if (!privacy.locked) return;
    selection = null;
    pendingCollections = {};
    picked = null;
    categoriesOpen = false;
  });

  function toggleSelection(): void {
    selection = selection === null ? new Set() : null;
  }

  /** Select All means the rows on screen, and the label says how many that is (§23). */
  function selectEverything(): void {
    selection = selectAll(rows);
  }

  /**
   * Selected titles the current view no longer shows.
   *
   * A bulk action would still touch them while the user cannot see them, so the screen asks — once
   * per change, not once per render.
   */
  const hiddenSelection = $derived(selection === null ? [] : hiddenBy(selection, rows));
  const viewKey = $derived(`${selected ?? "all"}|${query}|${JSON.stringify(filter)}`);
  const askAboutHidden = $derived(hiddenSelection.length > 0 && hiddenAcknowledged !== viewKey);

  /** Keep the selection as it is: the ids stay, they are simply not on screen. */
  function keepHiddenSelection(): void {
    hiddenAcknowledged = viewKey;
  }

  /** Clear only what is no longer visible — the rows still on screen stay selected. */
  function clearHiddenSelection(): void {
    const visible = new Set(rows.map((row) => row.id));
    selection = new Set([...(selection ?? [])].filter((id) => visible.has(id)));
    hiddenAcknowledged = viewKey;
  }

  /** The pills each card may draw, from the facts this screen already has. */
  const badges = $derived.by(() => {
    const map = new Map<string, Badge[]>();
    for (const row of rows) {
      map.set(
        row.id,
        badgeList(
          {
            unread: counts.unread.get(row.id),
            downloaded: downloaded.get(row.id),
            isNew: facts.newUpdates.has(row.id),
            source: row.provider,
          },
          settings.badgeSet,
        ),
      );
    }
    return map;
  });

  /** Where a `▶` would go, per series: the chapter the reader stopped in. */
  const resume = $derived(new Map(continuing.map((row) => [row.seriesId, row.chapterId])));

  /** The selected rows, which is what a collection row is asked about. */
  const selectedRows = $derived(selection === null ? [] : rows.filter((row) => selection?.has(row.id) === true));

  /** A collection row's state: the selection's, with this sheet's unticked changes on top. */
  function sheetState(categoryId: string): "all" | "some" | "none" {
    const pending = pendingCollections[categoryId];
    if (pending === undefined) return collectionState(selectedRows, categoryId);
    return pending ? "all" : "none";
  }

  /** Ticking a row files every selected title there; unticking removes them all from it. */
  function toggleCollection(categoryId: string): void {
    const current = sheetState(categoryId) === "all";
    pendingCollections = { ...pendingCollections, [categoryId]: !current };
  }

  /**
   * Apply the ticked rows, then close.
   *
   * One write per title through the same store call the single-tap path uses: the sheet changes
   * which categories, never how they are written. Untouched collections are not written at all.
   */
  async function applyCollections(): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined || selection === null) return;
    if (privacy.locked) return;
    const changes = Object.entries(pendingCollections);
    if (changes.length === 0) {
      categoriesOpen = false;
      return;
    }
    busy = "Filing…";
    try {
      for (const seriesId of selection) {
        const series = library.library.find((row) => row.id === seriesId);
        if (series === undefined) continue;
        let next = series.categoryIds ?? [];
        for (const [categoryId, want] of changes) next = applyCollection(next, categoryId, want);
        await store.setSeriesCategories(seriesId, next);
      }
      await library.refreshLibrary();
      categoriesOpen = false;
      pendingCollections = {};
      selection = null;
    } finally {
      busy = null;
    }
  }

  function onSelect(series: Series): void {
    if (selection === null) return;
    const next = new Set(selection);
    if (next.has(series.id)) next.delete(series.id);
    else next.add(series.id);
    selection = next;
  }

  async function bulkRead(read: boolean): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined || selection === null) return;
    busy = read ? "Marking read…" : "Marking unread…";
    try {
      for (const seriesId of selection) {
        if (privacy.locked && !visible.some((row) => row.id === seriesId)) continue;
        const chapters = await store.listChapters(seriesId);
        for (const chapter of chapters) {
          await store.setRead(chapter.id, read);
          if (!library.ownsProgress(chapter.id)) {
            const provider = library.profile?.providers.find((p) => chapter.id.startsWith(`${p.kind}:`));
            await provider?.setRead(chapter.id, read).catch(() => {});
          }
        }
      }
      await recount();
      selection = null;
    } finally {
      busy = null;
    }
  }

  async function bulkRemove(): Promise<void> {
    if (selection === null) return;
    confirmingRemove = false;
    removeError = null;
    busy = "Removing…";
    try {
      for (const seriesId of selection) {
        if (privacy.locked && !visible.some((row) => row.id === seriesId)) continue;
        await library.unsave(seriesId);
      }
      await library.refreshLibrary();
      await recount();
      selection = null;
    } catch (problem) {
      // A throw mid-loop left the rest of the selection in the library with nothing said about it.
      removeError = `Stopped removing: ${problem instanceof Error ? problem.message : String(problem)}`;
    } finally {
      busy = null;
    }
  }
</script>

<section class="view" class:split={layout.mode === "split"} class:thirds class:reading={readingPage}>
  <div class="sheet">
  <div class="pin">
  {#if initialTab !== "titles"}<PageMenu title="Library" current="library" />{:else}
  <LibraryHeader
    bind:this={header}
    count={rows.length}
    total={visible.length}
    {searching}
    text={query}
    scope={searchScope}
    selecting={selection !== null}
    onsearch={() => (libraryMemory.searching = !libraryMemory.searching)}
    onclosesearch={() => {
      libraryMemory.searching = false;
      libraryMemory.query = "";
    }}
    onselect={toggleSelection}
    onrefresh={() => void refreshLibrary()}
    onoverflow={() => (menuOpen = true)}
    onsettings={() => (settingsOpen = true)}
    ontext={(value) => (libraryMemory.query = value)}
    onscope={(scope) => (libraryMemory.scope = scope)}
  />
  {/if}
  <!--
    One row: the sections on the left, the pin on the right. The pin used to get a row of its own
    under these tabs, which bought nothing but 40 px of space and pushed the shelves further down
    the screen; it still stays outside the foldable band, which is the part that mattered.
  -->
  <div class="tabsrow">
    <nav class="library-tabs" aria-label="Library sections">
      {#each sections as section (section.id)}
        <button
          class="btn"
          aria-current={initialTab === section.id ? "page" : undefined}
          onclick={() => go(sectionHref(section.id))}
        >{section.label}</button>
      {/each}
    </nav>

  </div>
  </div>
  {#if initialTab === "updates"}
    <Updates />
  {:else if initialTab === "downloads"}
    <Downloads embedded />
  {:else}
  {#if offline}
    <p class="offline" role="status">{OFFLINE_NOTE}</p>
  {/if}

  <div class="body">
    {#if layout.categoryNav.mode === "sidebar"}
      <aside class="collections" style:width={`${layout.sidebarWidth}px`} aria-label="Collections">
        <button class="crow" class:on={selected === null} aria-current={selected === null ? "true" : undefined} onclick={() => setCollection(null)}>
          All
        </button>
        {#each shownCategories as category (category.id)}
          <button
            class="crow"
            class:on={selected === category.id}
            class:pinned={category.pinned}
            aria-current={selected === category.id ? "true" : undefined}
            onclick={() => setCollection(category.id)}
          >
            {category.name}
          </button>
        {/each}
        <button class="crow more" onclick={() => (categoriesOpen = true)}>Categories…</button>
        <!-- One and two panes, stacked at the foot of the rail: the swap is a shape, and two buttons
             that sit on top of each other read as one choice rather than two settings. -->
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
      </aside>
    {/if}

    <div class="panes" class:spread class:solo bind:this={panes}>
      <div class="column">
        <!--
          The pin is a seat in the band, beside the eye and the lock. Only the curtain moves it, and
          then it goes to the top bar (see LibraryHeader). The band belongs to the shelf — it says
          what the shelf shows — so it is drawn inside the shelf's column and stops at its seam
          instead of running across the series pane beside it.
        -->
        <LibraryBand />
        {#if library.library.length > 0}
        {#if layout.categoryNav.mode !== "sidebar"}
        <CollectionTabs
          categories={categories.items}
          visible={shownCategories}
          {selected}
          onselect={(id) => setCollection(id)}
          onedit={() => (categoriesOpen = true)}
        />
        {/if}

        {#if continueVisible && settings.continuePosition === "above"}
          <ContinueRail rows={continueRows} size={settings.continueSize} />
        {/if}

        <div class="tools" class:collapsed={settings.toolsCollapsed}>
          <!--
            One fold for the three doors. The row is three buttons of different widths for questions
            a reader asks in bursts — "filter this, sort it, change the covers" — and then does not
            ask again for ten minutes, so it gives the pixels back. Folded is remembered, like every
            other display choice; the handle keeps saying what is inside it, so a filter that is on
            is still visible with the row away.
          -->
          <button
            class="fold"
            aria-expanded={!settings.toolsCollapsed}
            aria-label={settings.toolsCollapsed ? "Show filter, sort and display" : "Hide filter, sort and display"}
            title={settings.toolsCollapsed ? "Show filter, sort and display" : "Hide filter, sort and display"}
            onclick={() => settings.set("toolsCollapsed", !settings.toolsCollapsed)}
          >
            <svg class="caret" class:up={!settings.toolsCollapsed} viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            {#if settings.toolsCollapsed}
              <span class="summary">Filter{filterCount > 0 ? ` (${filterCount})` : ""} · Sort · {sortLabel}</span>
            {/if}
          </button>
          {#if !settings.toolsCollapsed}
            <button class="btn ghost" onclick={() => (filterOpen = true)}>
              Filter{filterCount > 0 ? ` (${filterCount})` : ""}
            </button>
            <button class="btn ghost" onclick={() => (sortOpen = true)}>Sort · {sortLabel}</button>
            <button class="btn ghost" onclick={() => (displayOpen = true)}>Display</button>
          {/if}
        </div>

        <ChipRow chips={filterChips} onremove={removeChip} />

        {#if continueVisible && settings.continuePosition === "below"}
          <ContinueRail rows={continueRows} size={settings.continueSize} />
        {/if}
        {/if}

        <!--
          The local files live in the `⋯` sheet now. The inputs stay mounted here (buttons off) so
          the picker opens on the same gesture that closed the sheet — including on an empty
          library, where the sheet's "Add files…" must work exactly like the blank screen's button.
        -->
        <AddFiles bind:this={adders} showButtons={false} />

        {#if downloadsNote !== null}
          <p class="downnote">{downloadsNote}</p>
        {/if}

        <BrowseDisplay />
        {#if !library.ready}
          <p class="empty">Opening the library…</p>
        {:else if rows.length === 0 && library.library.length === 0}
          <div class="blank">
            <p class="blankline">Nothing here yet.</p>
            <p class="blanksub">
              Open a comic you already own, add the Komga or Suwayomi server you run yourself, or
              browse the Internet Archive's public-domain scans. HardlyTracking ships no comics of
              its own.
            </p>
            <div class="blankacts">
              <AddFiles look="primary" label="Add comic files" />
              <button class="btn ghost" onclick={() => (driveOpen = true)}>From Google Drive</button>
              <button class="btn" onclick={() => go("/browse")}>Internet Archive</button>
              <button class="btn" onclick={() => go("/extensions")}>My own server</button>
            </div>
          </div>
        {:else if rows.length === 0 && !isEmptyFilter(filter)}
          <div class="blank">
            <p class="blankline">Nothing matches these filters.</p>
            <div class="blankacts">
              <button class="btn primary" onclick={clearFilters}>Clear filters</button>
            </div>
          </div>
        {:else}
          <SeriesGrid
            series={rows}
            view={settings.libraryView}
            cover={cover}
    titlePlacement={settings.browseTitle}
    rowStyle={settings.rowStyle}
            sizes={fileSizes}
            totals={counts.total}
            empty={emptyMessage}
            current={layout.mode === "split" ? picked : current}
            {selection}
            {unread}
            onpick={pick}
            onselect={onSelect}
            reorderable={sortSpec.key === "manual"}
            onmove={moveRow}
            {badges}
            {resume}
            onlongpress={(series) => {
              selection = new Set([series.id]);
            }}
          />
        {/if}
      </div>

      {#if layout.mode === "split"}
        <div
          class="divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the detail pane"
          title="Drag to resize · double-click to reset"
          onpointerdown={startDrag}
          ondblclick={resetDrag}
        ></div>

        <!-- The second column: the series page, or the chapter when two panes are a reader. -->
        <aside
          class="detail"
          class:reading={openChapter !== null && layout.thirdWidth === 0}
          style:width={`${layout.detailWidth}px`}
          aria-label={openChapter !== null && layout.thirdWidth === 0 ? "Reader" : "Selected series"}
        >
          {#if openChapter !== null && layout.thirdWidth === 0}
            <Reader
              pane
              seriesId={openChapter.seriesId}
              chapterId={openChapter.chapterId}
              onclose={() => readerPane.close()}
              onnavigate={(id) => readerPane.replace(id)}
            />
          {:else if pickedRow !== null}
            <SeriesPage seriesId={pickedRow.id} embedded onlibrarychange={() => void recount()} />
          {:else}
            <p class="hint">Pick a title to see it here. The shelf keeps its place.</p>
          {/if}
        </aside>

      {:else if openChapter !== null}
        <!-- One column, reading: the shelf gives its place to the page and comes back on close. -->
        <aside class="detail reading" style:width="100%" aria-label="Reader">
          <Reader
            pane
            seriesId={openChapter.seriesId}
            chapterId={openChapter.chapterId}
            onclose={() => readerPane.close()}
            onnavigate={(id) => readerPane.replace(id)}
          />
        </aside>
      {/if}
    </div>
  </div>

  {#if selection !== null}
    <div class="selection" class:pinned={layout.selectionBar === "pinned"} role="toolbar" aria-label="Selection actions">
      <span class="n">{busy ?? `${selection.size} selected`}</span>
      <div class="sacts">
        {#if confirmingRemove}
          <!-- Two taps, like every other delete: the first one asks, this one removes. -->
          <button class="btn danger" disabled={selection.size === 0} onclick={() => void bulkRemove()}>
            Remove {selection.size} from library
          </button>
          <button class="btn ghost" onclick={() => (confirmingRemove = false)}>Cancel</button>
        {:else}
          <button class="btn ghost" onclick={selectEverything}>Select all {rows.length}</button>
          <button class="btn ghost" disabled={selection.size === 0} onclick={() => void bulkRead(true)}>Read</button>
          <button class="btn ghost" disabled={selection.size === 0} onclick={() => void bulkRead(false)}>Unread</button>
          <button class="btn ghost" disabled={selection.size === 0} onclick={() => { pendingCollections = {}; categoriesOpen = true; }}>Category</button>
          <button class="btn danger" disabled={selection.size === 0} onclick={() => (confirmingRemove = true)}>Remove</button>
          <button class="btn ghost" onclick={() => { selection = null; confirmingRemove = false; removeError = null; }}>Done</button>
        {/if}
      </div>
      {#if removeError !== null}<p class="hint" role="alert">{removeError}</p>{/if}
    </div>
  {/if}
  {/if}
  </div>

  {#if thirds}
    <!-- The reading column outside the page: its own seam, the top of the scroller, and the whole
         height of the window — the same surface one-pane reading has always had. -->
    <div class="thirdpane">
      <div
        class="divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the reading pane"
        title="Drag to resize · double-click to reset"
        onpointerdown={startShareDrag}
        ondblclick={resetShare}
      ></div>
      <aside class="detail reading third" style:width={`${layout.thirdWidth}px`} aria-label="Reader">
        {#if openChapter !== null}
          <Reader
            pane
            seriesId={openChapter.seriesId}
            chapterId={openChapter.chapterId}
            onclose={() => readerPane.close()}
            onnavigate={(id) => readerPane.replace(id)}
          />
        {:else}
          <p class="hint">Pick a chapter and it opens here, beside the series.</p>
        {/if}
      </aside>
    </div>
  {/if}
</section>

<SortSheet
  open={sortOpen}
  spec={sortSpec}
  collection={selected === null ? "All" : shownCategories.find((category) => category.id === selected)?.name ?? "All"}
  onclose={() => (sortOpen = false)}
  onapply={setSort}
/>

<FilterSheet
  open={filterOpen}
  {filter}
  statuses={statusOptions}
  sources={sourceOptions}
  onclose={() => (filterOpen = false)}
  onapply={(next) => settings.set("libraryFilter", next)}
/>

<DriveImport open={driveOpen} onclose={() => (driveOpen = false)} />

<Sheet open={settingsOpen} title="Library settings" onclose={closeSettings}>
  <!-- Same component the Settings page renders: one implementation, two doors. `browse` is off
       because `<BrowseDisplay />` already sits inline above the shelf, a few pixels from here. -->
  <LibrarySettingsPanel browse={false} />
</Sheet>

<Sheet open={displayOpen} title="Display" onclose={() => (displayOpen = false)}>
  <div class="rows">
    <label class="row">
      <span>Show “Continue reading”</span>
      <input type="checkbox" checked={settings.showContinue} onchange={(event) => settings.set("showContinue", event.currentTarget.checked)} />
    </label>
    <div class="row badgeset">
      <span>Badges</span>
      <div class="badgegrid">
        {#each BADGE_KINDS as kind (kind)}
          <label class="badgetoggle">
            <input
              type="checkbox"
              checked={settings.badgeSet[kind] ?? DEFAULT_BADGES[kind]}
              onchange={(event) => settings.set("badgeSet", { ...settings.badgeSet, [kind]: event.currentTarget.checked })}
            />
            <span>{kind}</span>
          </label>
        {/each}
      </div>
    </div>
  </div>
</Sheet>

<OverflowSheet
  open={menuOpen}
  onclose={() => (menuOpen = false)}
  onrefresh={() => void refreshLibrary()}
  onselect={() => (selection = new Set())}
  oncategories={() => (categoriesOpen = true)}
  onsettings={() => (settingsOpen = true)}
  onaddfiles={() => adders?.pickFiles()}
  onaddfolder={() => adders?.pickFolder()}
  onimportdownloads={canImportDownloads ? () => void importDownloads() : null}
  onexporttomihon={canImportDownloads ? () => void exportToMihon() : null}
  ondrive={() => (driveOpen = true)}
  {stats}
/>

<Sheet open={categoriesOpen} title={selection === null ? "Categories" : "Collections"} onclose={() => (categoriesOpen = false)}>
  {#if selection !== null}
    <p class="muted">{selection.size} selected — tick the collections they belong in.</p>
    <div class="picklist">
      {#each categories.items.filter((c) => !privacy.locked || !c.hidden) as category (category.id)}
        {@const state = sheetState(category.id)}
        <button
          class="chip"
          class:on={state !== "none"}
          aria-pressed={state === "all" ? true : state === "some" ? "mixed" : false}
          onclick={() => toggleCollection(category.id)}
        >{state === "all" ? "✓" : state === "some" ? "–" : " "} {category.name}</button>
      {/each}
      {#if categories.items.length === 0}
        <p class="empty">No categories yet.</p>
      {/if}
    </div>
    <div class="sheetfoot">
      <button class="btn ghost" onclick={() => { pendingCollections = {}; categoriesOpen = false; }}>Cancel</button>
      <button class="btn primary" onclick={() => void applyCollections()}>Apply</button>
    </div>
  {:else}
    <CategoryRail
      {selected}
      onselect={(id) => {
        setCollection(id);
        categoriesOpen = false;
      }}
    />
  {/if}
</Sheet>

<Sheet open={askAboutHidden} title="Selection would be hidden" onclose={keepHiddenSelection}>
  <p>{hiddenSelection.length} selected {hiddenSelection.length === 1 ? "title is" : "titles are"} no longer in this view.</p>
  <div class="sheetfoot">
    <button class="btn ghost" onclick={keepHiddenSelection}>Keep selection</button>
    <button class="btn primary" onclick={clearHiddenSelection}>Clear selection</button>
  </div>
</Sheet>

<style>
  /* The line an import answers with: one sentence, under the shelf controls, never a dialog. */
  .downnote {
    margin: 0 0 var(--s3);
    color: var(--text-2);
    font-size: var(--t-sm);
  }
  /* Sections and the pin share a row: 44 px tall, no extra padding above or below. */
  .tabsrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s2);
    margin-bottom: var(--s1);
  }
  .library-tabs { display: flex; gap: var(--s2); }
  /* The label is text, so it takes the readable accent: the fill colour is #613583, which is
     2.15:1 on the dark page. The border keeps the fill — a 1px line has no legibility of its own. */
  .library-tabs [aria-current="page"] { color: var(--accent-text); border-color: var(--accent); }
  /* One line, in place: no dialog, no empty screen, nothing else on this page changes. */
  .offline {
    margin: 0 var(--s3) var(--s2);
    padding: var(--s2) var(--s3);
    border: 1px solid var(--line);
    border-radius: var(--r2);
    background: var(--surface-2);
    color: var(--muted);
    font-size: 13px;
    line-height: 1.35;
  }
  .view :global([role="tablist"][aria-label="Categories"]) {
    flex-wrap: wrap;
    overflow: visible;
  }
  .view :global([role="tablist"][aria-label="Categories"] .chip) {
    max-width: 100%;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .view {
    min-width: 0;
    box-sizing: border-box;
    padding: var(--s4) var(--s4) var(--s6);
    max-width: 1200px;
  }

  /* A split uses the room it is given.
     The 1200 px cap is a reading measure for a single column. Left on beside a detail pane it made
     the layout and the screen disagree: `libraryLayout` divides the window's room (the shell's rail
     and this padding already taken out), so at 1440 it believed the shelf had 657 px while the cap
     left it 464 — and a drag clamped against the panes it could actually see could ask for a shelf
     narrower than the floor the arithmetic had just promised. Measured: 44 px. The panes are two
     columns of a master/detail screen, not prose; they grow with the window. */
  .view.split {
    max-width: none;
  }

  /* The floors, enforced by the box rather than only by the arithmetic.
     `libraryLayout` decides the mode, and its floors are what make a split legal at all — but the
     seam and the gap between the collections and the panes are 29 px of chrome the widths do not
     name, so the last 29 px of a drag land inside a column instead of between them. These two lines
     are the promise #3 makes: whatever happens to the arithmetic, neither pane is drawn under its
     minimum, and the detail gives way instead of overflowing the row. */
  .view.split .column {
    min-width: 200px; /* MIN_SHELF_WIDTH */
  }

  .view.split .detail {
    max-width: calc(100% - 217px); /* MIN_SHELF_WIDTH + the 9 px seam and its 8 px of margins */
  }

  /* Three panes: the page and the reader are two things side by side. The page keeps the padding,
     the reader gets none of it — so the band and the search sit over the shelves and never over the
     chapter, and the chapter starts where the window starts. */
  .view.thirds {
    display: flex;
    align-items: stretch;
    padding: 0;
    max-width: none;
    height: 100dvh;
    overflow: hidden;
  }
  /* The page scrolls inside itself, so the reader beside it is a still column rather than a sticky
     panel being re-composited on every wheel tick. */
  .view.thirds .sheet {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    overscroll-behavior-y: contain;
    box-sizing: border-box;
    padding: var(--s4) var(--s4) var(--s6);
  }
  .thirdpane {
    flex: none;
    display: flex;
    align-items: stretch;
    height: 100%;
  }
  /* The three-pane view is already exactly one screen tall and scrolls inside itself, so its seam
     stretches the column instead of sticking to the window. */
  .thirdpane .divider {
    position: static;
    align-self: stretch;
    height: auto;
    max-height: none;
  }
  .thirdpane .detail.reading.third {
    height: 100%;
    max-height: none;
    align-self: stretch;
    position: relative;
    top: 0;
    box-sizing: border-box;
  }

  /* Reading in one pane (or a spread): the library's chrome belongs to the shelf, and the shelf is
     away. The reader takes the whole frame — no header above it, no page to scroll behind it. */
  .view.reading {
    display: flex;
    flex-direction: column;
    padding: 0;
    max-width: none;
    height: 100dvh;
    overflow: hidden;
  }
  .view.reading > .pin,
  .view.reading :global(.bandbox) { display: none; }
  .view.reading .body { flex: 1; min-height: 0; }
  .view.reading .panes { height: 100%; }
  .view.reading .detail.reading {
    height: 100%;
    max-height: none;
    position: relative;
    top: 0;
  }

  /* A sheet's footer: the two buttons sit at the end, Cancel first so Apply is the reach. */
  .sheetfoot {
    display: flex;
    justify-content: flex-end;
    gap: var(--s2);
    margin-top: var(--s4);
  }

  /* ---- the body: collections, the grid column, and the detail pane ------------------------- */

  .body {
    display: flex;
    align-items: flex-start;
    gap: var(--s3);
  }

  .panes {
    display: flex;
    align-items: flex-start;
    flex: 1;
    min-width: 0;
  }

  .column {
    flex: 1;
    min-width: 0;
  }

  /* A collection column, only when the grid still keeps its minimum beside it. */
  .collections {
    flex: none;
    position: sticky;
    top: var(--s4);
    align-self: flex-start;
    max-height: calc(100dvh - var(--s4) * 2);
    overflow-y: auto;
    display: grid;
    gap: 2px;
    padding-right: var(--s3);
    border-right: 1px solid var(--line);
    box-sizing: border-box;
    scrollbar-width: none;
  }

  .collections::-webkit-scrollbar {
    display: none;
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

  .crow {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding: var(--s2) var(--s3);
    border-radius: var(--r2);
    min-height: 36px;
    font-size: var(--t-md);
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .crow:hover {
    background: var(--surface-2);
    color: var(--text-1);
  }

  .crow.on {
    background: var(--surface-2);
    color: var(--text-1);
    font-weight: 600;
  }

  /* The pinned mark is a quiet cue here too: a 2px underlight, not a second icon. */
  .crow.pinned {
    color: var(--text-1);
    box-shadow: inset 2px 0 0 color-mix(in srgb, var(--tone-pinned) 60%, transparent);
  }

  .crow.more {
    color: var(--text-3);
  }

  .divider {
    flex: none;
    /*
     * The handle is the height of the window, not the height of the shelf.
     *
     * It used to be `align-self: stretch` in a flex row whose tallest item is the shelf column: on a
     * 5 000-title library that is a seam tens of thousands of pixels tall. It draws nothing below
     * the fold, but it does two worse things — the resize cursor is live over every pixel of the
     * document's right edge, and the box the drag measures no longer matches what the reader sees.
     * Sticky, at the same viewport-bound height as the pane it resizes, keeps the handle where the
     * eye and the pointer are.
     */
    position: sticky;
    top: var(--s4);
    align-self: flex-start;
    height: calc(100dvh - var(--s4) * 2);
    max-height: calc(100dvh - var(--s4) * 2);
    width: 9px;
    margin: 0 var(--s1);
    border-radius: var(--r-pill);
    cursor: col-resize;
    touch-action: none;
    background: transparent;
    transition: background var(--dur);
  }

  .divider:hover,
  .divider:active {
    background: var(--line-strong);
  }

  /* The pane scrolls on its own, so the shelf keeps its place while chapters are read. */
  /* The spread: the shelf steps aside (hidden, not unmounted) and the reading surface takes both
     columns, so the gutter falls where the divider was — and the divider is no longer a handle. */
  .panes.spread .column,
  .panes.solo .column { display: none; }
  .panes.spread .divider { display: none; }

  /* The third column's seam is a handle now, so it does not also draw a border there. */
  .detail.third { border-left: none; }

  .detail.reading {
    position: relative;
    height: calc(100dvh - var(--s4) * 2);
    padding: 0;
    overflow: hidden;
  }

  .detail {
    flex: none;
    position: sticky;
    top: var(--s4);
    align-self: flex-start;
    max-height: calc(100dvh - var(--s4) * 2);
    overflow-y: auto;
    box-sizing: border-box;
    border-left: 1px solid var(--line);
  }

  .hint {
    margin: 0;
    padding: var(--s4) var(--s3);
    font-size: var(--t-sm);
    line-height: 1.6;
    color: var(--text-3);
  }

  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s2);
    margin-bottom: var(--s4);
  }
  /* The handle is bare: the row it folds is the loud thing, so the caret is the only furniture.
     Folded, it carries the summary instead of three buttons, which keeps the state of the shelf
     (a filter is on, the sort is not Title) readable without opening anything. */
  .tools .fold {
    display: flex;
    align-items: center;
    gap: var(--s1);
    min-height: 24px;
    padding: 0 2px;
    border: 0;
    background: transparent;
    color: var(--text-3);
    font: inherit;
    cursor: pointer;
  }
  .tools .fold:hover, .tools .fold:focus-visible { color: var(--text-1); }
  .tools .fold .caret { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; transition: transform 140ms ease; }
  .tools .fold .caret.up { transform: rotate(180deg); }
  .tools .fold .summary { font-size: var(--t-sm); }
  .tools.collapsed { margin-bottom: var(--s3); }
  @media (prefers-reduced-motion: reduce) { .tools .fold .caret { transition: none; } }

    .blank {
    display: grid;
    gap: var(--s2);
    padding-top: var(--s6);
    max-width: 48ch;
  }

  .blankline {
    margin: 0;
    font-size: var(--t-lg);
  }

  .blanksub {
    margin: 0;
    font-size: var(--t-sm);
    line-height: 1.6;
    color: var(--text-2);
  }

  .blankacts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
    margin-top: var(--s2);
  }

  /* The selection bar sits above the bottom bar, and above the desktop fold. */
  .selection {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(var(--nav-h) + var(--safe-b) + var(--s2));
    z-index: 30;
    display: flex;
    align-items: center;
    gap: var(--s3);
    padding: var(--s2) var(--s3);
    border-radius: var(--r-pill);
    background: var(--elevated);
    border: 1px solid var(--line-strong);
    box-shadow: var(--shadow-2);
    max-width: calc(100vw - 24px);
    flex-wrap: wrap;
    box-sizing: border-box;
    border-radius: var(--r2);
  }

  .selection .n {
    font-size: var(--t-sm);
    color: var(--text-2);
    white-space: nowrap;
  }

  /* Where a sidebar or a split puts the bar, there is no bottom bar to clear. */
  .selection.pinned {
    bottom: var(--s3);
  }

  .sacts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s1);
  }

  .rows {
    display: grid;
    gap: var(--s3);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    font-size: var(--t-md);
    min-height: 36px;
  }

  .picklist {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }
</style>
