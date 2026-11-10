<script lang="ts">
  /**
   * History: where you were, grouped the way a person remembers it.
   *
   * It is a shortcut back into a book, not an audit log — so each row is a cover, the chapter, how
   * long ago, and the row itself is the way back in: a Continue button beside it repeated what a tap
   * already does and cost the width the chapter name needed.
   */
  import Sheet from "../components/Sheet.svelte";
  import HistorySettingsPanel from "../components/HistorySettingsPanel.svelte";
  import { tick } from "svelte";
  import { incognito } from "../state/incognito.svelte";
  import { INCOGNITO_PATH } from "../lib/marks";

  /** A box, empty and ticked: the selection toggle is one control in two states. */
  const EMPTY_BOX = "M4 4h16v16H4z";
  const CHECKED_BOX = "M4 4h16v16H4zM8 12.2l2.6 2.6L16.4 9";
  import { historyGroups, historySwipe, selectedHistoryIds, toggleHistoryPin } from "../lib/history-controls";
  import { privacy } from "../state/privacy.svelte";
  import { library } from "../state/library.svelte";
  import Cover from "../components/Cover.svelte";
  import PageMenu from "../components/PageMenu.svelte";
  import { go, pathTo } from "../lib/nav";
  import { chapterLabel, seriesLabel } from "../lib/titles";
  import { settings } from "../state/settings.svelte";
  import { viewport } from "../lib/layout.svelte";
  import { paneMode, paneRatio, squeezed } from "../lib/view-options";
  import { categories } from "../state/categories.svelte";
  import { sourceMarks } from "../state/source-marks.svelte";
  import { contextOf, isHidden, sourceKeyOf } from "../lib/marks";
  import { MARKER_PATH } from "../lib/categories";

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
  let selecting = $state(false);
  let selected = $state<Set<string>>(new Set());
  let revealed = $state<string | null>(null);
  let pending = $state<string[]>([]);
  let removing = $state(false);
  let error = $state<string | null>(null);
  let start: { x: number; y: number; id: number } | null = null;
  let swiped = false;

  /**
   * The History page's own options, in a popup here rather than a trip to Settings.
   *
   * The panel is the same component the Settings page draws; opening it does not touch the route,
   * and closing it hands focus back to the gear.
   */
  let settingsOpen = $state(false);
  let gear = $state<HTMLButtonElement | null>(null);

  function closeSettings(): void {
    settingsOpen = false;
    void tick().then(() => gear?.focus());
  }

  function toggleSelected(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    selected = next;
  }

  function pointerStart(event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    swiped = false;
  }

  function pointerEnd(event: PointerEvent, chapterId: string): void {
    if (start === null || start.id !== event.pointerId) return;
    const swipe = historySwipe(event.clientX - start.x, event.clientY - start.y);
    start = null;
    if (swipe === null || selecting) return;
    swiped = true;
    revealed = swipe === "reveal" ? chapterId : null;
  }

  async function removePending(): Promise<void> {
    removing = true;
    error = null;
    try {
      // Privacy marks may have changed while the confirmation was open.
      const ids = pending.filter((id) => shown.some((row) => row.chapterId === id));
      await library.removeHistoryEntries(ids);
      const removed = new Set(ids);
      rows = rows.filter((row) => !removed.has(row.chapterId));
      selected = new Set([...selected].filter((id) => !removed.has(id)));
      pending = [];
      revealed = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally { removing = false; }
  }
  /** The row shown in the detail pane when there is one. */
  let picked = $state<string | null>(null);

  const mode = $derived(paneMode(settings.historyPane, viewport.width));
  const isSqueezed = $derived(squeezed(settings.historyPane, viewport.width));
  const ratio = $derived(paneRatio(settings.splitRatio, viewport.width));

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
    if (swiped) { swiped = false; return; }
    if (selecting) { toggleSelected(row.chapterId); return; }
    if (revealed !== null) { revealed = null; return; }
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
      // The whole mapping, not just the source id: a migrated title is governed by the source it
    // reads from now, and only the mapping knows which one that is.
    mappedSource = new Map(mappings.map((row) => [row.seriesId, { provider: row.provider, sourceId: row.sourceId }]));
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
  let mappedSource = $state<Map<string, { provider: string; sourceId: string }>>(new Map());

  /**
   * The same rule the library uses, so hiding a category or a source takes its history with it.
   *
   * The row is dropped, not greyed: a hidden shelf that still fills History has not been hidden, it
   * has been labelled.
   */
  const shown = $derived(
    rows.filter((row) => (!privacy.locked || (categories.loaded && sourceMarks.loaded)) &&
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

  const selectedIds = $derived(selectedHistoryIds(selected, shown));

  // A previously picked private row must not survive in the split detail pane.
  const pickedRow = $derived(shown.find((row) => row.chapterId === picked) ?? shown[0] ?? null);

  const groups = $derived.by(() => historyGroups(shown, settings.historyPins));

  /** Is this title pinned? Pin state is per series, so every row of it says the same. */
  function isPinned(seriesId: string): boolean {
    return settings.historyPins.includes(seriesId);
  }

  function togglePin(seriesId: string): void {
    settings.set("historyPins", toggleHistoryPin(settings.historyPins, seriesId));
  }

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
  <div class="pin">
  <header class="top">
    <div class="headline">
      <PageMenu title="History" current="history" />
      <span class="count">{shown.length}</span>
    </div>
    <!--
      The pills and the gear travel together: at 390 px the group is wider than the space left
      beside the title, so the whole group drops to its own line, right-aligned, rather than the
      gear being stranded on the left under the heading.
    -->
    <div class="tools">
    <!-- Two toggles, two glyphs: a ghost for incognito and a ticked box for selection. The words took 190 px of a 390 px bar and pushed everything else onto a second line. -->
    <button
      class="btn ghost icon"
      class:on={incognito.active}
      aria-pressed={incognito.active}
      aria-label={incognito.active ? "Turn incognito off" : "Turn incognito on"}
      title={incognito.active ? "Incognito is on — history and sessions are paused" : "Incognito: read without leaving history"}
      onclick={() => incognito.toggle()}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={INCOGNITO_PATH} /></svg>
    </button>
    <button
      class="btn ghost icon"
      class:on={selecting}
      aria-pressed={selecting}
      aria-label={selecting ? "Done selecting" : "Select rows"}
      title={selecting ? "Done selecting" : "Select rows"}
      onclick={() => { selecting = !selecting; selected = new Set(); revealed = null; }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={selecting ? CHECKED_BOX : EMPTY_BOX} /></svg>
    </button>
    <button
      class="btn ghost icon gear"
      bind:this={gear}
      aria-label="History settings"
      title="History settings"
      aria-haspopup="dialog"
      onclick={() => (settingsOpen = true)}
    >
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="3.2" />
        <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
      </svg>
    </button>
    </div>
  </header>
  {#if incognito.active}<p class="privacy-note" role="status">Incognito is on until you turn it off or restart the app. History and reading sessions are paused; progress and read marks still save.</p>{:else if settings.historyPaused}<p class="privacy-note">History is paused in Settings.</p>{/if}
  {#if selecting}
    <div class="selection-actions">
      <span>{selectedIds.length} selected</span>
      <button class="btn" onclick={() => selected = new Set(shown.map((row) => row.chapterId))}>Select all</button>
      <button class="btn" disabled={selectedIds.length === 0} onclick={() => pending = [...selectedIds]}>Remove selected</button>
    </div>
  {/if}
  </div>
  {#if error && pending.length === 0}<p class="banner" role="alert">{error}</p>{/if}

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
    <div class="panes" class:split={mode === "split" && !selecting} style:--ratio={ratio}>
    {#each groups as group (group.label)}
      <section class="group">
        <h2>{group.label}</h2>
        <ul class="rows">
          {#each group.rows as row (row.chapterId)}
            <li class="entry" class:revealed={revealed === row.chapterId}>
              {#if revealed === row.chapterId}
                <div class="reveal-actions">
                  <button class="btn pin-action" aria-pressed={isPinned(row.seriesId)}
                    aria-label={`${isPinned(row.seriesId) ? "Unpin" : "Pin"} ${row.title} in History`}
                    onclick={() => togglePin(row.seriesId)}>{isPinned(row.seriesId) ? "Unpin" : "Pin"}</button>
                  <button class="btn remove" onclick={() => pending = [row.chapterId]}>Remove</button>
                </div>
              {/if}
              <div class="row" class:on={selecting ? selected.has(row.chapterId) : mode === "split" && pickedRow?.chapterId === row.chapterId}>
                <button class="hit" aria-label={`${selecting ? "Select " : ""}${row.title} — ${row.chapterName}`} aria-pressed={selecting ? selected.has(row.chapterId) : undefined}
                  onpointerdown={pointerStart} onpointerup={(event) => pointerEnd(event, row.chapterId)} onpointercancel={() => { start = null; swiped = false; }}
                  onclick={() => open(row)}></button>
                {#if selecting}<span class="check" aria-hidden="true">{selected.has(row.chapterId) ? "☑" : "☐"}</span>{/if}
                <Cover series={{ title: row.title, cover: row.cover }} size="row" />
                <div class="info">
                  <span class="t">
                    {#if isPinned(row.seriesId)}<svg class="pinned-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d={MARKER_PATH} /></svg>{/if}
                    {row.title}
                  </span>
                  <span class="s">{row.chapterName} · page {row.page + 1} · {ago(row.at)}</span>
                </div>
                {#if !selecting}
                  <button class="btn ghost action" aria-label={`Actions for ${row.title} — ${row.chapterName}`} aria-expanded={revealed === row.chapterId}
                    onclick={() => { swiped = false; revealed = revealed === row.chapterId ? null : row.chapterId; }}>⋯</button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      </section>
    {/each}

    {#if mode === "split" && pickedRow !== null && !selecting}
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

<Sheet open={settingsOpen} title="History settings" onclose={closeSettings}>
  <!-- The same component the Settings page renders: one implementation, two doors. -->
  <HistorySettingsPanel />
</Sheet>

<Sheet open={pending.length > 0} title="Remove reading history?" onclose={() => { if (!removing) { pending = []; error = null; } }}>
  <p>Remove {pending.length} {pending.length === 1 ? "entry" : "entries"} and their reading sessions? Progress, read marks, bookmarks and downloads will stay.</p>
  {#if error}<p class="banner" role="alert">{error}</p>{/if}
  <div class="selection-actions">
    <button class="btn" disabled={removing} onclick={() => { pending = []; error = null; }}>Cancel</button>
    <button class="btn" disabled={removing} onclick={() => void removePending()}>{removing ? "Removing…" : "Remove"}</button>
  </div>
</Sheet>

<style>
  .entry { position: relative; overflow: hidden; border-radius: var(--r2); }
  .entry .row { background: var(--surface); transition: transform 160ms ease; }
  .entry.revealed .row { transform: translateX(-196px); }
  .reveal-actions { position: absolute; top: 0; right: 0; bottom: 0; display: flex; width: 196px; }
  .reveal-actions .btn { flex: 1 1 0; min-width: 0; height: 100%; border-radius: 0; }
  .pinned-glyph { width: 12px; height: 12px; margin-right: 4px; vertical-align: -1px; fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; }
  .hit { touch-action: pan-y; }
  .action { position: relative; z-index: 1; }
  .privacy-note { font-size: var(--t-sm); color: var(--text-2); margin-bottom: var(--s3); }
  .selection-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); margin-block: var(--s3); }
  @media (prefers-reduced-motion: reduce) { .entry .row { transition: none; } }
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
    padding: var(--s3) var(--s4) var(--s7);
    --pad-x: var(--s4);
    --pad-y: var(--s3);
    max-width: 1200px;
  }

  .top {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s2);
    margin-bottom: var(--s4);
  }

  .headline {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    min-width: 0;
  }

  /* Pushed right as one group, so the gear keeps the top-right corner at every width. */
  .tools {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-left: auto;
  }

  .count {
    font-size: var(--t-sm);
    color: var(--text-3);
  }

  /* The gear keeps the page's glyph grammar: 18 px, stroked, no fill. */
  .gear svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
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
