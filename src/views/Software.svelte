<script lang="ts">
  /**
   * One package, on its own page.
   *
   * The Extensions list is the index; this is the record behind one row. It answers what a person
   * (and an App Store reviewer) asks before installing anything — who publishes it, which
   * ecosystem, which version, which languages, what rating, which sources, and whether it is
   * already installed — and it offers the four actions that exist: Install, Update, Disable,
   * Uninstall.
   *
   * Opening this page writes nothing. The only work an open does is read the package's repository
   * index (the same read the Extensions list does), so a link cannot install, update, add a
   * repository or remove anything by being followed. Every action below is a tap of its own.
   */
  import { library } from "../state/library.svelte";
  import { loadRepository, RepositoryError, type Repository } from "../lib/extensions/repository";
  import type { ExtensionEntry } from "../lib/extensions/index";
  import {
    repoRefusal,
    softwareFacts,
    type SoftwareAction,
    type SoftwareFacts,
  } from "../lib/software";
  import { go, pathTo } from "../lib/nav";

  interface Props {
    /** The Android package id — the thing an extension row and a link both name. */
    pkg: string;
    /** The repository the link named, when it named one. */
    repo?: string | null;
  }
  let { pkg, repo = null }: Props = $props();

  let facts = $state<SoftwareFacts | null>(null);
  /** The entry itself: installing needs its APK URL, which is not something a person reads. */
  let entry = $state<ExtensionEntry | null>(null);
  /** The repository the page is about, as a URL — what an install would come from. */
  let repoUrl = $state<string | null>(repo);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let busy = $state<SoftwareAction | null>(null);
  let confirming = $state(false);
  /** Sixty sources is a list, not a record: twelve is enough to see what it covers. */
  let allSources = $state(false);

  const installedRow = $derived(library.extensions.find((row) => row.packageId === pkg) ?? null);

  /** A repository a link named that is not an http(s) address cannot be reviewed either. */
  const reviewable = $derived(repoUrl !== null && repoRefusal(repoUrl) === null);

  /**
   * Load once per (package, repository). This is the "on open" half, and it only reads: a link that
   * names a repository the app has not added is read through `loadRepository`, which returns the
   * index and stores nothing.
   */
  let loadedKey: string | null = null;
  $effect(() => {
    const key = `${pkg}\u0000${repo ?? ""}`;
    if (key === loadedKey) return;
    loadedKey = key;
    void load();
  });

  function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** An index, through the session cache when the repository is already added. */
  async function readIndex(url: string): Promise<Repository> {
    const added = library.repos.find((row) => row.url === url);
    if (added !== undefined) {
      return { url: added.url, indexUrl: added.indexUrl, name: added.name, extensions: await library.repoEntries(url) };
    }
    // Not added: read it to describe the package, store nothing. Adding is the panel's own tap.
    return await loadRepository(url);
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    notice = null;
    confirming = false;
    allSources = false;
    facts = null;
    entry = null;

    const refusal = repoRefusal(repo);
    if (refusal !== null) {
      error = refusal;
      facts = softwareFacts({ ref: { pkg, repo }, index: null, repos: library.repos, installed: library.extensions });
      loading = false;
      return;
    }

    // Which repository to read: the link's, else where the install came from, else whichever added
    // repository carries this package.
    const candidates: string[] = [];
    const add = (url: string | null | undefined): void => {
      if (url !== null && url !== undefined && url !== "" && !candidates.includes(url)) candidates.push(url);
    };
    if (repo !== null) add(repo);
    else {
      add(installedRow?.repoUrl);
      for (const row of library.repos) add(row.url);
    }

    const failures: string[] = [];
    let read: Repository | null = null;
    let firstReadable: Repository | null = null;
    for (const url of candidates) {
      try {
        const candidate = await readIndex(url);
        firstReadable ??= candidate;
        if (candidate.extensions.some((candidateEntry) => candidateEntry.pkg === pkg)) {
          read = candidate;
          break;
        }
      } catch (e) {
        failures.push(e instanceof RepositoryError && e.tried.length > 0 ? `${e.message} — tried ${e.tried.join(", ")}` : message(e));
      }
    }
    // Read fine but carries no such package: still the repository this page is about, so the page
    // can say the package was dropped rather than pretending the repository failed.
    read ??= firstReadable;

    entry = read?.extensions.find((candidateEntry) => candidateEntry.pkg === pkg) ?? null;
    repoUrl = read?.url ?? repo ?? installedRow?.repoUrl ?? null;
    facts = softwareFacts({
      ref: { pkg, repo: repoUrl },
      index: read,
      repos: library.repos,
      installed: library.extensions,
    });
    if (read === null && failures.length > 0) error = failures.join(" · ");
    loading = false;
  }

  /** Install this package, at the version the repository publishes. */
  async function install(): Promise<void> {
    const wanted = entry;
    const from = repoUrl;
    if (wanted === null || from === null) return;
    busy = "install";
    error = null;
    try {
      const row = await library.installEntry(wanted, from);
      await load();
      notice = `${wanted.name} ${wanted.version} installed — ${row.sources.length} source${row.sources.length === 1 ? "" : "s"}`;
    } catch (e) {
      error = message(e);
    } finally {
      busy = null;
    }
  }

  /** Replace the installed copy with the newer one the repository publishes. */
  async function update(): Promise<void> {
    const wanted = entry;
    const from = repoUrl;
    if (wanted === null || from === null) return;
    busy = "update";
    error = null;
    try {
      await library.installEntry(wanted, from);
      await load();
      notice = `${wanted.name} updated to ${wanted.version}`;
    } catch (e) {
      error = message(e);
    } finally {
      busy = null;
    }
  }

  /** The switch, exactly as the Extensions row has it: the APK stays, its sources stop. */
  async function toggle(): Promise<void> {
    const row = installedRow;
    if (row === null) return;
    busy = row.enabled === false ? "enable" : "disable";
    error = null;
    try {
      await library.setExtensionEnabled(row.extensionId, row.enabled === false);
      await load();
    } catch (e) {
      error = message(e);
    } finally {
      busy = null;
    }
  }

  /** Remove it. Two taps, because the sources go with it and a stray tap should not do that. */
  async function uninstall(): Promise<void> {
    const row = installedRow;
    if (row === null) return;
    busy = "uninstall";
    error = null;
    try {
      await library.uninstallExtension(row.extensionId);
      confirming = false;
      await load();
      notice = "Uninstalled. Your library is untouched.";
    } catch (e) {
      error = message(e);
    } finally {
      busy = null;
    }
  }

  /**
   * The repository is not one this app has added, so installing is not offered here: the Extensions
   * repository panel reads it, says who publishes it, and adds it only on its own button.
   */
  function reviewRepository(): void {
    if (repoUrl === null) return;
    go(`/extensions?repo=${encodeURIComponent(repoUrl)}`);
  }

  function sourceHref(id: string): string {
    return pathTo("source", id.includes(":") ? id : `dalvik:src:${id}`);
  }

  const versionLine = $derived(
    facts === null
      ? ""
      : facts.installedVersion !== null && facts.availableVersion !== null && facts.installedVersion !== facts.availableVersion
        ? `${facts.installedVersion} installed · ${facts.availableVersion} available`
        : (facts.availableVersion ?? facts.installedVersion ?? "—"),
  );
