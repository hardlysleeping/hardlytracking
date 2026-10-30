<script lang="ts">
  /**
   * Global search: one query, several sources, results as they arrive.
   *
   * Each source is fired independently and painted the moment it answers, so a slow or broken
   * extension costs its own block and nothing else. There is no "waiting for all" state — that is
   * exactly the freeze the plan says must not happen.
   */
  import { library } from "../state/library.svelte";
  import { providerFor } from "../api/registry";
  import type { Series, Source } from "../api/source";
  import SeriesGrid from "../components/SeriesGrid.svelte";
  import { settings } from "../state/settings.svelte";
  import { pinnedSources, togglePin } from "../lib/pinned";

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

  const sources = $derived(library.sources);

  /** Pinned sources, in the order the user pinned them, limited to what is actually installed. */
  const pinned = $derived(pinnedSources(sources, settings.pinnedSources));

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
    const pickedSources = sources.filter((source) => chosen.has(source.id));
    blocks = pickedSources.map((source) => ({ source, state: "loading", items: [], hasNext: false, page: 1 }));

    await Promise.all(
      pickedSources.map(async (source) => {
        try {
          const result = await providerFor(library.profile!.providers, source.id).search(source.id, needle, 1);
          if (mine !== token) return;
          blocks = blocks.map((block) =>
            block.source.id === source.id ? { ...block, state: "done", items: result.items, hasNext: result.hasNext } : block,
          );
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
</script>

<section class="view">
  <header class="bar">
    <h1>Search</h1>
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

  {#if blocks.length === 0}
    <p class="empty">
      {#if settings.searchPinnedOnly && pinned.length > 0}
        Searching your {pinned.length} pinned source{pinned.length === 1 ? "" : "s"}. Pin more, or tap All to widen it.
      {:else}
        Pick sources and search. Each one answers on its own.
      {/if}
    </p>
  {:else if !running}
    <p class="summary">{found} result{found === 1 ? "" : "s"} across {blocks.length} source{blocks.length === 1 ? "" : "s"}</p>
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
        <SeriesGrid series={block.items} cover={116} empty="" />
      {/if}
      {#if block.hasNext}
        <button class="btn more" onclick={() => void more(block)}>More from {block.source.name}</button>
      {/if}
    </section>
  {/each}
</section>

<style>
  .view {
    padding: var(--s4) var(--s4) var(--s7);
    max-width: 1100px;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding-top: var(--safe-t);
    margin-bottom: var(--s3);
    min-height: 36px;
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
</style>
