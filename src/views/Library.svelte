<script lang="ts">
  import { library } from "../state/library.svelte";
  import { categories } from "../state/categories.svelte";
  import CategoryRail from "../components/CategoryRail.svelte";
  import SeriesGrid from "../components/SeriesGrid.svelte";
  import { go, pathTo } from "../lib/nav";
  import { applyView } from "../lib/categories";

  /** Which category the rail is pointing at; `null` is the whole library. */
  let selected = $state<string | null>(null);

  /**
   * The library as the two marks leave it: the eye decides membership, the pin
   * decides both the filter and what floats to the top, and the rail's selection
   * narrows to one category without changing either mark.
   */
  const rows = $derived(
    applyView(
      library.library.map((series) => ({ ...series, categoryIds: series.categoryIds ?? [] })),
      categories.items,
      { hiddenView: categories.hiddenView, pinView: categories.pinView },
    ).filter((series) => selected === null || series.categoryIds.includes(selected)),
  );

  /** Where the reader was, newest first — the one thing a library should never hide. */
  let continuing = $state<Array<{ seriesId: string; chapterId: string; page: number; title: string }>>([]);
  $effect(() => {
    if (library.profile === null) return;
    void library.continueReading().then((rows) => (continuing = rows));
  });

  const emptyMessage = $derived(
    library.library.length === 0
      ? "Nothing here yet. Open a source and add a series."
      : selected !== null
        ? "Nothing in this category yet."
        : categories.hiddenView === "only"
          ? "No hidden category has anything in it."
          : "These rows are hidden by the eye. Switch it to Revealed to see them.",
  );
</script>

<section>
  <header class="head">
    <h1>Library</h1>
    <button class="ghost" onclick={() => go("/browse")}>Browse sources</button>
  </header>

  {#if library.error}
    <p class="banner">{library.error}</p>
  {/if}

  {#if !library.ready}
    <p class="empty">Opening the library…</p>
  {:else}
    <div class="board">
      <CategoryRail {selected} onselect={(id) => (selected = id)} />
      <div class="main">
        {#if selected !== null}
          <p class="crumb">
            <button class="ghost" onclick={() => (selected = null)}>All</button>
            <span>{categories.items.find((c) => c.id === selected)?.name ?? ""}</span>
          </p>
        {/if}
        {#if selected === null && continuing.length > 0}
          <div class="continue" aria-label="Continue reading">
            {#each continuing as row (row.seriesId)}
              <button class="cont" onclick={() => go(pathTo("read", row.seriesId, row.chapterId))}>
                <span class="t">{row.title}</span>
                <span class="p">page {row.page + 1}</span>
              </button>
            {/each}
          </div>
        {/if}
        <SeriesGrid series={rows} empty={emptyMessage} />
      </div>
    </div>
  {/if}
</section>

<style>
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 20px;
  }
  h1 {
    font-size: 22px;
    font-weight: 600;
    margin: 0;
  }
  .board {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    gap: 24px;
    align-items: start;
  }
  @media (max-width: 620px) {
    .board {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .crumb {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 14px;
    font-size: 12.5px;
    color: #b9b9c6;
  }
  /* Continue: a horizontal strip, because it is a shortcut back into a book, not a shelf. */
  .continue {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 4px;
    margin: 0 0 18px;
  }
  .cont {
    all: unset;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 150px;
    max-width: 220px;
    padding: 8px 11px;
    border-radius: 9px;
    border: 1px solid var(--line);
    background: #16161c;
  }
  .cont:hover {
    border-color: #3a3a48;
  }
  .cont .t {
    font-size: 12.5px;
    color: #dcdce6;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cont .p {
    font-size: 11px;
    color: var(--muted);
  }
  .empty {
    color: #8a8a96;
    font-size: 14px;
  }
</style>
