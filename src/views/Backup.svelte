<script lang="ts">
  /**
   * Backup & restore: one file out, one file in. Free, always.
   *
   * The file is the same document sync uses, so a backup is not a second format that can drift.
   * Export writes the whole library; import applies what the file carries and leaves everything
   * else alone — an import is "bring this in", not "make this device match that one".
   */
  import { library } from "../state/library.svelte";
  import { categories } from "../state/categories.svelte";
  import { documentFromStore } from "../lib/sync/from-store";
  import { deviceId } from "../lib/sync/device";
  import { parseSync, serializeSync } from "../lib/sync/document";
  import { applyDocument } from "../lib/sync/apply";
  import { go } from "../lib/nav";

  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);

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
      notice = `${name} — ${doc.series.length} series, ${doc.categories.length} categories, ${doc.history.length} history rows`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }

  async function importBackup(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    const store = library.profile?.store;
    if (file === undefined || store === undefined) return;
    busy = "Reading the file…";
    error = null;
    notice = null;
    try {
      const doc = parseSync(await file.text());
      const summary = await applyDocument(store, doc);
      await library.refreshLibrary();
      await categories.load(store);
      notice = `Imported ${summary.series} series, ${summary.categories} categories, ${summary.progress} positions, ${summary.read} read marks, ${summary.history} history rows.`;
    } catch (e) {
      // A bad file is a plain sentence: which rule it broke, from `parseSync`.
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
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
      <p class="sub">Your library, categories, read marks, positions, history and settings, in one JSON file. No pages, no APKs.</p>
      <button class="btn primary" disabled={busy !== null} onclick={() => void exportBackup()}>Export backup</button>
    </section>

    <section class="card">
      <h2>Import</h2>
      <p class="sub">Apply a backup to this device. Existing rows are overwritten by the file; nothing is deleted.</p>
      <label class="btn" class:disabled={busy !== null}>
        Import backup
        <input type="file" accept="application/json,.json" hidden disabled={busy !== null} onchange={(event) => void importBackup(event)} />
      </label>
    </section>
  </div>

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

  .note-block {
    border-top: 1px solid var(--line);
    padding-top: var(--s4);
    display: grid;
    gap: var(--s2);
  }

  ul {
    margin: 0;
    padding-left: var(--s4);
    color: var(--text-2);
    font-size: var(--t-sm);
    line-height: 1.7;
  }
</style>
