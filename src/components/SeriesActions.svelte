<script lang="ts">
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
   */
  import type { Chapter, Series } from "../api/source";
  import { go, pathTo } from "../lib/nav";
  import { library } from "../state/library.svelte";
  import { categories } from "../state/categories.svelte";
  import { downloads } from "../state/downloads.svelte";
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

  const model = $derived(pickerModel(categories.items, { categoryIds }, library.library));
  const names = $derived(
    model.rows.filter((entry) => entry.checked).map((entry) => entry.name),
  );
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

  // A new title resets the sheet: the last one's state must not leak into this one.
  $effect(() => {
    const wanted = series;
    view = "actions";
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
    busy = "read";
    try {
      const target = readTarget(await ensureChapters());
      if (target !== null) {
        onclose();
        go(pathTo("read", series.id, target.id));
        return;
      }
      // Nothing to read yet: the series page is where the chapters will be, not an empty reader.
      onclose();
      if (ondetails !== undefined) ondetails(series);
      else go(pathTo("series", series.id));
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
    if (series === null) return;
    if (!(await ensureSaved())) return;
    const next = toggleAssignment(categoryIds, rowId);
    categoryIds = next;
    await categories.assign(series.id, next);
    // The counts and every "In library" row read `library.library`; without this the shelf you just
    // filed into still says 0 and the one you left still counts this title.
    await library.refreshLibrary();
    const label = assignmentLabel(next.map((entry) => categories.items.find((c) => c.id === entry)?.name ?? "").filter(Boolean));
    say(next.length === 0 ? "Moved to Uncategorized" : `Filed under ${label}`);
  }

  async function create(): Promise<void> {
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
</script>

<Sheet open={series !== null} title={view === "actions" ? (series?.title ?? "") : "Categories"} onclose={onclose}>
  {#if series !== null}
    {#if view === "actions"}
      <div class="who">
        <button class="thumb" onclick={() => { onclose(); if (ondetails !== undefined) ondetails(series); else go(pathTo("series", series.id)); }} aria-label="Open {series.title}">
          <Cover {series} size="row" />
        </button>
        <div class="meta">
          <p class="author">{series.author ?? series.provider}</p>
          {#if series.status}<p class="status">{series.status}</p>{/if}
          <p class="filed">{assignmentLabel(names)}</p>
        </div>
      </div>

      <div class="acts">
        <button class="act" disabled={busy !== null} onclick={() => void read()}>
          <span class="glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" /></svg>
          </span>
          <span class="words"><strong>Read</strong><em>{chapters.length === 0 ? "Open the series" : "Continue where you are"}</em></span>
        </button>

        <button class="act" class:done={saved} disabled={busy !== null || saved} onclick={() => void addToLibrary()}>
          <span class="glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24">{#if saved}<path d="M5 12.5 10 17.5 19 7" />{:else}<path d="M12 5v14M5 12h14" />{/if}</svg>
          </span>
          <span class="words"><strong>{saved ? "In library" : "Add to library"}</strong><em>{saved ? "On this device" : "Kept on this device"}</em></span>
        </button>

        <button class="act" disabled={busy !== null || (loaded && queued === 0)} onclick={() => void download()}>
          <span class="glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 19h14" /></svg>
          </span>
          <span class="words"><strong>Download</strong><em>{downloadLabel(queued, busy === "download", loaded, downloading)}</em></span>
        </button>

        <button class="act" onclick={() => (view = "categories")}>
          <span class="glyph bookmark" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M7 4h10v16l-5-3.5L7 20z" /></svg>
          </span>
          <span class="words"><strong>Categories</strong><em>{assignmentLabel(names)}</em></span>
          <span class="chev" aria-hidden="true">›</span>
        </button>
      </div>

      {#if notice !== ""}<p class="notice" role="status">{notice}</p>{/if}
    {:else}
      <div class="picker">
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
  .thumb {
    width: 56px;
    flex: 0 0 56px;
    aspect-ratio: 2 / 3;
    padding: 0;
    border: 0;
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface-2, #1a1a20);
    cursor: pointer;
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
  .glyph.bookmark svg {
    fill: none;
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
  .chev {
    color: var(--text-2, #9aa);
    font-size: 20px;
    line-height: 1;
  }

  .notice {
    margin: 10px 0 0;
    padding: 8px 12px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent, #6aa9ff) 16%, transparent);
    color: var(--text-1, #eef);
    font-size: var(--t-xs, 12px);
  }

  .picker {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 46vh;
    overflow-y: auto;
  }

  /*
   * The toggle. Off is a hollow ring, on is the accent with a check drawn in — the same shape in both
   * states so the row does not jump, and the tick animates in rather than appearing.
   */
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 11px 10px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: var(--text-1, #eef);
    text-align: left;
    cursor: pointer;
    transition: background 140ms ease;
  }
  .row:active {
    background: var(--surface-2, #22222a);
  }
  .row.on {
    background: color-mix(in srgb, var(--accent, #6aa9ff) 12%, transparent);
  }
  .check {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    flex: 0 0 24px;
    border-radius: 999px;
    border: 1.5px solid var(--edge, #3a3a44);
    background: transparent;
    transition: background 160ms ease, border-color 160ms ease;
  }
  .check svg {
    width: 14px;
    height: 14px;
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
    color: var(--text-2, #9aa);
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--surface-2, #22222a);
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
</style>
