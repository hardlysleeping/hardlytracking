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
  import type { Chapter, Series, Source } from "../api/source";
  import SeriesGrid from "../components/SeriesGrid.svelte";
  import BrowseDisplay from "../components/BrowseDisplay.svelte";
  import { downloads } from "../state/downloads.svelte";
  import SeriesActions from "../components/SeriesActions.svelte";
  import Cover from "../components/Cover.svelte";
  import { settings } from "../state/settings.svelte";
  import { isFresh, searchCacheKey, type CachedSearch } from "../lib/search/index";
  import { orderForPicker, pinnedSources, pruneSelection, seedSelection, togglePin } from "../lib/pinned";
  import { go, pathTo } from "../lib/nav";
  import { filterByLevel, levelOfSource } from "../lib/content/levels";
  import { languageLabel } from "../lib/language";
  import { chapterTitle } from "../lib/titles";
  import { mergeReadMarks, stillWanted } from "../lib/issues";
  import { orderChapters } from "../lib/chapter-order";
  import { hostOf, openExternal } from "../lib/external";

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
  /** The title whose quick actions are open, or null. */
  let actions = $state<Series | null>(null);
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

  // A source hidden by the content level cannot be searched either: hiding a list but not its
  // results would be the same content, one tap further in.
  const sources = $derived(
    filterByLevel(library.sources, (source) => levelOfSource(source.nsfw), settings.contentLevel, settings.adultDeclared),
  );

  /** Pinned sources, in the order the user pinned them, limited to what is actually installed. */
  const pinned = $derived(pinnedSources(sources, settings.pinnedSources));

  /** What the selector draws: the user's pinned sources first, then the rest by name. */
  const pickerOrder = $derived(orderForPicker(sources, settings.pinnedSources));

  /** What this device already has. A search result is a proposal; the library is the decision. */
  const saved = $derived(new Set(library.library.map((row) => row.id)));

  const rows = $derived(blocks.flatMap((block) => block.items));
  let bookSizes = $state<Map<string, number>>(new Map());
  $effect(() => {
    const store = library.profile?.store;
    if (store) void store.listBooks().then((books) => { bookSizes = new Map(books.map((book) => [book.seriesId, book.bytes])); });
  });
  const fileSizes = $derived.by(() => {
    const sizes = new Map<string, number>();
    for (const row of downloads.rows) if (row.bytes > 0) sizes.set(row.seriesId, (sizes.get(row.seriesId) ?? 0) + row.bytes);
    for (const [id, bytes] of bookSizes) sizes.set(id, bytes);
    return sizes;
  });

  $effect(() => {
    // Sources arrive after the first render (an extension has to be read, a server has to answer), and
    // one can also leave — the content level raised, an extension uninstalled. Ticking once and never
    // again left the selector showing chips with nothing chosen and no sentence saying why, which is
    // exactly what "poorly done" looks like.
    if (sources.length === 0) return;
    const kept = pruneSelection(chosen, sources);
    if (!picked) {
      picked = true;
      chosen = new Set(seedSelection(sources, settings.pinnedSources, settings.searchPinnedOnly));
      return;
    }
    // Only a *prune* rewrites the selection. When every ticked source has disappeared, fall back to
    // what a first visit would have picked; when the user pressed None, an empty selection is exactly
    // what they asked for and re-seeding it would be the app arguing with its own button.
    if (kept.size !== chosen.size) {
      chosen = kept.size === 0 ? new Set(seedSelection(sources, settings.pinnedSources, settings.searchPinnedOnly)) : kept;
    }
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

  // Opening a result must not scroll; the grid expands at the tapped row.
  const inLibrary = $derived(shown !== null && saved.has(shown.id));

  /**
   * The issues behind the opened card.
   *
   * Search used to answer "what is this?" and stop, so deciding whether a title is the one you want
   * meant leaving for the series page and coming back. The list belongs in the card: the numbers, how
   * many pages each has, which are read, and a tap that starts reading the one you picked.
   *
   * Fetched once per title and kept: reopening a card is instant, and flicking through six candidates
   * asks each source once.
   */
  let issues = $state<Chapter[]>([]);
  let issueState = $state<"idle" | "loading" | "ready" | "error">("idle");
  let issueError = $state("");
  const issueCache = new Map<string, Chapter[]>();
  /** Bumped per open, so a slow answer for a card you already left is dropped. */
  let issueToken = 0;
  let issueSeries = "";
  /** Long descriptions are clamped until asked for: the issues are why the card is open. */
  let descOpen = $state(false);
  /** Bumped by "Try again": a failed list is not cached, so asking again is the whole fix. */
  let issueAttempt = $state(0);
  /** A 221-issue collection is one card; drawing all 221 rows is not. */
  const ISSUE_PREVIEW = 40;
  let allIssues = $state(false);

  /**
   * The list as a reader looks at it: first issue first, not the host's order.
   *
   * An archive collection comes back lexicographic — N°1, N°10, N°100 — which reads as broken. The
   * series page always sorts and this must agree with it; `orderChapters` keeps unnumbered rows last
   * and ties stable.
   */
  const sortedIssues = $derived(orderChapters(issues, "oldest"));
  const listIssues = $derived(allIssues ? sortedIssues : sortedIssues.slice(0, ISSUE_PREVIEW));

  $effect(() => {
    const id = record?.id ?? null;
    void issueAttempt;
    if (id === null) {
      issues = [];
      issueState = "idle";
      return;
    }
    issueSeries = id;
    descOpen = false;
    allIssues = false;
    const cached = issueCache.get(id);
    if (cached !== undefined) {
      issues = cached;
      issueState = "ready";
      return;
    }
    issues = [];
    issueState = "loading";
    const mine = ++issueToken;
    void (async () => {
      try {
        const list = await library.chapters(id);
        // A provider that keeps its own read marks says so per chapter; ours live in prefs. Both
        // count, and neither clears the other — see `mergeReadMarks`.
        const rows = mergeReadMarks(list, (await library.profile?.store.listPrefs()) ?? []);
        issueCache.set(id, rows);
        if (!stillWanted(mine, issueToken)) return;
        issues = rows;
        issueState = "ready";
      } catch (error) {
        if (!stillWanted(mine, issueToken)) return;
        issueError = error instanceof Error ? error.message : String(error);
        issueState = "error";
      }
    })();
  });


</script>

{#snippet detailCard()}
  {#if record !== null}
    <div class="detail" aria-label={`${record.title} details`}>
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
        <section class="dissues" aria-label={`Issues of ${record.title}`}>
          <header class="dihead">
            <span>Issues</span>
            {#if issueState === "ready"}
              <span class="dicount">{issues.length}{issues.some((row) => !row.read) ? ` · ${issues.filter((row) => !row.read).length} unread` : ""}</span>
            {/if}
          </header>
          {#if issueState === "loading"}
            <p class="diempty muted">Asking {record.provider} for the issue list…</p>
          {:else if issueState === "error"}
            <p class="diempty muted">
              The issue list did not arrive ({issueError}).
              <button
                class="moredesc"
                onclick={() => {
                  if (record !== null) issueCache.delete(record.id);
                  issueAttempt += 1;
                }}>Try again</button
              >
            </p>
          {:else if issues.length === 0}
            <p class="diempty muted">This source lists no issues for this title.</p>
          {:else}
            <ul class="dilist">
              {#each listIssues as chapter (chapter.id)}
                <li>
                  <button
                    class="dirow"
                    class:read={chapter.read}
                    onclick={() => {
                      if (issueSeries !== record?.id) return;
                      go(pathTo("read", record!.id, chapter.id));
                    }}
                  >
                    <span class="diname">{chapterTitle(chapter)}</span>
                    <span class="disub">
                      {[chapter.pageCount > 0 ? `${chapter.pageCount} pages` : "", chapter.read ? "read" : ""]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <span class="dimark" aria-hidden="true">{chapter.read ? "✓" : "›"}</span>
                  </button>
                </li>
              {/each}
            </ul>
            {#if sortedIssues.length > ISSUE_PREVIEW}
              <button class="moredesc" onclick={() => (allIssues = !allIssues)}>
                {allIssues ? "Show fewer" : `Show all ${sortedIssues.length}`}
              </button>
            {/if}
          {/if}
        </section>
        <div class="dact">
          <button class="btn ghost" onclick={() => (actions = record)}>Read, keep, download…</button>
          {#if inLibrary}
            <button class="btn" onclick={() => go(pathTo("series", record.id))}>Open</button>
            <button class="btn ghost" onclick={() => void library.unsave(record.id)}>Remove from library</button>
          {:else}
            <button class="btn primary" onclick={() => void library.save(record)}>Save to library</button>
            <button class="btn ghost" onclick={() => go(pathTo("series", record.id))}>Open chapters</button>
          {/if}
        </div>
        {#if record.url !== undefined}
          <!-- Where it actually lives. A source that has a web page gets one link to it; an extension
               or a folder has none, so the line is simply absent rather than a dead button. -->
          <a
            class="dsrc"
            href={record.url}
            target="_blank"
            rel="noopener noreferrer"
            onclick={(event) => {
              event.preventDefault();
              void openExternal(record.url!);
            }}>Open on {hostOf(record.url)} ↗</a
          >
        {/if}
        {#if record.description !== undefined && record.description !== ""}
          <p class="ddesc" class:open={descOpen}>{record.description}</p>
          {#if record.description.length > 320}
            <button class="moredesc" onclick={() => (descOpen = !descOpen)}>
              {descOpen ? "Less" : "More"}
            </button>
          {/if}
        {:else if detailState === "loading"}
          <p class="ddesc muted">Reading the description from the source…</p>
        {:else if detailState === "error"}
          <p class="ddesc muted">The source did not answer with a description ({detailError}).</p>
        {:else}
          <p class="ddesc muted">This source gives no description for this title.</p>
        {/if}
      </div>
    </div>
  {/if}
{/snippet}

<section class="view">
  <!--
    The heading and the field are one pinned block: a search page whose field scrolls away is a page
    you have to scroll back up to use. `.pin` is sticky in `app.css`, together with every other
    view's heading, so the notch and the background are handled in one place.
  -->
  <div class="pin">
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
      disabled={pinned.length === 0}
      title={pinned.length === 0
        ? "Pin a source in the list below and a new search will start with it"
        : "New searches start with your pinned sources, not all sixty"}
      onclick={() => {
        const next = !settings.searchPinnedOnly;
        settings.set("searchPinnedOnly", next);
        if (next) chosen = new Set(pinned.map((source) => source.id));
      }}
    >
      Start with pinned{pinned.length > 0 ? ` (${pinned.length})` : ""}
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
  </div>

  <BrowseDisplay />
  <div class="picker">
    <span class="label">Sources · {chosen.size} of {sources.length} selected</span>
    <button class="chip" onclick={() => (chosen = new Set(sources.map((source) => source.id)))}>All</button>
    <button class="chip" onclick={() => (chosen = new Set())}>None</button>
    {#if pinned.length > 0}
      <button class="chip" class:on={chosen.size === pinned.length && pinned.every((s) => chosen.has(s.id))} onclick={() => (chosen = new Set(pinned.map((s) => s.id)))}>
        Pinned ({pinned.length})
      </button>
    {/if}
    <div class="chips">
      {#each pickerOrder as source (source.id)}
        <span class="pick" class:on={chosen.has(source.id)}>
          <button class="chip" class:on={chosen.has(source.id)} aria-pressed={chosen.has(source.id)} onclick={() => toggle(source.id)}>
            {source.name}{#if languageLabel(source.lang)}<span class="lang">{languageLabel(source.lang)}</span>{/if}
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

  <div class="stage">
    <div class="results">
      {#if notice !== ""}
        <p class="notice" role="status">{notice}</p>
      {/if}

      {#if blocks.length === 0}
        <p class="empty">
          {#if chosen.size === 0}
            No sources selected. Tap a source above — or All — and every one you tick answers on its own.
          {:else if settings.searchPinnedOnly && chosen.size === pinned.length && pinned.every((source) => chosen.has(source.id))}
            Searching your {pinned.length} pinned source{pinned.length === 1 ? "" : "s"}. Pin more, or tap All to widen it.
          {:else}
            {chosen.size} of {sources.length} sources selected. Type a title and press Search.
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
            <h2>{block.source.name}{#if languageLabel(block.source.lang)}<span class="lang">{languageLabel(block.source.lang)}</span>{/if}</h2>
            {#if block.state === "loading"}<span class="state">searching…</span>
            {:else if block.state === "error"}<span class="state bad">{block.error}</span>
            {:else}<span class="state">{block.items.length}</span>{/if}
          </header>
          {#if block.items.length > 0}
            <SeriesGrid
              saved={saved}
              series={block.items}
              cover={116}
              view={settings.libraryView}
              columns={settings.browseColumns}
              density={settings.browseDensity}
              horizontal={settings.browseHorizontal}
              sizes={fileSizes}
              empty=""
              current={shown?.id ?? null}
              selection={selectMode ? selected : null}
              onpick={(series) => show(series)}
              onlongpress={(series) => (actions = series)}
              onselect={(series) => toggleSelect(series.id)}
              expandAfter={record !== null && block.items.some((item) => item.id === record.id) ? record.id : null}
              expanded={record !== null ? detailCard : null}
            />
          {/if}
          {#if block.hasNext}
            <button class="btn more" onclick={() => void more(block)}>More from {block.source.name}</button>
          {/if}
        </section>
      {/each}
    </div>

  </div>

  <SeriesActions
    series={actions}
    onclose={() => (actions = null)}
    ondetails={(series) => {
      actions = null;
      go(pathTo("series", series.id));
    }}
  />

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

  .bar {
    display: flex;
    flex-wrap: wrap;
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
    min-width: 0;
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

  /* The opened card is drawn *inside* the result grid, in the row after its own tile, so the tiles
     after it move down and the search stays where it was. Nothing is covered by a pane and nothing
     is replaced by a full screen. */

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
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    border: 1px solid var(--line-strong);
    border-radius: var(--r3);
    background: var(--surface);
    overflow: hidden;
    /* It grows where the tile was; a still grid with the answer drawn somewhere else is the thing
       this replaced. Reduced motion gets the card without the movement. */
    animation: open-card 160ms ease-out;
  }

  @keyframes open-card {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .detail {
      animation: none;
    }
  }

  /* A long description scrolls inside the card rather than making the grid a mile long. */
  .dscroll {
    max-height: 70dvh;
    overflow: auto;
  }

  /* The issue list in the card: the numbers are the reason you opened it. */
  .dissues {
    margin-top: var(--s4);
    border-top: 1px solid var(--line);
    padding-top: var(--s3);
  }

  .dihead {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    font-size: var(--t-xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-2);
    margin-bottom: var(--s2);
  }

  .dicount {
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
    color: var(--text-3);
  }

  .dilist {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .dirow {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: var(--s2);
    width: 100%;
    padding: var(--s2) var(--s2);
    border: 0;
    border-radius: var(--r1);
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }

  .dirow:hover {
    background: var(--surface-2);
  }

  .dirow.read .diname {
    color: var(--text-2);
  }

  .diname {
    font-size: var(--t-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .disub {
    font-size: var(--t-xs);
    color: var(--text-3);
    white-space: nowrap;
  }

  .dimark {
    font-size: var(--t-sm);
    color: var(--text-3);
    width: 1em;
    text-align: center;
  }

  .dirow.read .dimark {
    color: var(--accent);
  }

  .diempty {
    margin: 0;
    font-size: var(--t-sm);
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

  /* The cover is an aid, not the answer: capped so the title and the issue list are on screen the
     moment the card opens, instead of after a scroll through artwork. */
  .dcover {
    margin-bottom: var(--s3);
    height: 200px;
    overflow: hidden;
    border-radius: var(--r2);
  }

  .dcover :global(img) {
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: left center;
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
    margin: var(--s3) 0 0;
    font-size: var(--t-sm);
    line-height: 1.5;
    color: var(--text-2);
    white-space: pre-line;
    /* Six lines of blurb; the issues above it must be reachable. The card scrolls — three nested
       scrollers under one finger was the alternative. */
    display: -webkit-box;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .ddesc.open {
    -webkit-line-clamp: unset;
    line-clamp: unset;
    overflow: visible;
  }

  .dsrc {
    display: inline-block;
    margin-top: var(--s2);
    font-size: var(--t-xs);
    color: var(--text-3);
    text-decoration: none;
  }

  .dsrc:hover {
    color: var(--text);
  }

  .moredesc {
    margin-top: var(--s1);
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font-size: var(--t-xs);
    cursor: pointer;
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
    flex-wrap: wrap;
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
    /* On a phone the card is still in the grid — it *is* the tile that opened, grown — so the
       results above and below it stay on screen instead of being covered. */
    .detail {
      border-radius: var(--r2);
    }

    .dscroll {
      max-height: 76dvh;
      padding-bottom: var(--s3);
    }
  }
</style>
