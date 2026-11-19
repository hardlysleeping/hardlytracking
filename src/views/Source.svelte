<script lang="ts">
  /**
   * One source: popular, latest, search, and more pages.
   *
   * The same component whether it is the whole screen on a phone or the right-hand pane of a
   * desktop split — it asks the provider for pages and draws a grid, and knows nothing about
   * where it sits.
   */
  import { untrack } from "svelte";
  import { privacy } from "../state/privacy.svelte";
  import { visibility } from "../state/visibility.svelte";
  import { library } from "../state/library.svelte";
  import { providerFor } from "../api/registry";
  import { needsLogin } from "../api/mihon-bridge";
  import type { BrowseTab, Paged, Series, SourceFilter, SourceFilterSelection, SourceProvider } from "../api/source";
  import { browseTabLabel, browseTabsOf } from "../lib/source-tabs";
  import SeriesGrid from "../components/SeriesGrid.svelte";
  import SeriesDetail from "./Series.svelte";
  let expandedId = $state<string | null>(null);
  import SeriesActions from "../components/SeriesActions.svelte";
  import BrowseDisplay from "../components/BrowseDisplay.svelte";
  import SourceSettings from "../components/SourceSettings.svelte";
  import SourceFilterSheet from "../components/SourceFilterSheet.svelte";
  import CollapseFloat from "../components/CollapseFloat.svelte";
  import { settings } from "../state/settings.svelte";
  import { activeCount, cleanSelection } from "../lib/source-filters";
  import { generations } from "../lib/latest";
  import { go, pathTo } from "../lib/nav";

  interface Props {
    sourceId: string;
    embedded?: boolean;
  }
  let { sourceId, embedded = false }: Props = $props();

  /**
   * A tap outside an opened item closes it.
   *
   * The panel is a second line of the row it belongs to, so tapping anywhere else on the page — another
   * title, the search field, the empty space under the grid — means "I am done with this". The tile
   * that owns the panel is exempt, because tapping it is the toggle; so is anything inside the panel,
   * which is where the reader is actually reading.
   */
  $effect(() => {
    if (expandedId === null) return;
    const onTap = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".issue-panel") !== null) return;
      // Any tile is left to the tile: tapping another title switches the panel to it, and tapping the
      // open one closes it. Closing here on pointerdown would reflow the grid under the finger and the
      // click that was meant to land on a title would never arrive.
      if (target.closest("[data-series-id]") !== null) return;
      expandedId = null;
    };
    document.addEventListener("pointerdown", onTap, true);
    return () => document.removeEventListener("pointerdown", onTap, true);
  });

  /**
   * Swapping the layout closes whatever is open.
   *
   * An item opened as a row is a full-width second line under that row; carried into a grid it becomes
   * a panel wedged between two columns, with the title it belongs to somewhere else. The layout is a
   * different way of reading the same list, so it starts closed — and the opened item is remembered
   * nowhere, because coming back to a layout and finding a stranger's details already open is worse
   * than tapping the title again.
   */
  let watchedView = settings.libraryView;
  $effect(() => {
    const view = settings.libraryView;
    if (view === watchedView) return;
    watchedView = view;
    untrack(() => {
      if (expandedId !== null) expandedId = null;
    });
  });

  let mode = $state<BrowseTab | "search">("popular");
  /** The title whose quick actions are open, or null. */
  let actions = $state<Series | null>(null);
  let query = $state("");
  let items = $state<Series[]>([]);
  const visibleItems = $derived(items.filter((row) => visibility.allows(row)));
  const visibleExpanded = $derived(expandedId !== null && visibleItems.some((row) => row.id === expandedId) ? expandedId : null);
  let hasNext = $state(false);
  let page = $state(1);
  let busy = $state(false);
  let error = $state<string | null>(null);
  /** The login page a 401 named, so the button opens the page the source asked for. */
  let loginUrl = $state<string | null>(null);
  let loginState = $state<"idle" | "busy" | "done">("idle");
  /**
   * The consent question, when the source has not been allowed cookies for its domain yet.
   *
   * The login button opens a webview, which is where the cookie jar starts being shared, so the
   * question is asked before that page loads rather than after it has already been used.
   */
  let askConsent = $state<{ host: string; question: string } | null>(null);

  const source = $derived(library.sources.find((row) => row.id === sourceId) ?? null);
  /** The provider behind this source, or null when it is gone (extension removed mid-visit). */
  function providerOrNull(): SourceProvider | null {
    if (library.profile === null) return null;
    try {
      return providerFor(library.profile.providers, sourceId);
    } catch {
      return null;
    }
  }
  /**
   * The listings this source actually has.
   *
   * Read from the source's own declaration, so a source that cannot answer a listing does not get a
   * chip for it — archive.org answers three (Trending, Popular, Latest), everything else keeps the
   * Popular/Latest pair it has always had.
   */
  const tabs = $derived(browseTabsOf(source, providerOrNull()));
  /**
   * Only a source from the extension runtime has a settings screen of its own. Showing a gear on
   * archive.org or the device library would promise a page that does not exist.
   */
  const configurable = $derived(source?.id.startsWith("dalvik:") === true);
  let settingsOpen = $state(false);

  /**
   * Which listing request is allowed to paint.
   *
   * A tap on Latest while Popular is still loading must not be overwritten when Popular answers:
   * the newest request owns the grid, the spinner and the error banner, and an older answer is
   * dropped where it lands. Same rule the detail and reader screens already apply by hand.
   */
  const listingRuns = generations();

  /**
   * The source's own filter form, asked once per source.
   *
   * An empty list is the answer for most sources, and it is also where a provider that cannot ask
   * lands: the Filters button is drawn only for a form that exists, so a source with nothing to
   * filter never shows a button that opens an empty sheet.
   */
  let filters = $state<SourceFilter[]>([]);
  let filterSheetOpen = $state(false);
  /** Which source the in-flight filter request is for, so a late answer cannot land on the wrong one. */
  let askedFor = "";

  /** What this source's search carries: the stored choices, minus anything that is not a change. */
  const filterSelection = $derived<SourceFilterSelection>(
    cleanSelection(filters, settings.sourceFilters[sourceId] ?? {}),
  );

  async function loadFilters(): Promise<void> {
    filters = [];
    const wanted = sourceId;
    askedFor = wanted;
    if (library.profile === null) return;
    const provider = providerFor(library.profile.providers, wanted);
    if (provider.filters === undefined) return;
    try {
      const answer = await provider.filters(wanted);
      if (askedFor !== wanted) return;
      filters = answer;
    } catch {
      // A source that cannot answer its own form has no filters, not an error banner: the listing
      // above it still works, and the reader did not ask this source a question.
      filters = [];
    }
  }

  /**
   * Whether the library has opened yet.
   *
   * A route restored on launch (a reload, a phone that was killed with a source open) mounts this
   * view before `library.open()` has built its providers. `run()` returns early with no profile and
   * nothing used to ask it again, so the page said "This source returned nothing." and only a
   * manual Refresh brought the grid back. Read here, outside the `untrack` below, so the effect
   * depends on it the way it depends on `sourceId`.
   */
  const ready = $derived(library.profile !== null);

  $effect(() => {
    // A new source resets the grid: keeping the old rows while the next fetch runs is how a
    // screen ends up showing one source's results under another source's name.
    //
    // Everything below is `untrack`ed on purpose: `run()` reads `mode` and `query` before its first
    // await, and a plain call here would make those reads dependencies of *this* effect — so tapping
    // Latest set the mode, this effect re-ran, and set it back to Popular. The tabs stopped working
    // and the only thing that moved was nothing. The effect depends on `sourceId` and readiness.
    void sourceId;
    if (!ready) return;
    untrack(() => {
      items = [];
      page = 1;
      // The source's own first listing, so Archive opens on Trending rather than on the all-time
      // list that reads the same for months.
      mode = tabs[0] ?? "popular";
      query = "";
      filterSheetOpen = false;
      void loadFilters();
      void run(1);
    });
  });

  /**
   * One page of whichever listing `mode` names.
   *
   * Trending falls back to Popular when a provider declares the tab but has no method — the tab row
   * already drops it in that case, so this is only reachable mid-flight.
   */
  function listing(provider: SourceProvider, next: number): Promise<Paged<Series>> {
    if (mode === "trending") return (provider.trending ?? provider.popular).call(provider, sourceId, next);
    if (mode === "popular") return provider.popular(sourceId, next);
    if (mode === "latest") return provider.latest(sourceId, next);
    // The source's own form travels with the search, and only with the search: a Mihon extension
    // applies filters in `getSearchManga` and ignores them for popular/latest.
    return provider.search(
      sourceId,
      query.trim(),
      next,
      Object.keys(filterSelection).length > 0 ? filterSelection : undefined,
    );
  }

  async function run(next = 1): Promise<void> {
    // Claimed before the guards, so a run that returns early still invalidates the one in flight:
    // leaving a source has to stop the answer it was waiting for from filling the next one's grid.
    const token = listingRuns.begin();
    if (!visibility.sourceAllowed(sourceId)) return;
    const revision = privacy.revision;
    if (library.profile === null) return;
    if (mode === "search" && query.trim() === "") return;
    const current = (): boolean =>
      listingRuns.isCurrent(token) && revision === privacy.revision && visibility.sourceAllowed(sourceId);
    busy = true;
    error = null;
    loginUrl = null;
    try {
      const provider = providerFor(library.profile.providers, sourceId);
      const result = await listing(provider, next);
      if (!current()) return;
      items = next === 1 ? result.items : [...items, ...result.items];
      hasNext = result.hasNext;
      page = next;
    } catch (e) {
      // A superseded request's failure is not this screen's error: the reader has already asked
      // another source, and its banner would be about a title they cannot see.
      if (!current()) return;
      error = e instanceof Error ? e.message : String(e);
      // A source that wants a login says so with a 401 and the page to open; anything else is a
      // failure to show as it is, without offering a login that would not help.
      if (needsLogin(e)) loginUrl = e.loginUrl ?? "";
    } finally {
      // Only the newest run owns `busy`: an older one finishing must not clear the spinner the
      // newer one is still waiting under.
      if (current()) busy = false;
    }
  }

  /**
   * Write the sheet's choices for this source and re-run what is on screen.
   *
   * Stored as one entry of `settings.sourceFilters`, and an empty selection removes the entry rather
   * than keeping a key that says nothing — the pref only names sources that actually filter.
   */
  function applyFilters(selection: SourceFilterSelection): void {
    const all = { ...settings.sourceFilters };
    if (Object.keys(selection).length === 0) delete all[sourceId];
    else all[sourceId] = selection;
    settings.set("sourceFilters", all);
    if (mode === "search") void run(1);
  }

  /**
   * Open the source's page in the in-app webview and hand the runtime what it set.
   *
   * The outcome is stated plainly: a cancelled page is not an error, a build without a webview says
   * so, and a login that did not take is reported rather than silently retried.
   */
  async function login(): Promise<void> {
    if (library.profile === null) return;
    loginState = "busy";
    try {
      const result = await library.profile.login(sourceId, { loginUrl });
      if (result.status === "consent") {
        askConsent = { host: result.host, question: result.question };
        loginState = "idle";
        return;
      }
      if (result.status === "ok") {
        loginState = "done";
        error = null;
        await run(1);
        return;
      }
      error =
        result.status === "cancelled"
          ? "Login cancelled."
          : result.status === "unsupported"
            ? result.reason
            : result.status === "failed"
              ? `The login page could not open: ${result.reason}`
              : `The source still refuses this session: ${result.reason}`;
      loginState = "idle";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      loginState = "idle";
    }
  }

  /** Remember the yes, then run the login that was waiting on it. */
  async function allowCookies(): Promise<void> {
    if (library.profile === null || askConsent === null) return;
    await library.profile.consent.grant(sourceId, askConsent.host);
    askConsent = null;
    await login();
  }

  function setMode(next: BrowseTab): void {
    mode = next;
    void run(1);
  }
  $effect(() => { const store = library.profile?.store; if (store) void visibility.load(store); });
