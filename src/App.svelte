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
  import { parseRoute, go } from "./lib/nav";
  import { isFetchableRepo, registerProtocolHandler, repoFromLocation } from "./lib/deep-link";
  import { pairFromLocation, setHostToken, setRemoteHost } from "./lib/host";

  let route = $state(parseRoute(location.hash));

  const active = $derived(destinationOf(route));

  /**
   * An install link opened this app: `?repo=…`, `#/extensions?repo=…`, or a packaged build handing us
   * `mihon://extension-store?url=…`. The repository is remembered here and consumed by the Extensions
   * screen, which is where adding one belongs.
   */
  let pendingRepo = $state<string | null>(null);

  onMount(() => {
    // A pairing link points this device at a desktop that serves the runtime, and carries its token.
    const pair = pairFromLocation(location.href);
    if (pair.host !== null) setRemoteHost(pair.host);
    if (pair.token !== null) setHostToken(pair.token);

    const requested = repoFromLocation(location.href);
    if (requested !== null && isFetchableRepo(requested)) {
      pendingRepo = requested;
      go("/extensions");
    }
    // Lets `web+mihon://…` links open this app in a tab; a bare `mihon://` is the packaged build's
    // scheme, and pasting it into the field works here.
    registerProtocolHandler();
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
      <Extensions repo={pendingRepo} />
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
