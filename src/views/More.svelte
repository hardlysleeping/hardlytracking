<script lang="ts">
  /**
   * More: the small set of things that are not a daily tab.
   *
   * Every row here is a page that lives nowhere else. The exceptions that were removed are the
   * point of this file: Appearance was printed in full underneath this list *and* inside Settings,
   * Extensions was a row that only re-opened the Browse tab's own list, and Stats had a bottom-bar
   * button for a page nobody opens daily. Each of those is now one door with one name.
   */
  import { library } from "../state/library.svelte";
  import { downloads } from "../state/downloads.svelte";
  import { go } from "../lib/nav";
  import { plugins } from "../state/plugins.svelte";

  const counts = $derived({
    library: library.library.length,
    downloads: downloads.rows.length,
    plugins: plugins.list.length,
  });
</script>

<section class="view">
  <header class="top">
    <h1>More</h1>
  </header>

  <nav class="list" aria-label="More">
    <button class="row" onclick={() => go("/appearance")}>
      <span class="t">Appearance</span>
      <span class="s">Theme, colours, page background</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>
    <button class="row" onclick={() => go("/stats")}>
      <span class="t">Stats</span>
      <span class="s">What you have read, and when</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>
    <button class="row" onclick={() => go("/downloads")}>
      <span class="t">Downloads</span>
      <span class="s">{counts.downloads} chapter{counts.downloads === 1 ? "" : "s"}</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>
    <button class="row" onclick={() => go("/plugins")}>
      <span class="t">Plugins</span>
      <span class="s">{counts.plugins} installed</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>
    <button class="row sync" onclick={() => go("/sync")}>
      <span class="t">Sync<span class="s">Optional cloud sync · account and subscription</span></span>
      <span class="chev" aria-hidden="true">›</span>
    </button>
    <button class="row" onclick={() => go("/backup")}>
      <span class="t">Backup &amp; restore</span>
      <span class="s">Export or import a file — always free</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>
    <button class="row" onclick={() => go("/settings")}>
      <span class="t">Settings</span>
      <span class="s">Content, library, reader, storage</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>
  </nav>

  <p class="about">
    HardlyTracking · a Mihon/Komikku-compatible reader. Your library, history and downloads live on
    this device; sync is optional and paid, the reader is not.
  </p>
</section>

<style>
  .view {
    padding: var(--s4) var(--s4) var(--s7);
    max-width: 720px;
  }

  .top {
    margin-bottom: var(--s4);
  }

  h1 {
    font-size: var(--t-2xl);
    font-weight: 650;
  }

  .list {
    display: grid;
    margin-bottom: var(--s5);
  }

  .row {
    all: unset;
    cursor: pointer;
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: var(--s3);
    padding: var(--s3) var(--s2);
    min-height: 52px;
    box-sizing: border-box;
    border-bottom: 1px solid var(--line);
  }

  .row.sync { grid-template-columns: minmax(0, 1fr) auto; }
  .row.sync .s { display: block; margin-top: var(--s1); overflow-wrap: anywhere; }

  .row:hover {
    background: var(--surface-2);
  }

  .t {
    font-size: var(--t-md);
  }

  .s {
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .chev {
    color: var(--text-3);
    font-size: var(--t-lg);
  }

  .about {
    font-size: var(--t-xs);
    color: var(--text-3);
    line-height: 1.7;
    max-width: 52ch;
  }
</style>
