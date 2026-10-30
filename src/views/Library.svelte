<script lang="ts">
  /**
   * The library: the shelf, and the controls that narrow it.
   *
   * The eye and the pin still decide membership and order (`applyView`), the rail is still the
   * place those marks live, and this screen adds what a real library needs: search, sort, three
   * densities, filters and a selection mode. Nothing here writes to a source — the only writes are
   * read marks, category membership and removing a row from the shelf.
   */
  import { library } from "../state/library.svelte";
  import { categories } from "../state/categories.svelte";
  import { settings } from "../state/settings.svelte";
  import { downloads } from "../state/downloads.svelte";
  import { viewStateKey } from "../lib/history";
  import CategoryRail from "../components/CategoryRail.svelte";
  import SeriesGrid from "../components/SeriesGrid.svelte";
  import Cover from "../components/Cover.svelte";
  import Sheet from "../components/Sheet.svelte";
  import LibraryHeader from "../components/LibraryHeader.svelte";
  import OverflowSheet, { type LibraryStats } from "../components/OverflowSheet.svelte";
  import FilterSheet from "../components/FilterSheet.svelte";
  import ChipRow from "../components/ChipRow.svelte";
  import CollectionTabs from "../components/CollectionTabs.svelte";
  import { go, pathTo } from "../lib/nav";
  import { visibleCategories } from "../lib/categories";
  import { coverWidth, libraryLayout } from "../lib/layout-modes";
  import { viewport } from "../lib/layout.svelte";
  import { emptyFacts, runQuery, type QueryFacts } from "../lib/library/query";
  import { EMPTY_FILTER, activeChips, countActive, isEmptyFilter, mergeFilter, withoutChip } from "../lib/library/filter";
  import { DEFAULT_SORT, type SortSpec } from "../lib/library/sort";
  import { parseSearch, withoutOperator, type SearchScope } from "../lib/library/search";
  import { sourceLabel } from "../lib/titles";
  import SeriesPage from "./Series.svelte";
  import type { Series } from "../api/source";

  let { current = null }: { current?: string | null } = $props();

  /** Which category the rail is pointing at; `null` is the whole library. */
  let selected = $state<string | null>(null);
  let query = $state("");
  let searching = $state(false);
  /** `This collection` narrows the tab you are on; `All library` looks past it (§29). */
  let searchScope = $state<SearchScope>("category");
  let filterOpen = $state(false);
  let sortOpen = $state(false);
  let categoriesOpen = $state(false);
  /** Display knobs (cover size, continue strip) — the settings that are not a filter. */
  let displayOpen = $state(false);

  /** The applied filter is a setting, not component state: a reload must keep it. */
  const filter = $derived(settings.libraryFilter);

  let selection = $state<Set<string> | null>(null);
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
      query,
      scroll: typeof window === "undefined" ? 0 : window.scrollY,
      selectedSeriesId: null as string | null,
    };
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
    if (row.sort !== undefined) settings.set("librarySort", row.sort as typeof settings.librarySort);
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
      query = row.query;
      searching = row.query.trim() !== "";
    }
    restoring = false;
    // Record the visit even if nothing is changed: the next launch should open here.
    saveViewSoon();
    if (typeof window !== "undefined" && row.scroll !== undefined) {
      // After paint, so the grid has its real height and the offset lands.
      requestAnimationFrame(() => window.scrollTo({ top: row.scroll ?? 0, behavior: "auto" }));
    }
  }

  $effect(() => {
    if (!library.ready) return;
    void restoreView(selected);

    // A tab close or a reload does not destroy the component, so the flush cannot live only in
    // the cleanup: `pagehide` and a hidden tab are the moments a phone app is killed.
    const flush = (): void => {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = null;
      if (restoring) return;
      void library.saveViewState(savedKey === "all" ? null : savedKey, captureViewState());
    };
    const onScroll = (): void => saveViewSoon();
    const onHide = (): void => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);

    return () => {
      window.removeEventListener("scroll", onScroll);
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

  const SORT_LABELS = { title: "Title", recent: "Recently read", source: "Source" } as const;

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
  let counts = $state<{ unread: Map<string, number>; total: Map<string, number>; lastRead: Map<string, number>; status: Map<string, string> }>({
    unread: new Map(),
    total: new Map(),
    lastRead: new Map(),
    status: new Map(),
  });

  async function recount(): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    const [chapters, prefs, positions] = await Promise.all([
      store.listAllChapters(),
      store.listPrefs(),
      store.listPositions(),
    ]);
    const read = new Set(
      prefs.filter((row) => String(row.key).startsWith("read:")).filter((row) => row.value === true).map((row) => String(row.key).slice(5)),
    );
    const unread = new Map<string, number>();
    const total = new Map<string, number>();
    for (const chapter of chapters) {
      total.set(chapter.seriesId, (total.get(chapter.seriesId) ?? 0) + 1);
      if (chapter.read || read.has(chapter.id)) continue;
      unread.set(chapter.seriesId, (unread.get(chapter.seriesId) ?? 0) + 1);
    }
    counts = {
      unread,
      total,
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
  });

  /** Continue reading, newest first — the shortcut back into a book. */
  let continuing = $state<Array<{ seriesId: string; chapterId: string; page: number; title: string; cover?: string; chapterName: string }>>([]);
  $effect(() => {
    if (library.profile === null) return;
    void library.continueReading().then((rows) => (continuing = rows));
  });

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
    if (!wasInSheet) query = withoutOperator(query, key);
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

  /** A refresh re-reads the shelf and asks the sources again; a source that is down is a note. */
  async function refreshLibrary(): Promise<void> {
    await library.refreshLibrary();
    await library.loadSources();
    await recount();
  }

  /** The sort the old preference means, until T-L7 gives each collection its own spec. */
  const sortSpec = $derived<SortSpec>(
    settings.librarySort === "recent"
      ? { key: "lastRead", dir: "desc" }
      : settings.librarySort === "source"
        ? { key: "source", dir: "asc" }
        : DEFAULT_SORT,
  );

  /** Every row this screen shows, through the one query model. */
  const rows = $derived(
    runQuery(
      { series: visible, categories: categories.items, marks: { hiddenView: categories.hiddenView, pinView: categories.pinView } },
      {
        collection: selected,
        filter,
        search: { text: query, scope: searchScope },
        sort: sortSpec,
      },
      facts,
    ),
  );

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

  async function bulkCategory(categoryId: string): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined || selection === null) return;
    busy = "Filing…";
    try {
      for (const seriesId of selection) {
        const series = library.library.find((row) => row.id === seriesId);
        const current = series?.categoryIds ?? [];
        if (current.includes(categoryId)) continue;
        await store.setSeriesCategories(seriesId, [...current, categoryId]);
      }
      await library.refreshLibrary();
      categoriesOpen = false;
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
    onsearch={() => (searching = !searching)}
    onclosesearch={() => {
      searching = false;
      query = "";
    }}
    onselect={toggleSelection}
    onrefresh={() => void refreshLibrary()}
    onoverflow={() => (menuOpen = true)}
    ontext={(value) => (query = value)}
    onscope={(scope) => (searchScope = scope)}
  />

  <div class="body">
    {#if layout.categoryNav.mode === "sidebar"}
      <aside class="collections" style:width={`${layout.sidebarWidth}px`} aria-label="Collections">
        <button class="crow" class:on={selected === null} aria-current={selected === null ? "true" : undefined} onclick={() => (selected = null)}>
          All
        </button>
        {#each shownCategories as category (category.id)}
          <button
            class="crow"
            class:on={selected === category.id}
            class:pinned={category.pinned}
            aria-current={selected === category.id ? "true" : undefined}
            onclick={() => (selected = category.id)}
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
          onselect={(id) => (selected = id)}
          onedit={() => (categoriesOpen = true)}
        />
        {/if}

        {#if library.ready && selected === null && settings.showContinue && continuing.length > 0 && query.trim() === ""}
          <section class="continue" aria-label="Continue reading">
            <h2>Continue reading</h2>
            <div class="strip">
              {#each continuing as row (row.seriesId)}
                <button class="cont" onclick={() => go(pathTo("read", row.seriesId, row.chapterId))}>
                  <Cover series={{ title: row.title, ...(row.cover === undefined ? {} : { cover: row.cover }) }} size="row" />
                  <span class="body">
                    <span class="t">{row.title}</span>
                    <span class="p">{row.chapterName === "" ? `page ${row.page + 1}` : `${row.chapterName} · page ${row.page + 1}`}</span>
                    <span class="go">Continue</span>
                  </span>
                </button>
              {/each}
            </div>
          </section>
        {/if}

        <div class="tools">
          <button class="btn ghost" onclick={() => (filterOpen = true)}>
            Filter{filterCount > 0 ? ` (${filterCount})` : ""}
          </button>
          <button class="btn ghost" onclick={() => (sortOpen = true)}>Sort · {SORT_LABELS[settings.librarySort]}</button>
          <button class="btn ghost" onclick={() => (displayOpen = true)}>Display</button>
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
        {/if}

        {#if !library.ready}
          <p class="empty">Opening the library…</p>
        {:else if rows.length === 0 && library.library.length === 0}
          <div class="blank">
            <p class="blankline">Your library is empty.</p>
            <p class="blanksub">Add a repository, install an extension, and the first series you keep lands here.</p>
            <div class="blankacts">
              <button class="btn primary" onclick={() => go("/extensions")}>Add a repository</button>
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
        <button class="btn ghost" disabled={selection.size === 0} onclick={() => void bulkRead(true)}>Read</button>
        <button class="btn ghost" disabled={selection.size === 0} onclick={() => void bulkRead(false)}>Unread</button>
        <button class="btn ghost" disabled={selection.size === 0} onclick={() => (categoriesOpen = true)}>Category</button>
        <button class="btn danger" disabled={selection.size === 0} onclick={() => void bulkRemove()}>Remove</button>
        <button class="btn ghost" onclick={() => (selection = null)}>Done</button>
      </div>
    </div>
  {/if}
</section>

<Sheet open={sortOpen} title="Sort by" onclose={() => (sortOpen = false)}>
  <div class="menu-list">
    {#each Object.entries(SORT_LABELS) as [id, label] (id)}
      <button
        class="menu-item"
        class:on={settings.librarySort === id}
        onclick={() => {
          settings.set("librarySort", id as typeof settings.librarySort);
          sortOpen = false;
        }}
      >
        <span>{label}</span>
        {#if settings.librarySort === id}<span aria-hidden="true">✓</span>{/if}
      </button>
    {/each}
  </div>
</Sheet>

<FilterSheet
  open={filterOpen}
  {filter}
  statuses={statusOptions}
  sources={sourceOptions}
  onclose={() => (filterOpen = false)}
  onapply={(next) => settings.set("libraryFilter", next)}
/>

<Sheet open={displayOpen} title="Display" onclose={() => (displayOpen = false)}>
  <div class="rows">
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

<Sheet open={categoriesOpen} title={selection === null ? "Categories" : "Add to category"} onclose={() => (categoriesOpen = false)}>
  {#if selection !== null}
    <p class="muted">{selection.size} series will be added to:</p>
    <div class="picklist">
      {#each categories.items as category (category.id)}
        <button class="chip" onclick={() => void bulkCategory(category.id)}>{category.name}</button>
      {/each}
      {#if categories.items.length === 0}
        <p class="empty">No categories yet.</p>
      {/if}
    </div>
  {:else}
    <CategoryRail
      {selected}
      onselect={(id) => {
        selected = id;
        categoriesOpen = false;
      }}
    />
  {/if}
</Sheet>

<style>
  .view {
    padding: var(--s4) var(--s4) var(--s6);
    max-width: 1200px;
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

  .continue {
    margin-bottom: var(--s5);
  }

  .continue h2 {
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
    margin-bottom: var(--s2);
  }

  .strip {
    display: flex;
    gap: var(--s2);
    overflow-x: auto;
  }

  .cont {
    all: unset;
    cursor: pointer;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: var(--s3);
    min-width: 208px;
    max-width: 268px;
    padding: var(--s3);
    border-radius: var(--r2);
    border: 1px solid var(--line);
    background: var(--surface);
  }

  .cont .body {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .cont .t {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cont .go {
    font-size: var(--t-xs);
    color: var(--accent);
  }

  .cont:hover {
    border-color: var(--line-strong);
  }

  .cont .t {
    font-size: var(--t-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cont .p {
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .cont .go {
    font-size: var(--t-xs);
    color: var(--accent);
    margin-top: var(--s1);
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

  .menu-list {
    display: grid;
    gap: 2px;
  }

  .menu-item {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    padding: var(--s3);
    border-radius: var(--r2);
    min-height: 44px;
    box-sizing: border-box;
    font-size: var(--t-md);
  }

  .menu-item:hover,
  .menu-item.on {
    background: var(--surface-2);
  }

  .picklist {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }
</style>
