<script lang="ts">
  /**
   * Continue reading: the covers of what you were reading, and the page you stopped on.
   *
   * A card is one tap back into the book, at the exact page — not the chapter's first page. The
   * long-press (the same 450 ms rule the grid uses) opens the six things a reader might want
   * instead: continue, details, restart the chapter, mark it read, download it, or take it off the
   * strip. Removing writes a preference and nothing else: the position, the library row and the
   * history row all survive, because "not here" is not "forget".
   */
  import Cover from "./Cover.svelte";
  import Sheet from "./Sheet.svelte";
  import { go, pathTo } from "../lib/nav";
  import { library } from "../state/library.svelte";
  import { downloads } from "../state/downloads.svelte";
  import { settings } from "../state/settings.svelte";
  import { chapterLabel, seriesLabel } from "../lib/titles";
  import type { ContinueRow } from "../lib/library/continue";

  interface Props {
    rows: ContinueRow[];
    size: "small" | "medium";
  }
  let { rows, size }: Props = $props();

  let menuRow = $state<ContinueRow | null>(null);
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressed = false;

  function down(event: PointerEvent, row: ContinueRow): void {
    if (event.pointerType === "mouse") return;
    longPressed = false;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      longPressed = true;
      menuRow = row;
    }, 450);
  }

  function up(): void {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  /** A long press must not also open the reader when the finger lifts. */
  function open(row: ContinueRow): void {
    if (longPressed) {
      longPressed = false;
      return;
    }
    go(pathTo("read", row.seriesId, row.chapterId));
  }

  async function markRead(row: ContinueRow): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    await store.setRead(row.chapterId, true);
    const provider = library.profile?.providers.find((p) => row.chapterId.startsWith(`${p.kind}:`));
    if (!library.ownsProgress(row.chapterId)) await provider?.setRead(row.chapterId, true).catch(() => {});
    menuRow = null;
  }

  function download(row: ContinueRow): void {
    downloads.enqueue(row.seriesId, {
      id: row.chapterId,
      seriesId: row.seriesId,
      name: chapterLabel(row.chapterName),
      number: 0,
      pageCount: 0,
      read: false,
    });
    menuRow = null;
  }

  function dismiss(row: ContinueRow): void {
    const next = [...new Set([...settings.continueDismissed, row.seriesId])];
    settings.set("continueDismissed", next);
    menuRow = null;
  }
</script>

