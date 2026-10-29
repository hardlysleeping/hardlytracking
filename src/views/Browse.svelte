<script lang="ts">
  import { library } from "../state/library.svelte";
  import { go } from "../lib/nav";
  import { providerFor } from "../api/registry";
  import type { Series } from "../api/source";
  import SeriesGrid from "../components/SeriesGrid.svelte";

  let sourceId = $state<string | null>(null);
  let mode = $state<"POPULAR" | "LATEST" | "SEARCH">("POPULAR");
  let query = $state("");
  let items = $state<Series[]>([]);
  let hasNext = $state(false);
  let page = $state(1);
  let busy = $state(false);
  let error = $state<string | null>(null);
  /** A host that did not answer is worth saying once, here, in words. */
  const hostWarning = $derived(library.profile?.warnings.find((w) => w.startsWith("dalvik:")) ?? null);

  async function run(next = 1): Promise<void> {
    if (library.profile === null || sourceId === null) return;
    if (mode === "SEARCH" && query.trim() === "") return;
    busy = true;
    error = null;
    try {
      const provider = providerFor(library.profile.providers, sourceId);
      const result =
        mode === "POPULAR"
          ? await provider.popular(sourceId, next)
          : mode === "LATEST"
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

  function pick(id: string): void {
    sourceId = id;
    items = [];
    void run(1);
  }

</script>

<section>
  <header class="head">
    <h1>Browse</h1>
    <button class="ghost" onclick={() => go("/extensions")}>Extensions</button>
  </header>

  {#if hostWarning && library.sources.length === 0}
    <p class="note warn">No extension host answered, so there is nothing to browse yet.</p>
  {/if}

  {#if library.sources.length === 0}
    <p class="empty">
      No sources yet. <button class="ghost inline" onclick={() => go("/extensions")}>Add a repository</button> and
      install an extension — its sources appear here.
    </p>
  {:else}
    <div class="sources">
      {#each library.sources as source (source.id)}
        <button class="chip" class:on={source.id === sourceId} onclick={() => pick(source.id)}>
          {source.name}
          <!-- A multi-source APK exposes dozens of sources with the same name; the language is
               the only thing that tells them apart, so it belongs in the chip. -->
          {#if source.lang}<span class="lang">{source.lang}</span>{/if}
          {#if source.nsfw}<span class="nsfw">18+</span>{/if}
        </button>
      {/each}
    </div>
  {/if}

  {#if sourceId}
    <div class="modes">
      <button class="chip" class:on={mode === "POPULAR"} onclick={() => { mode = "POPULAR"; void run(1); }}>Popular</button>
      <button class="chip" class:on={mode === "LATEST"} onclick={() => { mode = "LATEST"; void run(1); }}>Latest</button>
      <form class="search" onsubmit={(e) => { e.preventDefault(); mode = "SEARCH"; void run(1); }}>
        <input bind:value={query} placeholder="Search this source" />
        <button class="ghost" type="submit">Search</button>
      </form>
    </div>

    {#if error}<p class="banner">{error}</p>{/if}
    {#if busy && items.length === 0}<p class="empty">Loading…</p>{/if}

    <SeriesGrid series={items} empty="This source returned nothing." />
    {#if hasNext}
      <button class="ghost more" disabled={busy} onclick={() => run(page + 1)}>More</button>
    {/if}
  {/if}
</section>

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;
  }
  h1 {
    font-size: 22px;
    font-weight: 600;
    margin: 0;
  }
  /* The file input is the browser's own control; keep it out of the way and style the label. */
  
  
  
  
  .note {
    color: #8fd6a8;
    font-size: 13px;
    margin: 0 0 12px;
  }
  .note.warn {
    color: #e0b06b;
  }
  .sources,
  .modes {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 16px;
    align-items: center;
  }
  .chip {
    all: unset;
    cursor: pointer;
    padding: 6px 12px;
    border-radius: 999px;
    background: #1c1c22;
    color: #c9c9d4;
    font-size: 13px;
  }
  .chip.on {
    background: #2c2c38;
    color: #fff;
  }
  .lang {
    margin-left: 5px;
    font-size: 10.5px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #7d7d8c;
  }
  .nsfw {
    font-size: 10px;
    color: #e0796b;
    margin-left: 6px;
  }
  .search {
    display: flex;
    gap: 8px;
    flex: 1;
    min-width: 220px;
  }
  .search input {
    flex: 1;
    background: #16161c;
    border: 1px solid #2a2a34;
    border-radius: 8px;
    padding: 7px 10px;
    color: #e6e6ee;
    font: inherit;
    font-size: 13px;
  }
  .inline {
    padding: 0;
    border: 0;
    color: #b9b9c6;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .empty {
    color: #8a8a96;
    font-size: 14px;
  }
  .more {
    margin-top: 18px;
  }
</style>
