<script lang="ts">
  /**
   * Downloads: what is arriving, what is here, and how to ask for more.
   *
   * Two lists, because they answer two different questions — Queue is "what is left", Finished is
   * "what do I have" — and both are searchable, because a device with 400 chapters needs a way in
   * that is not scrolling. A series card says how many of its issues are here out of how many it
   * has, so "did it finish?" is answered on the card rather than by counting rows.
   *
   * The paste box exists because the links come from somewhere else: a forum, a chat, an archive
   * search in another tab. A link is resolved against the sources this app actually has installed
   * and turned into queue entries — or refused with the reason, never guessed at.
   *
   * Downloaded chapters are the offline promise, so this screen is about state as much as
   * management: queued, running, finished, partial and failed look different, and each has the one
   * action that makes sense. Nothing here is ever uploaded — a download lives in this device's
   * database and nowhere else.
   */
  import { privacy } from "../state/privacy.svelte";
  import { visibility } from "../state/visibility.svelte";
  import { downloads } from "../state/downloads.svelte";
  import { library } from "../state/library.svelte";
  import {
    grabbedLabel,
    groupBySeries,
    isComplete,
    manageRows,
    matchesDownloadQuery,
    type ManageRow,
  } from "../lib/downloads/state";
  import { bestMatch, hostOf, resolveLinks } from "../lib/downloads/links";
  import { go, pathTo } from "../lib/nav";

  /** Rendered inside the Library's Downloads tab rather than as its own page. */
  let { embedded = false }: { embedded?: boolean } = $props();

  $effect(() => {
    void downloads.load();
  });

  /** Titles: the library first, then any title this device has seen before. */
  let known = $state<Map<string, string>>(new Map());

  /** Read the titles this device knows; called again whenever a new one is learned. */
  async function refreshKnown(): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    const rows = await store.listKnownSeries();
    known = new Map(rows.map((row) => [row.id, row.title]));
  }

  $effect(() => {
    void refreshKnown();
  });

  const titles = $derived(new Map([...known, ...library.library.map((row) => [row.id, row.title] as [string, string])]));

  $effect(() => { const store = library.profile?.store; if (store) void visibility.load(store); });
  const visibleDownloads = $derived(downloads.rows.filter((row) => visibility.allows({ id: row.seriesId })));
  const visibleQueue = $derived(downloads.queue.filter((row) => visibility.allows({ id: row.seriesId })));
  const lines = $derived(manageRows(visibleDownloads, visibleQueue, downloads.active && visibility.allows({ id: downloads.active.seriesId ?? "" }) ? downloads.active : null));

  /** How many chapters a series has, so "3 of 12 issues" is a fact rather than a row count. */
  let totals = $state<Record<string, number>>({});
  /** Not reactive: it only stops the same series being read out of the database twice. */
  const counted = new Map<string, number>();

  $effect(() => {
    const store = library.profile?.store;
    if (store === undefined) return;
    // Every series on this screen, including the ones that are only queued and have no row yet.
    const ids = [...new Set(lines.map((row) => row.seriesId))].filter((id) => !(id in totals));
    if (ids.length === 0) return;
    void (async () => {
      const learned = await downloads.knownTotals();
      const next: Record<string, number> = {};
      for (const id of ids) {
        // A count learned by a fetch first; the mirrored chapter list second; nothing invented.
        const known = counted.get(id) ?? learned[id];
        const total = known ?? (await store.listChapters(id)).length;
        if (total > 0) counted.set(id, total);
        next[id] = total;
      }
      totals = { ...totals, ...next };
    })();
  });

  let tab = $state<"queue" | "finished">("queue");
  let query = $state("");

  const filtered = $derived(
    lines.filter((row) => matchesDownloadQuery(query, titles.get(row.seriesId), row.chapterName)),
  );
  // The running chapter is pinned above the list; showing it again here would be the same row
  // twice, and the two copies would disagree by a page.
  const queueLines = $derived(
    filtered.filter(
      (row) =>
        row.chapterId !== downloads.active?.chapterId &&
        (row.state === "queued" || row.state === "downloading" || row.state === "failed" || row.state === "partial"),
    ),
  );
  const finishedLines = $derived(filtered.filter((row) => row.state === "done"));
  const shown = $derived(tab === "queue" ? queueLines : finishedLines);
  const groups = $derived(groupBySeries(shown, titles));

  const kept = $derived(visibleDownloads.filter(isComplete).length);
  const waiting = $derived(visibleQueue.filter((item) => item.state !== "failed").length);
  const failed = $derived(visibleQueue.filter((item) => item.state === "failed").length);

  /** The row or series waiting for a second tap. Destructive actions are never one tap. */
  let confirming = $state<string | null>(null);
  let confirmingSeries = $state<string | null>(null);

  /** The paste box, and what each line of the last paste turned into. */
  let paste = $state("");
  let pasting = $state(false);
  let reports = $state<Array<{ ok: boolean; text: string }>>([]);

  /** A series whose "fetch" tap is in flight, so the button cannot be double-tapped. */
  let fetching = $state<string | null>(null);
  let notice = $state("");

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

  /** Chapters of one series that are complete here, for the card's count. */
  function grabbed(seriesId: string): number {
    return downloads.rows.filter((row) => row.seriesId === seriesId && isComplete(row)).length;
  }

  /** The running chapter's own line, when the list already has it. */
  const running = $derived(
    downloads.active === null ? null : lines.find((row) => row.chapterId === downloads.active?.chapterId) ?? null,
  );
  const runningPercent = $derived(
    downloads.active === null
      ? 0
      : downloads.active.total <= 0
        ? 0
        : Math.min(Math.round((downloads.active.done / downloads.active.total) * 100), 100),
  );

  async function removeRow(row: ManageRow): Promise<void> {
    confirming = null;
    await downloads.remove(row.chapterId);
  }

  async function removeGroup(seriesId: string): Promise<void> {
    confirmingSeries = null;
    await downloads.removeSeries(seriesId);
  }

  /** Queue a series' chapters: only the unseen ones, or everything that is not already here. */
  async function fetchSeries(seriesId: string, mode: "new" | "all"): Promise<void> {
    if (!visibility.allows({ id: seriesId })) return;
    const revision = privacy.revision;
    if (fetching !== null) return;
    fetching = seriesId;
    notice = "";
    try {
      const { queued, total } = await downloads.fetchSeries(seriesId, mode);
      if (revision !== privacy.revision) return;
      counted.set(seriesId, total);
      totals = { ...totals, [seriesId]: total };
      const name = titles.get(seriesId) ?? "That series";
      notice =
        queued === 0
          ? `${name}: nothing left to fetch (${total} issue${total === 1 ? "" : "s"})`
          : `${name}: queued ${queued} of ${total} issue${total === 1 ? "" : "s"}`;
    } catch (error) {
      if (revision === privacy.revision) notice = `${titles.get(seriesId) ?? "That series"}: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      fetching = null;
    }
  }

  /**
   * Resolve every pasted link and queue what it names.
   *
   * One line at a time, in order, so the report reads like the paste: an Archive link is an item id
   * and needs no search; a source link is searched on the one source whose host it belongs to. A
   * title that is found is queued straight away — that is what "grab it" means — and a line that
   * cannot be resolved says why instead of vanishing.
   */
  async function addPasted(): Promise<void> {
    if (privacy.locked || pasting || paste.trim() === "") return;
    const revision = privacy.revision;
    pasting = true;
    reports = [];
    const found: Array<{ ok: boolean; text: string }> = [];
    try {
      for (const target of resolveLinks(paste, library.sources)) {
        if (target.kind === "error") {
          found.push({
            ok: false,
            text: `${target.url === null ? target.raw : hostOf(target.url) ?? target.raw} — ${target.reason}`,
          });
          reports = [...found];
          continue;
        }
        try {
          const series =
            target.kind === "archive"
              ? await library.details(target.seriesId)
              : bestMatch(await library.searchSource(target.sourceId, target.query), target.query);
          if (revision !== privacy.revision) return;
          if (series === null) {
            found.push({
              ok: false,
              text:
                target.kind === "source"
                  ? `${target.sourceName} found nothing for “${target.query}”`
                  : `Internet Archive has no item ${target.seriesId}`,
            });
            reports = [...found];
            continue;
          }
          if (revision !== privacy.revision || !visibility.allows(series)) return;
          await library.rememberSeriesMeta(series);
          const { queued, total } = await downloads.fetchSeries(series.id, "new");
          counted.set(series.id, total);
          totals = { ...totals, [series.id]: total };
          known = new Map([...known, [series.id, series.title]]);
          found.push({
            ok: true,
            text: `${series.title} — ${
              queued === 0 ? "already here" : `${queued} of ${total} issue${total === 1 ? "" : "s"} queued`
            }`,
          });
        } catch (error) {
          found.push({
            ok: false,
            text: `${hostOf(target.url) ?? target.url}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        if (revision === privacy.revision) reports = [...found];
      }
      if (found.some((entry) => entry.ok)) paste = "";
    } finally {
      pasting = false;
    }
  }
  $effect(() => { if (privacy.locked) { reports = []; notice = ""; paste = ""; } });