<section class="continue" class:collapsed={settings.continueCollapsed} aria-label="Continue reading">
  <header class="head">
    <h2 class="t">
      <button
        class="fold"
        aria-expanded={!settings.continueCollapsed}
        aria-label={`${settings.continueCollapsed ? "Expand" : "Collapse"} Continue reading, ${rows.length} series`}
        onclick={() => settings.set("continueCollapsed", !settings.continueCollapsed)}
      >
        <span class="caret" aria-hidden="true">›</span>
        <span class="title">Continue reading</span>
        <span class="n">{rows.length}</span>
      </button>
    </h2>
    <button class="btn ghost" onclick={() => go("/history")}>See All</button>
  </header>
  {#if !settings.continueCollapsed}
  <div class="strip" class:medium={size === "medium"}>
    {#each rows as row (row.seriesId)}
      <button
        class="cont"
        aria-label={`Continue ${seriesLabel(row.title)}, ${chapterLabel(row.chapterName)}, page ${row.page + 1}`}
        onclick={() => open(row)}
        onpointerdown={(event) => down(event, row)}
        onpointerup={up}
        onpointercancel={up}
        onpointerleave={up}
        oncontextmenu={(event) => {
          event.preventDefault();
          menuRow = row;
        }}
      >
        <Cover series={{ title: seriesLabel(row.title), ...(row.cover === undefined ? {} : { cover: row.cover }) }} size="row" />
        <span class="body">
          <span class="t">{seriesLabel(row.title)}</span>
          <span class="p">{chapterLabel(row.chapterName)} · page {row.page + 1}</span>
          <span class="go">Continue</span>
        </span>
      </button>
    {/each}
  </div>
  {/if}
</section>

<Sheet open={menuRow !== null} title={menuRow === null ? "Continue reading" : seriesLabel(menuRow.title)} onclose={() => (menuRow = null)}>
  {#if menuRow !== null}
    {@const row = menuRow}
    <div class="menu-list">
      <button class="menu-item" onclick={() => go(pathTo("read", row.seriesId, row.chapterId))}>
        <span>Continue · page {row.page + 1}</span>
      </button>
      <button
        class="menu-item"
        onclick={() => {
          go(pathTo("series", row.seriesId));
          menuRow = null;
        }}
      >
        <span>Open details</span>
      </button>
      <button class="menu-item" onclick={() => go(pathTo("read", row.seriesId, row.chapterId))}>
        <span>Restart chapter</span>
      </button>
      <button class="menu-item" onclick={() => void markRead(row)}><span>Mark chapter read</span></button>
      <button class="menu-item" onclick={() => download(row)}><span>Download chapter</span></button>
      <button class="menu-item danger" onclick={() => dismiss(row)}><span>Remove from continue</span></button>
    </div>
  {/if}
</Sheet>

<style>
  .continue {
    margin-bottom: var(--s5);
  }

  /* Folded, the strip's own block is gone: the header keeps its line, the covers take none. */
  .continue.collapsed {
    margin-bottom: var(--s2);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    margin-bottom: var(--s2);
  }

  .continue.collapsed .head {
    margin-bottom: 0;
  }

  h2 {
    margin: 0;
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
  }

  .t {
    min-width: 0;
  }

  .fold {
    all: unset;
    box-sizing: border-box;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--s2);
    min-height: 44px;
    border-radius: var(--r2);
  }

  .fold:hover {
    color: var(--text-1);
  }

  .fold:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .caret {
    display: inline-block;
    font-size: var(--t-md);
    line-height: 1;
    color: var(--text-3);
    transition: transform 120ms ease;
  }

  .fold[aria-expanded="true"] .caret {
    transform: rotate(90deg);
  }

  .n {
    font-size: var(--t-xs);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }

  .head .btn {
    min-height: 28px;
    padding: 0 var(--s2);
    font-size: var(--t-xs);
  }

  .strip {
    display: flex;
    gap: var(--s2);
    overflow-x: auto;
    padding-bottom: var(--s1);
    scrollbar-width: none;
  }

  .strip::-webkit-scrollbar {
    display: none;
  }

  .cont {
    all: unset;
    cursor: pointer;
    flex: none;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: var(--s3);
    min-width: 200px;
    max-width: 260px;
    padding: var(--s2) var(--s3);
    border-radius: var(--r2);
    border: 1px solid var(--line);
    background: var(--surface);
    box-sizing: border-box;
  }

  /* A medium card is the same row with a taller cover — one decision, two sizes. */
  .strip.medium .cont {
    min-width: 232px;
    max-width: 300px;
    padding: var(--s3);
  }

  .cont:hover {
    border-color: var(--line-strong);
  }

  .cont .body {
    display: grid;
    gap: 1px;
    min-width: 0;
  }

  .t {
    font-size: var(--t-sm);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .p {
    font-size: var(--t-xs);
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .go {
    font-size: var(--t-xs);
    color: var(--accent);
    margin-top: 2px;
  }

  .menu-list {
    display: grid;
    gap: 2px;
  }

  .menu-item {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--s3);
    padding: var(--s3);
    border-radius: var(--r2);
    min-height: 44px;
    box-sizing: border-box;
    font-size: var(--t-md);
  }

  .menu-item:hover {
    background: var(--surface-2);
  }

  .menu-item.danger {
    color: var(--danger);
  }
</style>