</script>

<section class="view">
  <header class="bar">
    <button class="btn ghost icon" aria-label="Back to extensions" onclick={() => go("/extensions")}>
      <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>
    </button>
    <div class="titles">
      <h1>{facts?.name ?? pkg}</h1>
      {#if facts !== null && facts.warning !== "SAFE" && facts.warning !== "UNKNOWN"}
        <span class="badge rating" class:adult={facts.warning === "NSFW"}>{facts.rating}</span>
      {/if}
    </div>
  </header>

  <p class="pkg mono selectable">{pkg}</p>

  {#if error}<p class="banner">{error}</p>{/if}
  {#if notice}<p class="note">{notice}</p>{/if}

  {#if loading}
    <p class="empty">Reading the package…</p>
  {:else if facts !== null}
    {#if facts.upstreamRemoved}
      <p class="banner">
        This repository no longer lists {facts.name}.{facts.state === "not-installed"
          ? " Nothing is installed, so there is nothing to remove."
          : " The installed copy still works and can be disabled or uninstalled."}
      </p>
    {/if}

    <!-- The actions come before the record: a package with sixty sources would otherwise put
         Install below a wall of chips. -->
    <div class="acts">
      {#if facts.actions.includes("install")}
        <button class="btn primary" disabled={busy !== null} onclick={() => void install()}>
          {busy === "install" ? "Installing…" : `Install ${facts.availableVersion ?? ""}`.trim()}
        </button>
      {/if}
      {#if facts.actions.includes("update")}
        <button class="btn primary" disabled={busy !== null} onclick={() => void update()}>
          {busy === "update" ? "Updating…" : `Update to ${facts.availableVersion ?? ""}`.trim()}
        </button>
      {/if}
      {#if facts.actions.includes("disable")}
        <button class="btn" disabled={busy !== null} onclick={() => void toggle()}>
          {busy === "disable" ? "Switching off…" : "Disable"}
        </button>
      {/if}
      {#if facts.actions.includes("enable")}
        <button class="btn" disabled={busy !== null} onclick={() => void toggle()}>
          {busy === "enable" ? "Switching on…" : "Enable"}
        </button>
      {/if}
      {#if facts.actions.includes("uninstall")}
        {#if confirming}
          <span class="confirm">
            <span>Uninstall {facts.name}? Its {facts.sources.length} source{facts.sources.length === 1 ? "" : "s"} disappear; your library stays.</span>
            <button class="chip" onclick={() => (confirming = false)}>Cancel</button>
            <button class="chip danger" disabled={busy !== null} onclick={() => void uninstall()}>
              {busy === "uninstall" ? "Uninstalling…" : "Uninstall"}
            </button>
          </span>
        {:else}
          <button class="btn ghost quiet" disabled={busy !== null} onclick={() => (confirming = true)}>Uninstall</button>
        {/if}
      {/if}
      {#if facts.actions.length === 0 && reviewable && !facts.repoAdded && !facts.upstreamRemoved}
        <!-- A package from a repository this app has not added: described, never installed from here. -->
        <button class="btn" onclick={() => reviewRepository()}>Review repository</button>
      {/if}
    </div>

    {#if reviewable && !facts.repoAdded && !facts.upstreamRemoved}
      <p class="hint">
        This package comes from a repository this app has not added. Nothing is installed from it here — review the
        repository first, and add it only if you want its packages.
      </p>
    {/if}

    {#if facts.state !== "not-installed" && facts.builtin === true}
      <p class="hint">Ships with HardlyTracking — no APK, so there is nothing to uninstall.</p>
    {/if}

    <dl class="facts">
      <dt>Ecosystem</dt>
      <dd>{facts.ecosystem}</dd>

      <dt>Version</dt>
      <dd>{versionLine}</dd>

      <dt>Repository</dt>
      <dd>
        {#if facts.repository !== null}
          <span>{facts.repository.name}</span>
          <span class="mono small selectable">{facts.repository.url}</span>
          {#if !facts.repoAdded}<span class="warn">not added to this app</span>{/if}
        {:else}
          <span class="muted">not known — no repository said it publishes this package</span>
        {/if}
      </dd>

      <dt>Languages</dt>
      <dd>{facts.languages.length === 0 ? "—" : facts.languages.map((lang) => lang.toUpperCase()).join(", ")}</dd>

      <dt>Rating</dt>
      <dd>{facts.rating}</dd>

      <dt>Sources</dt>
      <dd>
        {#if facts.sources.length === 0}
          <span class="muted">—</span>
        {:else}
          <div class="srcs">
            {#each allSources ? facts.sources : facts.sources.slice(0, 12) as source (source.id)}
              <button class="chip small link" title={`Browse ${source.name}`} onclick={() => go(sourceHref(source.id))}>
                {source.name}{#if source.lang}<span class="lang">{source.lang}</span>{/if}
              </button>
            {/each}
          </div>
          {#if facts.sources.length > 12}
            <button class="chip small more" onclick={() => (allSources = !allSources)}>
              {allSources ? "Show fewer" : `+${facts.sources.length - 12} more`}
            </button>
          {/if}
        {/if}
      </dd>

      <dt>Installed</dt>
      <dd>
        {#if facts.state === "not-installed"}
          Not installed
        {:else if facts.state === "disabled"}
          Installed{facts.installedVersion === null ? "" : ` · ${facts.installedVersion}`} · switched off
        {:else}
          Installed{facts.installedVersion === null ? "" : ` · ${facts.installedVersion}`}
        {/if}
      </dd>
    </dl>

  {/if}
</section>

<style>
  .view {
    padding: var(--s4) var(--s4) var(--s7);
    max-width: 820px;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-bottom: var(--s1);
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

  .badge.rating {
    flex: none;
    font-size: var(--t-xs);
    color: var(--text-2);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 1px 8px;
  }

  .badge.rating.adult {
    color: var(--warning);
    border-color: currentColor;
  }

  .pkg {
    margin: 0 0 var(--s3);
    font-size: var(--t-xs);
    color: var(--text-3);
    overflow-wrap: anywhere;
  }

  .facts {
    display: grid;
    grid-template-columns: 108px 1fr;
    gap: var(--s2) var(--s3);
    margin: 0 0 var(--s4);
    align-items: baseline;
  }

  .facts dt {
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
  }

  .facts dd {
    margin: 0;
    display: grid;
    gap: 2px;
    font-size: var(--t-sm);
    color: var(--text-1);
    min-width: 0;
  }

  .facts .small {
    font-size: var(--t-xs);
    color: var(--text-3);
    overflow-wrap: anywhere;
  }

  .acts {
    display: flex;
    align-items: center;
    gap: var(--s2);
    flex-wrap: wrap;
    margin-bottom: var(--s3);
  }

  .srcs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s1);
  }

  .chip.link {
    cursor: pointer;
  }

  .chip.link:hover {
    color: var(--accent);
  }

  .chip.danger {
    color: var(--danger, #d9534f);
    border-color: currentColor;
  }

  .confirm {
    display: flex;
    align-items: center;
    gap: var(--s2);
    flex-wrap: wrap;
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .btn.quiet {
    color: var(--text-3);
  }

  .btn.quiet:hover {
    color: var(--danger, #d9534f);
  }

  .hint {
    margin: 0 0 var(--s2);
    font-size: var(--t-xs);
    line-height: 1.55;
    color: var(--text-3);
    max-width: 62ch;
  }

  .warn {
    color: var(--warning);
  }

  .muted {
    color: var(--text-3);
  }

  .lang {
    text-transform: uppercase;
    font-size: 10px;
    color: var(--text-3);
  }

  .chip.small {
    padding: 2px var(--s2);
    font-size: var(--t-xs);
  }

  .chip.more {
    justify-self: start;
    margin-top: var(--s1);
    cursor: pointer;
    color: var(--text-2);
  }

  .empty {
    padding: var(--s4) 0;
    color: var(--text-3);
    font-size: var(--t-sm);
  }
</style>
