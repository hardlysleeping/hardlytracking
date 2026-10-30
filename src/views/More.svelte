<script lang="ts">
  /**
   * More: the small set of things that are not a daily tab.
   *
   * Deliberately short. A destination that earns daily use lives in the bottom bar; everything
   * else is one level down and named plainly. The theme switch is here because it is the one
   * setting people change while reading at night.
   */
  import { library } from "../state/library.svelte";
  import { downloads } from "../state/downloads.svelte";
  import { appearance, THEME_OPTIONS } from "../lib/theme.svelte";
  import { go } from "../lib/nav";

  const counts = $derived({
    library: library.library.length,
    downloads: downloads.rows.length,
    extensions: library.extensions.length,
  });
</script>

<section class="view">
  <header class="top">
    <h1>More</h1>
  </header>

  <nav class="list" aria-label="More">
    <button class="row" onclick={() => go("/downloads")}>
      <span class="t">Downloads</span>
      <span class="s">{counts.downloads} chapter{counts.downloads === 1 ? "" : "s"}</span>
      <span class="chev">›</span>
    </button>
    <button class="row" onclick={() => go("/backup")}>
      <span class="t">Backup &amp; restore</span>
      <span class="s">Export or import a file — always free</span>
      <span class="chev">›</span>
    </button>
    <button class="row" onclick={() => go("/settings")}>
      <span class="t">Settings</span>
      <span class="s">Appearance, library, reader</span>
      <span class="chev">›</span>
    </button>
    <button class="row" onclick={() => go("/extensions")}>
      <span class="t">Extensions</span>
      <span class="s">{counts.extensions} installed · {library.repos.length} repositor{library.repos.length === 1 ? "y" : "ies"}</span>
      <span class="chev">›</span>
    </button>
  </nav>

  <section class="block">
    <h2>Appearance</h2>
    <div class="chips">
      {#each THEME_OPTIONS as option (option.id)}
        <button class="chip" class:on={appearance.theme === option.id} aria-pressed={appearance.theme === option.id} onclick={() => appearance.apply(option.id)}>
          {option.label}
        </button>
      {/each}
    </div>
  </section>

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

  .block {
    margin-bottom: var(--s5);
  }

  h2 {
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
    margin-bottom: var(--s2);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }

  .about {
    font-size: var(--t-xs);
    color: var(--text-3);
    line-height: 1.7;
    max-width: 52ch;
  }
</style>
