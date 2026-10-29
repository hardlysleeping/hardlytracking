<script lang="ts">
  import type { Series } from "../api/source";
  import Cover from "./Cover.svelte";
  import { go } from "../lib/nav";

  interface Props {
    series: Series[];
    /** What an empty grid says; the library and a source say different things. */
    empty?: string;
  }
  let { series, empty = "Nothing here yet." }: Props = $props();
</script>

{#if series.length === 0}
  <p class="empty">{empty}</p>
{:else}
  <div class="grid">
    {#each series as item (item.id)}
      <button class="tile" onclick={() => go(`/series/${item.id}`)}>
        <Cover series={item} />
        <span class="title">{item.title}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 16px;
  }
  .tile {
    all: unset;
    cursor: pointer;
    display: grid;
    gap: 8px;
  }
  .tile:hover :global(.cover) {
    outline: 1px solid #3a3a46;
  }
  .title {
    font-size: 13px;
    line-height: 1.3;
    color: #d6d6de;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .empty {
    color: #8a8a96;
    font-size: 14px;
  }
</style>
