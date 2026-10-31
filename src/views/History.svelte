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
  import { chapterLabel, seriesLabel } from "../lib/titles";
  import { settings } from "../state/settings.svelte";
  import { viewport } from "../lib/layout.svelte";
  import { paneMode, paneRatio, squeezed } from "../lib/view-options";
  import { categories } from "../state/categories.svelte";
  import { sourceMarks } from "../state/source-marks.svelte";
  import { contextOf, isHidden, sourceKeyOf } from "../lib/marks";

  interface Row {
    seriesId: string;
    chapterId: string;
    /** The title's categories, so a hidden category can take its history with it. */
    categoryIds: string[];
    at: number;
    title: string;
    cover?: string;
    page: number;
    chapterName: string;
  }

  let rows = $state<Row[]>([]);
  let loading = $state(true);
  /** The row shown in the detail pane when there is one. */
  let picked = $state<string | null>(null);

  const mode = $derived(paneMode(settings.historyPane, viewport.width));
  const isSqueezed = $derived(squeezed(settings.historyPane, viewport.width));
  const ratio = $derived(paneRatio(settings.splitRatio, viewport.width));
  const pickedRow = $derived(rows.find((row) => row.chapterId === picked) ?? rows[0] ?? null);

  /**
   * The source as a reader names it, never as the runtime spells it.
   *
   * `dalvik` is an implementation word; the panel says "Black Clover from <extension name>" or, when
   * the extension is not installed any more, "an extension you no longer have".
   */
  function sourceLabel(seriesId: string): string {
    const [provider, ...rest] = seriesId.split(":");
    if (provider === "dalvik") {
      const sourceId = rest.join(":").split(":")[0];
      const match = library.sources.find((source) => source.id === `dalvik:src:${sourceId}` || source.id.endsWith(`:${sourceId}`));
      return match?.name ?? "an extension you no longer have";
    }
    if (provider === "mihon") return "Suwayomi";
    if (provider === "komga") return "Komga";
    if (provider === "local") return "This device";
    return "Unknown source";
  }

  /** A row opens the reader everywhere except in the split, where it fills the pane. */
  function open(row: Row): void {
    if (mode === "split") {
      picked = row.chapterId;
      return;
    }
    go(pathTo("read", row.seriesId, row.chapterId));
  }

  $effect(() => {
    void load();
  });

  async function load(): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    loading = true;
    try {
      const [history, series, positions, allChapters, mappings] = await Promise.all([
        store.listHistory(200),
        store.listSeries(),
        store.listPositions(),
        store.listAllChapters(),
        // A `mihon:` title's source is only knowable from its mapping.
        store.listMappings(),
      ]);
      mappedSource = new Map(mappings.map((row) => [row.seriesId, row.sourceId]));
      const byId = new Map(series.map((row) => [row.id, row]));
      const positionOf = new Map(positions.map((row) => [row.chapterId, row.page]));
      const chapterNames = new Map(allChapters.map((chapter) => [chapter.id, chapter.name]));
      rows = history.map((row) => ({
        seriesId: row.seriesId,
        chapterId: row.chapterId,
        categoryIds: byId.get(row.seriesId)?.categoryIds ?? [],
        at: row.at,
        title: seriesLabel(byId.get(row.seriesId)?.title),
        cover: byId.get(row.seriesId)?.cover,
        page: positionOf.get(row.chapterId) ?? 0,
        chapterName: chapterLabel(chapterNames.get(row.chapterId)),
      }));
    } finally {
      loading = false;
    }

    // Rows for series that are not in the library get their names from the titles we have seen
    // before, and only then from the source. This is what turns a raw id into "Black Clover".
    const unknown = [...new Set(rows.filter((row) => row.title === "Unknown title").map((row) => row.seriesId))];
    if (unknown.length === 0) return;
    await Promise.all(
      unknown.slice(0, 12).map(async (seriesId) => {
        const meta = await library.resolveSeriesMeta(seriesId);
        if (meta === null) return;
        const names = new Map<string, string>();
        if (rows.some((row) => row.seriesId === seriesId && row.chapterName === "Chapter")) {
          try {
            for (const chapter of await library.chapters(seriesId)) names.set(chapter.id, chapter.name);
          } catch {
            // A dead source must not empty the list: the rows keep their placeholder.
          }
        }
        rows = rows.map((row) =>
          row.seriesId === seriesId
            ? {
                ...row,
                title: seriesLabel(meta.title),
                ...(meta.cover === undefined ? {} : { cover: meta.cover }),
                chapterName: chapterLabel(names.get(row.chapterId) ?? row.chapterName),
              }
            : row,
        );
      }),
    );
  }

  /** seriesId -> source id, from the stored mapping. */
  let mappedSource = $state<Map<string, string>>(new Map());

  /**
   * The same rule the library uses, so hiding a category or a source takes its history with it.
   *
   * The row is dropped, not greyed: a hidden shelf that still fills History has not been hidden, it
   * has been labelled.
   */
  const shown = $derived(
    rows.filter((row) =>
      !isHidden(
        { id: row.seriesId, categoryIds: row.categoryIds },
        contextOf({
          categories: categories.items,
          sources: sourceMarks.marks,
          sourceOf: (seriesId: string) => sourceKeyOf(seriesId, mappedSource.get(seriesId)),
        }),
      ),
    ),
  );

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
    for (const row of shown) {
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
    <span class="count">{shown.length}</span>
  </header>

  {#if loading}
    <p class="empty">Reading history…</p>
  {:else if shown.length === 0}
    <div class="blank">
      <p class="blankline">Nothing read yet.</p>
      <p class="blanksub">Chapters you open land here, newest first, with the page you stopped on.</p>
      <button class="btn primary" onclick={() => go("/library")}>Go to the library</button>
    </div>
  {:else}
    {#if isSqueezed}
      <p class="squeeze">Two panes need a wider window — showing one until there is room.</p>
    {/if}
    <div class="panes" class:split={mode === "split"} style:--ratio={ratio}>
    {#each groups as group (group.label)}
      <section class="group">
        <h2>{group.label}</h2>
        <ul class="rows">
          {#each group.rows as row (row.chapterId)}
            <li>
              <div class="row" class:on={mode === "split" && pickedRow?.chapterId === row.chapterId}>
                <button class="hit" aria-label={`${row.title} — ${row.chapterName}`} onclick={() => open(row)}></button>
                <Cover series={{ title: row.title, cover: row.cover }} size="row" />
                <div class="info">
                  <span class="t">{row.title}</span>
                  <span class="s">{row.chapterName} · page {row.page + 1} · {ago(row.at)}</span>
                </div>
                {#if mode !== "split"}
                  <button class="btn ghost" onclick={() => open(row)}>Continue</button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      </section>
    {/each}

    {#if mode === "split" && pickedRow !== null}
      <aside class="detail" aria-label="Selected entry">
        <div class="dcover">
          <Cover series={{ title: pickedRow.title, cover: pickedRow.cover }} size="hero" />
        </div>
        <h2 class="dtitle">{pickedRow.title}</h2>
        <p class="dsub">{pickedRow.chapterName}</p>
        <dl class="dfacts">
          <div><dt>Page</dt><dd>{pickedRow.page + 1}</dd></div>
          <div><dt>Last read</dt><dd>{ago(pickedRow.at)}</dd></div>
          <div><dt>Source</dt><dd>{sourceLabel(pickedRow.seriesId)}</dd></div>
        </dl>
        <button class="btn primary" onclick={() => go(pathTo("read", pickedRow.seriesId, pickedRow.chapterId))}>
          Continue reading
        </button>
      </aside>
    {/if}
    </div>
  {/if}
</section>

<style>
  .panes.split {
    display: grid;
    grid-template-columns: minmax(0, calc(var(--ratio) * 100% - 12px)) minmax(0, 1fr);
    gap: 24px;
    align-items: start;
  }

  .panes.split .rows {
    min-width: 0;
  }

  .detail {
    position: sticky;
    top: var(--pad-y);
    display: grid;
    gap: var(--s3);
    padding: var(--s4);
    border: 1px solid var(--line);
    border-radius: var(--r2);
    background: var(--surface);
  }

  .detail .dcover {
    max-width: 220px;
  }

  .dtitle {
    font-size: var(--t-lg);
    font-weight: 650;
  }

  .dsub {
    color: var(--text-2);
    font-size: var(--t-sm);
  }

  .dfacts {
    display: grid;
    gap: var(--s2);
    margin: 0;
    font-size: var(--t-sm);
  }

  .dfacts > div {
    display: flex;
    justify-content: space-between;
    gap: var(--s3);
  }

  .dfacts dt {
    color: var(--text-3);
  }

  .dfacts dd {
    margin: 0;
    color: var(--text-1);
  }

  .squeeze {
    margin: 0 0 var(--s3);
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .row {
    position: relative;
  }

  .row.on {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    border-radius: var(--r2);
  }

  .hit {
    all: unset;
    position: absolute;
    inset: 0;
    cursor: pointer;
  }

  .view {
    padding: var(--s4) var(--s4) var(--s7);
    max-width: 820px;
  }

  .top {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
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
