<script lang="ts">
  /**
   * A series: what it is, and its chapters.
   *
   * The plan's structure, kept honest: the three things a reader does are on the page (keep it,
   * continue, download), everything rarer is behind one overflow. Chapters get their own toolbar
   * because a 300-chapter list with no filter is a scroll, not a list.
   */
  import { privacy } from "../state/privacy.svelte";
  import { visibility } from "../state/visibility.svelte";
  import { library } from "../state/library.svelte";
  import { categories } from "../state/categories.svelte";
  import { downloads } from "../state/downloads.svelte";
  import { settings } from "../state/settings.svelte";
  import { providerFor } from "../api/registry";
  import type { Chapter, Series } from "../api/source";
  import Cover from "../components/Cover.svelte";
  import SourceLink from "../components/SourceLink.svelte";
  import Sheet from "../components/Sheet.svelte";
  import MigrateSheet from "../components/MigrateSheet.svelte";
  import TrackerCard from "../components/TrackerCard.svelte";
  import { highestReadChapter } from "../lib/trackers/local";
  import { copyText } from "../lib/clipboard";
  import { go, pathTo } from "../lib/nav";
  import { startReading } from "../state/reader-pane.svelte";
  import { flipOrder, orderChapters, orderLabel, type ChapterOrder } from "../lib/chapter-order";
  import { SELECTION_SETTLE_MS, settleSelection } from "../lib/selection";
  import { chapterTitle } from "../lib/titles";

  interface Props {
    seriesId: string;
    /** In a desktop split there is nothing to go back to: the shelf is already beside it. */
    embedded?: boolean;
    /** A tracker bind or unlink changed what the library can filter on. */
    onlibrarychange?: () => void;
  }
  let { seriesId, embedded = false, onlibrarychange }: Props = $props();

  let series = $state<Series | null>(null);
  let chapters = $state<Chapter[]>([]);
  let saved = $state(false);
  let busy = $state(true);
  let error = $state<string | null>(null);
  let position = $state<{ chapterId: string; page: number } | null>(null);

  let query = $state("");
  let onlyUnread = $state(false);
  let onlyDownloaded = $state(false);
  let order = $state<ChapterOrder>("oldest");

  let expanded = $state(false);
  let menuOpen = $state(false);
  /** The answer to "Copy link": a copy, or the address the clipboard refused. */
  let shareNote = $state<string | null>(null);
  let shareNoteTimer: ReturnType<typeof setTimeout> | null = null;
  let chapterMenu = $state<Chapter | null>(null);
  /** The title the migration sheet is about; `null` closes it. */
  let migrating = $state<Series | null>(null);

  $effect(() => {
    void load(seriesId);
    // Leaving the pane invalidates whatever it still has in flight: the generation is what every
    // `current()` check compares against, so an answer that arrives after the pane is gone is
    // dropped instead of writing into a screen nobody is looking at.
    return () => {
      loadGeneration += 1;
    };
  });

  let loadGeneration = 0;
  async function load(id: string): Promise<void> {
    const profile = library.profile;
    if (profile === null) return;
    const generation = ++loadGeneration;
    const current = () => generation === loadGeneration && id === seriesId;
    busy = true;
    error = null;
    series = null;
    chapters = [];
    saved = false;
    position = null;
    try {
      // Render persisted content before asking any source. A runtime starting in the background
      // must not prevent opening a title or its downloaded chapters.
      const [stored, cached, rememberedPosition, prefs] = await Promise.all([
        profile.store.getSeries(id), profile.store.listChapters(id), profile.store.getPosition(id), profile.store.listPrefs(),
      ]);
      const storedRead = new Set(prefs.filter(row => String(row.key).startsWith('read:') && row.value === true)
        .map(row => String(row.key).slice(5)));
      if (!current()) return;
      if (stored !== undefined) {
        series = stored;
        chapters = cached.map(chapter => ({ ...chapter, read: chapter.read || storedRead.has(chapter.id) }));
        saved = true;
        position = rememberedPosition ?? null;
        busy = false;
      }
      // The remote half waits for the selection to settle when this page is a pane. A burst of
      // taps is one decision, and only the title it settles on is worth a round trip — the stored
      // row above has already answered the finger. A full page skips the wait: opening a series is
      // a decision, not a gesture, and 150 ms of nothing would just be a slower screen.
      if (!(await settleSelection(embedded ? SELECTION_SETTLE_MS : 0, current))) return;
      // Through the library, not the provider: a migrated title asks the source its mapping names,
      // which is not the one its id was born on.
      const fresh = await library.details(id);
      if (!current()) return;
      // A details call cannot rebuild the source page (it has no source site to join the path to),
      // so the url recorded when the row was saved is the one kept.
      series = fresh.url === undefined && stored?.url !== undefined ? { ...fresh, url: stored.url } : fresh;
      void library.rememberSeriesMeta(series);
      const freshSaved = await library.isSaved(id);
      const freshPosition = await profile.store.getPosition(id);
      const freshChapters = await library.chapters(id);
      if (!current()) return;
      saved = freshSaved;
      position = freshPosition ?? null;
      chapters = freshChapters;
      // Read marks for a provider that keeps them itself come from the host; ours come from the
      // prefs store. Merge, so a chapter shows as read whichever of the two said so.
      const local = new Set(
        (await profile.store.listPrefs())
          .filter((row) => String(row.key).startsWith("read:") && row.value === true)
          .map((row) => String(row.key).slice(5)),
      );
      if (!current()) return;
      chapters = chapters.map((chapter) => ({ ...chapter, read: chapter.read || local.has(chapter.id) }));
    } catch (e) {
      if (!current()) return;
      const reason = e instanceof Error ? e.message : String(e);
      error = series === null ? reason : `Showing saved details and cached chapters. Source unavailable: ${reason}`;
    } finally {
      if (current()) busy = false;
    }
  }

  const shown = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const list = chapters.filter((chapter) => {
      if (onlyUnread && chapter.read) return false;
      if (onlyDownloaded && !downloads.isDownloaded(chapter.id)) return false;
      if (needle !== "" && !chapter.name.toLowerCase().includes(needle)) return false;
      return true;
    });
    // Always sorted, never "trust the host's order" — that is what made the toggle look dead.
    return orderChapters(list, order);
  });

  const unread = $derived(chapters.filter((chapter) => !chapter.read).length);
  /**
   * The furthest chapter actually read here.
   *
   * A bind seeds the tracker row with this, so a title that is forty chapters in does not start its
   * service list at chapter one. Unread chapters are not evidence, so they do not count.
   */
  const highestRead = $derived(highestReadChapter(chapters));
  const next = $derived(position === null ? null : chapters.find((chapter) => chapter.id === position?.chapterId) ?? null);

  /** In flight: the seat spins, and a second tap cannot start a second write. */
  let saving = $state(false);

  async function toggleSaved(): Promise<void> {
    if (series === null || saving) return;
    saving = true;
    try {
      if (saved) {
        await library.unsave(series.id);
        saved = false;
      } else {
        await library.save(series, chapters);
        saved = true;
      }
    } finally {
      saving = false;
    }
  }

  async function toggleCategory(categoryId: string): Promise<void> {
    if (privacy.locked) return;
    if (series === null) return;
    const current = series.categoryIds ?? [];
    const nextIds = current.includes(categoryId) ? current.filter((id) => id !== categoryId) : [...current, categoryId];
    await categories.assign(series.id, nextIds);
    series = { ...series, categoryIds: nextIds };
  }

  /**
   * A hold opens the chapter menu; the tap that follows the hold must not also start reading.
   *
   * `contextmenu` covers a desktop right-click and the iOS long-press gesture, but a plain hold on a
   * row that never fires it — a WebKit scroll view, a pointer with no context menu — used to do
   * nothing at all. A timer armed from either a pointer or a touch gives the same result everywhere,
   * and any movement past a few pixels cancels it so a scroll never opens a menu.
   */
  let heldId = "";
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdOrigin: { x: number; y: number } | null = null;

  function beginHold(event: PointerEvent, chapter: Chapter): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    holdOrigin = { x: event.clientX, y: event.clientY };
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      heldId = chapter.id;
      chapterMenu = chapter;
    }, 450);
  }

  function moveHold(event: PointerEvent): void {
    if (holdOrigin === null || holdTimer === null) return;
    if (Math.abs(event.clientX - holdOrigin.x) > 8 || Math.abs(event.clientY - holdOrigin.y) > 8) endHold();
  }

  function endHold(): void {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
    holdOrigin = null;
  }

  async function setRead(chapter: Chapter, read: boolean): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    if (library.ownsProgress(chapter.id)) {
      await store.setRead(chapter.id, read);
    } else {
      const provider = providerFor(library.profile!.providers, chapter.id);
      await provider.setRead(chapter.id, read).catch(() => {});
      await store.setRead(chapter.id, read);
    }
    chapters = chapters.map((row) => (row.id === chapter.id ? { ...row, read } : row));
    chapterMenu = null;
    // §7: a finished chapter points Continue at the next *unread* one. A local write only —
    // `advance` does nothing when there is no next unread chapter.
    if (read && series !== null && settings.continueAfterFinish === "next-unread") {
      await library.advance(series.id, chapter.id);
    }
  }

  /**
   * The rows a hold can act on, in the order drawn.
   *
   * "Above" and "below" mean where they sit on this screen, not which issue number is larger: a
   * list sorted newest-first puts the older issues *below*. A range that ignored the sort would mark
   * exactly the opposite of what the reader pointed at.
   */
  function rangeOf(chapter: Chapter, side: "above" | "below"): Chapter[] {
    const index = shown.findIndex((row) => row.id === chapter.id);
    if (index < 0) return [chapter];
    return side === "above" ? shown.slice(0, index + 1) : shown.slice(index);
  }

  /** Mark every row in a range read, skipping the ones already done. */
  async function markMany(rows: readonly Chapter[]): Promise<void> {
    busy = true;
    try {
      for (const row of rows.filter((candidate) => !candidate.read)) await setRead(row, true);
    } finally {
      busy = false;
      chapterMenu = null;
    }
  }

  /** Downloaded or not, for the one button that toggles it in a menu. */
  function toggleDownload(chapter: Chapter): void {
    if (downloads.isDownloaded(chapter.id)) void downloads.remove(chapter.id);
    else downloads.enqueue(seriesId, chapter);
  }

  async function markAll(): Promise<void> {
    if (series === null) return;
    busy = true;
    try {
      for (const chapter of chapters.filter((row) => !row.read)) await setRead(chapter, true);
    } finally {
      busy = false;
      menuOpen = false;
    }
  }

  /**
   * Copy this title's address.
   *
   * The old version fired `navigator.clipboard?.writeText(...).catch(() => {})` and closed the menu:
   * where the clipboard was missing or refused, the reader got no link and no answer. `copyText`
   * reports what happened, and a failure shows the address itself so it can still be selected.
   */
  async function share(): Promise<void> {
    if (series === null) return;
    const url = `${location.origin}${location.pathname}#${pathTo("series", series.id)}`;
    menuOpen = false;
    const result = await copyText(url);
    shareNote = result.copied ? "Link copied." : `Could not reach the clipboard here. The link is ${url}`;
    if (shareNoteTimer !== null) clearTimeout(shareNoteTimer);
    shareNoteTimer = result.copied ? setTimeout(() => (shareNote = null), 3000) : null;
  }

  function when(chapter: Chapter): string {
    if (chapter.uploadedAt === undefined) return "";
    const days = Math.floor((Date.now() - chapter.uploadedAt) / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    return new Date(chapter.uploadedAt).toLocaleDateString();
  }
  $effect(() => { const store = library.profile?.store; if (store) void visibility.load(store); });
</script>

{#if visibility.allows({ id: seriesId })}
<section class="view" class:embedded>
  <header class="bar">
    {#if !embedded}
      <button class="btn ghost icon" aria-label="Back" onclick={() => go("/library")}>
        <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>
      </button>
    {/if}
    <span class="barname">{series?.title ?? ""}</span>
    <button class="btn ghost icon" aria-label="More actions" aria-expanded={menuOpen} onclick={() => (menuOpen = true)}>
      <svg viewBox="0 0 24 24"><path d="M6 12h.01M12 12h.01M18 12h.01" /></svg>
    </button>
  </header>

  {#if error}<p class="banner">{error}</p>{/if}
  {#if shareNote}<p class="banner note" role="status" data-share-note>{shareNote}</p>{/if}
  {#if busy && series === null}<p class="empty">Loading…</p>{/if}

  {#if series}
    <div class="hero">
      <Cover {series} size="hero" />
      <div class="meta">
        <h1>{series.title}</h1>
        {#if series.author}<p class="author">{series.author}</p>{/if}
        <p class="facts">{[series.status, `Source: ${series.provider}`].filter(Boolean).join(" · ")}</p>
        <div class="actions">
          {#if next}
            <button class="btn primary wide" onclick={() => startReading(seriesId, next.id, embedded)}>
              Continue · {chapterTitle(next)}{position ? ` · p.${position.page + 1}` : ""}
            </button>
          {:else if chapters.length > 0}
            <button class="btn primary wide" onclick={() => startReading(seriesId, chapters[chapters.length - 1].id, embedded)}>Start reading</button>
          {/if}
          <div class="pair">
            <!-- In the library or not is the glyph and its tone: four cells alone, four cells with
                 the last replaced by a tick when the title is on the shelf. Adding spins while the
                 write is in flight, so the state after the tap is the state it shows. -->
            <button
              class="btn icon"
              class:on={saved}
              aria-pressed={saved}
              aria-label={saved ? "In your library — tap to remove" : "Add to library"}
              title={saved ? "In your library — tap to remove" : "Add to library"}
              disabled={saving}
              onclick={() => void toggleSaved()}
            >
              {#if saving}
                <span class="spin" aria-hidden="true"></span>
              {:else}
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={saved ? "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 17.5l2.5 2.5L20 15.5" : "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"} />
                </svg>
              {/if}
            </button>
            {#if chapters.length > 0}
              <button
                class="btn icon"
                aria-label={`Download ${chapterTitle(chapters[0])}`}
                title="Download"
                disabled={downloads.inQueue(chapters[0].id)}
                onclick={() => downloads.enqueue(seriesId, chapters[0])}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10M8 10l4 4 4-4M5 20h14" /></svg>
              </button>
            {/if}
            <SourceLink url={series.url} icon />
          </div>
        </div>
      </div>

      <!-- The shelves this title sits in, under the row it belongs to: the cover is sized by the
           text and the actions, and the chips are a second row rather than part of that measure. -->
      {#if saved && categories.items.length > 0}
        <div class="cats">
          {#each categories.items.filter((c) => !privacy.locked || !c.hidden) as category (category.id)}
            <button disabled={privacy.locked} class="chip" class:on={(series.categoryIds ?? []).includes(category.id)} onclick={() => void toggleCategory(category.id)}>
              {category.name}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    {#if series.description}
      <div class="desc">
        <p class="description" class:clamped={!expanded}>{series.description}</p>
        {#if series.description.length > 260}
          <button class="btn ghost small" onclick={() => (expanded = !expanded)}>{expanded ? "Show less" : "Read more"}</button>
        {/if}
      </div>
    {/if}

    <TrackerCard
      {seriesId}
      title={series.title}
      localChapter={highestRead}
      onchange={onlibrarychange}
    />

    <section class="chapters">
      <header class="chead">
        <h2>{series?.provider === "archive" ? "Issues" : "Chapters"}</h2>
        <span class="count">{chapters.length}{unread > 0 ? ` · ${unread} unread` : ""}</span>
        <button
          class="chip sortchip"
          aria-label={`Chapter order: ${orderLabel(order)}. Tap to switch.`}
          onclick={() => (order = flipOrder(order))}
        >
          {orderLabel(order)}
        </button>
        <div class="cacts">
          <input class="field" type="search" placeholder="Filter chapters" bind:value={query} aria-label="Filter chapters" />
          <button class="chip" class:on={onlyUnread} aria-pressed={onlyUnread} onclick={() => (onlyUnread = !onlyUnread)}>Unread</button>
          <button class="chip" class:on={onlyDownloaded} aria-pressed={onlyDownloaded} onclick={() => (onlyDownloaded = !onlyDownloaded)}>Downloaded</button>
        </div>
      </header>

      {#if chapters.length === 0}
        <!-- A slow source is not an empty source: Weeb Central takes seconds for its 1 198
             chapters, and the page used to say "no chapters" for the whole wait. -->
        <p class="empty">{busy ? "Loading chapters…" : "This source returned no chapters for this series."}</p>
      {:else if shown.length === 0}
        <p class="empty">No chapter matches these filters.</p>
      {:else}
        <ul class="list">
          {#each shown as chapter (chapter.id)}
            <li>
              <div
                class="row"
                class:read={chapter.read}
                role="button"
                tabindex="0"
                onclick={() => {
                  // The tap that ends a hold belongs to the menu, not to the reader.
                  if (heldId === chapter.id) {
                    heldId = "";
                    return;
                  }
                  startReading(seriesId, chapter.id, embedded);
                }}
                onkeydown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    startReading(seriesId, chapter.id, embedded);
                  }
                  // Keyboard parity with the hold: a menu without a pointer.
                  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault();
                    chapterMenu = chapter;
                  }
                }}
                onpointerdown={(event) => beginHold(event, chapter)}
                onpointermove={moveHold}
                onpointerup={endHold}
                onpointercancel={endHold}
                onpointerleave={endHold}
                ontouchstart={(event) => {
                  const touch = event.touches[0];
                  if (touch === undefined) return;
                  beginHold({ clientX: touch.clientX, clientY: touch.clientY, pointerType: "touch", button: 0 } as PointerEvent, chapter);
                }}
                ontouchmove={(event) => {
                  const touch = event.touches[0];
                  if (touch === undefined) return;
                  moveHold({ clientX: touch.clientX, clientY: touch.clientY } as PointerEvent);
                }}
                ontouchend={endHold}
                ontouchcancel={endHold}
                oncontextmenu={(event) => {
                  event.preventDefault();
                  endHold();
                  heldId = chapter.id;
                  chapterMenu = chapter;
                }}
              >
                <span class="name">
                  <span class="n">{chapterTitle(chapter)}</span>
                  <span class="sub">
                    {[when(chapter), chapter.pageCount > 0 ? `${chapter.pageCount} pages` : "", downloads.isDownloaded(chapter.id) ? "downloaded" : ""]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span class="mark" aria-hidden="true">{chapter.read ? "✓" : ""}</span>
                <span class="rowacts">
                  <button
                    class="mini"
                    aria-label={`More actions for ${chapterTitle(chapter)}`}
                    title="More actions"
                    onclick={(event) => {
                      event.stopPropagation();
                      chapterMenu = chapter;
                    }}
                  >
                    ⋯
                  </button>
                  <button
                    class="mini"
                    aria-label={`Download ${chapterTitle(chapter)}`}
                    title={downloads.isDownloaded(chapter.id) ? "Downloaded" : "Download"}
                    onclick={(event) => {
                      event.stopPropagation();
                      downloads.enqueue(seriesId, chapter);
                    }}
                  >
                    {downloads.isDownloaded(chapter.id) ? "⤓" : "↓"}
                  </button>
                </span>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</section>

<Sheet open={menuOpen} title="Series" onclose={() => (menuOpen = false)}>
  <div class="menu">
    {#if saved}
      <button class="menu-item" onclick={() => void toggleSaved()}>Remove from library</button>
    {:else}
      <button class="menu-item" onclick={() => void toggleSaved()}>Add to library</button>
    {/if}
    <button class="menu-item" disabled={busy || unread === 0} onclick={() => void markAll()}>Mark all chapters read</button>
    <button class="menu-item" onclick={() => downloads.enqueueMany(seriesId, shown.filter((c) => !downloads.isDownloaded(c.id)))}>
      Download {shown.length} listed chapters
    </button>
    <button class="menu-item" onclick={() => void downloads.removeSeries(seriesId)}>Delete downloads</button>
    {#if saved}
      <button class="menu-item" onclick={() => { menuOpen = false; migrating = series; }}>Migrate to another source</button>
    {/if}
    <button class="menu-item" onclick={() => void share()}>Copy link to this series</button>
  </div>
</Sheet>

<MigrateSheet
  series={migrating}
  onclose={() => (migrating = null)}
  onmigrated={() => void load(seriesId)}
/>

<Sheet open={chapterMenu !== null} title={chapterMenu === null ? "Chapter" : chapterTitle(chapterMenu)} onclose={() => (chapterMenu = null)}>
  {#if chapterMenu}
    {@const chapter = chapterMenu}
    {@const above = rangeOf(chapter, "above")}
    {@const below = rangeOf(chapter, "below")}
    {@const aboveUnread = above.filter((row) => !row.read).length}
    {@const belowUnread = below.filter((row) => !row.read).length}
    <div class="menu">
      <button class="menu-item" onclick={() => startReading(seriesId, chapter.id, embedded)}>Read</button>
      {#if chapter.read}
        <button class="menu-item" onclick={() => void setRead(chapter, false)}>Mark unread</button>
      {:else}
        <button class="menu-item" onclick={() => void setRead(chapter, true)}>Mark read</button>
      {/if}
      <!-- Ranges follow the order on screen: above is what is drawn above this row, which is the
           newer issues when the list is newest-first. -->
      {#if aboveUnread > 1}
        <button class="menu-item" disabled={busy} onclick={() => void markMany(above)}>
          Mark this and the {aboveUnread - (chapter.read ? 0 : 1)} above read
        </button>
      {/if}
      {#if belowUnread > 1}
        <button class="menu-item" disabled={busy} onclick={() => void markMany(below)}>
          Mark this and the {belowUnread - (chapter.read ? 0 : 1)} below read
        </button>
      {/if}
      <button class="menu-item" disabled={busy} onclick={() => toggleDownload(chapter)}>
        {downloads.isDownloaded(chapter.id) ? "Delete download" : "Download"}
      </button>
    </div>
  {/if}
</Sheet>

{:else}
  <p class="view" role="status">Hidden by local screen privacy. Unlock from Library to view.</p>
{/if}

<style>
  .view {
    padding: var(--s3) var(--s4) var(--s8);
    max-width: 980px;
    /* Same gutter cap as a source page: sixteen pixels of shell margin on each side was the width
       the issue rows and the hero were paying for. Declared as the view's gutter, not only as its
       padding, so the sticky header in app.css cancels exactly this much and the page cannot be
       dragged sideways by the difference (it was 8 px per side, a 456 px bar in a 440 px window). */
    --view-pad-x: min(var(--pad-x), var(--s2));
    padding-left: var(--view-pad-x) !important;
    padding-right: var(--view-pad-x) !important;
  }

  .view.embedded {
    padding-top: var(--s3);
    max-width: none;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-bottom: var(--s3);
    min-height: 36px;
  }

  .barname {
    flex: 1;
    font-size: var(--t-sm);
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .bar svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Two columns, and the artwork is the height of the first row — the title down to the action
     row — instead of its own 2:3 guess. A cover that ends wherever its aspect ratio said left a
     ragged edge under the actions and a gap under the cover. */
  .hero {
    display: grid;
    grid-template-columns: clamp(128px, 38%, 168px) minmax(0, 1fr);
    column-gap: var(--s3);
    row-gap: var(--s2);
    margin-bottom: var(--s4);
    align-items: stretch;
  }

  /*
   * The artwork is the one thing that says which title this is, so it takes width back from the
   * button pair: a fixed 128 px cover on a 424 px column left the actions two full-width rows and
   * the art with less than a third of the screen. It grows with the column, and the stacked
   * buttons below it are content-sized instead of stretched.
   */
  .hero > :global(div.cover.hero) {
    grid-column: 1;
    grid-row: 1;
    width: 100%;
    aspect-ratio: auto;
    align-self: stretch;
  }

  .meta {
    grid-column: 2;
    grid-row: 1;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s2);
    align-content: start;
    min-width: 0;
  }

  h1 {
    font-size: var(--t-xl);
    line-height: 1.2;
  }

  .author {
    margin: 0;
    color: var(--text-2);
    font-size: var(--t-sm);
  }

  .facts {
    margin: 0;
    color: var(--text-3);
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .actions {
    display: grid;
    gap: var(--s2);
    width: 100%;
  }

  /* One primary action, full width; the secondary pair shares the next row evenly. */
  .actions .btn {
    min-height: 44px;
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
    text-align: center;
  }

  /* One row of glyphs, never a wrapped stack: three 36 px seats and their gaps are 124 px, which
     fits beside the cover even in the narrowest pane. */
  .pair {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: var(--s2);
  }
  /* Square seats: the three glyphs read as one row of equal controls rather than three pills of
     different heights. */
  .pair .btn {
    width: 40px;
    min-width: 40px;
    min-height: 40px;
    padding: 0;
  }

  /* The in-flight mark for the library seat: an arc of the seat's own colour, turning. */
  .spin {
    width: 16px;
    height: 16px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: turn 700ms linear infinite;
  }
  @keyframes turn {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin { animation-duration: 2.4s; }
  }

  .cats {
    grid-column: 2;
    grid-row: 2;
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }

  .desc {
    margin: 0 0 var(--s5);
    display: grid;
    gap: var(--s1);
    justify-items: start;
  }

  .description {
    margin: 0;
    color: var(--text-2);
    font-size: var(--t-sm);
    line-height: 1.6;
    max-width: 72ch;
    white-space: pre-line;
  }

  .description.clamped {
    display: -webkit-box;
    -webkit-line-clamp: 5;
    line-clamp: 5;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .small {
    min-height: 28px;
    padding: 0;
    font-size: var(--t-xs);
    color: var(--accent);
    border-color: transparent;
  }

  .small:hover {
    background: transparent;
    color: var(--text-1);
  }

  .chead {
    display: flex;
    align-items: center;
    gap: var(--s3);
    flex-wrap: wrap;
    margin-bottom: var(--s3);
    padding-bottom: var(--s2);
    border-bottom: 1px solid var(--line);
  }

  h2 {
    font-size: var(--t-lg);
  }

  .count {
    font-size: var(--t-xs);
    color: var(--text-3);
    margin-left: var(--s2);
  }

  /* The order belongs to the count it orders: "12 chapters · 3 unread · Oldest first" reads as
     one sentence, so the chip sits beside it rather than pinned to the far edge. */
  .sortchip {
    margin-left: 0;
  }

  .cacts {
    display: flex;
    align-items: center;
    gap: var(--s2);
    flex-wrap: wrap;
    width: 100%;
    order: 4;
  }

  .cacts .field {
    flex: 1 1 120px;
    width: auto;
    min-width: 0;
    padding: 5px var(--s2);
  }
  .cacts .chip { flex: none; }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 1px;
  }

  /* An issue row is the width of the column, not a card inset inside it: the indent was 16 px of
     the screen spent on nothing, on the one list the reader scrolls fifty of. */
  .row {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding: var(--s3) 0;
    border-radius: var(--r1);
    min-height: 44px;
    width: 100%;
    box-sizing: border-box;
  }

  .row:hover {
    background: var(--surface-2);
  }

  .mark {
    width: 14px;
    color: var(--success);
    font-size: var(--t-sm);
    text-align: right;
    flex: none;
  }

  .name {
    display: grid;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }

  .n {
    font-size: var(--t-md);
    color: var(--text-1);
  }

  .row.read .n {
    color: var(--text-2);
  }

  .sub {
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .rowacts {
    display: flex;
    gap: var(--s2);
  }

  .mini {
    all: unset;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: var(--r1);
    color: var(--text-3);
    font-size: var(--t-md);
    cursor: pointer;
  }

  .mini:hover {
    color: var(--text-1);
    background: var(--surface-2);
  }

  .menu {
    display: grid;
    gap: 2px;
  }

  .menu-item {
    all: unset;
    cursor: pointer;
    padding: var(--s3);
    border-radius: var(--r2);
    font-size: var(--t-md);
    min-height: 44px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
  }

  .menu-item:hover {
    background: var(--surface-2);
  }

  .menu-item:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
