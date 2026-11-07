<script lang="ts">
  import { privacy } from "../state/privacy.svelte";
  /**
   * What tapping a title in a source should offer: read it, keep it, download it, or file it.
   *
   * Three things this is careful about.
   *
   * **Adding is one tap and lands in Uncategorized**, because that is what `categoryIds: []` means and
   * what a Mihon backup writes. Nothing is invented and nothing is guessed.
   *
   * **Uncategorized is a row, not a category.** It is ticked exactly when the title is in nothing, and
   * choosing any shelf clears it — a title cannot be both, because the store cannot hold both.
   *
   * **A count is the whole library's**, including the title being filed. A shelf that says 12 and holds
   * what you are looking at is the truth; a number that changed as you toggled would read as a bug.
   *
   * The four verbs are one row: Add to library keeps its words, Download and Categories are icon
   * buttons beside it, so the sheet's header can carry a larger cover instead of four full-width
   * rows. Categories opens the picker in this same sheet, with a list/grid choice for a library that
   * grows past a handful of shelves.
   */
  import type { Chapter, Series } from "../api/source";
  import { go, pathTo } from "../lib/nav";
  import { library } from "../state/library.svelte";
  import { categories } from "../state/categories.svelte";
  import { downloads } from "../state/downloads.svelte";
  import { plugins } from "../state/plugins.svelte";
  import Sheet from "./Sheet.svelte";
  import Cover from "./Cover.svelte";
  import {
    UNCATEGORIZED_ID,
    assignmentLabel,
    DOWNLOAD_LIMIT,
    downloadCandidates,
    downloadLabel,
    pickerModel,
    CHAPTER_TIMEOUT_MS,
    readTarget,
    toggleAssignment,
    withTimeout,
  } from "../lib/library/quick-actions";

  interface Props {
    /** The title the sheet is about; `null` closes it. */
    series: Series | null;
    onclose: () => void;
    /** The full series page, for the case where there is nothing to read yet. */
    ondetails?: (series: Series) => void;
  }
  let { series, onclose, ondetails }: Props = $props();

  let view = $state<"actions" | "categories">("actions");
  /**
   * How the picker draws its shelves. A list is what a handful of categories look like; a grid is
   * what thirty of them need. The choice is per open, not a stored preference — the sheet is a
   * moment, and the default list is the shape the owner already liked.
   */
  let layout = $state<"list" | "grid">("list");
  let saved = $state(false);
  let categoryIds = $state<string[]>([]);
  let chapters = $state<Chapter[]>([]);
  let loaded = $state(false);
  let busy = $state<"read" | "download" | "save" | null>(null);
  let notice = $state("");
  let newName = $state("");
  let creating = $state(false);
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  const id = $derived(series?.id ?? "");
  /** The plugin entries this sheet shows: series-page actions, from plugins that are running. */
  const pluginActions = $derived(plugins.actionsFor("series"));

  const model = $derived(pickerModel(categories.items.filter((c) => !privacy.locked || !c.hidden), { categoryIds }, library.library));
  const names = $derived(
    model.rows.filter((entry) => entry.checked).map((entry) => entry.name),
  );
  /** What the picker says about itself, in the places a two-line label no longer fits. */
  const filed = $derived(assignmentLabel(names));
  // Chapters this tap could still fetch: not on the device and not already waiting in the queue.
  const queued = $derived(
    loaded
      ? downloadCandidates(
          chapters,
          (chapterId) => downloads.isDownloaded(chapterId) || downloads.inQueue(chapterId),
        ).length
      : 0,
  );
  /** Chapters of this series already queued or in flight, so the row can say so. */
  const downloading = $derived(loaded && chapters.some((chapter) => downloads.inQueue(chapter.id)));
  const downloadWords = $derived(downloadLabel(queued, busy === "download", loaded, downloading));

  // A new title resets the sheet: the last one's state must not leak into this one.
  $effect(() => {
    const wanted = series;
    view = "actions";
    layout = "list";
    notice = "";
    newName = "";
    loaded = false;
    chapters = [];
    if (wanted === null) return;
    categoryIds = wanted.categoryIds ?? [];
    void (async () => {
      saved = await library.isSaved(wanted.id);
      const mine = library.library.find((entry) => entry.id === wanted.id);
      if (mine !== undefined) categoryIds = mine.categoryIds ?? [];
    })();
  });

  function say(message: string): void {
    notice = message;
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice = ""), 2600);
  }

  /** Chapters once: the read and download rows both need them, and neither should refetch. */
  async function ensureChapters(): Promise<Chapter[]> {
    if (loaded) return chapters;
    // A host that is down answers by never answering; six seconds is long enough to know.
    chapters = await withTimeout(library.chapters(id), CHAPTER_TIMEOUT_MS, []);
    if (chapters.length === 0) {
      // The list may still arrive; the next open asks again rather than remembering nothing.
      loaded = false;
      return chapters;
    }
    loaded = true;
    return chapters;
  }

  async function read(): Promise<void> {
    if (series === null) return;
    // `series` is a prop: closing the sheet sets the parent's state to null, and the getter here is
    // live. Reading `series.id` after `onclose()` threw "Cannot read properties of null (reading
    // 'id')" — a Read button that worked only while its own sheet was still open. The ids are taken
    // first, then the sheet closes.
    const chapterOwner = series.id;
    busy = "read";
    try {
      const target = readTarget(await ensureChapters());
      if (target !== null) {
        const chapterId = target.id;
        onclose();
        go(pathTo("read", chapterOwner, chapterId));
        return;
      }
      // Nothing to read yet: the series page is where the chapters will be, not an empty reader.
      onclose();
      if (ondetails !== undefined) ondetails({ ...series });
      else go(pathTo("series", chapterOwner));
    } finally {
      busy = null;
    }
  }

  async function addToLibrary(): Promise<void> {
    if (series === null || saved) return;
    busy = "save";
    try {
      // Uncategorized is the default and the only thing "add" means: no categories, no guessing.
      await library.save({ ...series, categoryIds: [] }, await ensureChapters());
      categoryIds = [];
      saved = true;
      say("Added to your library · Uncategorized");
    } finally {
      busy = null;
    }
  }

  async function download(): Promise<void> {
    if (series === null) return;
    busy = "download";
    try {
      const all = await ensureChapters();
      const missing = downloadCandidates(all, (chapterId) => downloads.isDownloaded(chapterId), all.length);
      if (missing.length === 0) {
        say("Already downloaded");
        return;
      }
      const candidates = missing.slice(0, DOWNLOAD_LIMIT);
      downloads.enqueueMany(series.id, candidates);
      say(
        missing.length > candidates.length
          ? `Queued ${candidates.length} of ${missing.length} chapters`
          : candidates.length === 1
            ? "Queued 1 chapter"
            : `Queued ${candidates.length} chapters`,
      );
    } finally {
      busy = null;
    }
  }

  /** A category can only hold a title that is in the library, so filing adds first. */
  async function ensureSaved(): Promise<boolean> {
    if (saved) return true;
    if (series === null) return false;
    await library.save({ ...series, categoryIds }, await ensureChapters());
    saved = true;
    return true;
  }

  async function toggle(rowId: string): Promise<void> {
    if (privacy.locked) return;
    if (series === null) return;
    if (!(await ensureSaved())) return;
    const next = toggleAssignment(categoryIds, rowId);
    categoryIds = next;
    await categories.assign(series.id, next);
    // The counts and every "In library" row read `library.library`; without this the shelf you just
    // filed into still says 0 and the one you left still counts this title.
    await library.refreshLibrary();
    const label = assignmentLabel(next.map((entry) => categories.items.find((c) => c.id === entry && (!privacy.locked || !c.hidden))?.name ?? "").filter(Boolean));
    say(next.length === 0 ? "Moved to Uncategorized" : `Filed under ${label}`);
  }

  async function create(): Promise<void> {
    if (privacy.locked) return;
    const name = newName.trim();
    if (name === "" || creating) return;
    creating = true;
    try {
      const created = await categories.create(name);
      if (created === null) {
        say("That name is already taken");
        return;
      }
      newName = "";
      await toggle(created.id);
    } finally {
      creating = false;
    }
  }
  $effect(() => { if (privacy.locked) { view = "actions"; notice = ""; } });
