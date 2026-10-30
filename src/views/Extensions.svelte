<script lang="ts">
  /**
   * Extensions: repositories, what is installed, and what can be installed.
   *
   * Three sections in the order they are used — a repository is where extensions come from, an
   * installed extension is what the runtime is actually running, and "available" is the index
   * narrowed by a search. The runtime's internals (a JVM, an APK handle) stay out of the way: the
   * user installed an extension, not a virtual machine.
   */
  import { library } from "../state/library.svelte";
  import { updateState, type ExtensionEntry } from "../lib/extensions/index";
  import { RepositoryError, type Repository } from "../lib/extensions/repository";
  import { extensionLabel, extensionLanguages, sourcesOfExtension } from "../lib/extensions/installed";
  import { proxiedImage } from "../lib/pages";
  import { go, pathTo } from "../lib/nav";

  interface Props {
    /** A repository from an install link (`mihon://…`, `?repo=…`), added on arrival. */
    repo?: string | null;
  }
  let { repo = null }: Props = $props();

  let section = $state<"installed" | "available" | "repositories">("installed");

  let repoUrl = $state("");
  let adding = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);

  let entries = $state<ExtensionEntry[]>([]);
  let loading = $state(false);
  let search = $state("");
  let activeRepo = $state<string | null>(null);
  let installing = $state<string | null>(null);
  /** Two-step uninstall: removing an extension is destructive and one stray tap should not do it. */
  let removing = $state<string | null>(null);
  let busy = $state<string | null>(null);

  async function toggle(row: (typeof library.extensions)[number]): Promise<void> {
    busy = row.extensionId;
    try {
      await library.setExtensionEnabled(row.extensionId, row.enabled === false);
    } finally {
      busy = null;
    }
  }

  async function uninstall(row: (typeof library.extensions)[number]): Promise<void> {
    busy = row.extensionId;
    try {
      await library.uninstallExtension(row.extensionId);
      removing = null;
    } finally {
      busy = null;
    }
  }

  /** The extension's own sources, as the provider lists them — for its browse button. */
  function sourcesFor(row: (typeof library.extensions)[number]) {
    return sourcesOfExtension(library.sources, row);
  }

  const installed = $derived(library.extensions);

  /** package id -> installed row, so an entry knows whether it is new, current or old. */
  const byPackage = $derived(new Map(installed.map((row) => [row.packageId, row])));

  const matched = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    if (needle === "") return entries;
    return entries.filter((entry) =>
      `${entry.name} ${entry.pkg} ${entry.sources.map((source) => source.lang).join(" ")}`.toLowerCase().includes(needle),
    );
  });

  /** A live repository publishes over a thousand entries; drawing them all is a stall. */
  const shown = $derived(matched.slice(0, 120));

  /**
   * An install link opened this screen: put it in the field, then add it, so the user sees what was
   * added and can correct it if the link was wrong.
   */
  let consumedRepo: string | null = null;
  $effect(() => {
    if (repo === null || repo === consumedRepo) return;
    consumedRepo = repo;
    repoUrl = repo;
    section = "repositories";
    void addRepository();
  });

  async function addRepository(): Promise<void> {
    const url = repoUrl.trim();
    if (url === "") return;
    adding = true;
    error = null;
    notice = null;
    try {
      const repository: Repository = await library.addRepository(url);
      repoUrl = "";
      notice = `${repository.name} — ${repository.extensions.length} extensions`;
      section = "available";
      await openRepository(repository.url);
    } catch (e) {
      // A repository URL is the user's guess; the error has to say what was tried.
      error = e instanceof RepositoryError && e.tried.length > 0 ? `${e.message} — tried ${e.tried.join(", ")}` : e instanceof Error ? e.message : String(e);
    } finally {
      adding = false;
    }
  }

  async function openRepository(url: string): Promise<void> {
    activeRepo = url;
    loading = true;
    error = null;
    try {
      entries = await library.repoEntries(url);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      entries = [];
    } finally {
      loading = false;
    }
  }

  async function install(entry: ExtensionEntry): Promise<void> {
    if (activeRepo === null) return;
    installing = entry.pkg;
    error = null;
    notice = null;
    try {
      const row = await library.installEntry(entry, activeRepo);
      notice = `${entry.name} ${entry.version} installed — ${row.sources.length} sources`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      installing = null;
    }
  }

  async function remove(url: string): Promise<void> {
    await library.removeRepository(url);
    if (activeRepo === url) {
      activeRepo = null;
      entries = [];
    }
  }

  function stateOf(entry: ExtensionEntry): string {
    const row = byPackage.get(entry.pkg);
    return updateState(row === undefined || row.versionCode === undefined ? undefined : { versionCode: row.versionCode }, entry);
  }

  function languages(entry: ExtensionEntry): string {
    const langs = entry.sources.map((source) => source.lang).filter((lang, index, all) => all.indexOf(lang) === index);
    return langs.join(", ") || "—";
  }
