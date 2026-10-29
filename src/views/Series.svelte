<script lang="ts">
  import { library } from "../state/library.svelte";
  import { providerFor } from "../api/registry";
  import type { Chapter, Series } from "../api/source";
  import Cover from "../components/Cover.svelte";
  import { go } from "../lib/nav";

  interface Props {
    seriesId: string;
  }
  let { seriesId }: Props = $props();

  let series = $state<Series | null>(null);
  let chapters = $state<Chapter[]>([]);
  let saved = $state(false);
  let busy = $state(true);
  let error = $state<string | null>(null);

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
      saved = await library.isSaved(id);
      chapters = await library.chapters(id);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function toggleSaved(): Promise<void> {
    if (series === null) return;
    if (saved) await library.unsave(series.id);
    else await library.save(series, chapters);
    saved = !saved;
  }
</script>

<section>
  {#if error}<p class="banner">{error}</p>{/if}
  {#if busy && series === null}<p class="empty">Loading…</p>{/if}

  {#if series}
    <header class="hero">
      <Cover {series} size="hero" />
      <div class="meta">
        <h1>{series.title}</h1>
        {#if series.author}<p class="author">{series.author}</p>{/if}
        <div class="actions">
          <button class="ghost" onclick={toggleSaved}>{saved ? "In library" : "Add to library"}</button>
        </div>
        {#if series.description}<p class="description">{series.description}</p>{/if}
      </div>
    </header>

    <h2>Chapters</h2>
    {#if chapters.length === 0}
      <p class="empty">This source has no chapters cached yet.</p>
    {:else}
      <ul class="chapters">
        {#each chapters as chapter (chapter.id)}
          <li>
            <button onclick={() => go(`/read/${seriesId}/${chapter.id}`)}>
              <span class="name">{chapter.name}</span>
              <span class="count">{chapter.pageCount > 0 ? `${chapter.pageCount} pages` : "unfetched"}</span>
              {#if chapter.read}<span class="read">read</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .hero {
    display: flex;
    gap: 18px;
    margin-bottom: 26px;
  }
  .meta {
    display: grid;
    gap: 10px;
    align-content: start;
  }
  h1 {
    font-size: 22px;
    font-weight: 600;
    margin: 0;
  }
  h2 {
    font-size: 15px;
    font-weight: 600;
    margin: 0 0 10px;
    color: #b9b9c6;
  }
  .author {
    margin: 0;
    color: #8a8a96;
    font-size: 13px;
  }
  .description {
    margin: 0;
    color: #a9a9b6;
    font-size: 13px;
    line-height: 1.5;
    max-width: 60ch;
  }
  .chapters {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  .chapters button {
    all: unset;
    cursor: pointer;
    display: flex;
    gap: 12px;
    align-items: baseline;
    padding: 9px 10px;
    border-radius: 8px;
    font-size: 13px;
    color: #d6d6de;
  }
  .chapters button:hover {
    background: #1c1c22;
  }
  .name {
    flex: 1;
  }
  .count,
  .read {
    color: #7d7d8a;
    font-size: 12px;
  }
  .read {
    color: #6f9f7a;
  }
  .empty {
    color: #8a8a96;
    font-size: 14px;
  }
</style>
