<script lang="ts">
  /**
   * One source: popular, latest, search, and more pages.
   *
   * The same component whether it is the whole screen on a phone or the right-hand pane of a
   * desktop split — it asks the provider for pages and draws a grid, and knows nothing about
   * where it sits.
   */
  import { library } from "../state/library.svelte";
  import { providerFor } from "../api/registry";
  import { needsLogin } from "../api/mihon-bridge";
  import type { Series } from "../api/source";
  import SeriesGrid from "../components/SeriesGrid.svelte";
  import SeriesActions from "../components/SeriesActions.svelte";
  import SourceSettings from "../components/SourceSettings.svelte";
  import { go, pathTo } from "../lib/nav";

  interface Props {
    sourceId: string;
    embedded?: boolean;
  }
  let { sourceId, embedded = false }: Props = $props();

  let mode = $state<"popular" | "latest" | "search">("popular");
  /** The title whose quick actions are open, or null. */
  let actions = $state<Series | null>(null);
  let query = $state("");
  let items = $state<Series[]>([]);
  let hasNext = $state(false);
  let page = $state(1);
  let busy = $state(false);
  let error = $state<string | null>(null);
  /** The login page a 401 named, so the button opens the page the source asked for. */
  let loginUrl = $state<string | null>(null);
  let loginState = $state<"idle" | "busy" | "done">("idle");

  const source = $derived(library.sources.find((row) => row.id === sourceId) ?? null);
  /**
   * Only a source from the extension runtime has a settings screen of its own. Showing a gear on
   * archive.org or the device library would promise a page that does not exist.
   */
  const configurable = $derived(source?.id.startsWith("dalvik:") === true);
  let settingsOpen = $state(false);

  $effect(() => {
    // A new source resets the grid: keeping the old rows while the next fetch runs is how a
    // screen ends up showing one source's results under another source's name.
    void sourceId;
    items = [];
    page = 1;
    mode = "popular";
    query = "";
    void run(1);
  });

  async function run(next = 1): Promise<void> {
    if (library.profile === null) return;
    if (mode === "search" && query.trim() === "") return;
    busy = true;
    error = null;
    loginUrl = null;
    try {
      const provider = providerFor(library.profile.providers, sourceId);
      const result =
        mode === "popular"
          ? await provider.popular(sourceId, next)
          : mode === "latest"
            ? await provider.latest(sourceId, next)
            : await provider.search(sourceId, query.trim(), next);
      items = next === 1 ? result.items : [...items, ...result.items];
      hasNext = result.hasNext;
      page = next;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      // A source that wants a login says so with a 401 and the page to open; anything else is a
      // failure to show as it is, without offering a login that would not help.
      if (needsLogin(e)) loginUrl = e.loginUrl ?? "";
    } finally {
      busy = false;
    }
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

  function setMode(next: "popular" | "latest"): void {
    mode = next;
    void run(1);
  }
</script>

<section class="view" class:embedded>
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
    <button class="chip" class:on={mode === "popular"} role="tab" aria-selected={mode === "popular"} onclick={() => setMode("popular")}>Popular</button>
    <button class="chip" class:on={mode === "latest"} role="tab" aria-selected={mode === "latest"} onclick={() => setMode("latest")}>Latest</button>
    {#if mode === "search"}
      <span class="hint">searching “{query}”</span>
    {/if}
  </div>

  {#if error}<p class="banner">{error}</p>{/if}
  {#if loginUrl !== null}
    <button class="btn login" disabled={loginState === "busy"} onclick={() => void login()}>
      {loginState === "busy" ? "Waiting for the login page…" : "Log in to this source"}
    </button>
  {/if}
  {#if busy && items.length === 0}<p class="empty">Loading…</p>{/if}

  <!-- A tap asks what to do with the title — read it, keep it, download it, file it — instead of
       assuming the series page. The page is still one tap away inside the sheet. -->
  <SeriesGrid
    series={items}
    cover={132}
    empty={mode === "search" ? "This source found nothing." : "This source returned nothing."}
    onpick={(series) => (actions = series)}
  />
  <SeriesActions series={actions} onclose={() => (actions = null)} ondetails={(series) => go(pathTo("series", series.id))} />

  {#if hasNext}
    <button class="btn more" disabled={busy} onclick={() => void run(page + 1)}>{busy ? "Loading…" : "Load more"}</button>
  {/if}
</section>

{#if configurable}
  <SourceSettings open={settingsOpen} {sourceId} onclose={() => (settingsOpen = false)} />
{/if}

<style>
  .view {
    padding: var(--s4) var(--s4) var(--s7);
    max-width: 1100px;
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
