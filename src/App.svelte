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
  import Browse from "./views/Browse.svelte";
  import History from "./views/History.svelte";
  import Stats from "./views/Stats.svelte";
  import More from "./views/More.svelte";
  import Sync from "./views/Sync.svelte";
  import Plugins from "./views/Plugins.svelte";
  import Series from "./views/Series.svelte";
  import Source from "./views/Source.svelte";
  import Search from "./views/Search.svelte";
  import ReaderGate from "./components/ReaderGate.svelte";
  import Extensions from "./views/Extensions.svelte";
  import Software from "./views/Software.svelte";
  import Settings from "./views/Settings.svelte";
  import Messages from "./views/Messages.svelte";
  import Backup from "./views/Backup.svelte";
  import Welcome from "./components/Welcome.svelte";
  import GlobalWarning from "./components/GlobalWarning.svelte";
  import { notices } from "./state/notices.svelte";
  import SlowNotice from "./components/SlowNotice.svelte";

  import { bootReport, library } from "./state/library.svelte";
  import { appVersion } from "./lib/app-info";
  import { categories } from "./state/categories.svelte";
import { sourceMarks } from "./state/source-marks.svelte";
  import { settings } from "./state/settings.svelte";
  import { downloads } from "./state/downloads.svelte";
  import { appearance } from "./lib/theme.svelte";
  import Appearance from "./views/Appearance.svelte";
  import { startChrome } from "./lib/chrome.svelte";
  import { viewport } from "./lib/layout.svelte";
  import { destinationOf } from "./lib/destinations";
  import { parseRoute, go } from "./lib/nav";
  import { noteRoute } from "./lib/reader-origin";
  import { isFetchableRepo, registerProtocolHandler, repoFromLocation, withoutLinkPayload } from "./lib/deep-link";
  import { softwareHref, softwareRefFromLocation, watchSoftwareLinks } from "./lib/software";
  import { pairFromLocation, setHostToken, setRemoteHost } from "./lib/host";

  let route = $state(parseRoute(location.hash));

  /**
   * The one place a route changes.
   *
   * The reader's exit needs to know which screen it was opened from, and it must know *before* the
   * reader mounts — a screen that asked later would race its own render. So the note is taken here,
   * synchronously with the route, rather than in an effect over `route`.
   */
  function readRoute(): void {
    const next = parseRoute(location.hash);
    route = next;
    noteRoute(location.hash, next.name === "read");
  }
  // The cold-start route counts too: a reader opened by a link has no origin, and must not inherit
  // one from a chapter change later in the session.
  noteRoute(location.hash, route.name === "read");

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
  /** The warning strip is dismissed by text, so a *new* warning is shown again. */
  let dismissedWarning = $state<string | null>(null);

  /**
   * One notice at a time, raised from the library's own trouble.
   *
   * `raised` is what stops a re-run of this effect from re-announcing the same sentence (and
   * retiming its seven seconds). Storage trouble is sticky: the log is for catching up, and a
   * library running in memory is not something to read later — it is something to fix, so that
   * notice has no timer and no X.
   */
  let raised: string | null = null;
  $effect(() => {
    notices.load();
    const text = library.storageFallback
      ? (library.error ?? "Device storage is unavailable — anything you do here is lost when the app closes.")
      : library.error !== null && library.error !== dismissedWarning
        ? library.error
        : null;
    if (text === null) {
      if (notices.sticky) notices.resolve();
      raised = null;
      return;
    }
    if (text === raised) return;
    raised = text;
    notices.show(text, { sticky: library.storageFallback });
  });
  const elapsed = $derived(
    bootReport.startedAt === 0 ? null : Math.max(0, Math.round((now - bootReport.startedAt) / 1000)),
  );

  /**
   * The preferences and marks that live in the library's store, read whenever that store appears.
   *
   * An effect on the profile rather than a block after the first `open()`: a failed boot has a
   * "Try again", and a retry that reopened the library without these turned every switch into a
   * write to nothing — silently — and left the first-run gate closed for good.
   */
  let loadedStore: unknown = null;
  $effect(() => {
    const store = library.profile?.store;
    if (store === undefined) {
      loadedStore = null;
      return;
    }
    if (loadedStore === store) return;
    loadedStore = store;
    void Promise.all([
      categories.load(store),
      sourceMarks.load(store),
      settings.load(store),
      downloads.load(),
    ]);
  });

  /**
   * An install link opened this app: `?repo=…`, `#/extensions?repo=…`, or a packaged build handing us
   * `mihon://extension-store?url=…`. The repository is remembered here and consumed by the Extensions
   * screen, which is where adding one belongs.
   */
  let pendingRepo = $state<string | null>(null);

  /**
   * Was this launch opened *by* a link rather than by tapping the icon?
   *
   * The welcome screen sits above every route, so a first launch that arrived with a destination —
   * a package page (`/source?repo=…&id=…`, `mihon://…`) or an install link (`?repo=…`) — had the
   * thing it was opened for replaced by three doors, and the doors navigate away from it. Read
   * synchronously, before the first render, because the gate is decided on that render and the URL
   * is rewritten to `#/software/…` in `onMount`.
   *
   * Only this launch is skipped: `welcomed` is not written, so an ordinary next launch still shows
   * the first-run screen. The screen is a start, not a gate.
   */
  const arrivedByLink: boolean = (() => {
    if (softwareRefFromLocation(location.href) !== null) return true;
    const repo = repoFromLocation(location.href);
    return repo !== null && isFetchableRepo(repo);
  })();

  /**
   * Take an install link's payload out of the address bar, wherever it sits.
   *
   * `?repo=…` / `?url=…` is an instruction to propose that repository once, not a permanent part of
   * the address. Left in place, every later hash change reads it again as a fresh install link and
   * pulls the person back to Extensions — and `go("/extensions")` on an address that already says
   * Extensions is no hash change at all, so the screen kept the previous route.
   */
  function stripLinkPayload(): void {
    history.replaceState(null, "", withoutLinkPayload(location.href));
  }

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
      readRoute();
    } else if (requested !== null && isFetchableRepo(requested)) {
      pendingRepo = requested;
      // Consume the payload: `?repo=…` stays in the address bar forever otherwise, and every later
      // hash change would be read as the same install link and pulled back to Extensions.
      stripLinkPayload();
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
      if (wantedRepo !== null && isFetchableRepo(wantedRepo) && pendingRepo !== wantedRepo) {
        pendingRepo = wantedRepo;
        go("/extensions");
        return;
      }
      // The same link again, or one already consumed: there is nothing new to propose, so the route
      // is read. `go("/extensions")` twice is no hash change at all, and the screen used to stay on
      // the previous route while the address bar said Extensions.
      if (wantedRepo !== null && isFetchableRepo(wantedRepo)) stripLinkPayload();
      readRoute();
    };
    addEventListener("hashchange", onHash);
    // Categories and preferences belong to the store, so they are read when it exists — not once
    // after the first `open()`. "Try again" after a failed boot reopens the library, and a one-shot
    // read left every preference writing nowhere (and the first-run gate never opening) with no
    // word said about it.
    void library.open();
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
{#if settings.ready && !settings.welcomed && !arrivedByLink}
  <Welcome />
{:else if route.name === "read" && route.id !== null && route.chapterId !== null}
  <ReaderGate seriesId={route.id} chapterId={route.chapterId} />
{:else}
  <AppShell {active} routeKey={`${route.name}:${route.id ?? ""}:${route.chapterId ?? ""}`}>
    {#if notices.current !== null}
      <!--
        An overlay, not a bar in the layout: a notice used to push the header and the page down and
        then stay there until tapped. It now floats over the top for seven seconds (see
        `state/notices`) and everything it said is kept in the log on the Settings page.
      -->
      <GlobalWarning
        message={notices.current}
        sticky={notices.sticky}
        ondismiss={() => { dismissedWarning = notices.current; notices.dismiss(); }}
      />
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
      <Library initialTab="updates" />
    {:else if route.name === "browse"}
      <Browse />
    {:else if route.name === "history"}
      <History />
    {:else if route.name === "stats"}
      <Stats />
    {:else if route.name === "more"}
      <More />
    {:else if route.name === "sync"}
      <Sync />
    {:else if route.name === "extensions"}
      <Extensions repo={pendingRepo} />
    {:else if route.name === "software" && route.id !== null}
      <Software pkg={route.id} repo={route.repo} />
    {:else if route.name === "plugins"}
      <Plugins />
    {:else if route.name === "appearance"}
      <Appearance />
    {:else if route.name === "settings"}
      <Settings />
    {:else if route.name === "messages"}
      <Messages />
    {:else if route.name === "downloads"}
      <!-- A Library section, so it renders inside the Library — same tabs, same back. -->
      <Library initialTab="downloads" />
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

</style>
