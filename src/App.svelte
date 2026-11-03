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
  import Plugins from "./views/Plugins.svelte";
  import Series from "./views/Series.svelte";
  import Source from "./views/Source.svelte";
  import Search from "./views/Search.svelte";
  import Reader from "./views/Reader.svelte";
  import Extensions from "./views/Extensions.svelte";
  import Software from "./views/Software.svelte";
  import Settings from "./views/Settings.svelte";
  import Downloads from "./views/Downloads.svelte";
  import Backup from "./views/Backup.svelte";
  import Welcome from "./components/Welcome.svelte";
  import SlowNotice from "./components/SlowNotice.svelte";

  import { bootReport, library } from "./state/library.svelte";
  import { appVersion } from "./lib/app-info";
  import { categories } from "./state/categories.svelte";
import { sourceMarks } from "./state/source-marks.svelte";
  import { settings } from "./state/settings.svelte";
  import { downloads } from "./state/downloads.svelte";
  import { appearance } from "./lib/theme.svelte";
  import { startChrome } from "./lib/chrome.svelte";
  import { viewport } from "./lib/layout.svelte";
  import { destinationOf } from "./lib/destinations";
  import { parseRoute, go } from "./lib/nav";
  import { isFetchableRepo, registerProtocolHandler, repoFromLocation } from "./lib/deep-link";
  import { softwareHref, softwareRefFromLocation, watchSoftwareLinks } from "./lib/software";
  import { pairFromLocation, setHostToken, setRemoteHost } from "./lib/host";

  let route = $state(parseRoute(location.hash));

  const active = $derived(destinationOf(route));

  /**
   * Seconds spent opening, counted only while it is still opening.
   *
   * A clock that stops when the library is ready is not decoration: "Opening the library… 0 s" and
   * "… 47 s" are different bugs, and the number is the only part of the screen that says which.
   */
  let now = $state(Date.now());
  $effect(() => {
    if (library.ready) return;
    const tick = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(tick);
  });
  const elapsed = $derived(
    bootReport.startedAt === 0 ? null : Math.max(0, Math.round((now - bootReport.startedAt) / 1000)),
  );

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
    // A package page comes first: `/source?repo=…&id=…` carries a `repo` too, and reading it as an
    // install link would open the repository panel instead of the package the link named. The path
    // stays — that is the canonical address — and the route moves into the hash, where it belongs.
    const software = softwareRefFromLocation(location.href);
    if (software !== null) {
      history.replaceState(null, "", `${location.pathname}#${softwareHref(software)}`);
      route = parseRoute(location.hash);
    } else if (requested !== null && isFetchableRepo(requested)) {
      pendingRepo = requested;
      go("/extensions");
    }

    // iOS hands a universal link to the app instead of loading a page: `getLaunchUrl` for a cold
    // start, the `appUrlOpen` event for a warm one. Both end on the package page, and neither acts.
    let stopLinks: (() => void) | null = null;
    void watchSoftwareLinks((ref) => go(softwareHref(ref)))
      .then((stop) => (stopLinks = stop))
      .catch(() => undefined);

    // Lets `web+mihon://…` links open this app in a tab; a bare `mihon://` is the packaged build's
    // scheme, and pasting it into the field works here.
    registerProtocolHandler();
    appearance.start();
    startChrome();
    const stopViewport = viewport.start();
    const onHash = () => {
      // An in-app `#/extensions?repo=…` — a package page pointing at a repository this app has not
      // added — proposes the same panel a cold boot does, instead of parsing as an unknown route.
      const wantedRepo = repoFromLocation(location.href);
      if (wantedRepo !== null && isFetchableRepo(wantedRepo)) {
        pendingRepo = wantedRepo;
        go("/extensions");
        return;
      }
      route = parseRoute(location.hash);
    };
    addEventListener("hashchange", onHash);
    // Categories and preferences are read once, with the library: a series deep link and the
    // reader both need them before a view mounts, so no view owns this.
    void (async () => {
      await library.open();
      const store = library.profile?.store;
      if (store === undefined) return;
      await Promise.all([categories.load(store), sourceMarks.load(store), settings.load(store), downloads.load()]);
    })();
    return () => {
      removeEventListener("hashchange", onHash);
      stopViewport();
      stopLinks?.();
    };
  });
</script>

<!--
  First run, before the shell: App Store review reads this screen first, and it is the one place the
  app can say what it is not — no comics of its own, no list of sites. `settings.ready` is the gate,
  not `library.ready`: a preference that has not loaded yet must not flash the welcome at someone who
  dismissed it months ago.
-->
{#if settings.ready && !settings.welcomed}
  <Welcome />
{:else if route.name === "read" && route.id !== null && route.chapterId !== null}
  <Reader seriesId={route.id} chapterId={route.chapterId} />
{:else}
  <AppShell {active} routeKey={`${route.name}:${route.id ?? ""}:${route.chapterId ?? ""}`}>
    {#if library.storageFallback}
      <!--
        Device-level, so it belongs above every destination: a library running in memory looks
        completely normal until someone closes the app and finds nothing they did survived. One
        sentence, dismissible by fixing the cause, not by tapping an X.
      -->
      <p class="nostore" role="status">{library.error}</p>
    {/if}
    {#if !library.ready && library.openError === null && active === "library"}
      <!--
        Scoped to the library destination on purpose. The gate used to sit above every route, so an
        opening library replaced Settings, Browse, Extensions and More with the same sentence — the
        tabs looked broken, and a library that never finished left the whole app looking dead. Other
        destinations read the same state and render their own empty case, so they keep working.
      -->
      <!--
        The words alone were undiagnosable: the same sentence appeared whether a step was slow, the
        extension host was wedged, or nothing had been called at all. The build and the running step
        are printed with it, so one screenshot says where it stopped — and "Try again" is the way out
        of a start that will never answer, without reinstalling the app.
      -->
      <div class="boot">
        <p class="bootline">Opening the library…{elapsed === null ? "" : ` ${elapsed} s`}</p>
        <p class="bootmeta">
          HardlyTracking {appVersion()}{bootReport.step === null ? "" : ` · ${bootReport.step}`}
        </p>
        <button class="btn ghost" onclick={() => void library.retry()}>Try again</button>
      </div>
    {:else if library.openError !== null && active === "library"}
      <div class="boot">
        <p class="banner">{library.openError}</p>
        <p class="muted">The library could not be opened. Reload once the extension host is running.</p>
        <p><button class="btn ghost" onclick={() => void library.retry()}>Try again</button></p>
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
    {:else if route.name === "software" && route.id !== null}
      <Software pkg={route.id} repo={route.repo} />
    {:else if route.name === "plugins"}
      <Plugins />
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

<!--
  Above every view, outside the shell and outside the welcome: a slow source is a property of the app,
  not of a screen. The welcome screen picks comic files too, and that is the one place a first import
  happens — a chip that only mounts after it cannot say the first file is still being read.
-->
<SlowNotice />

<style>
  .boot {
    padding: var(--s5) var(--s4);
    color: var(--text-2);
    font-size: var(--t-sm);
  }

  .boot .bootline {
    margin: 0;
  }

  .boot .bootmeta {
    margin: var(--s1) 0 var(--s3);
    color: var(--text-3);
    font-size: var(--t-xs);
  }

  .nostore {
    margin: 0;
    padding: var(--s3) var(--s4);
    border-bottom: 1px solid var(--line-strong);
    background: var(--surface);
    color: var(--text-1);
    font-size: var(--t-sm);
  }
</style>
