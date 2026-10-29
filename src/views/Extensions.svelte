<script lang="ts">
  /**
   * Extensions: repositories in, APKs installed out.
   *
   * This is the screen Mihon users expect — paste a repository URL, see what it publishes,
   * install an extension — and it is the only way extensions get installed here. The APK is
   * downloaded by the app from the index's own URL and handed to the host as bytes, because
   * the host has no install route and no repository support of its own.
   */
  import { library } from "../state/library.svelte";
  import { RepositoryError, describeEntry, matches, type Repository } from "../lib/extensions/repository";
  import { updateState, type ExtensionEntry } from "../lib/extensions/index";

  let url = $state("");
  let query = $state("");
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let note = $state<string | null>(null);
  let entries = $state<Array<{ repoUrl: string; entry: ExtensionEntry }>>([]);
  let loaded = $state(false);

  /** Installed by package name: an extension is its package, not the repository it came from. */
  const installed = $derived(new Map(library.extensions.map((row) => [row.packageId, row])));

  $effect(() => {
    if (library.profile === null || loaded) return;
    void readAll();
  });

  async function readAll(): Promise<void> {
    if (library.profile === null) return;
    loaded = true;
    const rows = [...library.repos];
    if (rows.length === 0) {
      entries = [];
      return;
    }
    const collected: Array<{ repoUrl: string; entry: ExtensionEntry }> = [];
    for (const repo of rows) {
      try {
        for (const entry of await library.repoEntries(repo.url)) collected.push({ repoUrl: repo.url, entry });
      } catch (e) {
        error = `${repo.name}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    entries = collected.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
  }

  async function add(event: Event): Promise<void> {
    event.preventDefault();
    const target = url.trim();
    if (target === "") return;
    busy = "repo";
    error = null;
    note = null;
    try {
      const repository: Repository = await library.addRepository(target);
      url = "";
      note = `${repository.name} — ${repository.extensions.length} extensions`;
      await readAll();
    } catch (e) {
      // A repository URL is guesswork on the user's side; the error has to name what was tried.
      error = e instanceof RepositoryError && e.tried.length > 0 ? `${e.message} — tried ${e.tried.join(", ")}` : e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }

  async function install(entry: ExtensionEntry, repoUrl: string): Promise<void> {
    busy = entry.pkg;
    error = null;
    note = null;
    try {
      const row = await library.installEntry(entry, repoUrl);
      note = `${entry.name} ${entry.version} installed — ${row.sources.length} sources`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }

  async function remove(repoUrl: string): Promise<void> {
    await library.removeRepository(repoUrl);
    await readAll();
  }

  /**
   * A live repository publishes over a thousand entries; drawing them all is a stall, not a
   * feature. The search box is how you narrow, and the count says what is being shown.
   */
  const visible = $derived(entries.filter((row) => matches(row.entry, query)).slice(0, 120));
</script>

<section>
  <header class="head">
    <h1>Extensions</h1>
    <span class="count">{installed.size} installed</span>
  </header>

  <form class="add" onsubmit={add}>
    <input
      bind:value={url}
      placeholder="https://raw.githubusercontent.com/keiyoushi/extensions/repo"
      aria-label="Repository URL"
      spellcheck="false"
    />
    <button class="primary" type="submit" disabled={busy === "repo"}>
      {busy === "repo" ? "Reading…" : "Add repository"}
    </button>
  </form>

  {#if error}<p class="banner">{error}</p>{/if}
  {#if note}<p class="note">{note}</p>{/if}

  {#if library.repos.length === 0}
    <p class="empty">
      No repositories yet. A repository is one URL that lists extensions — add one above and its
      extensions appear here, ready to install.
    </p>
  {:else}
    <ul class="repos">
      {#each library.repos as repo (repo.url)}
        <li>
          <span class="rname">{repo.name}</span>
          <span class="rurl">{repo.url}</span>
          <button class="ghost small" onclick={() => remove(repo.url)}>Remove</button>
        </li>
      {/each}
    </ul>

    <div class="filter">
      <input bind:value={query} placeholder="Search extensions, packages or languages" aria-label="Search extensions" />
      <span class="count">{visible.length} of {entries.length}{visible.length === 120 ? " shown" : ""}</span>
    </div>

    <ul class="entries">
      {#each visible as { repoUrl, entry } (entry.pkg + repoUrl)}
        {@const row = installed.get(entry.pkg)}
        {@const state = updateState(row === undefined ? undefined : { versionCode: row.versionCode ?? 0 }, entry)}
        <li>
          <div class="meta">
            <span class="ename">{entry.name}</span>
            <span class="edesc">{describeEntry(entry)}</span>
            <span class="epkg">{entry.pkg}</span>
          </div>
          {#if state === "up-to-date"}
            <span class="done">Installed</span>
          {:else}
            <button
              class="ghost"
              disabled={busy === entry.pkg}
              onclick={() => install(entry, repoUrl)}
            >
              {busy === entry.pkg ? "Installing…" : state === "update" ? `Update to ${entry.version}` : "Install"}
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 18px;
  }
  h1 {
    font-size: 22px;
    font-weight: 600;
    margin: 0;
  }
  .count {
    font-size: 12px;
    color: var(--muted);
  }
  .add {
    display: flex;
    gap: 8px;
    margin-bottom: 14px;
  }
  .add input,
  .filter input {
    flex: 1;
    min-width: 0;
    background: #16161c;
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 9px 12px;
    color: var(--fg);
    font: inherit;
    font-size: 13px;
  }
  .add input:focus,
  .filter input:focus {
    outline: none;
    border-color: #3f3f50;
  }
  .primary {
    all: unset;
    cursor: pointer;
    padding: 9px 16px;
    border-radius: 9px;
    background: #e6e6ee;
    color: #12121a;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
  }
  .primary:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .note {
    color: #8fd6a8;
    font-size: 13px;
    margin: 0 0 14px;
  }
  .empty {
    color: var(--muted);
    font-size: 13.5px;
    line-height: 1.6;
    max-width: 52ch;
  }
  .repos {
    list-style: none;
    margin: 0 0 18px;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .repos li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 11px;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: #14141a;
  }
  .rname {
    font-size: 13px;
    color: #dcdce6;
  }
  .rurl {
    flex: 1;
    min-width: 0;
    font-size: 11.5px;
    color: #6f6f7c;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .filter {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  .entries li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 11px;
    border-radius: 9px;
    border: 1px solid transparent;
  }
  .entries li:hover {
    background: #15151b;
    border-color: var(--line);
  }
  .meta {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 1px;
  }
  .ename {
    font-size: 13px;
    color: #e6e6ee;
  }
  .edesc {
    font-size: 11.5px;
    color: #8a8a96;
  }
  .epkg {
    font-size: 10.5px;
    color: #5f5f6c;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .done {
    font-size: 12px;
    color: #7fbf95;
  }
  .small {
    font-size: 12px;
  }
</style>
