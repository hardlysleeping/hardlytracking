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
  import CategoryRail from "../components/CategoryRail.svelte";
  import SeriesGrid from "../components/SeriesGrid.svelte";
  import Sheet from "../components/Sheet.svelte";
  import { go, pathTo } from "../lib/nav";
  import { applyView, visibleCategories } from "../lib/categories";
  import type { Series } from "../api/source";

  let { current = null }: { current?: string | null } = $props();

  /** Which category the rail is pointing at; `null` is the whole library. */
  let selected = $state<string | null>(null);
  let query = $state("");
  let searching = $state(false);
  let filterOpen = $state(false);
  let sortOpen = $state(false);
  let categoriesOpen = $state(false);

  /** filter sheet state, applied when the sheet closes with Apply */
  let onlyUnread = $state(false);
  let onlySource = $state<string | null>(null);

  let selection = $state<Set<string> | null>(null);
  let busy = $state<string | null>(null);

  const visible = $derived(
    applyView(
      library.library.map((series) => ({ ...series, categoryIds: series.categoryIds ?? [] })),
      categories.items,
      { hiddenView: categories.hiddenView, pinView: categories.pinView },
    ),
  );

  /** The chips obey the eye, exactly as the rail does. */
  const shownCategories = $derived(visibleCategories(categories.items, categories.hiddenView));

  const SORT_LABELS = { title: "Title", recent: "Recently read", source: "Source" } as const;

  const VIEWS = [
    { id: "grid", icon: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" },
    { id: "compact", icon: "M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4zM10 10h4v4h-4zM16 10h4v4h-4z" },
    { id: "list", icon: "M4 6h16M4 12h16M4 18h16" },
  ] as const;

  /** Unread per series, from one pass over the mirrored chapters and one over the read marks. */
  let unread = $state(new Map<string, number>());
  let readOrder = $state(new Map<string, number>());

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
    const counts = new Map<string, number>();
    for (const chapter of chapters) {
      if (chapter.read || read.has(chapter.id)) continue;
      counts.set(chapter.seriesId, (counts.get(chapter.seriesId) ?? 0) + 1);
    }
    unread = counts;
    readOrder = new Map(positions.map((row, index) => [row.seriesId, positions.length - index]));
  }

  $effect(() => {
    if (library.profile === null) return;
    void recount();
  });

  /** Continue reading, newest first — the shortcut back into a book. */
  let continuing = $state<Array<{ seriesId: string; chapterId: string; page: number; title: string }>>([]);
  $effect(() => {
    if (library.profile === null) return;
    void library.continueReading().then((rows) => (continuing = rows));
  });

  const sources = $derived([...new Set(library.library.map((series) => series.provider))]);

  const rows = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    let list = visible.filter((series) => {
      if (selected !== null && !(series.categoryIds ?? []).includes(selected)) return false;
      if (onlySource !== null && series.provider !== onlySource) return false;
      if (onlyUnread && (unread.get(series.id) ?? 0) === 0) return false;
      if (needle !== "" && !`${series.title} ${series.author ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    if (settings.librarySort === "title") {
      list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    } else if (settings.librarySort === "recent") {
      list = [...list].sort((a, b) => (readOrder.get(b.id) ?? 0) - (readOrder.get(a.id) ?? 0));
    } else {
      list = [...list].sort((a, b) => a.provider.localeCompare(b.provider) || a.title.localeCompare(b.title));
    }
    return list;
  });

  const emptyMessage = $derived.by(() => {
    if (library.library.length === 0) return "Your library is empty.";
    if (query.trim() !== "") return `Nothing matches “${query.trim()}”.`;
    if (selected !== null) return "Nothing in this category yet.";
    if (onlyUnread || onlySource !== null) return "Nothing matches these filters.";
    if (categories.hiddenView === "only") return "No hidden category has anything in it.";
    return "Every row here is filed under a hidden category. Reveal it in Categories to see them.";
  });

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
  <header class="top">
    <div class="titles">
      <h1>Library</h1>
      {#if library.library.length > 0}
        <span class="count">{rows.length}{rows.length !== library.library.length ? ` of ${library.library.length}` : ""}</span>
      {/if}
    </div>
    {#if library.library.length > 0}
    <div class="acts">
      <button class="btn ghost icon" aria-label="Search the library" aria-pressed={searching} onclick={() => (searching = !searching)}>
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
      </button>
      <button class="btn ghost icon" aria-label="Select series" aria-pressed={selection !== null} onclick={toggleSelection}>
        <svg viewBox="0 0 24 24"><path d="M4 7h10M4 12h10M4 17h7M17 15l2 2 3-3" /></svg>
      </button>
      <button class="btn ghost icon" aria-label="Refresh" onclick={() => void library.refreshLibrary().then(recount)}>
        <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" /></svg>
      </button>
    </div>
    {/if}
  </header>

  {#if searching}
    <input
      class="field search"
      type="search"
      placeholder="Search this library"
      bind:value={query}
      aria-label="Search this library"
    />
  {/if}

  {#if library.library.length > 0}
  <div class="chips" role="tablist" aria-label="Categories">
    <button class="chip" class:on={selected === null} role="tab" aria-selected={selected === null} onclick={() => (selected = null)}>
      All
    </button>
    {#each shownCategories as category (category.id)}
      <button
        class="chip"
        class:on={selected === category.id}
        class:pinned={category.pinned}
        role="tab"
        aria-selected={selected === category.id}
        onclick={() => (selected = category.id)}
      >
        {category.name}
      </button>
    {/each}
    <button class="chip" onclick={() => (categoriesOpen = true)}>Categories…</button>
  </div>

  <div class="tools">
    <button class="btn ghost" onclick={() => (filterOpen = true)}>
      Filter{onlyUnread || onlySource !== null ? " •" : ""}
    </button>
    <button class="btn ghost" onclick={() => (sortOpen = true)}>Sort · {SORT_LABELS[settings.librarySort]}</button>
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
  {/if}

  {#if !library.ready}
    <p class="empty">Opening the library…</p>
  {:else}
    {#if selected === null && settings.showContinue && continuing.length > 0 && query.trim() === ""}
      <section class="continue" aria-label="Continue reading">
        <h2>Continue reading</h2>
        <div class="strip">
          {#each continuing as row (row.seriesId)}
            <button class="cont" onclick={() => go(pathTo("read", row.seriesId, row.chapterId))}>
              <span class="t">{row.title}</span>
              <span class="p">page {row.page + 1}</span>
              <span class="go">Continue</span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    {#if rows.length === 0 && library.library.length === 0}
      <div class="blank">
        <p class="blankline">Your library is empty.</p>
        <p class="blanksub">Add a repository, install an extension, and the first series you keep lands here.</p>
        <div class="blankacts">
          <button class="btn primary" onclick={() => go("/extensions")}>Add a repository</button>
          <button class="btn" onclick={() => go("/browse")}>Browse sources</button>
        </div>
      </div>
    {:else}
      <SeriesGrid
        series={rows}
        view={settings.libraryView}
        cover={settings.coverSize}
        empty={emptyMessage}
        {current}
        {selection}
        {unread}
        onselect={onSelect}
        onlongpress={(series) => {
          selection = new Set([series.id]);
        }}
      />
    {/if}
  {/if}

  {#if selection !== null}
    <div class="selection" role="toolbar" aria-label="Selection actions">
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

<Sheet open={filterOpen} title="Filter" onclose={() => (filterOpen = false)}>
  <div class="rows">
    <label class="row">
      <span>Only unread</span>
      <input type="checkbox" bind:checked={onlyUnread} />
    </label>
    <label class="row">
      <span>Source</span>
      <select class="field" value={onlySource ?? ""} onchange={(event) => (onlySource = event.currentTarget.value === "" ? null : event.currentTarget.value)}>
        <option value="">Any source</option>
        {#each sources as source (source)}
          <option value={source}>{source}</option>
        {/each}
      </select>
    </label>
    <label class="row">
      <span>Cover size</span>
      <input type="range" min="96" max="200" step="4" value={settings.coverSize} oninput={(event) => settings.set("coverSize", Number(event.currentTarget.value))} />
    </label>
    <label class="row">
      <span>Show “Continue reading”</span>
      <input type="checkbox" checked={settings.showContinue} onchange={(event) => settings.set("showContinue", event.currentTarget.checked)} />
    </label>
  </div>
</Sheet>

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

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    padding-top: var(--safe-t);
    margin-bottom: var(--s3);
  }

  .titles {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    min-width: 0;
  }

  h1 {
    font-size: var(--t-2xl);
    font-weight: 650;
  }

  .count {
    font-size: var(--t-sm);
    color: var(--text-3);
  }

  .acts {
    display: flex;
    gap: 2px;
  }

  .acts svg,
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

  .search {
    width: 100%;
    margin-bottom: var(--s3);
    min-height: 38px;
  }

  .chips {
    display: flex;
    gap: var(--s2);
    overflow-x: auto;
    padding-bottom: var(--s1);
    margin-bottom: var(--s3);
    scrollbar-width: none;
  }

  .chips::-webkit-scrollbar {
    display: none;
  }

  .chip.pinned {
    border-color: color-mix(in srgb, var(--tone-pinned) 55%, var(--line));
    color: var(--text-1);
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
    gap: 1px;
    min-width: 168px;
    max-width: 240px;
    padding: var(--s3);
    border-radius: var(--r2);
    border: 1px solid var(--line);
    background: var(--surface);
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
