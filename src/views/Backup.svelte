<script lang="ts">
  /**
   * Backup & restore: one file out, one file in. Free, always.
   *
   * The file is the same document sync uses, so a backup is not a second format that can drift.
   * Export writes the whole library; import applies what the file carries and leaves everything
   * else alone — an import is "bring this in", not "make this device match that one".
   *
   * Import is two steps on purpose. Choosing a file only *reads* it: the screen then says what the
   * file holds and which sources are missing before a single row is written, because a restore is
   * the one button where being wrong costs a library. The second step applies, and reports how many
   * series can actually open — a series whose extension is not installed is imported as a row, and
   * is never described as readable.
   */
  import { library } from "../state/library.svelte";
  import { categories } from "../state/categories.svelte";
  import { documentFromStore } from "../lib/sync/from-store";
  import { deviceId } from "../lib/sync/device";
  import { parseSync, serializeSync, type SyncDocument } from "../lib/sync/document";
  import { applyDocument } from "../lib/sync/apply";
  import { outcomeSentence, summarizeImport, type ImportSummary } from "../lib/backup/report";
  import { RepositoryError } from "../lib/extensions/repository";
  import { go } from "../lib/nav";

  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);

  /** A file that has been read and not yet applied — the whole two-step confirm lives in this. */
  let pending = $state<{ doc: SyncDocument; summary: ImportSummary; name: string } | null>(null);
  /** The report that stays on screen after an import, so a missing source is still visible. */
  let applied = $state<{ doc: SyncDocument; summary: ImportSummary; message: string } | null>(null);
  let addingRepos = $state(false);

  async function exportBackup(): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    busy = "Building the file…";
    error = null;
    notice = null;
    try {
      const device = await deviceId(store);
      const doc = await documentFromStore(store, { device });
      const text = serializeSync(doc);
      const name = `hardlytracking-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      URL.revokeObjectURL(url);
      notice = `${name} — ${doc.series.length} series, ${doc.chapters.length} chapters, ${doc.categories.length} categories, ${doc.sessions.length} sessions`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }

  /** Step one: read the file and describe it. Nothing is written here. */
  async function chooseFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    const store = library.profile?.store;
    if (file === undefined || store === undefined) return;
    busy = "Reading the file…";
    error = null;
    notice = null;
    applied = null;
    pending = null;
    try {
      const doc = parseSync(await file.text());
      const summary = summarizeImport(doc, await store.listExtensions(), await store.listRepos());
      pending = { doc, summary, name: file.name };
    } catch (e) {
      // A bad file is a plain sentence: which rule it broke, from `parseSync`.
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }

  /** Step two: apply, then say what actually happened. */
  async function applyPending(): Promise<void> {
    const store = library.profile?.store;
    const chosen = pending;
    if (store === undefined || chosen === null) return;
    busy = "Writing the file into this device…";
    error = null;
    try {
      const result = await applyDocument(store, chosen.doc);
      // The reattach answer is recomputed against what is installed *now* — adding a repository in
      // the confirm step does not install anything, but the answer must never be stale.
      const summary = summarizeImport(chosen.doc, await store.listExtensions(), await store.listRepos());
      await library.refreshLibrary();
      await categories.load(store);
      applied = { doc: chosen.doc, summary, message: outcomeSentence(summary, result) };
      notice = `${chosen.name} — ${result.series} series, ${result.chapters} chapters, ${result.positions} positions, ${result.read} read marks.`;
      pending = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }

  /**
   * Add the repositories the file names, through the same path Extensions uses (`addRepository`),
   * so a URL is normalised, indexed and remembered exactly as if it had been pasted there.
   */
  async function addRepositories(): Promise<void> {
    const store = library.profile?.store;
    const chosen = pending ?? applied;
    if (store === undefined || chosen === null) return;
    const urls = chosen.summary.reposNotInstalled;
    addingRepos = true;
    error = null;
    const failures: string[] = [];
    let added = 0;
    try {
      for (const url of urls) {
        try {
          await library.addRepository(url);
          added += 1;
        } catch (e) {
          failures.push(e instanceof RepositoryError && e.tried.length > 0 ? `${url} — ${e.message} (tried ${e.tried.join(", ")})` : `${url} — ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const summary = summarizeImport(chosen.doc, await store.listExtensions(), await store.listRepos());
      if (pending !== null) pending = { ...pending, summary };
      if (applied !== null) applied = { ...applied, summary };
      notice = `${added} ${added === 1 ? "repository" : "repositories"} added. Install the extensions you need from Extensions, then the series that need them will open.`;
      if (failures.length > 0) error = failures.join(" · ");
    } finally {
      addingRepos = false;
    }
  }
