<script lang="ts">
  /**
   * The cover grid, in three densities, and the one place a series tile is drawn.
   *
   * Columns are `auto-fill` over a minimum cover width, so the count is a consequence of the
   * space — never "two columns on a phone". The same component draws a source's results, the
   * library, and the left pane of a desktop split.
   */
  import type { Snippet } from "svelte";
  import type { Series } from "../api/source";
  import type { Badge } from "../lib/library/badges";
  import Cover from "./Cover.svelte";
  import { browseMode, columnsFor, knownSize } from "../lib/browse-display";
  import { viewport } from "../lib/layout.svelte";
  import { go, pathTo } from "../lib/nav";

  /** A screenful and a bit; the rest arrives while the reader is still looking at the first row. */
  const FIRST_DRAW = 120;
  const GROW_BY = 250;

  /** `requestIdleCallback` where it exists, a macrotask where it does not — a missing one must not
   *  mean a library that never finishes drawing. */
  function schedule(run: () => void): number {
    if (typeof requestIdleCallback === "function") {
      return requestIdleCallback(run, { timeout: 200 }) as unknown as number;
    }
    return setTimeout(run, 16) as unknown as number;
  }

  function cancelSchedule(handle: number): void {
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle);
    else clearTimeout(handle);
  }

  interface Props {
    series: Series[];
    view?: "grid" | "compact" | "list" | "row" | "card";
    columns?: number;
    density?: "compact" | "larger";
    horizontal?: boolean;
    sizes?: Map<string, number>;
    totals?: Map<string, number>;
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
    /**
     * Titles already in the library.
     *
     * A search result and a shelf tile look identical otherwise, so the only way to tell "I have
     * this" at a glance is a mark on the tile. Not a badge: badges are a preference the user turns
     * on and off, and membership of your own library is not an opinion.
     */
    saved?: Set<string> | null;
    /**
     * A card that opens *in the grid*, after the tile with this id.
     *
     * Replace the clicked tile with a full-row expansion at the start of its existing row.
     * Opening below the tile forces a second scroll to find the result of the tap.
     */
    expandAfter?: string | null;
    /** What to draw in that row. Ignored unless `expandAfter` matches a tile in this grid. */
    expanded?: Snippet | null;
    /**
     * Where a grid tile's title goes: under the artwork, or laid over it.
     *
     * Only the grid reads this. A row or a card has room for its words and always shows them beside
     * or below the cover — moving a title onto a 42 px list thumbnail would make it unreadable.
     */
    titlePlacement?: "below" | "overlay";
  }
  let {
    series,
    view = "grid",
    columns,
    density = "larger",
    horizontal = false,
    sizes = new Map(),
    totals = new Map(),
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
    saved = null,
    expandAfter = null,
    expanded = null,
    titlePlacement = "below",
  }: Props = $props();

  /**
   * How many tiles are in the DOM right now.
   *
   * A 5 000-title library is 5 000 covers to *create*, and creating them is the first paint: 412 ms
   * on this box before the reader sees anything, even though all but a dozen are off screen.
   * `content-visibility` skips their rendering but not their creation. So the grid draws the first
   * screenful and grows in idle steps; every tile already reserves its height
   * (`contain-intrinsic-size`), so the document is the right length from the first frame and the
   * scrollbar, the scroll offset and a drag do not notice the rest arriving.
   */
  let drawnCount = $state(FIRST_DRAW);
  const drawn = $derived(series.length <= drawnCount ? series : series.slice(0, drawnCount));

  $effect(() => {
    if (series.length <= drawnCount) return;
    let cancelled = false;
    let handle = 0;
    const grow = (): void => {
      if (cancelled) return;
      drawnCount = Math.min(series.length, drawnCount + GROW_BY);
      if (drawnCount < series.length) handle = schedule(grow);
    };
    handle = schedule(grow);
    return () => {
      cancelled = true;
      cancelSchedule(handle);
    };
  });

  const mode = $derived(browseMode(view));
  /** A title laid over the cover: only in the grid, and only when the reader asked for it. */
  const overlaid = $derived(titlePlacement === "overlay" && mode === "grid");
  const columnCount = $derived(columnsFor(columns, viewport.width, viewport.height));

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

  let expansionAnchor = $state<string | null>(null);
  function pick(item: Series, event: MouseEvent) {
    const tile = event.currentTarget as HTMLElement;
    const top = tile.getBoundingClientRect().top;
    const siblings = [...(tile.parentElement?.querySelectorAll<HTMLElement>(":scope > .tile") ?? [])];
    expansionAnchor = siblings.find(el => Math.abs(el.getBoundingClientRect().top - top) < 2)?.dataset.seriesId ?? item.id;
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
  <div class="browse-rail" class:horizontal tabindex={horizontal ? 0 : undefined} role="region" aria-label={horizontal ? "Horizontally browsable titles" : undefined}>
  <div class="set {mode}" class:overtitle={overlaid} class:compact={density === "compact" || view === "compact"} class:explicit={columns !== undefined} style:--columns={columnCount} style:--cover="{cover}px">
    {#each drawn as item (item.id)}
      {#if expanded !== null && expandAfter !== null && item.id === (expansionAnchor ?? expandAfter)}
        <div class="expand" data-expanded="true">
          {@render expanded()}
        </div>
      {/if}
      {#if expanded === null || expandAfter !== item.id}
      <button
        class="tile"
        class:unread={mode === "row" && badgeFor(item.id) > 0}
        class:current={current === item.id}
        class:marked={selection?.has(item.id) === true}
        class:held={heldId === item.id}
        class:dragging={dragId === item.id}
        data-series-id={item.id}
        aria-pressed={selection === null ? undefined : selection.has(item.id)}
        onclick={(event) => pick(item, event)}
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
            {#if saved?.has(item.id) === true}
              <span class="saved" title="In your library" aria-label="In your library">✓</span>
            {/if}
            {#if selection !== null}
              <span class="tick" aria-hidden="true">{selection.has(item.id) ? "✓" : ""}</span>
            {/if}
            {#if overlaid}
              <span class="over-title">{item.title}</span>
            {/if}
          </div>
        <span class="meta">
          {#if !overlaid}<span class="title">{item.title}</span>{/if}
          {#if mode === "row"}
            <!--
              A row says four things and no more: who made it, what it is, how much of it is here,
              and a sentence of what it is about. The sentence goes above the numbers because it is
              the one line that varies in length, and a column of rows reads as a column only when
              the varying line is not the one at the bottom.
            -->
            {#if item.description}<span class="sub preview">{item.description}</span>{/if}
            <span class="sub">
              {[item.author, item.status, item.provider].filter(Boolean).join(" · ")}
            </span>
          {:else if mode === "card"}
            <span class="sub">
              {[item.author, item.provider, item.status].filter(Boolean).join(" · ")}
            </span>
            <span class="sub">{[totals.has(item.id) ? `${totals.get(item.id)} chapters` : "", unread.has(item.id) ? `${badgeFor(item.id)} unread` : "", knownSize(sizes.get(item.id)) !== null ? `${knownSize(sizes.get(item.id))} on device` : "Size unknown"].filter(Boolean).join(" · ")}</span>
            {#if mode === "card" && item.description}<span class="description">{item.description}</span>{/if}
          {:else if overlaid}
            <!-- The title is on the cover now, so this row exists only for an unread count. -->
            {#if badgeFor(item.id) > 0}<span class="sub">{badgeFor(item.id)} unread</span>{/if}
          {:else if view === "compact"}
            <span class="sub">{badgeFor(item.id) > 0 ? `${badgeFor(item.id)} unread` : ""}</span>
          {:else}
            <span class="sub">{badgeFor(item.id) > 0 ? `${badgeFor(item.id)} unread` : "\u00a0"}</span>
          {/if}
        </span>
      </button>
      {/if}
    {/each}
  </div>
  </div>
{/if}

<style>
  .browse-rail { min-width:0; max-width:100%; }
  .browse-rail.horizontal { overflow-x:auto; overscroll-behavior-x:contain; padding-bottom:8px; }
  .browse-rail.horizontal .set { display:flex; flex-direction:row; gap:12px; }
  .horizontal .set .tile { flex:0 0 min(75vw, 220px); }
  .horizontal .set.row .tile { flex-basis:min(82vw, 380px); }
  .horizontal .expand { flex:0 0 100%; }
  .set.explicit.grid { grid-template-columns:repeat(var(--columns), minmax(0, 1fr)); }
  /* A card is the "tell me about it" layout, not a page: tight padding, a smaller cover and two
     lines of description leave the information and drop the air around it. */
  .set.card { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr)); gap:10px; }
  .set.card .tile { padding:8px; border:1px solid var(--line); background:var(--surface); align-content:start; }
  .set.card .art { width:min(100%,132px); justify-self:center; }
  .set.card .meta { gap:0; }
  .set.card .description { -webkit-line-clamp:2; line-clamp:2; font-size:var(--t-xs); }
  .set.row .art { width:clamp(68px,18vw,calc(var(--cover) * 0.76)); flex:none; }
  .set.row .meta { flex:1; }
  .set.row .sub, .set.card .sub { white-space:normal; overflow-wrap:anywhere; }
  .description { font-size:var(--t-sm); color:var(--text-2); display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
  .set.grid.compact .title { font-size:var(--t-xs); }
  /* Without a title row the reserved height is the cover plus a hair, so rows stop leaving a gap
     where the title used to be. */
  .set.overtitle .tile { contain-intrinsic-size: auto calc(var(--cover) * 1.5 + 6px); }
  .set.explicit.grid.compact { gap: var(--s2) var(--s1); }
  .set.explicit.grid:not(.compact) { gap: var(--s3) var(--s2); }
  .set {
    /* Replacing the tapped row must not make the browser anchor to a later tile and jump. */
    overflow-anchor: none;
  }
  /* Tight rows: a shelf of covers is read as one picture, and 16 px of row gap plus 8 px under each
     cover turned a phone's search results into a mostly-empty column. The gap is between tiles, not
     inside them. */
  .set.grid,
  .set.compact {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--cover), 1fr));
    gap: var(--s3) var(--s2);
  }
  .set.compact {
    grid-template-columns: repeat(auto-fill, minmax(calc(var(--cover) * 0.72), 1fr));
    gap: var(--s2) var(--s1);
  }
  /* Rows butt against each other and are separated by a hairline, the way a list is: a gap between
     rounded rows turns a list of fifty into fifty cards. */
  .set.row {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* The opened card spans the grid it opened in. In a list it is one more row, which is already
     full width. */
  .expand {
    grid-column: 1 / -1;
    min-width: 0;
  }

  .tile {
    all: unset;
    cursor: pointer;
    display: grid;
    /* The title starts right under the artwork, not a gap below it. */
    gap: 3px;
    min-width: 0;
    border-radius: var(--r2);
    /* 5 000 rows is a real library, and every tile pays for its cover, its badges and its pill row
       whether or not it is on screen. `content-visibility: auto` skips that work for rows outside
       the viewport while keeping them in the DOM (so find-in-page, focus and the drag still work),
       and `contain-intrinsic-size` gives the skipped rows a height to reserve, so the scrollbar
       and the scroll offset do not jump as they come in. The size is the cover's aspect at the
       default width; `auto` in the second value keeps a row's real height once it has been seen. */
    content-visibility: auto;
    /* The reserved height is the cover's real height at this width (2:3) plus the title block,
       derived from `--cover` rather than a guessed constant: a wrong number is not just a gap, it
       makes every row that scrolls in re-lay-out the grid, which is where the frames went. */
    contain-intrinsic-size: auto calc(var(--cover) * 1.5 + 64px);
  }
  .set.row .tile {
    contain-intrinsic-size: auto 68px;
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--s3);
    padding: 8px var(--s2);
    border-radius: 0;
  }
  .set.row .tile + .tile {
    border-top: 1px solid var(--line);
  }
  .set.row .tile:hover {
    background: var(--surface-2);
  }
  /* An unread title says so with a rim on the leading edge: the same accent that means "new" in the
     Library, sized like a tab index rather than a badge. */
  .set.row .tile.unread::before {
    content: "";
    position: absolute;
    left: 0;
    top: 22%;
    bottom: 22%;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: var(--accent);
  }
  .set.row .art {
    width: clamp(34px, 10vw, 42px);
    flex: none;
  }
  .set.row .title {
    font-size: var(--t-sm);
    font-weight: 600;
    line-height: 1.25;
  }
  /* One line of what it is about, muted, so the three lines of a row have a clear hierarchy:
     name, substance, numbers. Clamped to one line because a row is a list line: two lines of blurb
     would triple the height of some rows and leave the column ragged. */
  .set.row .preview,
  .set.row .sub {
    color: var(--text-2);
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: normal;
  }
  .set.row .sub {
    color: var(--text-3);
  }
  .set.row .meta {
    gap: 0;
    flex: 1;
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

  /* Membership of the library, drawn where the eye already goes for state: the corner of the
     artwork, opposite the badges. Small enough to ignore when it is not what you are looking for. */
  .saved {
    position: absolute;
    left: var(--s1);
    bottom: var(--s1);
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 11px;
    line-height: 1;
    background: color-mix(in srgb, var(--bg) 72%, transparent);
    color: var(--text-1);
    border: 1px solid color-mix(in srgb, var(--text-3) 45%, transparent);
    pointer-events: none;
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
  .tick.marked .tick {
    opacity: 1;
  }

  /* The title laid over the bottom of the cover: a scrim so it reads on any artwork, two lines at
     most so the tile cannot grow, and no separate row underneath. */
  .over-title {
    position: absolute;
    inset: auto 0 0 0;
    padding: 18px 4px 4px;
    font-size: var(--t-xs);
    line-height: 1.2;
    color: #fff;
    text-align: center;
    text-shadow: 0 1px 2px rgb(0 0 0 / 80%);
    background: linear-gradient(to top, rgb(0 0 0 / 78%), rgb(0 0 0 / 0%));
    border-radius: 0 0 var(--r2) var(--r2);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    pointer-events: none;
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
  .set.row .title {
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
