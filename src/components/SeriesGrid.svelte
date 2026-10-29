<script lang="ts">
  /**
   * The cover grid, in three densities, and the one place a series tile is drawn.
   *
   * Columns are `auto-fill` over a minimum cover width, so the count is a consequence of the
   * space — never "two columns on a phone". The same component draws a source's results, the
   * library, and the left pane of a desktop split.
   */
  import type { Series } from "../api/source";
  import Cover from "./Cover.svelte";
  import { go, pathTo } from "../lib/nav";

  interface Props {
    series: Series[];
    view?: "grid" | "compact" | "list";
    /** Minimum cover width in px; the column count follows from it. */
    cover?: number;
    empty?: string;
    /** Highlighted in a split view without being "selected" for a bulk action. */
    current?: string | null;
    /** Non-null turns clicks into selection toggles. */
    selection?: Set<string> | null;
    unread?: Map<string, number>;
    /** Override the default "open the series page" click. */
    onpick?: (series: Series) => void;
    onselect?: (series: Series) => void;
    onlongpress?: (series: Series) => void;
  }
  let {
    series,
    view = "grid",
    cover = 132,
    empty = "Nothing here yet.",
    current = null,
    selection = null,
    unread = new Map(),
    onpick,
    onselect,
    onlongpress,
  }: Props = $props();

  let pressTimer: ReturnType<typeof setTimeout> | null = null;

  function down(event: PointerEvent, item: Series) {
    if (event.pointerType === "mouse") return; // long-press is a touch gesture
    pressTimer = setTimeout(() => {
      pressTimer = null;
      onlongpress?.(item);
    }, 450);
  }

  function up() {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  function pick(item: Series) {
    if (selection !== null) {
      onselect?.(item);
      return;
    }
    if (onpick !== undefined) onpick(item);
    else go(pathTo("series", item.id));
  }

  function badgeFor(id: string): number {
    return unread.get(id) ?? 0;
  }
</script>

{#if series.length === 0}
  <p class="empty">{empty}</p>
{:else}
  <div class="set {view}" style:--cover="{cover}px">
    {#each series as item (item.id)}
      <button
        class="tile"
        class:current={current === item.id}
        class:marked={selection?.has(item.id) === true}
        aria-pressed={selection === null ? undefined : selection.has(item.id)}
        onclick={() => pick(item)}
        onpointerdown={(event) => down(event, item)}
        onpointerup={up}
        onpointercancel={up}
        onpointerleave={up}
        oncontextmenu={(event) => {
          if (selection !== null) return;
          event.preventDefault();
          onlongpress?.(item);
        }}
      >
        {#if view === "list"}
          <Cover series={item} size="row" />
        {:else}
          <div class="art">
            <Cover series={item} />
            {#if badgeFor(item.id) > 0}
              <span class="badge">{badgeFor(item.id)}</span>
            {/if}
            {#if selection !== null}
              <span class="tick" aria-hidden="true">{selection.has(item.id) ? "✓" : ""}</span>
            {/if}
          </div>
        {/if}
        <span class="meta">
          <span class="title">{item.title}</span>
          {#if view === "list"}
            <span class="sub">{item.author ?? item.provider}</span>
          {:else if view === "compact"}
            <span class="sub">{badgeFor(item.id) > 0 ? `${badgeFor(item.id)} unread` : ""}</span>
          {:else}
            <span class="sub">{badgeFor(item.id) > 0 ? `${badgeFor(item.id)} unread` : "\u00a0"}</span>
          {/if}
        </span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .set.grid,
  .set.compact {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--cover), 1fr));
    gap: var(--s4) var(--s3);
  }
  .set.compact {
    grid-template-columns: repeat(auto-fill, minmax(calc(var(--cover) * 0.72), 1fr));
    gap: var(--s3) var(--s2);
  }
  .set.list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .tile {
    all: unset;
    cursor: pointer;
    display: grid;
    gap: var(--s2);
    min-width: 0;
    border-radius: var(--r2);
  }
  .set.list .tile {
    display: flex;
    align-items: center;
    gap: var(--s3);
    padding: var(--s2);
  }
  .set.list .tile:hover {
    background: var(--surface-2);
  }

  .art {
    position: relative;
  }
  .tile:hover :global(.cover) {
    outline: 1px solid var(--line-strong);
  }
  .tile.current :global(.cover) {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .tile.marked :global(.cover) {
    outline: 2px solid var(--accent);
  }

  .badge {
    position: absolute;
    top: var(--s1);
    right: var(--s1);
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    border-radius: var(--r-pill);
    background: color-mix(in srgb, var(--bg) 78%, transparent);
    color: var(--text-1);
    font-size: var(--t-xs);
    font-weight: 600;
    display: grid;
    place-items: center;
    backdrop-filter: blur(4px);
  }

  .tick {
    position: absolute;
    inset: 0;
    border-radius: var(--r2);
    background: color-mix(in srgb, var(--bg) 45%, transparent);
    color: var(--text-1);
    font-size: var(--t-xl);
    display: grid;
    place-items: center;
    opacity: 0;
    transition: opacity var(--dur);
  }
  .tile.marked .tick {
    opacity: 1;
  }

  .meta {
    display: grid;
    gap: 1px;
    min-width: 0;
  }
  .title {
    font-size: var(--t-sm);
    line-height: 1.3;
    color: var(--text-1);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .set.list .title {
    -webkit-line-clamp: 1;
  }
  .sub {
    font-size: var(--t-xs);
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