</script>

<section class="view">
  <header class="bar">
    <button class="btn ghost icon" aria-label="Back" onclick={() => go("/more")}>
      <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>
    </button>
    <h1>Backup &amp; restore</h1>
  </header>

  {#if error}<p class="banner">{error}</p>{/if}
  {#if notice}<p class="note">{notice}</p>{/if}
  {#if busy}<p class="empty">{busy}</p>{/if}

  <div class="cards">
    <section class="card">
      <h2>Export</h2>
      <p class="sub">Your library, chapters, categories, read marks, positions, history, sessions, source mappings and settings, in one JSON file. No pages, no APKs.</p>
      <button class="btn primary" disabled={busy !== null} onclick={() => void exportBackup()}>Export backup</button>
    </section>

    <section class="card">
      <h2>Import</h2>
      <p class="sub">Read a backup and see what it holds before anything is written. Existing rows are overwritten by the file; nothing is deleted.</p>
      {#if pending === null}
        <label class="btn" class:disabled={busy !== null}>
          Choose a backup file
          <input type="file" accept="application/json,.json" hidden disabled={busy !== null} onchange={(event) => void chooseFile(event)} />
        </label>
      {/if}

      {#if pending !== null}
        <div class="confirm">
          <p class="file">{pending.name}</p>
          <div class="chips" aria-label="What the file holds">
            <span class="chip static">{pending.summary.series} series</span>
            <span class="chip static">{pending.summary.chapters} chapters</span>
            <span class="chip static">{pending.summary.categories} categories</span>
            <span class="chip static">{pending.summary.sessions} sessions</span>
            {#if pending.summary.progress > 0}<span class="chip static">{pending.summary.progress} positions</span>{/if}
            {#if pending.summary.repos > 0}<span class="chip static">{pending.summary.repos} repositories</span>{/if}
          </div>
          <p>{pending.summary.sentence}</p>

          {#if pending.summary.missingSources.length > 0}
            <ul class="sources">
              {#each pending.summary.missingSources as source (source.sourceId)}
                <li>
                  <strong>{source.packageName ?? source.sourceId}</strong>
                  <span class="sub">
                    {source.disabled ? "installed but switched off" : "not installed"} · {source.seriesCount} series · source {source.sourceId}
                  </span>
                </li>
              {/each}
            </ul>
            <p class="sub">Those series will be imported, but they cannot open until the extension is installed and enabled. Nothing here is downloaded automatically.</p>
          {/if}

          {#if pending.summary.reposNotInstalled.length > 0}
            <div class="repos">
              <p class="sub">The file names {pending.summary.reposNotInstalled.length === 1 ? "a repository" : `${pending.summary.reposNotInstalled.length} repositories`} this device has not added:</p>
              <ul class="sources">
                {#each pending.summary.reposNotInstalled as url (url)}
                  <li><span class="sub mono">{url}</span></li>
                {/each}
              </ul>
              <button class="btn" disabled={addingRepos || busy !== null} onclick={() => void addRepositories()}>
                {addingRepos ? "Adding…" : "Add these repositories"}
              </button>
            </div>
          {/if}

          <span class="acts2">
            <button class="chip" onclick={() => (pending = null)}>Cancel</button>
            <button class="chip danger" disabled={busy !== null} onclick={() => void applyPending()}>
              Import {pending.summary.series} series
            </button>
          </span>
        </div>
      {/if}
    </section>
  </div>

  {#if applied !== null}
    <section class="note-block" aria-label="Import report">
      <h2>Last import</h2>
      <p>{applied.message}</p>
      {#if applied.summary.missingSources.length > 0}
        <ul class="sources">
          {#each applied.summary.missingSources as source (source.sourceId)}
            <li>
              <strong>{source.packageName ?? source.sourceId}</strong>
              <span class="sub">{source.disabled ? "installed but switched off" : "not installed"} · {source.seriesCount} series need it</span>
            </li>
          {/each}
        </ul>
      {/if}
      {#if applied.summary.reposNotInstalled.length > 0}
        <p class="sub">The file names {applied.summary.reposNotInstalled.length === 1 ? "a repository" : `${applied.summary.reposNotInstalled.length} repositories`} this device has not added.</p>
        <button class="btn" disabled={addingRepos} onclick={() => void addRepositories()}>Add these repositories</button>
      {/if}
    </section>
  {/if}

  <section class="note-block">
    <h2>What is never in the file</h2>
    <ul>
      <li>Manga pages and downloaded images — those stay on the device.</li>
      <li>Extension APKs — a backup names the package and version, not the binary.</li>
      <li>Passwords or account credentials.</li>
    </ul>
    <p class="sub">Automatic sync is a paid extra and is not required for any of this.</p>
  </section>
</section>

<style>
  .view {
    padding: var(--s3) var(--s4) var(--s7);
    max-width: 720px;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding-top: var(--safe-t);
    margin-bottom: var(--s4);
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

  h1 {
    font-size: var(--t-xl);
    font-weight: 650;
  }

  .cards {
    display: grid;
    gap: var(--s3);
    margin-bottom: var(--s5);
  }

  .card {
    display: grid;
    gap: var(--s2);
    justify-items: start;
    padding: var(--s4);
    border: 1px solid var(--line);
    border-radius: var(--r3);
    background: var(--surface);
  }

  h2 {
    font-size: var(--t-md);
    font-weight: 600;
  }

  .sub {
    margin: 0;
    font-size: var(--t-sm);
    color: var(--text-2);
    line-height: 1.6;
  }

  .btn.disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  .confirm {
    display: grid;
    gap: var(--s3);
    width: 100%;
    padding-top: var(--s3);
    border-top: 1px solid var(--line);
  }

  .confirm p {
    margin: 0;
    font-size: var(--t-sm);
    color: var(--text-2);
    line-height: 1.6;
  }

  .confirm .file {
    font-size: var(--t-xs);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }

  .chip.static {
    cursor: default;
    color: var(--text-1);
    background: var(--surface-2);
  }

  .sources {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
    width: 100%;
  }

  .sources li {
    display: grid;
    gap: 2px;
    padding: var(--s2) 0;
    border-bottom: 1px solid var(--line);
    font-size: var(--t-sm);
  }

  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
    word-break: break-all;
  }

  .repos {
    display: grid;
    gap: var(--s2);
    justify-items: start;
    width: 100%;
  }

  .acts2 {
    display: flex;
    gap: var(--s2);
    justify-content: flex-end;
  }

  .chip.danger {
    color: var(--danger, #d9534f);
    border-color: currentColor;
  }

  .note-block {
    border-top: 1px solid var(--line);
    padding-top: var(--s4);
    display: grid;
    gap: var(--s2);
    margin-bottom: var(--s5);
  }

  ul {
    margin: 0;
    padding-left: var(--s4);
    color: var(--text-2);
    font-size: var(--t-sm);
    line-height: 1.7;
  }
</style>
