<script lang="ts">
  /**
   * Downloads: what is on this device, what is arriving, and how much room it takes.
   *
   * Downloaded chapters are the offline promise, so this screen is about state rather than
   * management: progress while it runs, a queue, and a list you can delete from. Nothing here is
   * ever uploaded — a download lives in this device's database and nowhere else.
   */
  import { downloads } from "../state/downloads.svelte";
  import { library } from "../state/library.svelte";
  import { go, pathTo } from "../lib/nav";

  $effect(() => {
    void downloads.load();
  });

  const titles = $derived(new Map(library.library.map((row) => [row.id, row.title])));

  const grouped = $derived.by(() => {
    const map = new Map<string, typeof downloads.rows>();
    for (const row of downloads.rows) {
      const list = map.get(row.seriesId) ?? [];
      list.push(row);
      map.set(row.seriesId, list);
    }
    return [...map.entries()];
  });

  function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  const active = $derived(downloads.active);
  const percent = $derived(active !== null && active.total > 0 ? Math.round((active.done / active.total) * 100) : 0);
</script>

<section class="view">
  <header class="top">
    <h1>Downloads</h1>
    <span class="count">{size(downloads.bytes)}</span>
  </header>

  {#if downloads.error}<p class="banner">{downloads.error}</p>{/if}

  {#if active}
    <section class="group">
      <h2>Downloading</h2>
      <div class="card">
        <div class="info">
          <span class="t">{titles.get(active.chapterId.split(":").slice(0, 2).join(":")) ?? "Chapter"}</span>
          <span class="s">{active.done} / {active.total || "?"} pages</span>
        </div>
        <div class="bar" role="progressbar" aria-valuenow={percent} aria-valuemin="0" aria-valuemax="100">
          <span style:width="{percent}%"></span>
        </div>
      </div>
    </section>
  {/if}

  {#if downloads.queue.length > 0}
    <section class="group">
      <h2>Queued · {downloads.queue.length}</h2>
      <ul class="rows">
        {#each downloads.queue as item (item.chapterId)}
          <li class="row">
            <span class="t">{item.chapterName}</span>
            <button class="btn ghost" onclick={() => downloads.cancel(item.chapterId)}>Cancel</button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if downloads.rows.length === 0 && !active && downloads.queue.length === 0}
    <div class="blank">
      <p class="blankline">Nothing downloaded.</p>
      <p class="blanksub">Download a chapter from a series and it stays on this device — readable in airplane mode, and never uploaded.</p>
      <button class="btn primary" onclick={() => go("/library")}>Open the library</button>
    </div>
  {:else}
    {#each grouped as [seriesId, rows] (seriesId)}
      <section class="group">
        <h2>{titles.get(seriesId) ?? seriesId}<span class="gsize">{size(rows.reduce((sum, row) => sum + row.bytes, 0))}</span></h2>
        <ul class="rows">
          {#each rows as row (row.chapterId)}
            <li class="row">
              <div class="info">
                <span class="t">{row.chapterName}</span>
                <span class="s">{row.pages} pages · {size(row.bytes)}</span>
              </div>
              <button class="btn ghost" onclick={() => go(pathTo("read", row.seriesId, row.chapterId))}>Read</button>
              <button class="btn danger" onclick={() => void downloads.remove(row.chapterId)}>Delete</button>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
</section>

<style>
  .view {
    padding: var(--s4) var(--s4) var(--s7);
    max-width: 820px;
  }

  .top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s3);
    padding-top: var(--safe-t);
    margin-bottom: var(--s4);
  }

  h1 {
    font-size: var(--t-2xl);
    font-weight: 650;
  }

  .count {
    font-size: var(--t-sm);
    color: var(--text-3);
  }

  .group {
    margin-bottom: var(--s5);
  }

  h2 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s2);
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
    margin-bottom: var(--s2);
  }

  .gsize {
    text-transform: none;
    letter-spacing: 0;
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
  }

  .row,
  .card {
    display: flex;
    align-items: center;
    gap: var(--s3);
    padding: var(--s2);
    border-radius: var(--r2);
  }

  .row:hover {
    background: var(--surface-2);
  }

  .info {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 1px;
  }

  .t {
    font-size: var(--t-md);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .s {
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .bar {
    width: 96px;
    height: 6px;
    border-radius: var(--r-pill);
    background: var(--surface-2);
    overflow: hidden;
  }

  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width var(--dur);
  }

  .blank {
    display: grid;
    gap: var(--s2);
    padding-top: var(--s6);
    max-width: 46ch;
    justify-items: start;
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
</style>
