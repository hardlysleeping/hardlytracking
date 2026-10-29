<script lang="ts">
  import { library } from "../state/library.svelte";
  import { providerFor } from "../api/registry";
  import type { Page } from "../api/source";
  import { go, pathTo } from "../lib/nav";

  interface Props {
    seriesId: string;
    chapterId: string;
  }
  let { seriesId, chapterId }: Props = $props();

  let pages = $state<Page[]>([]);
  let index = $state(0);
  let busy = $state(true);
  let error = $state<string | null>(null);
  let strip = $state(false);
  let read = $state(false);

  $effect(() => {
    void load(chapterId);
  });

  async function load(id: string): Promise<void> {
    if (library.profile === null) return;
    busy = true;
    error = null;
    try {
      pages = await library.pages(id);
      const progress = await library.profile.store.getProgress(id);
      index = Math.min(progress?.page ?? 0, Math.max(pages.length - 1, 0));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /**
   * Read state is written only when you say so.
   *
   * Opening a chapter used to mark it read on the server, which is a write to the
   * runtime's own database the moment you glance at a page — and on a shared host that
   * is someone else's data. It is a button now.
   */
  async function toggleRead(): Promise<void> {
    if (library.profile === null) return;
    try {
      const provider = providerFor(library.profile.providers, chapterId);
      await provider.setRead(chapterId, !read);
      read = !read;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function remember(): Promise<void> {
    if (library.profile === null || pages.length === 0) return;
    await library.profile.store.setProgress(chapterId, index, pages.length);
  }

  function step(delta: number): void {
    const next = Math.min(Math.max(index + delta, 0), Math.max(pages.length - 1, 0));
    if (next === index) return;
    index = next;
    void remember();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === " ") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      step(-1);
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<section class="reader">
  <header>
    <button class="ghost" onclick={() => go(pathTo("series", seriesId))}>Back</button>
    <span class="pos">{pages.length > 0 ? `${index + 1} / ${pages.length}` : "no pages"}</span>
    <button class="ghost" onclick={toggleRead}>{read ? "Read" : "Mark read"}</button>
    <button class="ghost" onclick={() => (strip = !strip)}>{strip ? "Single" : "Strip"}</button>
  </header>

  {#if error}<p class="banner">{error}</p>{/if}
  {#if busy}<p class="empty">Fetching pages…</p>{/if}

  {#if pages.length > 0}
    {#if strip}
      <div class="strip">
        {#each pages as page (page.index)}
          <img src={page.url} alt={`Page ${page.index + 1}`} loading="lazy" />
        {/each}
      </div>
    {:else}
      <div class="stage">
        <img src={pages[index].url} alt={`Page ${index + 1}`} />
        <button class="zone left" aria-label="Previous page" onclick={() => step(-1)}></button>
        <button class="zone right" aria-label="Next page" onclick={() => step(1)}></button>
      </div>
    {/if}
  {/if}
</section>

<style>
  .reader header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  .pos {
    flex: 1;
    text-align: center;
    color: #8a8a96;
    font-size: 13px;
  }
  .stage {
    position: relative;
    display: grid;
    place-items: center;
    background: #0b0b0e;
    border-radius: 10px;
    overflow: hidden;
  }
  .stage img {
    max-width: 100%;
    max-height: 82vh;
    display: block;
  }
  .zone {
    all: unset;
    position: absolute;
    top: 0;
    bottom: 0;
    width: 35%;
    cursor: pointer;
  }
  .zone.left {
    left: 0;
  }
  .zone.right {
    right: 0;
  }
  .strip {
    display: grid;
    gap: 6px;
    justify-items: center;
  }
  .strip img {
    max-width: min(100%, 900px);
  }
  .empty {
    color: #8a8a96;
    font-size: 14px;
  }
</style>
