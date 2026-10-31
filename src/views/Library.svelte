<script lang="ts">
  /**
   * The library: the shelf, and the controls that narrow it.
   *
   * The eye and the pin still decide membership and order (`applyView`), the rail is still the
   * place those marks live, and this screen adds what a real library needs: search, sort, three
   * densities, filters and a selection mode. Nothing here writes to a source — the only writes are
   * read marks, category membership and removing a row from the shelf.
   */
  import { tick } from "svelte";
  import { library } from "../state/library.svelte";
  import { libraryMemory } from "../state/libraryview.svelte";
  import { categories } from "../state/categories.svelte";
  import { settings } from "../state/settings.svelte";
  import { downloads } from "../state/downloads.svelte";
  import { viewStateKey } from "../lib/history";
  import CategoryRail from "../components/CategoryRail.svelte";
  import SeriesGrid from "../components/SeriesGrid.svelte";
  import { cleanOrder, orderAfterMove } from "../lib/library/order";
  import { applyCollection, collectionState, hiddenBy, selectAll } from "../lib/library/selection";
  import { BADGE_KINDS, DEFAULT_BADGES, PRESET_BADGES, badgeList, type Badge } from "../lib/library/badges";
  import Sheet from "../components/Sheet.svelte";
  import LibraryHeader from "../components/LibraryHeader.svelte";
  import AddFiles from "../components/AddFiles.svelte";
  import DriveImport from "../components/DriveImport.svelte";
  import OverflowSheet, { type LibraryStats } from "../components/OverflowSheet.svelte";
  import FilterSheet from "../components/FilterSheet.svelte";
  import ChipRow from "../components/ChipRow.svelte";
  import CollectionTabs from "../components/CollectionTabs.svelte";
  import ContinueRail from "../components/ContinueRail.svelte";
  import SortSheet from "../components/SortSheet.svelte";
  import { go, pathTo } from "../lib/nav";
  import { visibleCategories } from "../lib/categories";
  import { sourceKeyOf } from "../lib/marks";
  import { sourceMarks } from "../state/source-marks.svelte";
  import { coverWidth, libraryLayout } from "../lib/layout-modes";
  import { viewport } from "../lib/layout.svelte";
  import { emptyFacts, runQuery, type QueryFacts } from "../lib/library/query";
  import { EMPTY_FILTER, activeChips, countActive, isEmptyFilter, mergeFilter, withoutChip } from "../lib/library/filter";
  import { SORT_OPTIONS, sortKeyOf, type SortSpec } from "../lib/library/sort";
  import { parseSearch, withoutOperator } from "../lib/library/search";
  import { eligible } from "../lib/library/continue";
  import { sourceLabel } from "../lib/titles";
  import SeriesPage from "./Series.svelte";
  import type { Series } from "../api/source";

  let { current = null }: { current?: string | null } = $props();

  /**
   * Which category the rail is pointing at; `null` is the whole library. It lives in
   * `libraryMemory` so Library → Series → back comes back here, and the durable copy in settings
   * so a relaunch does too.
   */
  const selected = $derived(libraryMemory.collection);
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
  let driveOpen = $state(false);

  /** The applied filter is a setting, not component state: a reload must keep it. */
  const filter = $derived(settings.libraryFilter);

  let selection = $state<Set<string> | null>(null);
  /** The collection sheet's working set (category id -> ticked), applied once so Cancel cancels. */
  let pendingCollections = $state<Record<string, boolean>>({});
  /** The change a "these would be hidden" sheet was already answered for. */
  let hiddenAcknowledged = $state<string | null>(null);
  let busy = $state<string | null>(null);

  // ---- the shape of this screen, and the pane that belongs to it -----------------------------
  //
  // Decided by `lib/layout-modes`, drawn here: a phone is one pane with collection chips, a tablet
  // gets the collection column when there is room for it beside a usable grid, a desktop adds the
  // detail pane. Nothing below reads a device name.

  /** The title in the detail pane, on a screen wide enough for one. */
  let picked = $state<string | null>(null);
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
    if (row.view !== undefined) settings.set("libraryView", row.view as typeof settings.libraryView);
    if (row.coverSize !== undefined) settings.set("coverSize", row.coverSize);
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
    library.library.map((series) => ({ ...series, categoryIds: series.categoryIds ?? [] })),
  );

  /** The chips obey the eye, exactly as the rail does. */
  const shownCategories = $derived(visibleCategories(categories.items, categories.hiddenView));

  const layout = $derived(
    libraryLayout(viewport.width, viewport.height, {
      nav: settings.categoryNav,
      collectionCount: shownCategories.length,
      pinnedCount: shownCategories.filter((category) => category.pinned).length,
      splitRatio: dragRatio ?? settings.splitRatio,
    }),
  );

  /** Auto is the device class's density, Custom is the slider, a preset wins over both. */
  const cover = $derived(coverWidth(settings.libraryDensity, layout.device, settings.coverSize));

  const VIEWS = [
    { id: "grid", icon: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" },
    { id: "compact", icon: "M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4zM10 10h4v4h-4zM16 10h4v4h-4z" },
    { id: "list", icon: "M4 6h16M4 12h16M4 18h16" },
  ] as const;

  /**
   * The facts every stage of the query reads, from one pass over what we already hold.
   *
   * Unread, totals, last-read order and downloads are all questions about the same rows, so they
   * are gathered together: a filter or a sort must never ask the database anything mid-render.
   */
  /** seriesId -> the source id its mapping names, when one exists. */
  let mappedSource = $state<Map<string, string>>(new Map());

  let counts = $state<{
    unread: Map<string, number>;
    total: Map<string, number>;
    lastRead: Map<string, number>;
    status: Map<string, string>;
    lastUpdated: Map<string, number>;
  }>({
    unread: new Map(),
    total: new Map(),
    lastRead: new Map(),
    status: new Map(),
    lastUpdated: new Map(),
  });

  async function recount(): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    const [chapters, prefs, positions, mappings] = await Promise.all([
      store.listAllChapters(),
      store.listPrefs(),
      store.listPositions(),
      // A `mihon:12` id does not name its source; the stored mapping is the only thing that does.
      // Read here, in the same pass as the counts, so hiding a Suwayomi source works like hiding a
      // dalvik one instead of silently doing nothing.
      store.listMappings(),
    ]);
    mappedSource = new Map(mappings.map((row) => [row.seriesId, row.sourceId]));
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

  /** The strip's rows: dismissed titles dropped, capped at the setting, order kept. */
  const continueRows = $derived(eligible(continuing, new Set(settings.continueDismissed), settings.continueMax));

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
    series: library.library.length,
    unread: [...counts.unread.values()].reduce((sum, count) => sum + count, 0),
    downloaded: downloads.rows.length,
    categories: categories.items.map((category) => ({
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

  /** Three named presets: a size and the badges that belong with it, written together. */
  const DENSITY_PRESETS = [
    { name: "comfortable", label: "Comfortable", cover: 132 },
    { name: "compact", label: "Compact", cover: 96 },
    { name: "large", label: "Large", cover: 180 },
  ] as const;

  function applyPreset(preset: (typeof DENSITY_PRESETS)[number]): void {
    settings.set("coverSize", preset.cover);
    // The slider's value is what draws, so a preset has to move it — and "manual" is the setting
    // that says the slider is in charge.
    settings.set("libraryDensity", "manual");
    settings.set("badgeSet", { ...PRESET_BADGES[preset.name] });
  }

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

  /** Drag the divider: the ratio is live while dragging, and remembered when the pointer lifts. */
  function startDrag(event: PointerEvent): void {
    if (panes === null) return;
    const handle = event.currentTarget as HTMLElement;
    const box = panes.getBoundingClientRect();
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      if (box.width === 0) return;
      dragRatio = Math.min(0.75, Math.max(0.45, (moveEvent.clientX - box.left) / box.width));
    };
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      if (dragRatio !== null) settings.set("splitRatio", dragRatio);
      dragRatio = null;
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  }

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
    busy = "Removing…";
    try {
      for (const seriesId of selection) await library.unsave(seriesId);
      await library.refreshLibrary();
      await recount();
      selection = null;
    } finally {
      busy = null;
    }
  }
</script>

<section class="view">
  <LibraryHeader
    count={rows.length}
    total={library.library.length}
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
    ontext={(value) => (libraryMemory.query = value)}
    onscope={(scope) => (libraryMemory.scope = scope)}
  />

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
      </aside>
    {/if}

    <div class="panes" bind:this={panes}>
      <div class="column">
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

        <div class="tools">
          <button class="btn ghost" onclick={() => (filterOpen = true)}>
            Filter{filterCount > 0 ? ` (${filterCount})` : ""}
          </button>
          <button class="btn ghost" onclick={() => (sortOpen = true)}>Sort · {sortLabel}</button>
          <button class="btn ghost" onclick={() => (displayOpen = true)}>Display</button>
          <!-- The comics they already own: no server, no extension, no network. -->
          <AddFiles />
          <button class="btn ghost" onclick={() => (driveOpen = true)}>From Drive</button>
          <div class="views" role="group" aria-label="Layout">
            {#each VIEWS as view (view.id)}
              <button
                class="btn ghost icon"
                class:on={settings.libraryView === view.id}
                aria-label={`${view.id} layout`}
                aria-pressed={settings.libraryView === view.id}
                onclick={() => settings.set("libraryView", view.id)}
              >
                <svg viewBox="0 0 24 24"><path d={view.icon} /></svg>
              </button>
            {/each}
          </div>
        </div>

        <ChipRow chips={filterChips} onremove={removeChip} />

        {#if continueVisible && settings.continuePosition === "below"}
          <ContinueRail rows={continueRows} size={settings.continueSize} />
        {/if}
        {/if}

        {#if !library.ready}
          <p class="empty">Opening the library…</p>
        {:else if rows.length === 0 && library.library.length === 0}
          <div class="blank">
            <p class="blankline">Your library is empty.</p>
            <p class="blanksub">
              Add the comics you already own — a CBZ or PDF from this device — or a repository, and the first
              series you keep lands here.
            </p>
            <div class="blankacts">
              <AddFiles look="primary" label="Add comic files" />
              <button class="btn ghost" onclick={() => (driveOpen = true)}>From Google Drive</button>
              <button class="btn" onclick={() => go("/extensions")}>Add a repository</button>
              <button class="btn" onclick={() => go("/browse")}>Browse sources</button>
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
          onpointerdown={startDrag}
        ></div>
        <aside class="detail" style:width={`${layout.detailWidth}px`} aria-label="Selected series">
          {#if pickedRow !== null}
            <SeriesPage seriesId={pickedRow.id} embedded />
          {:else}
            <p class="hint">Pick a title to see it here. The shelf keeps its place.</p>
          {/if}
        </aside>
      {/if}
    </div>
  </div>

  {#if selection !== null}
    <div class="selection" class:pinned={layout.selectionBar === "pinned"} role="toolbar" aria-label="Selection actions">
      <span class="n">{busy ?? `${selection.size} selected`}</span>
      <div class="sacts">
        <button class="btn ghost" onclick={selectEverything}>Select all {rows.length}</button>
        <button class="btn ghost" disabled={selection.size === 0} onclick={() => void bulkRead(true)}>Read</button>
        <button class="btn ghost" disabled={selection.size === 0} onclick={() => void bulkRead(false)}>Unread</button>
        <button class="btn ghost" disabled={selection.size === 0} onclick={() => { pendingCollections = {}; categoriesOpen = true; }}>Category</button>
        <button class="btn danger" disabled={selection.size === 0} onclick={() => void bulkRemove()}>Remove</button>
        <button class="btn ghost" onclick={() => (selection = null)}>Done</button>
      </div>
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

<Sheet open={displayOpen} title="Display" onclose={() => (displayOpen = false)}>
  <div class="rows">
    <div class="row presets">
      <span>Size</span>
      <div class="presetrow">
        {#each DENSITY_PRESETS as preset (preset.name)}
          <button
            class="chip"
            class:on={cover === preset.cover && settings.libraryDensity === "manual"}
            onclick={() => applyPreset(preset)}
          >{preset.label}</button>
        {/each}
      </div>
    </div>
    <label class="row">
      <span>Cover size</span>
      <input
        type="range"
        min="96"
        max="200"
        step="4"
        value={cover}
        oninput={(event) => {
          // Dragging the slider is a density choice of its own: "Custom" wins over the presets.
          settings.set("coverSize", Number(event.currentTarget.value));
          settings.set("libraryDensity", "manual");
        }}
      />
    </label>
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
  onsettings={() => go("/settings")}
  {stats}
/>

<Sheet open={categoriesOpen} title={selection === null ? "Categories" : "Collections"} onclose={() => (categoriesOpen = false)}>
  {#if selection !== null}
    <p class="muted">{selection.size} selected — tick the collections they belong in.</p>
    <div class="picklist">
      {#each categories.items as category (category.id)}
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
  .view {
    padding: var(--s4) var(--s4) var(--s6);
    max-width: 1200px;
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
    align-self: stretch;
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

  .views svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .views button.on {
    color: var(--text-1);
    background: var(--surface-2);
  }

  .tools {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-bottom: var(--s4);
  }

  .views {
    margin-left: auto;
    display: flex;
    gap: 2px;
  }

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
    overflow-x: auto;
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
