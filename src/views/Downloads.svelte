<script lang="ts">
  /**
   * Downloads: what is on this device, what is arriving, and how much room it takes.
   *
   * Downloaded chapters are the offline promise, so this screen is about state as much as
   * management: a chapter that is queued, running, finished, partial or failed looks different in
   * each case, and each case has the one action that makes sense. Nothing here is ever uploaded —
   * a download lives in this device's database and nowhere else.
   *
   * The list is grouped by series and read in chapter order, because a downloads screen is
   * checked against a series page, not against the order things happened to be tapped in.
   */
  import { downloads } from "../state/downloads.svelte";
  import { library } from "../state/library.svelte";
  import { groupBySeries, isComplete, manageRows, type ManageRow } from "../lib/downloads/state";
  import { go, pathTo } from "../lib/nav";

  $effect(() => {
    void downloads.load();
  });

  /** Titles: the library first, then any title this device has seen before. */
  let known = $state<Map<string, string>>(new Map());

  $effect(() => {
    const store = library.profile?.store;
    if (store === undefined) return;
    void store.listKnownSeries().then((rows) => {
      known = new Map(rows.map((row) => [row.id, row.title]));
    });
  });

  const titles = $derived(new Map([...known, ...library.library.map((row) => [row.id, row.title] as [string, string])]));

  const lines = $derived(manageRows(downloads.rows, downloads.queue, downloads.active));
  const groups = $derived(groupBySeries(lines, titles));

  /** Chapters whose pages are all here. A partial one is listed, but it is not counted as kept. */
  const kept = $derived(downloads.rows.filter(isComplete).length);
  const waiting = $derived(downloads.queue.filter((item) => item.state !== "failed").length);

  /** The row or series waiting for a second tap. Destructive actions are never one tap. */
  let confirming = $state<string | null>(null);
  let confirmingSeries = $state<string | null>(null);

  function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function label(row: ManageRow): string {
    return row.chapterName || (row.number !== undefined && row.number > 0 ? `Chapter ${row.number}` : "Chapter");
  }

  function pages(row: ManageRow): string {
    if (row.state === "downloading" && row.done !== undefined && (row.total ?? 0) > 0) return `${row.done} / ${row.total} pages`;
    if (row.state === "queued") return "waiting";
    if (row.total !== undefined && row.pages < row.total) return `${row.pages} of ${row.total} pages`;
    return `${row.pages} page${row.pages === 1 ? "" : "s"}`;
  }

  function percent(row: ManageRow): number {
    if (row.total === undefined || row.total <= 0) return 0;
    const done = row.state === "downloading" ? (row.done ?? 0) : row.pages;
    return Math.min(Math.round((done / row.total) * 100), 100);
  }

  function canRead(row: ManageRow): boolean {
    return row.pages > 0;
  }

  function canRetry(row: ManageRow): boolean {
    return row.state === "partial" || row.state === "failed";
  }

  async function removeRow(row: ManageRow): Promise<void> {
    confirming = null;
    await downloads.remove(row.chapterId);
  }

  async function removeGroup(seriesId: string): Promise<void> {
    confirmingSeries = null;
    await downloads.removeSeries(seriesId);
  }
</script>

