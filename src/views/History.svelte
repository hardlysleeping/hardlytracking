<script lang="ts">
  /**
   * History: where you were, grouped the way a person remembers it.
   *
   * It is a shortcut back into a book, not an audit log — so each row is a cover, the chapter, how
   * long ago, and a Continue button. The groups are Today / Yesterday / This week / Earlier.
   */
  import { library } from "../state/library.svelte";
  import Cover from "../components/Cover.svelte";
  import { go, pathTo } from "../lib/nav";

  interface Row {
    seriesId: string;
    chapterId: string;
    at: number;
    title: string;
    cover?: string;
    page: number;
    chapterName: string;
  }

  let rows = $state<Row[]>([]);
  let loading = $state(true);

  $effect(() => {
    void load();
  });

  async function load(): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    loading = true;
    try {
      const [history, series, positions] = await Promise.all([
        store.listHistory(200),
        store.listSeries(),
        store.listPositions(),
      ]);
      const byId = new Map(series.map((row) => [row.id, row]));
      const positionOf = new Map(positions.map((row) => [row.chapterId, row.page]));
      const chapterNames = new Map((await store.listAllChapters()).map((chapter) => [chapter.id, chapter.name]));
      rows = history.map((row) => ({
        seriesId: row.seriesId,
        chapterId: row.chapterId,
        at: row.at,
        title: byId.get(row.seriesId)?.title ?? row.seriesId,
        cover: byId.get(row.seriesId)?.cover,
        page: positionOf.get(row.chapterId) ?? 0,
        chapterName: chapterNames.get(row.chapterId) ?? "Chapter",
      }));
    } finally {
      loading = false;
    }
  }

  const groups = $derived.by(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const today = startOfToday.getTime();
    const buckets: Array<{ label: string; rows: Row[] }> = [
      { label: "Today", rows: [] },
      { label: "Yesterday", rows: [] },
      { label: "Earlier this week", rows: [] },
      { label: "Older", rows: [] },
    ];
    for (const row of rows) {
      if (row.at >= today) buckets[0].rows.push(row);
      else if (row.at >= today - 86_400_000) buckets[1].rows.push(row);
      else if (row.at >= today - 7 * 86_400_000) buckets[2].rows.push(row);
      else buckets[3].rows.push(row);
    }
    return buckets.filter((bucket) => bucket.rows.length > 0);
  });

  function ago(at: number): string {
    const minutes = Math.floor((Date.now() - at) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return new Date(at).toLocaleDateString();
  }
</script>

<section class="view">
  <header class="top">
    <h1>History</h1>
    <span class="count">{rows.length}</span>
  </header>

  {#if loading}
    <p class="empty">Reading history…</p>
  {:else if rows.length === 0}
    <div class="blank">
      <p class="blankline">Nothing read yet.</p>
      <p class="blanksub">Chapters you open land here, newest first, with the page you stopped on.</p>
      <button class="btn primary" onclick={() => go("/library")}>Go to the library</button>
    </div>
  {:else}
    {#each groups as group (group.label)}
      <section class="group">
        <h2>{group.label}</h2>
        <ul class="rows">
          {#each group.rows as row (row.chapterId)}
            <li>
              <div class="row">
                <Cover series={{ title: row.title, cover: row.cover }} size="row" />
                <div class="info">
                  <span class="t">{row.title}</span>
                  <span class="s">{row.chapterName} · page {row.page + 1} · {ago(row.at)}</span>
                </div>
                <button class="btn ghost" onclick={() => go(pathTo("read", row.seriesId, row.chapterId))}>Continue</button>
              </div>
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
    gap: var(--s2);
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
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
    margin-bottom: var(--s2);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
  }

  .row {
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
