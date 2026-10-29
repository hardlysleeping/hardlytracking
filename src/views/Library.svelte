<script lang="ts">
  import { library } from "../state/library.svelte";
  import SeriesGrid from "../components/SeriesGrid.svelte";
  import { go } from "../lib/nav";
</script>

<section>
  <header class="head">
    <h1>Library</h1>
    <button class="ghost" onclick={() => go("/browse")}>Browse sources</button>
  </header>

  {#if library.error}
    <p class="banner">{library.error}</p>
  {/if}

  {#if !library.ready}
    <p class="empty">Opening the library…</p>
  {:else}
    <SeriesGrid series={library.library} empty="Nothing here yet. Open a source and add a series." />
  {/if}
</section>

<style>
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 20px;
  }
  h1 {
    font-size: 22px;
    font-weight: 600;
    margin: 0;
  }
  .empty {
    color: #8a8a96;
    font-size: 14px;
  }
</style>
