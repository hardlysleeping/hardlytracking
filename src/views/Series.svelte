<script lang="ts">
  /**
   * A series: what it is, and its chapters.
   *
   * The plan's structure, kept honest: the three things a reader does are on the page (keep it,
   * continue, download), everything rarer is behind one overflow. Chapters get their own toolbar
   * because a 300-chapter list with no filter is a scroll, not a list.
   */
  import { library } from "../state/library.svelte";
  import { categories } from "../state/categories.svelte";
  import { downloads } from "../state/downloads.svelte";
  import { providerFor } from "../api/registry";
  import type { Chapter, Series } from "../api/source";
  import Cover from "../components/Cover.svelte";
  import Sheet from "../components/Sheet.svelte";
  import { go, pathTo } from "../lib/nav";
  import { flipOrder, orderChapters, orderLabel, type ChapterOrder } from "../lib/chapter-order";
  import { chapterLabel } from "../lib/titles";

  interface Props {
    seriesId: string;
    /** In a desktop split there is nothing to go back to: the shelf is already beside it. */
    embedded?: boolean;
  }
  let { seriesId, embedded = false }: Props = $props();

  let series = $state<Series | null>(null);
  let chapters = $state<Chapter[]>([]);
  let saved = $state(false);
  let busy = $state(true);
  let error = $state<string | null>(null);
  let position = $state<{ chapterId: string; page: number } | null>(null);

  let query = $state("");
  let onlyUnread = $state(false);
  let onlyDownloaded = $state(false);
  let order = $state<ChapterOrder>("newest");

  let expanded = $state(false);
  let menuOpen = $state(false);
  let chapterMenu = $state<Chapter | null>(null);

  $effect(() => {
    void load(seriesId);
  });

  async function load(id: string): Promise<void> {
    if (library.profile === null) return;
    busy = true;
    error = null;
    try {
      const provider = providerFor(library.profile.providers, id);
      series = await provider.details(id);
      void library.rememberSeriesMeta(series);
      saved = await library.isSaved(id);
      position = (await library.profile.store.getPosition(id)) ?? null;
      chapters = await library.chapters(id);
      // Read marks for a provider that keeps them itself come from the host; ours come from the
      // prefs store. Merge, so a chapter shows as read whichever of the two said so.
      const local = new Set(
        (await library.profile.store.listPrefs())
          .filter((row) => String(row.key).startsWith("read:") && row.value === true)
          .map((row) => String(row.key).slice(5)),
      );
      chapters = chapters.map((chapter) => ({ ...chapter, read: chapter.read || local.has(chapter.id) }));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
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
  const next = $derived(position === null ? null : chapters.find((chapter) => chapter.id === position?.chapterId) ?? null);

  async function toggleSaved(): Promise<void> {
    if (series === null) return;
    if (saved) {
      await library.unsave(series.id);
      saved = false;
    } else {
      await library.save(series, chapters);
      saved = true;
    }
  }

  async function toggleCategory(categoryId: string): Promise<void> {
    if (series === null) return;
    const current = series.categoryIds ?? [];
    const nextIds = current.includes(categoryId) ? current.filter((id) => id !== categoryId) : [...current, categoryId];
    await categories.assign(series.id, nextIds);
    series = { ...series, categoryIds: nextIds };
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

  function share(): void {
    if (series === null) return;
    const url = `${location.origin}${location.pathname}#${pathTo("series", series.id)}`;
    void navigator.clipboard?.writeText(url).catch(() => {});
    menuOpen = false;
  }

  function label(chapter: Chapter): string {
    // A real name beats a generated one. Mihon's own names are "Chapter 12", so this keeps them as
    // they are, while an archive.org volume called "Berserk v01 (2003)" stops being "Chapter 1".
    const named = chapterLabel(chapter.name);
    if (named !== "Chapter") return named;
    return chapter.number > 0 ? `Chapter ${chapter.number}` : named;
  }

  function when(chapter: Chapter): string {
    if (chapter.uploadedAt === undefined) return "";
    const days = Math.floor((Date.now() - chapter.uploadedAt) / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    return new Date(chapter.uploadedAt).toLocaleDateString();
  }
</script>

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
            <button class="btn primary wide" onclick={() => go(pathTo("read", seriesId, next.id))}>
              Continue · {label(next)}{position ? ` · p.${position.page + 1}` : ""}
            </button>
          {:else if chapters.length > 0}
            <button class="btn primary wide" onclick={() => go(pathTo("read", seriesId, chapters[chapters.length - 1].id))}>Start reading</button>
          {/if}
          <div class="pair">
            <button class="btn" onclick={() => void toggleSaved()}>{saved ? "In library" : "Add to library"}</button>
            {#if chapters.length > 0}
              <button class="btn" disabled={downloads.inQueue(chapters[0].id)} onclick={() => downloads.enqueue(seriesId, chapters[0])}>Download</button>
            {/if}
          </div>
        </div>
        {#if saved && categories.items.length > 0}
          <div class="cats">
            {#each categories.items as category (category.id)}
              <button class="chip" class:on={(series.categoryIds ?? []).includes(category.id)} onclick={() => void toggleCategory(category.id)}>
                {category.name}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    {#if series.description}
      <div class="desc">
        <p class="description" class:clamped={!expanded}>{series.description}</p>
        {#if series.description.length > 260}
          <button class="btn ghost small" onclick={() => (expanded = !expanded)}>{expanded ? "Show less" : "Read more"}</button>
        {/if}
      </div>
    {/if}

    <section class="chapters">
      <header class="chead">
        <h2>Chapters</h2>
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
        <p class="empty">This source returned no chapters for this series.</p>
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
                onclick={() => go(pathTo("read", seriesId, chapter.id))}
                onkeydown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    go(pathTo("read", seriesId, chapter.id));
                  }
                }}
                oncontextmenu={(event) => {
                  event.preventDefault();
                  chapterMenu = chapter;
                }}
              >
                <span class="name">
                  <span class="n">{label(chapter)}</span>
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
                    aria-label={`Download ${label(chapter)}`}
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
    <button class="menu-item" onclick={share}>Copy link to this series</button>
  </div>
</Sheet>

<Sheet open={chapterMenu !== null} title={chapterMenu === null ? "Chapter" : label(chapterMenu)} onclose={() => (chapterMenu = null)}>
  {#if chapterMenu}
    {@const chapter = chapterMenu}
    <div class="menu">
      <button class="menu-item" onclick={() => go(pathTo("read", seriesId, chapter.id))}>Read</button>
      {#if chapter.read}
        <button class="menu-item" onclick={() => void setRead(chapter, false)}>Mark unread</button>
      {:else}
        <button class="menu-item" onclick={() => void setRead(chapter, true)}>Mark read</button>
      {/if}
      {#if downloads.isDownloaded(chapter.id)}
        <button class="menu-item" onclick={() => void downloads.remove(chapter.id)}>Delete download</button>
      {:else}
        <button class="menu-item" onclick={() => downloads.enqueue(seriesId, chapter)}>Download</button>
      {/if}
    </div>
  {/if}
</Sheet>

<style>
  .view {
    padding: var(--s3) var(--s4) var(--s8);
    max-width: 980px;
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

  .hero {
    display: flex;
    gap: var(--s4);
    margin-bottom: var(--s4);
  }

  .meta {
    display: grid;
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
  }

  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s2);
  }

  .pair .btn {
    width: 100%;
    padding: 0 var(--s2);
  }

  .cats {
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

  .sortchip {
    margin-left: auto;
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
    width: 160px;
    padding: 5px var(--s2);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 1px;
  }

  .row {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding: var(--s3) var(--s2);
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
