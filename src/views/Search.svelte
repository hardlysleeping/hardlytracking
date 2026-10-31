<script lang="ts">
  /**
   * Global search: one query, several sources, results as they arrive.
   *
   * Each source is fired independently and painted the moment it answers, so a slow or broken
   * extension costs its own block and nothing else. There is no "waiting for all" state — that is
   * exactly the freeze the plan says must not happen.
   *
   * A result opens **here**, the way HardlyReading's search does it: the grid narrows and the title's
   * own pane appears beside it (a full screen over the results on a phone), so looking at five
   * candidates is five clicks, not five round trips through the series page and Back. The series page
   * is still one button away inside the pane — it is where chapters live, not where you decide.
   */
  import { library } from "../state/library.svelte";
  import { providerFor } from "../api/registry";
  import type { Series, Source } from "../api/source";
  import SeriesGrid from "../components/SeriesGrid.svelte";
  import Cover from "../components/Cover.svelte";
  import { settings } from "../state/settings.svelte";
  import { isFresh, searchCacheKey, type CachedSearch } from "../lib/search/index";
  import { pinnedSources, togglePin } from "../lib/pinned";
  import { go, pathTo } from "../lib/nav";

  interface Props {
    initial?: string | null;
  }
  let { initial = null }: Props = $props();

  interface Block {
    source: Source;
    state: "loading" | "done" | "error";
    items: Series[];
    error?: string;
    hasNext: boolean;
    page: number;
  }

  let query = $state(initial ?? "");
  let blocks = $state<Block[]>([]);
  let chosen = $state<Set<string>>(new Set());
  let picked = $state(false);
  let running = $state(false);
  /** Bumped per run, so a late answer from a previous query is dropped rather than painted. */
  let token = 0;

  /** The result whose pane is open, and the fuller version once the source has answered. */
  let shown = $state<Series | null>(null);
  let detailed = $state<Series | null>(null);
  let detailState = $state<"idle" | "loading" | "error">("idle");
  let detailError = $state("");
  /** Details already fetched, so reopening a pane is instant and never asks twice. */
  const details = new Map<string, Series>();

  /** Select mode: a tick on a card, and one button that files them all. */
  let selectMode = $state(false);
  let selected = $state<Set<string>>(new Set());
  let saving = $state(false);
  let notice = $state("");

  const sources = $derived(library.sources);

  /** Pinned sources, in the order the user pinned them, limited to what is actually installed. */
  const pinned = $derived(pinnedSources(sources, settings.pinnedSources));

  /** What this device already has. A search result is a proposal; the library is the decision. */
  const saved = $derived(new Set(library.library.map((row) => row.id)));

  const rows = $derived(blocks.flatMap((block) => block.items));

  $effect(() => {
    // First visit: pinned sources when the user has any (Komikku's rule), otherwise the first dozen —
    // sixty sources at once is a hammer, not a search.
    if (picked || sources.length === 0) return;
    picked = true;
    chosen = new Set(
      settings.searchPinnedOnly && pinned.length > 0 ? pinned.map((source) => source.id) : sources.slice(0, 12).map((source) => source.id),
    );
  });

  function pin(id: string): void {
    settings.set("pinnedSources", togglePin(settings.pinnedSources, id));
  }

  $effect(() => {
    if (initial !== null && initial !== "" && blocks.length === 0 && !running) void run();
  });

  function toggle(id: string): void {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    chosen = next;
  }

  async function run(): Promise<void> {
    const needle = query.trim();
    if (needle === "" || library.profile === null) return;
    const mine = ++token;
    running = true;
    notice = "";
    const pickedSources = sources.filter((source) => chosen.has(source.id));
    blocks = pickedSources.map((source) => ({ source, state: "loading", items: [], hasNext: false, page: 1 }));

    // What this device already answered for this query paints immediately — a repeat search is
    // instant, and with no network it still shows the last answer instead of an error.
    const store = library.profile.store;
    await Promise.all(
      pickedSources.map(async (source) => {
        const cached = await store.getSearchCache<CachedSearch>(searchCacheKey(source.id, needle));
        if (cached === undefined || !isFresh(cached)) return;
        if (mine !== token) return;
        blocks = blocks.map((block) =>
          block.source.id === source.id ? { ...block, state: "done", items: cached.items, hasNext: false } : block,
        );
      }),
    );

    await Promise.all(
      pickedSources.map(async (source) => {
        try {
          const result = await providerFor(library.profile!.providers, source.id).search(source.id, needle, 1);
          if (mine !== token) return;
          blocks = blocks.map((block) =>
            block.source.id === source.id ? { ...block, state: "done", items: result.items, hasNext: result.hasNext } : block,
          );
          void store.putSearchCache(searchCacheKey(source.id, needle), {
            key: searchCacheKey(source.id, needle),
            sourceId: source.id,
            query: needle,
            items: result.items,
            at: Date.now(),
          } satisfies CachedSearch);
        } catch (error) {
          if (mine !== token) return;
          blocks = blocks.map((block) =>
            block.source.id === source.id
              ? { ...block, state: "error", error: error instanceof Error ? error.message : String(error) }
              : block,
          );
        }
      }),
    );
    if (mine === token) running = false;
  }

  async function more(block: Block): Promise<void> {
    if (library.profile === null) return;
    const next = block.page + 1;
    blocks = blocks.map((row) => (row.source.id === block.source.id ? { ...row, state: "loading" } : row));
    try {
      const result = await providerFor(library.profile.providers, block.source.id).search(block.source.id, query.trim(), next);
      blocks = blocks.map((row) =>
        row.source.id === block.source.id
          ? { ...row, state: "done", items: [...row.items, ...result.items], hasNext: result.hasNext, page: next }
          : row,
      );
    } catch (error) {
      blocks = blocks.map((row) =>
        row.source.id === block.source.id ? { ...row, state: "error", error: error instanceof Error ? error.message : String(error) } : row,
      );
    }
  }

  const found = $derived(blocks.reduce((sum, block) => sum + block.items.length, 0));

  /**
   * Open a result's pane, and ask the source for the whole record.
   *
   * A search row carries a title and a cover; the description, the author and the status live behind
   * `details()`. The pane paints from the row first and fills in when the answer arrives, so it never
   * sits blank waiting on a source — and a source that refuses to answer is a muted line, not an
   * empty panel.
   */
  function show(series: Series): void {
    if (selectMode) {
      toggleSelect(series.id);
      return;
    }
    shown = series;
    detailed = details.get(series.id) ?? null;
    detailError = "";
    const cached = details.get(series.id);
    if (cached !== undefined) {
      detailState = "idle";
      return;
    }
    detailState = "loading";
    if (library.profile === null) return;
    const wanted = series.id;
    void providerFor(library.profile.providers, wanted)
      .details(wanted)
      .then((full) => {
        details.set(wanted, full);
        if (shown?.id !== wanted) return;
        detailed = full;
        detailState = "idle";
      })
      .catch((error: unknown) => {
        if (shown?.id !== wanted) return;
        detailState = "error";
        detailError = error instanceof Error ? error.message : String(error);
      });
  }

  function close(): void {
    shown = null;
    detailed = null;
    detailState = "idle";
    detailError = "";
  }

  function toggleSelect(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  function setSelectMode(on: boolean): void {
    selectMode = on;
    if (!on) selected = new Set();
    if (on) close();
  }

  async function saveSelected(): Promise<void> {
    const ids = [...selected];
    if (ids.length === 0 || saving) return;
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const fresh = ids.filter((id) => !saved.has(id));
    const already = ids.length - fresh.length;
    saving = true;
    let savedCount = 0;
    const failures: string[] = [];
    for (const id of fresh) {
      const row = rowsById.get(id);
      if (row === undefined) continue;
      try {
        await library.save(row);
        savedCount += 1;
      } catch (error) {
        failures.push(`${row.title}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    saving = false;
    selected = new Set();
    const bits: string[] = [];
    if (savedCount > 0) bits.push(`${savedCount} added to your library`);
    if (already > 0) bits.push(`${already} already there`);
    if (failures.length > 0) bits.push(failures.join(" · "));
    notice = bits.join(" · ") || "Nothing to add";
  }

  /** The pane's record: the fuller one when it has arrived, the search row until then. */
  const record = $derived(detailed ?? shown);
  const inLibrary = $derived(shown !== null && saved.has(shown.id));
</script>

<section class="view" class:split={shown !== null}>
  <header class="bar">
    <h1>Search</h1>
    <button
      class="chip"
      class:on={selectMode}
      aria-pressed={selectMode}
      title={selectMode ? "Done ticking results" : "Tick several results and save them together"}
      onclick={() => setSelectMode(!selectMode)}
    >
      {selectMode ? "Done" : "Select"}
    </button>
    <button
      class="chip pinnedonly"
      class:on={settings.searchPinnedOnly}
      aria-pressed={settings.searchPinnedOnly}
      title="New searches start with your pinned sources"
      onclick={() => {
        const next = !settings.searchPinnedOnly;
        settings.set("searchPinnedOnly", next);
        if (next && pinned.length > 0) chosen = new Set(pinned.map((source) => source.id));
      }}
    >
      Pinned only
    </button>
  </header>

  <form
    class="search"
    onsubmit={(event) => {
      event.preventDefault();
      void run();
    }}
  >
    <input class="field" type="search" placeholder="One title, every source" bind:value={query} aria-label="Search every selected source" />
    <button class="btn primary" type="submit" disabled={running || chosen.size === 0}>{running ? "Searching…" : "Search"}</button>
  </form>

  <div class="picker">
    <span class="label">Sources ({chosen.size})</span>
    <button class="chip" onclick={() => (chosen = new Set(sources.map((source) => source.id)))}>All</button>
    <button class="chip" onclick={() => (chosen = new Set())}>None</button>
    {#if pinned.length > 0}
      <button class="chip" class:on={chosen.size === pinned.length && pinned.every((s) => chosen.has(s.id))} onclick={() => (chosen = new Set(pinned.map((s) => s.id)))}>
        Pinned ({pinned.length})
      </button>
    {/if}
    <div class="chips">
      {#each sources as source (source.id)}
        <span class="pick" class:on={chosen.has(source.id)}>
          <button class="chip" class:on={chosen.has(source.id)} aria-pressed={chosen.has(source.id)} onclick={() => toggle(source.id)}>
            {source.name}{#if source.lang}<span class="lang">{source.lang}</span>{/if}
          </button>
          <button
            class="pinbtn"
            class:pinned={settings.pinnedSources.includes(source.id)}
            aria-label={settings.pinnedSources.includes(source.id) ? `Unpin ${source.name}` : `Pin ${source.name}`}
            aria-pressed={settings.pinnedSources.includes(source.id)}
            title={settings.pinnedSources.includes(source.id) ? "Unpin" : "Pin"}
            onclick={() => pin(source.id)}
          >
            <svg viewBox="0 0 24 24"><path d="M9 4h6l-1 5 3 3H7l3-3zM12 12v8" /></svg>
          </button>
        </span>
      {/each}
    </div>
  </div>

  <div class="stage" class:split={shown !== null}>
    <div class="results">
      {#if notice !== ""}
        <p class="notice" role="status">{notice}</p>
      {/if}

      {#if blocks.length === 0}
        <p class="empty">
          {#if settings.searchPinnedOnly && pinned.length > 0}
            Searching your {pinned.length} pinned source{pinned.length === 1 ? "" : "s"}. Pin more, or tap All to widen it.
          {:else}
            Pick sources and search. Each one answers on its own.
          {/if}
        </p>
      {:else if !running}
        <p class="summary">
          {found} result{found === 1 ? "" : "s"} across {blocks.length} source{blocks.length === 1 ? "" : "s"}
          {#if selectMode}· tick what you want{/if}
        </p>
      {/if}

      {#each blocks as block (block.source.id)}
        <section class="block">
          <header>
            <h2>{block.source.name}{#if block.source.lang}<span class="lang">{block.source.lang}</span>{/if}</h2>
            {#if block.state === "loading"}<span class="state">searching…</span>
            {:else if block.state === "error"}<span class="state bad">{block.error}</span>
            {:else}<span class="state">{block.items.length}</span>{/if}
          </header>
          {#if block.items.length > 0}
            <SeriesGrid
              series={block.items}
              cover={116}
              empty=""
              current={shown?.id ?? null}
              selection={selectMode ? selected : null}
              onpick={(series) => show(series)}
              onselect={(series) => toggleSelect(series.id)}
            />
          {/if}
          {#if block.hasNext}
            <button class="btn more" onclick={() => void more(block)}>More from {block.source.name}</button>
          {/if}
        </section>
      {/each}
    </div>

    {#if record !== null}
      <aside class="detail" aria-label={`${record.title} details`}>
        <div class="dhead">
          <span class="dkind">{record.provider}</span>
          <span class="sp"></span>
          <button class="dclose" onclick={close} title="Close" aria-label="Close">✕</button>
        </div>
        <div class="dscroll">
          <div class="dcover"><Cover series={record} size="hero" /></div>
          <h3>{record.title}</h3>
          <div class="dmeta">
            {#if record.author}<span>{record.author}</span>{/if}
            {#if record.status}<span class="pill">{record.status}</span>{/if}
            {#if inLibrary}<span class="pill saved">In your library</span>{/if}
          </div>
          {#if record.description !== undefined && record.description !== ""}
            <p class="ddesc">{record.description}</p>
          {:else if detailState === "loading"}
            <p class="ddesc muted">Reading the description from the source…</p>
          {:else if detailState === "error"}
            <p class="ddesc muted">The source did not answer with a description ({detailError}).</p>
          {:else}
            <p class="ddesc muted">This source gives no description for this title.</p>
          {/if}
          <div class="dact">
            {#if inLibrary}
              <button class="btn" onclick={() => go(pathTo("series", record.id))}>Open</button>
              <button class="btn ghost" onclick={() => void library.unsave(record.id)}>Remove from library</button>
            {:else}
              <button class="btn primary" onclick={() => void library.save(record)}>Save to library</button>
              <button class="btn ghost" onclick={() => go(pathTo("series", record.id))}>Open chapters</button>
            {/if}
          </div>
        </div>
      </aside>
    {/if}
  </div>

  {#if selectMode}
    <div class="selbar">
      <span class="selcount">{selected.size === 0 ? "Tick the results you want" : `${selected.size} selected`}</span>
      <button class="btn ghost" onclick={() => (selected = new Set())} disabled={selected.size === 0}>Clear</button>
      <button class="btn primary" onclick={() => void saveSelected()} disabled={selected.size === 0 || saving}>
        {saving ? "Saving…" : `Save ${selected.size === 0 ? "" : selected.size} to library`}
      </button>
    </div>
  {/if}
</section>

<style>
  .view {
    padding: var(--s4) var(--s4) var(--s7);
    max-width: 1100px;
  }

  .view.split {
    max-width: 1400px;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-bottom: var(--s3);
    min-height: 36px;
  }

  .bar h1 {
    margin-right: auto;
  }

  .bar svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  h1 {
    font-size: var(--t-xl);
    font-weight: 650;
  }

  .search {
    display: flex;
    gap: var(--s2);
    margin-bottom: var(--s3);
  }

  .search .field {
    flex: 1;
    min-height: 40px;
  }

  .picker {
    display: grid;
    gap: var(--s2);
    margin-bottom: var(--s4);
  }

  .label {
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
  }

  .chips {
    display: flex;
    gap: var(--s2);
    flex-wrap: wrap;
    max-height: 132px;
    overflow-y: auto;
  }

  .lang {
    margin-left: 5px;
    font-size: 10px;
    text-transform: uppercase;
    color: var(--text-3);
  }

  .summary {
    margin: 0 0 var(--s4);
    font-size: var(--t-sm);
    color: var(--text-2);
  }

  .notice {
    margin: 0 0 var(--s3);
    padding: var(--s2) var(--s3);
    border-radius: var(--r2);
    background: var(--surface-2);
    font-size: var(--t-sm);
    color: var(--text-2);
  }

  /* The split: the grid narrows and the pane sits beside it, so choosing between results never
     leaves the search. Below 940px there is no room for two columns and the pane becomes the
     screen instead — same idea, phone shape. */
  .stage.split {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);
    gap: var(--s4);
    align-items: start;
  }

  .block {
    margin-bottom: var(--s6);
  }

  .block header {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    margin-bottom: var(--s2);
    padding-bottom: var(--s1);
    border-bottom: 1px solid var(--line);
  }

  h2 {
    font-size: var(--t-md);
    font-weight: 600;
  }

  .state {
    font-size: var(--t-xs);
    color: var(--text-3);
    margin-left: auto;
  }

  .state.bad {
    color: var(--danger);
  }

  .more {
    margin-top: var(--s3);
  }

  .detail {
    position: sticky;
    top: var(--s3);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    max-height: calc(100dvh - var(--s7));
    border: 1px solid var(--line);
    border-radius: var(--r3);
    background: var(--surface);
    overflow: hidden;
  }

  .dhead {
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding: var(--s2) var(--s3);
    border-bottom: 1px solid var(--line);
  }

  .dkind {
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
  }

  .sp {
    flex: 1;
  }

  .dclose {
    all: unset;
    cursor: pointer;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--text-2);
  }

  .dclose:hover {
    background: var(--surface-2);
  }

  .dscroll {
    overflow-y: auto;
    padding: var(--s3);
  }

  .dcover {
    margin-bottom: var(--s3);
  }

  .detail h3 {
    margin: 0 0 var(--s2);
    font-size: var(--t-lg);
    font-weight: 650;
    line-height: 1.25;
  }

  .dmeta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s2);
    margin-bottom: var(--s3);
    font-size: var(--t-sm);
    color: var(--text-2);
  }

  .pill {
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--line);
    font-size: var(--t-xs);
    color: var(--text-2);
  }

  .pill.saved {
    border-color: var(--accent);
    color: var(--accent);
  }

  .ddesc {
    margin: 0 0 var(--s4);
    font-size: var(--t-sm);
    line-height: 1.5;
    color: var(--text-2);
    white-space: pre-line;
  }

  .ddesc.muted {
    color: var(--text-3);
    font-style: italic;
  }

  .dact {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }

  .selbar {
    position: sticky;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-top: var(--s4);
    padding: var(--s2) var(--s3) calc(var(--s2) + var(--safe-b));
    border-top: 1px solid var(--line);
    background: var(--surface);
  }

  .selcount {
    margin-right: auto;
    font-size: var(--t-sm);
    color: var(--text-2);
  }

  @media (max-width: 939px) {
    .stage.split {
      display: block;
    }

    .detail {
      position: fixed;
      inset: 0;
      z-index: 40;
      max-height: none;
      border: 0;
      border-radius: 0;
      padding-top: var(--safe-t);
    }

    .dscroll {
      padding-bottom: calc(var(--s6) + var(--safe-b));
    }
  }
</style>