</script>

<section class="view">
  <header class="top">
    <h1>Extensions</h1>
    <span class="count">{installed.length} installed</span>
  </header>

  <div class="tabs" role="tablist" aria-label="Extension sections">
    <button class="chip" class:on={section === "installed"} role="tab" aria-selected={section === "installed"} onclick={() => (section = "installed")}>Installed</button>
    <button class="chip" class:on={section === "available"} role="tab" aria-selected={section === "available"} onclick={() => (section = "available")}>Available</button>
    <button class="chip" class:on={section === "repositories"} role="tab" aria-selected={section === "repositories"} onclick={() => (section = "repositories")}>Repositories</button>
  </div>

  {#if error}<p class="banner">{error}</p>{/if}
  {#if notice}<p class="note">{notice}</p>{/if}

  {#if section === "installed"}
    {#if installed.length === 0}
      <div class="blank">
        <p class="blankline">Nothing installed yet.</p>
        <p class="blanksub">Add a repository, then install an extension from its index. Its sources appear under Browse.</p>
        <button class="btn primary" onclick={() => (section = "repositories")}>Add a repository</button>
      </div>
    {:else}
      <ul class="rows">
        {#each installed as row (row.extensionId)}
          {@const label = extensionLabel(row)}
          {@const langs = extensionLanguages(row)}
          {@const owned = sourcesFor(row)}
          <li class="card" class:off={row.enabled === false}>
            <div class="head">
              {#if row.iconUrl}
                <img class="icon" src={proxiedImage(row.iconUrl)} alt="" loading="lazy" decoding="async" />
              {:else}
                <span class="icon fallback" aria-hidden="true">{label.slice(0, 1)}</span>
              {/if}
              <div class="info">
                <span class="name">{label}</span>
                <span class="sub">
                  {row.versionName ?? "unknown version"} · {row.sources.length} source{row.sources.length === 1 ? "" : "s"}{#if langs.length > 0} · {langs.join(", ")}{/if}
                </span>
                {#if row.enabled === false}<span class="badge off">Disabled</span>{/if}
              </div>
              <label class="switch" title={row.enabled === false ? "Enable" : "Disable"}>
                <input
                  type="checkbox"
                  checked={row.enabled !== false}
                  disabled={busy === row.extensionId}
                  aria-label={`${row.enabled === false ? "Enable" : "Disable"} ${label}`}
                  onchange={() => void toggle(row)}
                />
                <span class="track" aria-hidden="true"><span class="knob"></span></span>
              </label>
            </div>

            <div class="srcs">
              {#each row.sources.slice(0, 8) as source (source.id)}
                <button
                  class="chip small link"
                  title={`Browse ${source.name}`}
                  onclick={() => go(pathTo("source", `dalvik:src:${source.id}`))}
                >
                  {source.name}{#if source.lang} <span class="lang">{source.lang}</span>{/if}
                </button>
              {/each}
              {#if row.sources.length > 8}<span class="chip small">+{row.sources.length - 8}</span>{/if}
            </div>

            <div class="acts">
              {#if owned.length > 0}
                <button class="btn ghost" onclick={() => go(pathTo("source", owned[0].id))}>Browse</button>
              {/if}
              {#if removing === row.extensionId}
                <span class="confirm">
                  <span>Uninstall {label}? Its {row.sources.length} source{row.sources.length === 1 ? "" : "s"} disappear; your library stays.</span>
                  <button class="chip" onclick={() => (removing = null)}>Cancel</button>
                  <button class="chip danger" disabled={busy === row.extensionId} onclick={() => void uninstall(row)}>Uninstall</button>
                </span>
              {:else}
                <button class="btn ghost quiet" onclick={() => (removing = row.extensionId)}>Uninstall</button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {:else if section === "available"}
    {#if library.repos.length === 0}
      <div class="blank">
        <p class="blankline">No repositories yet.</p>
        <p class="blanksub">A repository is one URL that lists extensions. Add it once and every extension in it is one tap away.</p>
        <button class="btn primary" onclick={() => (section = "repositories")}>Add a repository</button>
      </div>
    {:else}
      <div class="repo-bar">
        {#each library.repos as repo (repo.url)}
          <button class="chip" class:on={activeRepo === repo.url} onclick={() => void openRepository(repo.url)}>{repo.name}</button>
        {/each}
      </div>

      <input class="field search" type="search" placeholder="Search extensions, packages or languages" bind:value={search} aria-label="Search extensions" />

      {#if loading}
        <p class="empty">Reading the index…</p>
      {:else if entries.length === 0}
        <p class="empty">Pick a repository above to read its index.</p>
      {:else}
        <p class="summary">
          {matched.length === 0 ? "No match" : `${matched.length} extension${matched.length === 1 ? "" : "s"}`}{matched.length > shown.length ? ` · showing ${shown.length}` : ""}
        </p>
        <ul class="rows">
          {#each shown as entry (entry.pkg)}
            {@const state = stateOf(entry)}
            <li class="card">
              <div class="info">
                <span class="name">{entry.name}</span>
                <span class="sub">
                  {languages(entry)} · v{entry.version}
                  {#if entry.contentWarning !== "SAFE" && entry.contentWarning !== "UNKNOWN"}<span class="warn"> · {entry.contentWarning}</span>{/if}
                </span>
                <span class="pkg">{entry.pkg}</span>
              </div>
              <button
                class="btn"
                class:primary={state === "new" || state === "update"}
                disabled={installing === entry.pkg || state === "up-to-date"}
                onclick={() => void install(entry)}
              >
                {installing === entry.pkg ? "Installing…" : state === "new" ? "Install" : state === "update" ? "Update" : state === "downgrade" ? "Reinstall" : "Installed"}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  {:else}
    <form
      class="add"
      onsubmit={(event) => {
        event.preventDefault();
        void addRepository();
      }}
    >
      <input
        class="field"
        type="text"
        inputmode="url"
        placeholder="Repository URL, or an Install link (mihon://extension-store?url=…)"
        bind:value={repoUrl}
        aria-label="Repository URL or install link"
        spellcheck="false"
      />
      <button class="btn primary" type="submit" disabled={adding}>{adding ? "Reading…" : "Add repository"}</button>
    </form>

    {#if library.repos.length === 0}
      <p class="empty">No repositories yet. A Keiyoushi-compatible URL is the usual starting point.</p>
    {:else}
      <ul class="rows">
        {#each library.repos as repo (repo.url)}
          <li class="card">
            <div class="info">
              <span class="name">{repo.name}</span>
              <span class="sub">{repo.url}</span>
            </div>
            <div class="rowacts">
              <button class="btn ghost" onclick={() => { section = "available"; void openRepository(repo.url); }}>Browse</button>
              <button class="btn danger" onclick={() => void remove(repo.url)}>Remove</button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .view {
    padding: var(--s4) var(--s4) var(--s7);
    max-width: 900px;
  }

  .top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s3);
    padding-top: var(--safe-t);
    margin-bottom: var(--s3);
  }

  h1 {
    font-size: var(--t-2xl);
    font-weight: 650;
  }

  .count {
    font-size: var(--t-sm);
    color: var(--text-3);
  }

  .tabs {
    display: flex;
    gap: var(--s2);
    margin-bottom: var(--s4);
    overflow-x: auto;
  }

  .add {
    display: flex;
    gap: var(--s2);
    margin-bottom: var(--s4);
  }

  .add .field {
    flex: 1;
    min-height: 40px;
  }

  .repo-bar {
    display: flex;
    gap: var(--s2);
    overflow-x: auto;
    margin-bottom: var(--s3);
  }

  .search {
    width: 100%;
    min-height: 38px;
    margin-bottom: var(--s3);
  }

  .summary {
    margin: 0 0 var(--s2);
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--s2);
  }

  .card {
    display: grid;
    gap: var(--s2);
    padding: var(--s3);
    border: 1px solid var(--line);
    border-radius: var(--r2);
    background: var(--surface);
  }

  .card.off {
    opacity: 0.62;
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--s3);
  }

  .icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    object-fit: cover;
    flex: none;
    background: var(--surface-2, var(--surface));
  }

  .icon.sm {
    width: 28px;
    height: 28px;
    border-radius: 8px;
  }

  .icon.fallback {
    display: grid;
    place-items: center;
    font-weight: 650;
    color: var(--text-3);
    border: 1px solid var(--line);
  }

  .switch {
    flex: none;
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .switch input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
  }

  .track {
    width: 42px;
    height: 25px;
    border-radius: 999px;
    background: var(--line);
    display: block;
    position: relative;
    transition: background 140ms ease;
  }

  .knob {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 19px;
    height: 19px;
    border-radius: 999px;
    background: var(--text-3);
    transition: transform 140ms ease, background 140ms ease;
  }

  .switch input:checked + .track {
    background: color-mix(in srgb, var(--accent) 45%, transparent);
  }

  .switch input:checked + .track .knob {
    transform: translateX(17px);
    background: var(--accent);
  }

  .switch input:focus-visible + .track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .badge.off {
    justify-self: start;
    font-size: var(--t-xs);
    color: var(--text-3);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 1px 8px;
  }

  .chip.link {
    cursor: pointer;
  }

  .chip.link:hover {
    color: var(--accent);
  }

  .acts {
    display: flex;
    align-items: center;
    gap: var(--s2);
    flex-wrap: wrap;
  }

  .btn.quiet {
    color: var(--text-3);
  }

  .btn.quiet:hover {
    color: var(--danger, #d9534f);
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

  .info {
    display: grid;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }

  .name {
    font-size: var(--t-md);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub,
  .pkg {
    font-size: var(--t-xs);
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pkg {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text-3);
    opacity: 0.75;
  }

  .warn {
    color: var(--warning);
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

  .srcs {
    display: none;
    gap: var(--s1);
    flex-wrap: wrap;
  }

  @media (min-width: 760px) {
    .srcs {
      display: flex;
      max-width: 260px;
    }
  }

  .rowacts {
    display: flex;
    gap: var(--s1);
  }

  .blank {
    display: grid;
    gap: var(--s2);
    padding-top: var(--s5);
    max-width: 48ch;
    justify-items: start;
  }

  .blankline {
    margin: 0;
    font-size: var(--t-lg);
  }

  .blanksub {
    margin: 0;
    font-size: var(--t-sm);
    line-height: 1.6;
    color: var(--text-2);
  }
</style>
