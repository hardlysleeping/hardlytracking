<script lang="ts">
  /**
   * The router and the one place the app starts.
   *
   * One screen at a time — the iPhone-first decision. A series page and a source are pushed on top
   * of the destination they came from, the shell keeps saying which destination that is, and the
   * reader leaves the shell entirely so nothing competes with the page.
   */
  import { onMount } from "svelte";
  import AppShell from "./components/AppShell.svelte";
  import Library from "./views/Library.svelte";
  import Updates from "./views/Updates.svelte";
  import Browse from "./views/Browse.svelte";
  import History from "./views/History.svelte";
  import More from "./views/More.svelte";
  import Series from "./views/Series.svelte";
  import Source from "./views/Source.svelte";
  import Search from "./views/Search.svelte";
  import Reader from "./views/Reader.svelte";
  import Extensions from "./views/Extensions.svelte";
  import Settings from "./views/Settings.svelte";
  import Downloads from "./views/Downloads.svelte";
  import Backup from "./views/Backup.svelte";

  import { library } from "./state/library.svelte";
  import { categories } from "./state/categories.svelte";
  import { settings } from "./state/settings.svelte";
  import { downloads } from "./state/downloads.svelte";
  import { appearance } from "./lib/theme.svelte";
  import { viewport } from "./lib/layout.svelte";
  import { destinationOf } from "./lib/destinations";
  import { parseRoute } from "./lib/nav";

  let route = $state(parseRoute(location.hash));

  const active = $derived(destinationOf(route));

  onMount(() => {
    appearance.start();
    const stopViewport = viewport.start();
    const onHash = () => (route = parseRoute(location.hash));
    addEventListener("hashchange", onHash);
    // Categories and preferences are read once, with the library: a series deep link and the
    // reader both need them before a view mounts, so no view owns this.
    void (async () => {
      await library.open();
      const store = library.profile?.store;
      if (store === undefined) return;
      await Promise.all([categories.load(store), settings.load(store), downloads.load()]);
    })();
    return () => {
      removeEventListener("hashchange", onHash);
      stopViewport();
    };
  });
</script>

{#if route.name === "read" && route.id !== null && route.chapterId !== null}
  <Reader seriesId={route.id} chapterId={route.chapterId} />
{:else}
  <AppShell {active}>
    {#if !library.ready && library.openError === null}
      <p class="boot">Opening the library…</p>
    {:else if library.openError !== null}
      <div class="boot">
        <p class="banner">{library.openError}</p>
        <p class="muted">The library could not be opened. Reload once the extension host is running.</p>
      </div>
    {:else if route.name === "updates"}
      <Updates />
    {:else if route.name === "browse"}
      <Browse />
    {:else if route.name === "history"}
      <History />
    {:else if route.name === "more"}
      <More />
    {:else if route.name === "extensions"}
      <Extensions />
    {:else if route.name === "settings"}
      <Settings />
    {:else if route.name === "downloads"}
      <Downloads />
    {:else if route.name === "backup"}
      <Backup />
    {:else if route.name === "search"}
      <Search initial={route.id} />
    {:else if route.name === "source" && route.id !== null}
      <Source sourceId={route.id} />
    {:else if route.name === "series" && route.id !== null}
      <Series seriesId={route.id} />
    {:else}
      <Library />
    {/if}
  </AppShell>
{/if}

<style>
  .boot {
    padding: var(--s5) var(--s4);
    color: var(--text-2);
    font-size: var(--t-sm);
  }
</style>
