<script lang="ts">
  // The real shell and the real pages, over the synthetic store in `nav-customise-fixture.ts`.
  // A tiny hash router stands in for App.svelte's, so `go()` (which sets `location.hash`) actually
  // changes the page — that is what the browser check navigates with.
  import AppShell from '../../src/components/AppShell.svelte';
  import Library from '../../src/views/Library.svelte';
  import Browse from '../../src/views/Browse.svelte';
  import Search from '../../src/views/Search.svelte';
  import History from '../../src/views/History.svelte';
  import More from '../../src/views/More.svelte';
  import Settings from '../../src/views/Settings.svelte';
  import { destinationOf } from '../../src/lib/destinations';
  import { parseRoute } from '../../src/lib/nav';

  let route = $state(parseRoute(location.hash));
  addEventListener('hashchange', () => (route = parseRoute(location.hash)));
  const active = $derived(destinationOf(route));
  const routeKey = $derived(`${route.name}:${route.id ?? ''}`);
</script>

<AppShell {active} {routeKey}>
  {#if route.name === 'settings'}
    <Settings />
  {:else if route.name === 'updates'}
    <Library initialTab="updates" />
  {:else if route.name === 'downloads'}
    <Library initialTab="downloads" />
  {:else if route.name === 'browse'}
    <Browse />
  {:else if route.name === 'search'}
    <Search />
  {:else if route.name === 'history'}
    <History />
  {:else if route.name === 'more'}
    <More />
  {:else}
    <Library />
  {/if}
</AppShell>

<style>
  :global(body) { margin: 0; padding: 0; }
</style>