</script>

<section class="view">
  <!--
    Embedded in the Library's Downloads tab, the page title is the tab above it: drawing "Downloads"
    a second time, 30 px under the word, is the duplicate heading this app keeps deleting. The count
    stays, because it is the one line that is not repeated anywhere else.
  -->
  <header class="top" class:embedded>
    {#if !embedded}<h1>Downloads</h1>{/if}
    <span class="count">
      {size(visibleDownloads.reduce((sum, row) => sum + row.bytes, 0))} · {kept} chapter{kept === 1 ? "" : "s"}{waiting > 0 ? ` · ${waiting} queued` : ""}{failed > 0 ? ` · ${failed} failed` : ""}
    </span>
  </header>

  {#if downloads.error && !privacy.locked}<p class="banner">{downloads.error}</p>{/if}

  <!-- Downloading now: pinned above both lists, because the running chapter is the one thing that
       changes while you watch. -->
  {#if downloads.active !== null && visibility.allows({ id: downloads.active.seriesId ?? "" })}
    <section class="now">
      <header>
        <h2>Downloading now</h2>
        <span class="hint">{waiting} waiting</span>
      </header>
      <div class="nowbody">
        <div class="info">
          <span class="t">{downloads.active.chapterName ?? running?.chapterName ?? "Chapter"}</span>
          <span class="s">
            {[
              titles.get(downloads.active.seriesId ?? "") ?? downloads.active.seriesId ?? "",
              `${downloads.active.done} / ${downloads.active.total || "?"} pages`,
            ]
              .filter((part) => part !== "")
              .join(" · ")}
          </span>
        </div>
        <span class="state on">{runningPercent}%</span>
        <div class="bar" role="progressbar" aria-valuenow={runningPercent} aria-valuemin="0" aria-valuemax="100">
          <span style:width="{runningPercent}%"></span>
        </div>
        <button class="btn ghost" onclick={() => downloads.cancel(downloads.active!.chapterId)}>Cancel</button>
      </div>
    </section>
  {/if}

  <!-- The paste box: small on purpose. It is a doorway, not the page. -->
  <details class="paste" open={reports.length > 0 || paste !== ""}>
    <summary>Add from a link</summary>
    <p class="phint">
      Paste links — Internet Archive items, or pages from a source you have installed (BatCave, and anything else
      that publishes one). Each one is found and queued.
    </p>
    <textarea
      bind:value={paste}
      rows="2"
      placeholder="https://archive.org/details/…&#10;https://batcave.biz/comic/…"
      aria-label="Links to download"
    ></textarea>
    <div class="prow">
      <button class="btn primary" onclick={() => void addPasted()} disabled={pasting || paste.trim() === ""}>
        {pasting ? "Looking…" : "Add to queue"}
      </button>
      <span class="hint">{library.sources.length} source{library.sources.length === 1 ? "" : "s"} installed</span>
    </div>
    {#if reports.length > 0}
      <ul class="reports">
        {#each reports as report}
          <li class:bad={!report.ok}>
            <span aria-hidden="true">{report.ok ? "✓" : "✕"}</span>
            {report.text}
          </li>
        {/each}
      </ul>
    {/if}
  </details>

  {#if notice !== ""}<p class="banner quiet">{notice}</p>{/if}

  <div class="tabs" role="tablist">
    <button class="tab" class:on={tab === "queue"} role="tab" aria-selected={tab === "queue"} onclick={() => (tab = "queue")}>
      Queue<span class="n">{queueLines.length}</span>
    </button>
    <button class="tab" class:on={tab === "finished"} role="tab" aria-selected={tab === "finished"} onclick={() => (tab = "finished")}>
      Finished<span class="n">{finishedLines.length}</span>
    </button>
  </div>

  {#if lines.length > 0}
    <input class="find" bind:value={query} placeholder="Search this list" aria-label="Search downloads" />
  {/if}

  {#if lines.length === 0}
    <div class="blank">
      <p class="blankline">Nothing downloaded.</p>
      <p class="blanksub">
        A download keeps a chapter's pages in this device's own database, so it opens with no network at all — the
        extension host can be off, and the chapter still reads. Paste a link above, or open a series and download
        from there.
      </p>
      <button class="btn primary" onclick={() => go("/library")}>Open the library</button>
    </div>
  {:else if shown.length === 0}
    <p class="blankline small">
      {query.trim() === ""
        ? tab === "queue"
          ? "Nothing waiting."
          : "Nothing finished yet."
        : `Nothing matches “${query.trim()}”.`}
    </p>
  {:else}
    {#each groups as group (group.seriesId)}
      <section class="group">
        <header class="ghead">
          <div class="gtitle">
            <h2>{titles.get(group.seriesId) ?? group.seriesId}</h2>
            <span class="gsize">{grabbedLabel(grabbed(group.seriesId), totals[group.seriesId])} · {size(group.bytes)}</span>
          </div>
          {#if confirmingSeries !== group.seriesId}
            <span class="gacts">
              <button class="chip" disabled={fetching !== null} onclick={() => void fetchSeries(group.seriesId, "new")}>
                {fetching === group.seriesId ? "Fetching…" : "Fetch new"}
              </button>
              <button class="chip" disabled={fetching !== null} onclick={() => void fetchSeries(group.seriesId, "all")}>Fetch all</button>
              <button class="chip danger" onclick={() => (confirmingSeries = group.seriesId)}>Delete all</button>
            </span>
          {/if}
        </header>

        {#if confirmingSeries === group.seriesId}
          <div class="confirm">
            <p>
              Delete all {grabbed(group.seriesId)} downloaded chapter{grabbed(group.seriesId) === 1 ? "" : "s"} of
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
    margin-bottom: var(--s4);
  }
  /* Embedded, the count is a quiet subtitle under the section tabs, not a heading row. */
  .top.embedded {
    margin-bottom: var(--s3);
    padding-bottom: var(--s1);
    border-bottom: 1px solid var(--line);
  }
  .top.embedded .count {
    margin-left: 0;
  }

  h1 {
    font-size: var(--t-2xl);
    font-weight: 650;
  }

  .count {
    font-size: var(--t-sm);
    color: var(--text-3);
  }

  .banner {
    margin: 0 0 var(--s3);
    padding: var(--s2) var(--s3);
    border-radius: var(--r2);
    background: var(--surface-2);
    font-size: var(--t-sm);
  }

  .banner.quiet {
    color: var(--text-2);
  }

  .now {
    margin-bottom: var(--s4);
    padding: var(--s3);
    border: 1px solid var(--line);
    border-radius: var(--r3);
    background: var(--surface-2);
  }

  .now header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s2);
    margin-bottom: var(--s2);
  }

  .now h2 {
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
  }

  .nowbody {
    display: flex;
    align-items: center;
    gap: var(--s3);
    flex-wrap: wrap;
  }

  .nowbody .bar {
    flex: 1 1 140px;
    width: auto;
  }

  .paste {
    margin-bottom: var(--s4);
    padding: var(--s2) var(--s3);
    border: 1px solid var(--line);
    border-radius: var(--r3);
  }

  .paste summary {
    cursor: pointer;
    font-size: var(--t-sm);
    color: var(--text-2);
  }

  .phint {
    margin: var(--s2) 0;
    font-size: var(--t-xs);
    color: var(--text-3);
    max-width: 60ch;
  }

  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    padding: var(--s2);
    border: 1px solid var(--line);
    border-radius: var(--r2);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: var(--t-sm);
  }

  .prow {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-top: var(--s2);
    flex-wrap: wrap;
  }

  .hint {
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .reports {
    list-style: none;
    margin: var(--s2) 0 0;
    padding: 0;
    display: grid;
    gap: 2px;
    font-size: var(--t-xs);
  }

  .reports li {
    color: var(--success, #4f9d69);
    overflow-wrap: anywhere;
  }

  .reports li.bad {
    color: var(--danger, #d9534f);
  }

  .tabs {
    display: flex;
    gap: var(--s2);
    margin-bottom: var(--s3);
  }

  .tab {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: var(--s2);
    padding: 6px var(--s3);
    border-radius: var(--r-pill);
    font-size: var(--t-sm);
    color: var(--text-2);
    border: 1px solid transparent;
  }

  .tab.on {
    color: var(--text);
    background: var(--surface-2);
    border-color: var(--line);
  }

  /* A tab is a text seat, so it takes the text number. transform cannot reflow the row. */
  .tab:active {
    transform: scale(0.985);
  }

  .tab .n {
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .find {
    width: 100%;
    box-sizing: border-box;
    margin-bottom: var(--s3);
    padding: 8px var(--s3);
    border: 1px solid var(--line);
    border-radius: var(--r-pill);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: var(--t-sm);
  }

  .group {
    margin-bottom: var(--s5);
  }

  .ghead {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    margin-bottom: var(--s2);
    flex-wrap: wrap;
  }

  .gtitle {
    flex: 1;
    min-width: 12ch;
    display: grid;
    gap: 1px;
  }

  h2 {
    font-size: var(--t-md);
    font-weight: 600;
  }

  .gsize {
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .gacts {
    display: flex;
    gap: var(--s2);
    flex-wrap: wrap;
  }

  .chip {
    all: unset;
    cursor: pointer;
    padding: 4px var(--s2);
    border-radius: var(--r-pill);
    border: 1px solid var(--line);
    font-size: var(--t-xs);
    color: var(--text-2);
  }

  .chip:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .chip.danger {
    color: var(--danger, #d9534f);
    border-color: currentColor;
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

  .sentence {
    list-style: none;
    padding: 0 var(--s2) var(--s2);
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

  .blankline.small {
    color: var(--text-3);
    font-size: var(--t-sm);
  }

  .blanksub {
    margin: 0;
    font-size: var(--t-sm);
    line-height: 1.6;
    color: var(--text-2);
  }
</style>