</script>

<Sheet open={series !== null} title={view === "actions" ? (series?.title ?? "") : "Categories"} onclose={onclose}>
  {#if series !== null}
    {#if view === "actions"}
      <div class="who">
        <button class="thumb" onclick={() => { const opened = { ...series }; onclose(); if (ondetails !== undefined) ondetails(opened); else go(pathTo("series", opened.id)); }} aria-label="Open {series.title}">
          <Cover {series} />
        </button>
        <div class="meta">
          <p class="author">{series.author ?? series.provider}</p>
          {#if series.status}<p class="status">{series.status}</p>{/if}
          <p class="filed">{filed}</p>
        </div>
      </div>

      <div class="acts">
        <button class="act" disabled={busy !== null} onclick={() => void read()}>
          <span class="glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" /></svg>
          </span>
          <span class="words"><strong>Read</strong><em>{chapters.length === 0 ? "Open the series" : "Continue where you are"}</em></span>
        </button>
      </div>

      <!--
        The three verbs that are not "read" share one row. Add to library keeps its words — it is the
        one a new title needs to find — and Download and Categories are 48px icon buttons beside it,
        each carrying its own state as a small numeral so nothing the stacked rows said is lost.
      -->
      <div class="quick">
        <button class="act add" class:done={saved} disabled={busy !== null || saved} onclick={() => void addToLibrary()}>
          <span class="glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24">{#if saved}<path d="M5 12.5 10 17.5 19 7" />{:else}<path d="M12 5v14M5 12h14" />{/if}</svg>
          </span>
          <span class="words"><strong>{saved ? "In library" : "Add to library"}</strong><em>{saved ? "On this device" : "Kept on this device"}</em></span>
        </button>

        <button
          class="iconbtn"
          aria-label={`Download — ${downloadWords}`}
          title={downloadWords}
          disabled={busy !== null || (loaded && queued === 0)}
          onclick={() => void download()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 19h14" /></svg>
          {#if loaded && queued > 0}<span class="pip" aria-hidden="true">{queued}</span>{/if}
        </button>

        <button
          class="iconbtn cat"
          class:on={names.length > 0}
          aria-label={`Categories — ${filed}`}
          title={`Categories — ${filed}`}
          aria-haspopup="dialog"
          disabled={privacy.locked}
          onclick={() => (view = "categories")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v16l-5-3.5L7 20z" /></svg>
          {#if names.length > 0}<span class="pip" aria-hidden="true">{names.length}</span>{/if}
        </button>
      </div>

      {#if pluginActions.length > 0}
        <!--
          A plugin's own entry, in the same sheet as the app's own verbs — the manifest declared it,
          the user granted the permission, and it is dispatched by `<plugin>:<action>` so two plugins
          cannot shadow each other.
        -->
        <div class="acts">
          {#each pluginActions as action (action.pluginId + action.id)}
            <button class="act" onclick={() => { plugins.invoke(action.pluginId, action.id); onclose(); }}>
              <span class="glyph" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" /></svg>
              </span>
              <span class="words"><strong>{action.title}</strong><em>{action.pluginId}</em></span>
            </button>
          {/each}
        </div>
      {/if}

      {#if notice !== ""}<p class="notice" role="status">{notice}</p>{/if}
    {:else}
      <div class="ptools">
        <span class="ptext">{model.rows.length + 1} shelves</span>
        <div class="seg" role="group" aria-label="Category layout">
          <button class="segbtn" class:on={layout === "list"} aria-pressed={layout === "list"} aria-label="List view" title="List view" onclick={() => (layout = "list")}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <button class="segbtn" class:on={layout === "grid"} aria-pressed={layout === "grid"} aria-label="Grid view" title="Grid view" onclick={() => (layout = "grid")}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" /></svg>
          </button>
        </div>
      </div>

      <div class="picker {layout}">
        <button
          class="row"
          class:on={model.uncategorized.checked}
          onclick={() => void toggle(UNCATEGORIZED_ID)}
          aria-pressed={model.uncategorized.checked}
        >
          <span class="check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7" /></svg></span>
          <span class="label">Uncategorized</span>
          <span class="count">{model.uncategorized.count}</span>
        </button>

        {#each model.rows as row (row.id)}
          <button class="row" class:on={row.checked} onclick={() => void toggle(row.id)} aria-pressed={row.checked}>
            <span class="check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7" /></svg></span>
            <span class="label">{row.name}</span>
            <span class="count">{row.count}</span>
          </button>
        {/each}

        {#if model.rows.length === 0}
          <p class="hint">No categories yet. The title sits in Uncategorized until you make one.</p>
        {/if}
      </div>

      <div class="new">
        <input
          class="field"
          bind:value={newName}
          placeholder="New category"
          aria-label="New category"
          enterkeyhint="done"
          onkeydown={(event) => { if (event.key === "Enter") void create(); }}
        />
        <button class="btn" disabled={creating || newName.trim() === ""} onclick={() => void create()}>
          {creating ? "Adding…" : "Add"}
        </button>
      </div>

      {#if notice !== ""}<p class="notice" role="status">{notice}</p>{/if}

      <div class="foot">
        <button class="btn ghost" onclick={() => (view = "actions")}>Back</button>
        <button class="btn" onclick={onclose}>Done</button>
      </div>
    {/if}
  {/if}
</Sheet>

<style>
  .who {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-bottom: 12px;
  }
  /* The artwork earns the width the stacked rows used to take: it is the one thing that says which
     title you are filing. */
  .thumb {
    width: clamp(64px, 20%, 92px);
    flex: 0 0 clamp(64px, 20%, 92px);
    aspect-ratio: 2 / 3;
    padding: 0;
    border: 0;
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface-2, #1a1a20);
    cursor: pointer;
  }
  .thumb :global(.cover) {
    width: 100%;
    height: 100%;
    border-radius: 8px;
  }
  .meta {
    min-width: 0;
  }
  .author,
  .status,
  .filed {
    margin: 0;
    font-size: var(--t-xs, 12px);
    color: var(--text-2, #9aa);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .filed {
    color: var(--accent, #6aa9ff);
  }

  .acts {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* One row per action: glyph, two lines of words, and room to press. The whole row is the target. */
  .act {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 12px 10px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: var(--text-1, #eef);
    text-align: left;
    cursor: pointer;
    transition: background 140ms ease, transform 90ms ease;
  }
  .act:active {
    transform: scale(0.985);
    background: var(--surface-2, #22222a);
  }
  .act:disabled {
    cursor: default;
    opacity: 0.55;
  }
  .act.done {
    opacity: 1;
    color: var(--accent, #6aa9ff);
  }
  .glyph {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    flex: 0 0 34px;
    border-radius: 10px;
    background: var(--surface-2, #22222a);
    transition: background 160ms ease, color 160ms ease;
  }
  .act.done .glyph {
    background: color-mix(in srgb, var(--accent, #6aa9ff) 22%, transparent);
  }
  .glyph svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .words {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .words strong {
    font-weight: 600;
    font-size: var(--t-md, 15px);
  }
  .words em {
    font-style: normal;
    font-size: var(--t-xs, 12px);
    color: var(--text-2, #9aa);
  }

  /* Add to library grows; the two icon buttons stay a thumb's width. */
  .quick {
    display: flex;
    align-items: stretch;
    gap: 8px;
    margin-top: 2px;
  }
  .quick .act {
    flex: 1;
    min-width: 0;
  }
  .iconbtn {
    position: relative;
    display: grid;
    place-items: center;
    flex: 0 0 48px;
    width: 48px;
    min-height: 48px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
  }
  .iconbtn svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .iconbtn:active {
    background: var(--surface-2);
  }
  .iconbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* Filed: the same accent the shelf chips use, so the button answers "is this filed?" at a glance. */
  .iconbtn.on {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .iconbtn.cat.on svg {
    fill: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .pip {
    position: absolute;
    top: 3px;
    right: 3px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 999px;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--accent-ink, #0b1020);
    font-size: 10px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .notice {
    margin: 10px 0 0;
    padding: 8px 12px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent, #6aa9ff) 16%, transparent);
    color: var(--text-1, #eef);
    font-size: var(--t-xs, 12px);
  }

  /* The picker's own toolbar: how many shelves, and how they are drawn. */
  .ptools {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .ptext {
    font-size: var(--t-xs, 12px);
    color: var(--text-3);
  }
  .seg {
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: 10px;
    background: var(--surface-2);
  }
  .segbtn {
    display: grid;
    place-items: center;
    width: 40px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
  }
  .segbtn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }
  .segbtn.on {
    background: var(--elevated);
    color: var(--text-1);
  }

  .picker {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 46vh;
    overflow-y: auto;
  }
  .picker.grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
    gap: 6px;
    align-content: start;
  }

  /*
   * The toggle. Off is a hollow ring on a hairline over nothing — greyer words, quieter surface —
   * and on is the accent with a check drawn in: the same shape in both states so the row does not
   * jump, and the tick animates in rather than appearing.
   */
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 10px;
    border: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
    border-radius: 12px;
    background: transparent;
    color: var(--text-3);
    text-align: left;
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
  }
  .row:active {
    background: var(--surface-2, #22222a);
  }
  .row.on {
    color: var(--text-1);
    border-color: color-mix(in srgb, var(--accent, #6aa9ff) 45%, transparent);
    background: color-mix(in srgb, var(--accent, #6aa9ff) 14%, transparent);
  }
  .check {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    flex: 0 0 22px;
    border-radius: 999px;
    border: 1.5px solid color-mix(in srgb, var(--text-3) 60%, transparent);
    background: transparent;
    transition: background 160ms ease, border-color 160ms ease;
  }
  .check svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: #fff;
    stroke-width: 2.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0;
    transform: scale(0.6);
    transition: opacity 150ms ease, transform 180ms cubic-bezier(0.2, 1.4, 0.4, 1);
  }
  .row.on .check {
    background: var(--accent, #6aa9ff);
    border-color: var(--accent, #6aa9ff);
  }
  .row.on .check svg {
    opacity: 1;
    transform: scale(1);
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    font-size: var(--t-xs, 12px);
    font-variant-numeric: tabular-nums;
    color: var(--text-3);
    padding: 2px 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-2) 70%, transparent);
  }
  .row.on .count {
    color: var(--text-2);
    background: color-mix(in srgb, var(--accent, #6aa9ff) 12%, transparent);
  }

  /*
   * Grid chips: the tick sits in the corner rather than in a column of its own, so the name gets the
   * width of the chip. A name that still does not fit wraps at a word, and only an absurdly long one
   * breaks inside a word — `display: -webkit-box` is deliberately not used here: this browser
   * resolves it to `flow-root`, which turned every "Uncategorized" chip into "Uncateg…".
   */
  .picker.grid .row {
    position: relative;
    display: block;
    padding: 8px 9px;
    min-height: 62px;
  }
  .picker.grid .label {
    display: block;
    white-space: normal;
    overflow-wrap: anywhere;
    text-overflow: clip;
    padding-right: 18px;
    font-size: var(--t-xs, 12px);
    line-height: 1.3;
    max-height: 2.6em;
    overflow: hidden;
  }
  .picker.grid .count {
    display: block;
    margin-top: 2px;
    padding: 0;
    background: transparent;
    font-size: var(--t-xs, 12px);
  }
  .picker.grid .check {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 18px;
    height: 18px;
    flex: none;
  }
  .picker.grid .check svg {
    width: 12px;
    height: 12px;
  }

  .new {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .field {
    flex: 1;
    min-width: 0;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--edge, #3a3a44);
    background: var(--surface-2, #22222a);
    color: var(--text-1, #eef);
    /* 16px stops iOS zooming the whole app when the field is focused. */
    font-size: 16px;
  }
  .foot {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: 14px;
  }
  .hint {
    margin: 10px 2px;
    font-size: var(--t-xs, 12px);
    color: var(--text-2, #9aa);
  }

  /*
   * Very narrow sheet: the quick row wraps, and the icons stay icons on their own line rather than
   * turning into full-width rows again — a stacked Download is still 48px of a 320px screen.
   */
  @media (max-width: 330px) {
    .quick {
      flex-wrap: wrap;
    }
    .quick .act {
      flex: 1 1 100%;
    }
    .quick .iconbtn {
      flex: 1 1 48px;
    }
  }
</style>
