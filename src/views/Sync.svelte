<script lang="ts">
  import { go } from "../lib/nav";
  import SyncAccount from "../components/SyncAccount.svelte";
</script>

<section class="view" aria-label="Sync">
  <header class="top">
    <button class="btn ghost icon" aria-label="Back to More" onclick={() => go("/more")}>
      <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>
    </button>
    <h1>Sync</h1>
  </header>
  <p class="intro">HardlySyncing is the optional paid service for syncing your reading state between devices. Local reading, manual backup, and Komga/Suwayomi read-state sync remain free.</p>
  <SyncAccount standalone />
  <button class="btn ghost backup" onclick={() => go("/backup")}>Free backup &amp; restore</button>
</section>

<style>
  .view { min-width: 0; max-width: 720px; padding: var(--s4) var(--s4) var(--s7); }
  .top { display: flex; align-items: center; gap: var(--s2); margin-bottom: var(--s4); }
  .top svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  h1 { font-size: var(--t-2xl); }
  .intro { color: var(--text-2); font-size: var(--t-sm); line-height: 1.6; margin-bottom: var(--s4); overflow-wrap: anywhere; }
  .backup { margin-top: var(--s4); max-width: 100%; white-space: normal; }
</style>