</script>

{#if visibility.sourceAllowed(sourceId)}
<section class="view" class:embedded>
  <div class="pin">
  <header class="bar">
    {#if !embedded}
      <button class="btn ghost icon" aria-label="Back to sources" onclick={() => go("/browse")}>
        <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>
      </button>
    {/if}
    <div class="titles">
      <h1>{source?.name ?? "Source"}</h1>
      {#if source?.lang}<span class="lang">{source.lang}</span>{/if}
    </div>
    {#if configurable}
      <button class="btn ghost icon" aria-label="Source settings" onclick={() => (settingsOpen = true)}>
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10l1.4 1.4m0-12.8l-1.4 1.4m-10 10l-1.4 1.4" /></svg>
      </button>
    {/if}
  </header>

  <form
    class="search"
    onsubmit={(event) => {
      event.preventDefault();
      mode = "search";
      void run(1);
    }}
  >
    <input class="field" type="search" placeholder={`Search ${source?.name ?? "this source"}`} bind:value={query} aria-label="Search this source" />
    <button class="btn" type="submit" disabled={busy}>Search</button>
  </form>

  <div class="modes" role="tablist" aria-label="Listing">
    {#each tabs as tab (tab)}
      <button
        class="chip"
        class:on={mode === tab}
        role="tab"
        aria-selected={mode === tab}
        onclick={() => setMode(tab)}
      >{browseTabLabel(tab)}</button>
    {/each}
    {#if filters.length > 0}
      <button
        class="chip filters"
        class:on={activeCount(filterSelection) > 0}
        title={activeCount(filterSelection) > 0
          ? "This source's search carries your filter choices"
          : "Pick what this source should narrow its searches to"}
        onclick={() => (filterSheetOpen = true)}
      >
        Filters{activeCount(filterSelection) > 0 ? ` (${activeCount(filterSelection)})` : ""}
      </button>
    {/if}
    {#if mode === "search"}
      <span class="hint">searching “{query}”</span>
    {:else if activeCount(filterSelection) > 0}
      <span class="hint">filters apply to search</span>
    {/if}
    <!--
      A listing is a page of the source *now*, and it is the one thing a source page had no way to
      ask for again: the mode chips only re-run when the mode changes, so tapping Popular twice did
      nothing, and a feed that had grown stale stayed stale until the source was left and reopened.
      The rows stay on screen while the new page loads, so a refresh is not a flash of empty grid.
    -->
    <button
      class="chip refresh"
      aria-label={`Refresh ${mode === "search" ? "results" : mode}`}
      title="Ask the source for this page again"
      disabled={busy}
      onclick={() => void run(1)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4" /></svg>
      Refresh
    </button>
  </div>

  </div>

  {#if error}<p class="banner">{error}</p>{/if}
  {#if askConsent !== null}
    <div class="consent" role="group" aria-label="Cookie permission">
      <p class="cq">{askConsent.question}</p>
      <p class="cd">The sign-in page runs on the site itself. Whatever it sets is kept on this device and sent to the source with each request, so you stay signed in. Refusing keeps the source working, just signed out.</p>
      <div class="cacts">
        <button class="btn ghost" onclick={() => (askConsent = null)}>Not now</button>
        <button class="btn primary" onclick={() => void allowCookies()}>Allow</button>
      </div>
    </div>
  {/if}
  {#if loginUrl !== null}
    <button class="btn login" disabled={loginState === "busy"} onclick={() => void login()}>
      {loginState === "busy" ? "Waiting for the login page…" : "Log in to this source"}
    </button>
  {/if}
  {#if busy && items.length === 0}<p class="empty">Loading…</p>{/if}

  <!-- The same display controls as the Library and Search, on the same stored choice: a source's
       own grid was drawing with no column setting at all, which auto-filled to two covers on a
       phone and offered nothing to change. -->
  {#if visibleItems.length > 0 || items.length > 0}
    <BrowseDisplay />
  {/if}

  <!-- A tap exposes this item's issues in the result grid, not a menu hiding the contents. -->
  <SeriesGrid
    series={visibleItems}
    cover={132}
    view={settings.libraryView}
    titlePlacement={settings.browseTitle}
    rowStyle={settings.rowStyle}
    empty={mode === "search" ? "This source found nothing." : "This source returned nothing."}
    expandAfter={visibleExpanded}
    expanded={issuePanel}
    onlongpress={(series) => (actions = series)}
    onpick={(series) => { expandedId = expandedId === series.id ? null : series.id; }}
  />
  {#snippet issuePanel()}
    {#if visibleExpanded !== null}
      <div class="issue-panel">
        <SeriesDetail seriesId={visibleExpanded} embedded />
      </div>
    {/if}
  {/snippet}
  <!--
    Out of an opened item: the floating caret above the back pair, or a tap anywhere that is not the
    item itself. Both leave the page where it is; neither is a button at the top of the panel that you
    have to scroll back to.
  -->
  {#if visibleExpanded !== null}
    <CollapseFloat oncollapse={() => (expandedId = null)} />
  {/if}
  <SeriesActions series={actions && visibility.allows(actions) ? actions : null} onclose={() => (actions = null)} ondetails={(series) => go(pathTo("series", series.id))} />

  {#if hasNext}
    <button class="btn more" disabled={busy} onclick={() => void run(page + 1)}>{busy ? "Loading…" : "Load more"}</button>
  {/if}
</section>

{#if configurable}
  <SourceSettings open={settingsOpen} {sourceId} onclose={() => (settingsOpen = false)} />
{/if}

{#if filters.length > 0}
  <SourceFilterSheet
    open={filterSheetOpen}
    sourceName={source?.name ?? "this source"}
    {filters}
    selection={filterSelection}
    onclose={() => (filterSheetOpen = false)}
    onapply={applyFilters}
  />
{/if}

{:else}
  <p class="view" role="status">Hidden by local screen privacy. Unlock from Library to view.</p>
{/if}

<style>
  /* The refresh chip carries a small icon; the other chips are words only, so this is the only
     place the icon size is stated. */
  .chip.refresh {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
  }
  .chip.refresh svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }

  .issue-panel {
    padding: var(--s3);
    border: 1px solid var(--line);
    border-radius: var(--r3);
    background: var(--surface);
  }
  .issue-panel :global(.view > header) {
    position: static;
    margin-top: 0;
    padding-top: 0;
    box-shadow: none;
  }

  .consent {
    display: grid;
    gap: var(--s1);
    margin: 0 var(--s3) var(--s3);
    padding: var(--s3);
    border: 1px solid var(--line);
    border-radius: var(--r3);
    background: var(--surface-2);
  }

  .cq {
    margin: 0;
    font-weight: 600;
  }

  .cd {
    margin: 0;
    font-size: var(--t-sm);
    color: var(--text-2);
    max-width: 60ch;
  }

  .cacts {
    display: flex;
    gap: var(--s2);
    margin-top: var(--s1);
    flex-wrap: wrap;
  }

  .view {
    padding: var(--s4) var(--s4) var(--s7);
    max-width: 1100px;
    /* The shell's own gutter, capped: at the default 16px the covers in a three-across grid were
       the smallest thing on the screen, which is the report "excessive margins are squishing the
       cover images". The user's own margins setting still wins when it is tighter (compact 10px
       becomes 8, none 4 stays 4). `!important` because the shell applies the margin with it, and
       declared as the view's gutter so the pinned header in app.css cancels exactly this much. */
    --view-pad-x: min(var(--pad-x), var(--s2));
    padding-left: var(--view-pad-x) !important;
    padding-right: var(--view-pad-x) !important;
  }

  .view.embedded {
    max-width: none;
    padding-top: var(--s3);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-bottom: var(--s3);
    min-height: 36px;
  }

  .bar svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .titles {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    min-width: 0;
  }

  h1 {
    font-size: var(--t-xl);
    font-weight: 650;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .lang {
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
  }

  .search {
    display: flex;
    gap: var(--s2);
    margin-bottom: var(--s3);
  }

  .search .field {
    flex: 1;
    min-height: 38px;
  }

  .modes {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-bottom: var(--s4);
  }

  .hint {
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .more {
    margin-top: var(--s5);
  }

  /* The login button sits directly under the banner that asked for it, so the two read as one
     message: "this source wants a login" and "here is the button". */
  .login {
    margin-top: var(--s2);
  }
</style>