<section class="view">
  <header class="top">
    <h1>Downloads</h1>
    <span class="count">
      {size(downloads.bytes)} · {kept} chapter{kept === 1 ? "" : "s"}{waiting > 0 ? ` · ${waiting} queued` : ""}
    </span>
  </header>

  {#if downloads.error}<p class="banner">{downloads.error}</p>{/if}

  {#if lines.length === 0}
    <div class="blank">
      <p class="blankline">Nothing downloaded.</p>
      <p class="blanksub">
        A download keeps a chapter's pages in this device's own database, so it opens with no network at all —
        the extension host can be off, and the chapter still reads. Nothing is uploaded, and deleting it frees the space.
      </p>
      <button class="btn primary" onclick={() => go("/library")}>Open the library</button>
    </div>
  {:else}
    {#each groups as group (group.seriesId)}
      <section class="group">
        <header class="ghead">
          <h2>{titles.get(group.seriesId) ?? group.seriesId}<span class="gsize">{size(group.bytes)} · {group.chapters}</span></h2>
          {#if confirmingSeries !== group.seriesId}
            <button class="chip" onclick={() => (confirmingSeries = group.seriesId)}>Delete all</button>
          {/if}
        </header>

        {#if confirmingSeries === group.seriesId}
          <div class="confirm">
            <p>
              Delete all {group.chapters} downloaded chapter{group.chapters === 1 ? "" : "s"} of
              {titles.get(group.seriesId) ?? "this series"}? {size(group.bytes)} will be freed on this device.
            </p>
            <span class="acts2">
              <button class="chip" onclick={() => (confirmingSeries = null)}>Cancel</button>
              <button class="chip danger" onclick={() => void removeGroup(group.seriesId)}>Delete</button>
            </span>
          </div>
        {/if}

        <ul class="rows">
          {#each group.rows as row (row.chapterId)}
            <li class="row" class:failed={row.state === "failed"}>
              <div class="info">
                <span class="t">{label(row)}</span>
                <span class="s">
                  {pages(row)}{row.bytes > 0 ? ` · ${size(row.bytes)}` : ""}
                  {#if row.state === "failed" && row.error}<em class="why">{row.error}</em>{/if}
                </span>
              </div>

              <span class="state" class:on={row.state === "done"} class:warn={row.state === "partial" || row.state === "failed"}>
                {#if row.state === "downloading"}
                  Downloading · {percent(row)}%
                {:else if row.state === "queued"}
                  Queued
                {:else if row.state === "partial"}
                  Partial
                {:else if row.state === "failed"}
                  Failed
                {:else}
                  On this device
                {/if}
              </span>

              {#if row.state === "downloading"}
                <div class="bar" role="progressbar" aria-valuenow={percent(row)} aria-valuemin="0" aria-valuemax="100">
                  <span style:width="{percent(row)}%"></span>
                </div>
              {/if}

              {#if confirming === row.chapterId}
                <span class="acts2">
                  <button class="chip" onclick={() => (confirming = null)}>Keep</button>
                  <button class="chip danger" onclick={() => void removeRow(row)}>Delete</button>
                </span>
              {:else}
                <span class="acts">
                  {#if row.state === "queued" || row.state === "downloading"}
                    <button class="btn ghost" onclick={() => downloads.cancel(row.chapterId)}>Cancel</button>
                  {/if}
                  {#if canRetry(row)}
                    <button class="btn ghost" onclick={() => downloads.retry(row.chapterId)}>Retry</button>
                  {/if}
                  {#if canRead(row)}
                    <button class="btn ghost" onclick={() => go(pathTo("read", row.seriesId, row.chapterId))}>Read</button>
                  {/if}
                  <button class="btn danger" onclick={() => (confirming = row.chapterId)}>Delete</button>
                </span>
              {/if}
            </li>

            {#if confirming === row.chapterId}
              <li class="sentence">
                <p>
                  Delete “{label(row)}” from this device? {row.bytes > 0 ? `${size(row.bytes)} will be freed. ` : ""}
                  {row.state === "partial"
                    ? "The pages that did arrive are removed too, and reading it again will need the network."
                    : "Reading it again will need the network."}
                </p>
              </li>
            {/if}
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

  .ghead {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    margin-bottom: var(--s2);
  }

  h2 {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s2);
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
  }

  .gsize {
    text-transform: none;
    letter-spacing: 0;
    white-space: nowrap;
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
    flex-wrap: wrap;
  }

  .row:hover {
    background: var(--surface-2);
  }

  .info {
    flex: 1;
    min-width: 12ch;
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
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }

  .why {
    font-style: normal;
    color: var(--danger, #d9534f);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40ch;
  }

  .state {
    font-size: var(--t-xs);
    color: var(--text-3);
    white-space: nowrap;
  }

  .state.on {
    color: var(--success, #4f9d69);
  }

  .state.warn {
    color: var(--danger, #d9534f);
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

  .acts,
  .acts2 {
    display: flex;
    gap: var(--s2);
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .acts .btn {
    min-height: 32px;
    padding: 0 var(--s3);
    font-size: var(--t-sm);
  }

  .confirm {
    display: grid;
    gap: var(--s2);
    padding: var(--s2) var(--s2) var(--s3);
    border-bottom: 1px solid var(--line);
    margin-bottom: var(--s2);
  }

  .confirm p,
  .sentence p {
    margin: 0;
    font-size: var(--t-sm);
    color: var(--text-2);
    line-height: 1.6;
    max-width: 60ch;
  }

  .sentence {
    list-style: none;
    padding: 0 var(--s2) var(--s2);
  }

  .chip.danger {
    color: var(--danger, #d9534f);
    border-color: currentColor;
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
