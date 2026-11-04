<script lang="ts">
  import Library from '../../src/views/Library.svelte';
  import Search from '../../src/views/Search.svelte';
  import History from '../../src/views/History.svelte';
  import Stats from '../../src/views/Stats.svelte';
  import Downloads from '../../src/views/Downloads.svelte';
  import Browse from '../../src/views/Browse.svelte';
  import Source from '../../src/views/Source.svelte';
  import Series from '../../src/views/Series.svelte';
  import LibraryBand from '../../src/components/LibraryBand.svelte';
  let view = $state('Library');
</script>
<nav aria-label="Fixture views">{#each ['Library','Search','History','Stats','Downloads','Browse','Source','Series'] as item}<button onclick={() => view = item}>{item}</button>{/each}</nav>
{#if view !== 'Library'}<LibraryBand />{/if}
<main>
{#if view === 'Library'}<Library />
{:else if view === 'Search'}<Search />
{:else if view === 'History'}<History />
{:else if view === 'Stats'}<Stats />
{:else if view === 'Downloads'}<Downloads />
{:else if view === 'Browse'}<Browse />
{:else if view === 'Source'}<Source sourceId="mihon:src:99" />
{:else}<Series seriesId="local:private" />{/if}
</main>
<style>
 :global(body) { margin:0; padding:var(--safe-t) var(--safe-r) var(--safe-b) var(--safe-l); box-sizing:border-box; min-height:100dvh; overflow:auto; }
 nav { display:flex; flex-wrap:wrap; gap:4px; } nav button { min-height:44px; }
 main { min-width:0; }
</style>
