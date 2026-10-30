<script lang="ts">
  /**
   * The cover grid, in three densities, and the one place a series tile is drawn.
   *
   * Columns are `auto-fill` over a minimum cover width, so the count is a consequence of the
   * space — never "two columns on a phone". The same component draws a source's results, the
   * library, and the left pane of a desktop split.
   */
  import type { Series } from "../api/source";
  import type { Badge } from "../lib/library/badges";
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
    /** Sort = Manual: a hold arms a drag, and releasing in place still selects. */
    reorderable?: boolean;
    /** A drag that ended on another tile, by id. */
    onmove?: (fromId: string, toId: string) => void;
    /** The pills a card may draw, per series. Absent means the plain unread count. */
    badges?: Map<string, Badge[]>;
    /** Where a resume would go, per series: a `▶` is drawn only when this has a chapter. */
    resume?: Map<string, string>;
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
    reorderable = false,
    onmove,
    badges = new Map(),
    resume = new Map(),
  }: Props = $props();

  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  /** The tile under a held finger, and whether that hold has turned into a drag. */
  let heldId = $state<string | null>(null);
  let dragId = $state<string | null>(null);
  let startX = 0;
  let startY = 0;

  /**
   * Two gestures share one press (§22).
   *
   * With `reorderable` on (sort = Manual) a hold only *arms* the tile: moving more than 8px makes it
   * a drag, releasing without moving still means selection. Everywhere else a hold is selection
   * immediately, exactly as before — a long press must never do nothing because the sort key changed.
   */
  function down(event: PointerEvent, item: Series) {
    if (event.pointerType === "mouse") return; // long-press is a touch gesture
    startX = event.clientX;
    startY = event.clientY;
    if (!reorderable) {
      pressTimer = setTimeout(() => {
        pressTimer = null;
        onlongpress?.(item);
      }, 450);
      return;
    }
    pressTimer = setTimeout(() => {
      pressTimer = null;
      heldId = item.id;
    }, 450);
  }

  function moved(event: PointerEvent) {
    if (heldId === null || dragId !== null) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 8) dragId = heldId;
  }

  /** The id of the tile under a point, so a drop lands on what the finger is over. */
  function tileAt(x: number, y: number): string | null {
    const hit = document.elementFromPoint(x, y)?.closest("[data-series-id]");
    return hit instanceof HTMLElement ? hit.dataset.seriesId ?? null : null;
  }

  function up(event: PointerEvent, item: Series) {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    const wasHeld = heldId !== null;
    const from = dragId;
    heldId = null;
    dragId = null;
    if (from !== null) {
      const to = tileAt(event.clientX, event.clientY);
      if (to !== null && to !== from) onmove?.(from, to);
      return;
    }
    // Held and released in place: that is the selection gesture, not a reorder.
    if (wasHeld) onlongpress?.(item);
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

  /** The pills for one card: the badge map when the view built one, else today's unread count. */
  function pillsFor(item: Series): Badge[] {
    const built = badges.get(item.id);
    if (built !== undefined) return built;
    const count = badgeFor(item.id);
    return count > 0 ? [{ kind: "unread", label: String(count), count }] : [];
  }

  /** One tap into the book, without opening the details page first (§15). */
  function resumeAt(event: MouseEvent, item: Series): void {
    event.stopPropagation();
    const chapterId = resume.get(item.id);
    if (chapterId !== undefined) go(pathTo("read", item.id, chapterId));
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
        class:held={heldId === item.id}
        class:dragging={dragId === item.id}
        data-series-id={item.id}
        aria-pressed={selection === null ? undefined : selection.has(item.id)}
        onclick={() => pick(item)}
        onpointerdown={(event) => down(event, item)}
        onpointermove={moved}
        onpointerup={(event) => up(event, item)}
        onpointercancel={(event) => up(event, item)}
        onpointerleave={(event) => up(event, item)}
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
            {#if pillsFor(item).length > 0}
              <span class="pills">
                {#each pillsFor(item) as pill (pill.kind)}
                  <span class="pill {pill.kind}">{pill.label}</span>
                {/each}
              </span>
            {/if}
            {#if resume.has(item.id)}
              <button
                class="resume"
                aria-label={`Resume ${item.title}`}
                onclick={(event) => resumeAt(event, item)}
              >▶</button>
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
  /* A held tile says so, because a hold now waits to learn whether it is a drag or a selection. */
  .tile.held {
    transform: scale(1.03);
    filter: drop-shadow(0 6px 14px rgb(0 0 0 / 35%));
    transition: transform 120ms ease;
  }
  .tile.dragging {
    opacity: 0.55;
  }
  @media (prefers-reduced-motion: reduce) {
    .tile.held {
      transform: none;
      transition: none;
    }
  }

  .pills {
    position: absolute;
    top: var(--s1);
    right: var(--s1);
    left: var(--s1);
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    justify-content: flex-end;
  }
  .pill {
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
    backdrop-filter: blur(2px);
  }
  .pill.downloaded {
    color: var(--accent);
  }
  .pill.new {
    background: var(--accent);
    color: var(--bg);
  }
  /* The resume button sits where a thumb reaches on a phone, not in the corner a badge owns. */
  .resume {
    position: absolute;
    right: var(--s1);
    bottom: var(--s1);
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 0;
    background: color-mix(in srgb, var(--accent) 88%, transparent);
    color: var(--bg);
    font-size: var(--t-sm);
    display: grid;
    place-items: center;
  }
  .resume:hover {
    background: var(--accent);
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
