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
  import { go } from "../lib/nav";
  import { plugins } from "../state/plugins.svelte";
  import { notices } from "../state/notices.svelte";
  import { noticeTime } from "../lib/notice-log";
  import PageMenu from "../components/PageMenu.svelte";

  // The log is what the notices said on this device, newest first. Reading it here is the point of
  // keeping it: the overlay is gone in seven seconds, and "what did that say?" lands on this page.
  $effect(() => {
    notices.load();
  });

  const counts = $derived({
    library: library.library.length,
    plugins: plugins.list.length,
  });
</script>

<section class="view">
  <header class="top">
    <PageMenu title="More" current="more" />
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

  <section class="notices" aria-label="Notices">
    <header class="nhead">
      <h2>Notices</h2>
      {#if notices.log.length > 0}
        <button class="clear" onclick={() => notices.clearLog()}>Clear</button>
      {/if}
    </header>
    {#if notices.log.length === 0}
      <p class="none">Nothing to report. Anything the app tells you at the top of the screen is kept here.</p>
    {:else}
      <ol class="log">
        {#each notices.log as entry (entry.at + entry.text)}
          <li>
            <span class="when">{noticeTime(entry.at)}</span>
            <span class="what selectable">{entry.text}</span>
          </li>
        {/each}
      </ol>
    {/if}
  </section>

  <p class="about">
    HardlyTracking · a Mihon/Komikku-compatible reader. Your library, history and downloads live on
    this device; sync is optional and paid, the reader is not.
  </p>
</section>

<style>
  .view {
    padding: var(--s4) var(--s4) var(--s7);
    max-width: 1200px;
  }

  .top {
    margin-bottom: var(--s4);
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

  .notices {
    margin-bottom: var(--s5);
  }

  .nhead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s3);
    padding-bottom: var(--s2);
    border-bottom: 1px solid var(--line);
  }

  h2 {
    font-size: var(--t-md);
    font-weight: 600;
  }

  .clear {
    all: unset;
    cursor: pointer;
    min-height: 44px;
    padding: 0 var(--s2);
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .none {
    margin: var(--s3) 0 0;
    font-size: var(--t-xs);
    color: var(--text-3);
    line-height: 1.6;
  }

  .log {
    list-style: none;
    margin: var(--s2) 0 0;
    padding: 0;
    display: grid;
  }

  .log li {
    display: grid;
    gap: 2px;
    padding: var(--s2) 0;
    border-bottom: 1px solid var(--line);
  }

  .when {
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .what {
    font-size: var(--t-sm);
    overflow-wrap: anywhere;
  }

  .about {
    font-size: var(--t-xs);
    color: var(--text-3);
    line-height: 1.7;
    max-width: 52ch;
  }
</style>
