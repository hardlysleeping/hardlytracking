<script lang="ts">
  /**
   * One source: popular, latest, search, and more pages.
   *
   * The same component whether it is the whole screen on a phone or the right-hand pane of a
   * desktop split — it asks the provider for pages and draws a grid, and knows nothing about
   * where it sits.
   */
  import { library } from "../state/library.svelte";
  import { providerFor } from "../api/registry";
  import type { Series } from "../api/source";
  import SeriesGrid from "../components/SeriesGrid.svelte";
  import { go } from "../lib/nav";

  interface Props {
    sourceId: string;
    embedded?: boolean;
  }
  let { sourceId, embedded = false }: Props = $props();

  let mode = $state<"popular" | "latest" | "search">("popular");
  let query = $state("");
  let items = $state<Series[]>([]);
  let hasNext = $state(false);
  let page = $state(1);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const source = $derived(library.sources.find((row) => row.id === sourceId) ?? null);

  $effect(() => {
    // A new source resets the grid: keeping the old rows while the next fetch runs is how a
    // screen ends up showing one source's results under another source's name.
    void sourceId;
    items = [];
    page = 1;
    mode = "popular";
    query = "";
    void run(1);
  });

  async function run(next = 1): Promise<void> {
    if (library.profile === null) return;
    if (mode === "search" && query.trim() === "") return;
    busy = true;
    error = null;
    try {
      const provider = providerFor(library.profile.providers, sourceId);
      const result =
        mode === "popular"
          ? await provider.popular(sourceId, next)
          : mode === "latest"
            ? await provider.latest(sourceId, next)
            : await provider.search(sourceId, query.trim(), next);
      items = next === 1 ? result.items : [...items, ...result.items];
      hasNext = result.hasNext;
      page = next;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function setMode(next: "popular" | "latest"): void {
    mode = next;
    void run(1);
  }
</script>

<section class="view" class:embedded>
  <header class="bar">
    {#if !embedded}
      <button class="btn ghost icon" aria-label="Back to sources" onclick={() => go("/browse")}>
        <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>
      </button>
    {/if}
    <div class="titles">
      <h1>{source?.name ?? "Source"}</h1>
      {#if source?.lang}<span class="lang">{source.lang}</span>{/if}
    </div>
  </header>

  <form
    class="search"
    onsubmit={(event) => {
      event.preventDefault();
      mode = "search";
      void run(1);
    }}
  >
    <input class="field" type="search" placeholder={`Search ${source?.name ?? "this source"}`} bind:value={query} aria-label="Search this source" />
    <button class="btn" type="submit" disabled={busy}>Search</button>
  </form>

  <div class="modes" role="tablist" aria-label="Listing">
    <button class="chip" class:on={mode === "popular"} role="tab" aria-selected={mode === "popular"} onclick={() => setMode("popular")}>Popular</button>
    <button class="chip" class:on={mode === "latest"} role="tab" aria-selected={mode === "latest"} onclick={() => setMode("latest")}>Latest</button>
    {#if mode === "search"}
      <span class="hint">searching “{query}”</span>
    {/if}
  </div>

  {#if error}<p class="banner">{error}</p>{/if}
  {#if busy && items.length === 0}<p class="empty">Loading…</p>{/if}

  <SeriesGrid series={items} cover={132} empty={mode === "search" ? "This source found nothing." : "This source returned nothing."} />

  {#if hasNext}
    <button class="btn more" disabled={busy} onclick={() => void run(page + 1)}>{busy ? "Loading…" : "Load more"}</button>
  {/if}
</section>

<style>
  .view {
    padding: var(--s4) var(--s4) var(--s7);
    max-width: 1100px;
  }

  .view.embedded {
    max-width: none;
    padding-top: var(--s3);
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

  .titles {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    min-width: 0;
  }

  h1 {
    font-size: var(--t-xl);
    font-weight: 650;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .lang {
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
  }

  .search {
    display: flex;
    gap: var(--s2);
    margin-bottom: var(--s3);
  }

  .search .field {
    flex: 1;
    min-height: 38px;
  }

  .modes {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-bottom: var(--s4);
  }

  .hint {
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .more {
    margin-top: var(--s5);
  }
</style>
