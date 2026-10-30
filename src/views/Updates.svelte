<script lang="ts">
  /**
   * Updates: new chapters from the titles you keep.
   *
   * There is no push feed — this screen asks the library's own sources for their chapter lists and
   * shows what is new, newest first, grouped by day. A title whose source fails is skipped, and the
   * screen says how many titles were asked so an empty list is not mistaken for "nothing happened".
   */
  import { library, type UpdateRow } from "../state/library.svelte";
  import { downloads } from "../state/downloads.svelte";
  import Cover from "../components/Cover.svelte";
  import { go, pathTo } from "../lib/nav";

  let rows = $state<UpdateRow[]>([]);
  let asked = $state(0);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let checked = $state(false);

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      asked = Math.min(library.library.length, 150);
      rows = await library.refreshUpdates();
      checked = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (library.ready && !checked && !loading && library.library.length > 0) void refresh();
  });

  const groups = $derived.by(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const today = startOfToday.getTime();
    const buckets: Array<{ label: string; rows: UpdateRow[] }> = [
      { label: "Today", rows: [] },
      { label: "Yesterday", rows: [] },
      { label: "This week", rows: [] },
      { label: "Earlier", rows: [] },
    ];
    for (const row of rows) {
      const at = row.chapter.uploadedAt ?? 0;
      if (at >= today) buckets[0].rows.push(row);
      else if (at >= today - 86_400_000) buckets[1].rows.push(row);
      else if (at >= today - 7 * 86_400_000) buckets[2].rows.push(row);
      else buckets[3].rows.push(row);
    }
    return buckets.filter((bucket) => bucket.rows.length > 0);
  });

  function ago(at: number | undefined): string {
    if (at === undefined) return "";
    const hours = Math.floor((Date.now() - at) / 3_600_000);
    if (hours < 1) return "just now";
    if (hours < 24) return `${hours} h ago`;
    return `${Math.floor(hours / 24)} d ago`;
  }
</script>

<section class="view">
  <header class="top">
    <h1>Updates</h1>
    <button class="btn" disabled={loading} onclick={() => void refresh()}>{loading ? "Checking…" : "Check now"}</button>
  </header>

  {#if error}<p class="banner">{error}</p>{/if}

  {#if library.library.length === 0}
    <div class="blank">
      <p class="blankline">No titles to check.</p>
      <p class="blanksub">Updates come from the series in your library, so add a few first.</p>
      <button class="btn primary" onclick={() => go("/browse")}>Browse sources</button>
    </div>
  {:else if loading && rows.length === 0}
    <p class="empty">Asking {asked || library.library.length} titles for their chapters…</p>
  {:else if rows.length === 0 && checked}
    <p class="empty">Nothing new. {asked} titles checked, and none of their sources returned a dated chapter.</p>
  {:else}
    {#each groups as group (group.label)}
      <section class="group">
        <h2>{group.label}</h2>
        <ul class="rows">
          {#each group.rows as row (row.chapter.id)}
            <li>
              <div class="row">
                <Cover series={{ title: row.title, cover: row.cover }} size="row" />
                <div class="info">
                  <span class="t">{row.title}</span>
                  <span class="s">
                    {row.chapter.number > 0 ? `Chapter ${row.chapter.number}` : row.chapter.name} · {ago(row.chapter.uploadedAt)}
                    {#if row.chapter.read}· read{/if}
                  </span>
                </div>
                <button
                  class="btn ghost icon"
                  aria-label={`Download ${row.chapter.name}`}
                  disabled={downloads.isDownloaded(row.chapter.id)}
                  onclick={() => downloads.enqueue(row.seriesId, row.chapter)}
                >
                  {downloads.isDownloaded(row.chapter.id) ? "⤓" : "↓"}
                </button>
                <button class="btn" onclick={() => go(pathTo("read", row.seriesId, row.chapter.id))}>Read</button>
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
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    margin-bottom: var(--s4);
  }

  h1 {
    font-size: var(--t-2xl);
    font-weight: 650;
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
